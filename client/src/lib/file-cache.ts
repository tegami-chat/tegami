// Files kept on this device (browser: IndexedDB, encrypted). The phone apps use file-cache.native.ts.

import { atRestAccount, openBytes, sealBytes } from './at-rest';
import { downloadPlain } from './file-download';
import type { FileRef } from './files';

// ---------- local cache (IndexedDB, encrypted) ----------
//
// A kept file is encrypted with the open account's key (lib/at-rest.ts) and stored under
// "<account>|<id>", so each account has its own copies and another account's key cannot
// read them (a copy that cannot be read counts as not kept: it is fetched again). Bound
// into the encryption: the stored name. Inside: the file's type, then its bytes.
// Files kept before this were plain Blobs under "<id>"; sealLegacyFiles() moves them.

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('tegami-files', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(d: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const r = d.transaction('files').objectStore('files').get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function idbPut(d: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = d.transaction('files', 'readwrite');
    tx.objectStore('files').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const placeOf = (account: string, id: string) => `${account}|${id}`;

async function pack(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  const type = new TextEncoder().encode(blob.type);
  const body = new Uint8Array(await blob.arrayBuffer());
  const out = new Uint8Array(2 + type.length + body.length);
  out[0] = type.length >> 8;
  out[1] = type.length & 255;
  out.set(type, 2);
  out.set(body, 2 + type.length);
  return out;
}

function unpack(bytes: Uint8Array): Blob | null {
  if (bytes.length < 2) return null;
  const n = (bytes[0] << 8) | bytes[1];
  if (bytes.length < 2 + n) return null;
  const type = new TextDecoder().decode(bytes.subarray(2, 2 + n));
  return new Blob([bytes.slice(2 + n) as Uint8Array<ArrayBuffer>], { type });
}

async function seal(account: string, id: string, blob: Blob) {
  const place = placeOf(account, id);
  return sealBytes(`file:${place}`, await pack(blob));
}

async function cached(id: string): Promise<Blob | undefined> {
  const account = atRestAccount();
  if (!account) return undefined; // no key: nothing here can be read
  const place = placeOf(account, id);
  const d = await db();
  try {
    const rec = await idbGet(d, place);
    if (rec) {
      const bytes = await openBytes(`file:${place}`, rec);
      return (bytes && unpack(bytes)) || undefined;
    }
    // Kept before the files were encrypted: encrypt it now (the plain copy goes in sealLegacyFiles).
    const legacy = await idbGet(d, id);
    if (legacy instanceof Blob) {
      const sealed = await seal(account, id, legacy);
      if (sealed) await idbPut(d, place, sealed).catch(() => {});
      return legacy;
    }
    return undefined;
  } finally {
    d.close();
  }
}

async function keep(id: string, blob: Blob) {
  const account = atRestAccount();
  if (!account) return; // no key: not kept (it is fetched again when needed)
  const sealed = await seal(account, id, blob);
  if (!sealed) return;
  const d = await db();
  try {
    await idbPut(d, placeOf(account, id), sealed);
  } finally {
    d.close();
  }
}

/** Returns the decrypted file, from this device if kept, otherwise from the server. */
// (openFile is also used for avatars, cached under avatar:<sha256>.)
export async function openFile(id: string, f: FileRef): Promise<Blob> {
  const hit = await cached(id).catch(() => undefined);
  if (hit) return hit;
  const plain = await downloadPlain(f);
  const blob = new Blob([plain], { type: f.type });
  await keep(id, blob).catch(() => {});
  return blob;
}

/** A URL a picture or video element can show. Give it back with releaseFileUri. */
export async function openFileUri(id: string, f: FileRef): Promise<string> {
  return URL.createObjectURL(await openFile(id, f));
}

export function releaseFileUri(uri: string) {
  URL.revokeObjectURL(uri);
}

/** Keeps a file I sent, so it shows without downloading it again. */
export async function keepSent(id: string, bytes: Uint8Array<ArrayBuffer>, type: string) {
  await keep(id, new Blob([bytes], { type })).catch(() => {});
}

/** A file kept on this device under this id, if any. */
export async function keptFile(id: string): Promise<Blob | undefined> {
  return cached(id).catch(() => undefined);
}

/** Removes a file kept on this device (a photo that was never sent), and a plain copy from before the encryption. */
export async function forgetFile(id: string) {
  const account = atRestAccount();
  const d = await db().catch(() => null);
  if (!d) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = d.transaction('files', 'readwrite');
      const s = tx.objectStore('files');
      if (account) s.delete(placeOf(account, id));
      s.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } finally {
    d.close();
  }
}

/** Removes every file kept for an account (it does not need to be open). */
export async function forgetAccountFiles(account: string) {
  const d = await db().catch(() => null);
  if (!d) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = d.transaction('files', 'readwrite');
      const prefix = placeOf(account, '');
      tx.objectStore('files').delete(IDBKeyRange.bound(prefix, prefix + '￿'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } finally {
    d.close();
  }
}

const SEALED_LIST = 'tegami.filesSealed';

/**
 * Encrypts the plain copies the open account's files had before the encryption (`ids`: the ids its
 * messages, stamps and avatars use). The plain copies are shared by every account on this device,
 * so they are removed only when each account in `accounts` has done this.
 */
export async function sealLegacyFiles(ids: string[], accounts: string[]) {
  const account = atRestAccount();
  if (!account || typeof indexedDB === 'undefined') return;
  let done: string[] = [];
  try {
    done = JSON.parse(globalThis.localStorage?.getItem(SEALED_LIST) ?? '[]');
  } catch {
    done = [];
  }
  if (!Array.isArray(done)) done = [];
  try {
    const d = await db();
    try {
      if (!done.includes(account)) {
        for (const id of ids) {
          const place = placeOf(account, id);
          if (await idbGet(d, place)) continue;
          const legacy = await idbGet(d, id);
          if (!(legacy instanceof Blob)) continue;
          const sealed = await seal(account, id, legacy);
          if (!sealed) return;
          await idbPut(d, place, sealed);
        }
        done = [...done, account];
        globalThis.localStorage?.setItem(SEALED_LIST, JSON.stringify(done));
      }
      if (!accounts.every((a) => done.includes(a))) return;
      // Every account here has its own encrypted copies: the plain ones go.
      await new Promise<void>((resolve, reject) => {
        const tx = d.transaction('files', 'readwrite');
        const s = tx.objectStore('files');
        const req = s.openKeyCursor();
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return;
          if (typeof c.key === 'string' && !c.key.includes('|')) s.delete(c.key);
          c.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      d.close();
    }
  } catch {
    // Try again the next time the account opens.
  }
}
