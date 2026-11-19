// Photos and files (NIP-17 kind 15 + Blossom).
//
// Sending: the photo is made smaller on this device, encrypted with a fresh AES-GCM
// key, and only the encrypted bytes are uploaded. The key travels inside the
// end-to-end encrypted message, so the file server cannot open the photo.
// Receiving: the encrypted bytes are downloaded, decrypted here, and kept in this
// device's IndexedDB. The server deletes its copy after 30 days; this device keeps it.
//
// TODO(native): resizing and the local cache use browser APIs (canvas, IndexedDB).

import { finalizeEvent } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';

import { atRestAccount, openBytes, sealBytes } from './at-rest';

export const FILE_SERVER = (process.env.EXPO_PUBLIC_TEGAMI_FILES ?? 'https://relay.tegami.chat').replace(/\/$/, '');

/** Maximum size the relay's file server accepts (10 MB). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** What a kind 15 message carries about its file. */
export type FileRef = {
  url: string;
  type: string;
  key: string; // hex AES-GCM key
  nonce: string; // hex 12-byte nonce
  sha256: string; // of the encrypted bytes
  size?: number;
  dim?: string; // "WxH"
  name?: string; // original file name (general files only)
  duration?: number; // seconds (voice messages)
};

/** Checks a file name from a message: 1..200 characters, no path separators. */
export function validFileName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 200 || /[/\\\0]/.test(trimmed)) return undefined;
  return trimmed;
}

/** Checks a file size (bytes) from a message: a positive integer. */
export function validFileSize(raw: unknown): number | undefined {
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

const MAX_SIDE = 1600;
const AVATAR_SIDE = 256;
const STAMP_SIDE = 320;
const QUALITY = 0.82;

async function sha256Hex(bytes: BufferSource) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

/** Makes a photo smaller (longest side 1600 px, JPEG). Philosophy #97: small by default. */
export async function shrinkImage(file: Blob): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob>((ok, fail) =>
    canvas.toBlob((b) => (b ? ok(b) : fail(new Error('could not encode the photo'))), 'image/jpeg', QUALITY),
  );
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/jpeg', width, height };
}

/** Whether the image has an alpha channel (transparent pixels, or a PNG with alpha). */
async function hasAlpha(file: Blob, ctx: CanvasRenderingContext2D, width: number, height: number): Promise<boolean> {
  const rgba = ctx.getImageData(0, 0, width, height).data;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < 255) return true;
  }
  const head = new Uint8Array(await file.slice(0, 26).arrayBuffer());
  // PNG signature followed by IHDR: byte 25 is the color type (4 = gray+alpha, 6 = RGBA).
  if (head.length >= 26 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return head[25] === 4 || head[25] === 6;
  }
  return false;
}

/** Shrinks a stamp to fit 320x320; outputs PNG when the input has an alpha channel, else JPEG. */
export async function shrinkStamp(file: Blob): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, STAMP_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const alpha = await hasAlpha(file, ctx, width, height);
  const type = alpha ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob>((ok, fail) =>
    canvas.toBlob((b) => (b ? ok(b) : fail(new Error('could not encode the stamp'))), type, alpha ? undefined : QUALITY),
  );
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type, width, height };
}

/** Crops to a centered square and shrinks to at most 256x256 JPEG. */
export async function shrinkAvatar(file: Blob): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const short = Math.min(bitmap.width, bitmap.height);
  const side = Math.max(1, Math.min(AVATAR_SIDE, short));
  const sx = Math.floor((bitmap.width - short) / 2);
  const sy = Math.floor((bitmap.height - short) / 2);
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  canvas.getContext('2d')!.drawImage(bitmap, sx, sy, short, short, 0, 0, side, side);
  bitmap.close();
  const blob = await new Promise<Blob>((ok, fail) =>
    canvas.toBlob((b) => (b ? ok(b) : fail(new Error('could not encode the avatar'))), 'image/jpeg', QUALITY),
  );
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/jpeg', width: side, height: side };
}

/** Encrypts and uploads. Returns everything the message needs to carry. */
export async function encryptAndUpload(
  bytes: Uint8Array<ArrayBuffer>,
  type: string,
  secret: Uint8Array,
  dim?: string,
  extra?: { name?: string; duration?: number },
): Promise<FileRef> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, bytes));
  const hash = await sha256Hex(cipher);
  const auth = finalizeEvent(
    {
      kind: 24242,
      created_at: Math.floor(Date.now() / 1000),
      content: 'Upload',
      tags: [
        ['t', 'upload'],
        ['x', hash],
        ['expiration', String(Math.floor(Date.now() / 1000) + 300)],
      ],
    },
    secret,
  );
  const res = await fetch(`${FILE_SERVER}/upload`, {
    method: 'PUT',
    body: cipher,
    headers: { Authorization: `Nostr ${btoa(JSON.stringify(auth))}`, 'Content-Type': 'application/octet-stream' },
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${res.headers.get('X-Reason') ?? ''}`);
  const desc = (await res.json()) as { url: string };
  const name = validFileName(extra?.name);
  const size = validFileSize(bytes.byteLength);
  const duration =
    typeof extra?.duration === 'number' && Number.isFinite(extra.duration) && extra.duration >= 0
      ? Math.round(extra.duration)
      : undefined;
  return {
    url: desc.url,
    type,
    key: bytesToHex(raw),
    nonce: bytesToHex(nonce),
    sha256: hash,
    ...(size !== undefined ? { size } : {}),
    ...(dim ? { dim } : {}),
    ...(name ? { name } : {}),
    ...(duration !== undefined ? { duration } : {}),
  };
}

// ---------- stamps: kept on the relay until removed ----------
//
// Photos go to /upload, which the file server deletes after 30 days. Stamps go to /stamp,
// which keeps them until I remove them. Each stamp is encrypted with a key made from the
// image and my account's secret (not a random key), so:
// - the same stamp is the same file on all my devices (my list can be synced, nothing is
//   uploaded twice);
// - another account's copy of the same image is a different file, so the relay cannot see
//   who has the same stamp as whom.
// The key and nonce are unique to each image, so the fixed nonce is never reused with a
// different plaintext under the same key.

/** Whether a stamp lives in the stamp storage (kept until removed) rather than the 30-day file server. */
export function isKeptStamp(f: FileRef): boolean {
  return /\/stamp\/[0-9a-f]{64}$/.test(f.url);
}

async function stampKeyAndNonce(bytes: Uint8Array<ArrayBuffer>, secret: Uint8Array) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', secret as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveBits']);
  const mac = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('tegami/stamp/v1'), info: enc.encode('stamp mac') }, base, 256);
  const hmac = await crypto.subtle.importKey('raw', mac, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const seed = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, bytes));
  const part = async (label: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([...enc.encode(label), ...seed])));
  return { raw: await part('key'), nonce: (await part('nonce')).slice(0, 12) };
}

function fileAuthHeader(secret: Uint8Array, t: string, hash: string) {
  const now = Math.floor(Date.now() / 1000);
  const auth = finalizeEvent(
    { kind: 24242, created_at: now, content: t, tags: [['t', t], ['x', hash], ['expiration', String(now + 300)]] },
    secret,
  );
  return `Nostr ${btoa(JSON.stringify(auth))}`;
}

/** Encrypts a stamp for my account and keeps it in the stamp storage (skipped when it is there already). */
export async function uploadStamp(bytes: Uint8Array<ArrayBuffer>, type: string, secret: Uint8Array, dim?: string): Promise<FileRef> {
  const { raw, nonce } = await stampKeyAndNonce(bytes, secret);
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, bytes));
  const hash = await sha256Hex(cipher);
  const url = `${FILE_SERVER}/stamp/${hash}`;
  const there = await fetch(url, { method: 'HEAD' }).then((r) => r.ok).catch(() => false);
  if (!there) {
    const res = await fetch(`${FILE_SERVER}/stamp`, {
      method: 'PUT',
      body: cipher,
      headers: { Authorization: fileAuthHeader(secret, 'stamp', hash), 'Content-Type': 'application/octet-stream' },
    });
    if (!res.ok) throw new Error(`stamp upload failed: ${res.status} ${res.headers.get('X-Reason') ?? ''}`);
  }
  const size = validFileSize(bytes.byteLength);
  return {
    url,
    type,
    key: bytesToHex(raw),
    nonce: bytesToHex(nonce),
    sha256: hash,
    ...(size !== undefined ? { size } : {}),
    ...(dim ? { dim } : {}),
  };
}

/** Stops keeping a stamp in the stamp storage. Messages already sent keep showing it where it was opened. */
export async function deleteStampFile(sha256: string, secret: Uint8Array) {
  const res = await fetch(`${FILE_SERVER}/stamp/${sha256}`, { method: 'DELETE', headers: { Authorization: fileAuthHeader(secret, 'delete', sha256) } });
  if (!res.ok && res.status !== 404) throw new Error(`stamp delete failed: ${res.status}`);
}

/** NIP-17 kind 15 tags for a file (with `["t", "stamp"]` when `stamp` is true). */
export function fileTags(f: FileRef, stamp?: boolean): string[][] {
  const tags = [
    ['file-type', f.type],
    ['encryption-algorithm', 'aes-gcm'],
    ['decryption-key', f.key],
    ['decryption-nonce', f.nonce],
    ['x', f.sha256],
  ];
  const size = validFileSize(f.size);
  if (size !== undefined) tags.push(['size', String(size)]);
  if (f.dim) tags.push(['dim', f.dim]);
  if (f.name) tags.push(['name', f.name]);
  if (f.duration !== undefined) tags.push(['duration', String(Math.round(f.duration))]);
  if (stamp) tags.push(['t', 'stamp']);
  return tags;
}

/** Whether a kind 15 rumor's tags mark it as a stamp. */
export function isStampRumor(tags: string[][]): boolean {
  return tags.some((t) => t[0] === 't' && t[1] === 'stamp');
}

/** Reads a kind 15 rumor back into a FileRef (null when it is not something we can open). */
export function fileFromRumor(content: string, tags: string[][]): FileRef | null {
  const tag = (n: string) => tags.find((t) => t[0] === n)?.[1];
  const key = tag('decryption-key');
  const nonce = tag('decryption-nonce');
  const sha256 = tag('x');
  if (tag('encryption-algorithm') !== 'aes-gcm' || !key || !nonce || !sha256) return null;
  // Only https, or this app's own file server (a development address in tests).
  if (!content.startsWith('https://') && !content.startsWith(`${FILE_SERVER}/`)) return null;
  const rawName = tag('name');
  if (rawName !== undefined && !validFileName(rawName)) return null;
  const name = validFileName(rawName);
  const size = validFileSize(tag('size'));
  const rawDur = tag('duration');
  const durNum = rawDur !== undefined ? Number(rawDur) : undefined;
  const duration = durNum !== undefined && Number.isFinite(durNum) && durNum >= 0 ? Math.round(durNum) : undefined;
  return {
    url: content,
    type: tag('file-type') ?? 'application/octet-stream',
    key,
    nonce,
    sha256,
    ...(size !== undefined ? { size } : {}),
    dim: tag('dim'),
    ...(name ? { name } : {}),
    ...(duration !== undefined ? { duration } : {}),
  };
}

/** Checks a JSON FileRef (such as an avatar in a profile card). Null when malformed. */
export function validFileRef(raw: unknown): FileRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  if (
    typeof f.url !== 'string' ||
    (!f.url.startsWith('https://') && !f.url.startsWith(`${FILE_SERVER}/`)) ||
    typeof f.type !== 'string' ||
    typeof f.key !== 'string' ||
    !f.key ||
    typeof f.nonce !== 'string' ||
    !f.nonce ||
    typeof f.sha256 !== 'string' ||
    !f.sha256
  ) {
    return null;
  }
  if (f.name !== undefined && !validFileName(f.name)) return null;
  const name = validFileName(f.name);
  const size = validFileSize(f.size);
  return {
    url: f.url,
    type: f.type,
    key: f.key,
    nonce: f.nonce,
    sha256: f.sha256,
    ...(size !== undefined ? { size } : {}),
    ...(typeof f.dim === 'string' ? { dim: f.dim } : {}),
    ...(name ? { name } : {}),
    ...(typeof f.duration === 'number' && Number.isFinite(f.duration) && f.duration >= 0 ? { duration: Math.round(f.duration) } : {}),
  };
}

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
  const res = await fetch(f.url);
  if (!res.ok) throw new Error(res.status === 404 ? 'gone' : `download failed: ${res.status}`);
  const cipher = new Uint8Array(await res.arrayBuffer());
  if ((await sha256Hex(cipher)) !== f.sha256) throw new Error('file does not match its hash');
  const key = await crypto.subtle.importKey('raw', hexToBytes(f.key) as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: hexToBytes(f.nonce) as Uint8Array<ArrayBuffer> }, key, cipher);
  const blob = new Blob([plain], { type: f.type });
  await keep(id, blob).catch(() => {});
  return blob;
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
