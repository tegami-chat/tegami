// Files kept on the phone, encrypted like the browser's (file-cache.ts): what stays on the
// phone is only bytes sealed with the open account's key (lib/at-rest.ts), in the app's
// document folder (the phone does not purge it), one folder per account, named by the
// SHA-256 of the file's id. Inside: the file's type, then its bytes (the same layout as the
// browser's IndexedDB copy).
//
// To show a file it is opened in memory and written to a short-lived plain copy in the cache
// folder under a random name. openFileUri hands out that copy's address and releaseFileUri
// deletes it. Copies left over from a closed app are deleted when this module loads.
// Nothing here touches IndexedDB, canvas or Blob([bytes]).

import { Directory, File, Paths } from 'expo-file-system';

import { atRestAccount, openBytes, sealBytes } from './at-rest';
import { downloadPlain, sha256Hex } from './file-download';
import type { FileRef } from './files';

const ROOT = 'tegami-files';
const TEMP = 'tegami-temp';

// Plain copies from a run that did not finish (and the older plain cache folders).
for (const name of [TEMP, 'tegami-shrink', ROOT]) {
  try {
    const d = new Directory(Paths.cache, name);
    if (d.exists) d.delete();
  } catch {
    // Already gone.
  }
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/aac': 'aac',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
};

/** The part after the dot for a file type, so the phone's players can tell what a file is. */
export function extensionOf(type: string): string {
  return EXTENSIONS[type.split(';')[0].trim().toLowerCase()] ?? 'bin';
}

async function folderOf(account: string): Promise<Directory> {
  const name = await sha256Hex(new TextEncoder().encode(account));
  return new Directory(Paths.document, ROOT, name.slice(0, 32));
}

function pack(type: string, body: Uint8Array): Uint8Array<ArrayBuffer> {
  const t = new TextEncoder().encode(type);
  const out = new Uint8Array(2 + t.length + body.length);
  out[0] = t.length >> 8;
  out[1] = t.length & 255;
  out.set(t, 2);
  out.set(body, 2 + t.length);
  return out;
}

function unpack(bytes: Uint8Array): { type: string; body: Uint8Array } | null {
  if (bytes.length < 2) return null;
  const n = (bytes[0] << 8) | bytes[1];
  if (bytes.length < 2 + n) return null;
  return { type: new TextDecoder().decode(bytes.subarray(2, 2 + n)), body: bytes.subarray(2 + n) };
}

async function placeOf(id: string): Promise<{ dir: Directory; file: File; aad: string } | null> {
  const account = atRestAccount();
  if (!account) return null; // no key: nothing here can be sealed or read
  const dir = await folderOf(account);
  const name = await sha256Hex(new TextEncoder().encode(id));
  return { dir, file: new File(dir, name), aad: `file:${account}|${id}` };
}

async function keep(id: string, type: string, body: Uint8Array) {
  const place = await placeOf(id);
  if (!place) return;
  const sealed = await sealBytes(place.aad, pack(type, body));
  if (!sealed) return;
  const out = new Uint8Array(sealed.iv.length + sealed.ct.length);
  out.set(sealed.iv, 0);
  out.set(sealed.ct, sealed.iv.length);
  place.dir.create({ intermediates: true, idempotent: true });
  place.file.create({ overwrite: true });
  place.file.write(out);
}

async function kept(id: string): Promise<{ type: string; body: Uint8Array } | undefined> {
  const place = await placeOf(id);
  if (!place || !place.file.exists) return undefined;
  const raw = await place.file.bytes();
  if (raw.length < 13) return undefined;
  const opened = await openBytes(place.aad, { v: 1, iv: raw.slice(0, 12), ct: raw.slice(12) });
  return (opened && unpack(opened)) || undefined;
}

// ---------- short-lived plain copies ----------

const live = new Map<string, { uri: string; users: number }>();

async function makeTemp(type: string, body: Uint8Array): Promise<string> {
  const dir = new Directory(Paths.cache, TEMP);
  dir.create({ intermediates: true, idempotent: true });
  const random = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const file = new File(dir, `${random}.${extensionOf(type)}`);
  file.create({ overwrite: true });
  file.write(body);
  return file.uri;
}

function dropTemp(uri: string) {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // Already gone.
  }
}

async function plainOf(id: string, f?: FileRef): Promise<{ type: string; body: Uint8Array }> {
  const hit = await kept(id).catch(() => undefined);
  if (hit) return hit;
  if (!f) throw new Error('not kept');
  const body = new Uint8Array(await downloadPlain(f));
  await keep(id, f.type, body).catch(() => {});
  return { type: f.type, body };
}

/** The address of a short-lived plain copy of the file. Give it back with releaseFileUri. */
export async function openFileUri(id: string, f: FileRef): Promise<string> {
  const have = live.get(id);
  if (have) {
    have.users++;
    return have.uri;
  }
  const { type, body } = await plainOf(id, f);
  const again = live.get(id); // another caller made it while this one was reading
  if (again) {
    again.users++;
    return again.uri;
  }
  const uri = await makeTemp(type, body);
  live.set(id, { uri, users: 1 });
  return uri;
}

/** Deletes the plain copy when its last user gives it back. */
export function releaseFileUri(uri: string) {
  for (const [id, entry] of live) {
    if (entry.uri !== uri) continue;
    if (--entry.users <= 0) {
      live.delete(id);
      dropTemp(uri);
    }
    return;
  }
  dropTemp(uri);
}

/** A Blob with the file's bytes (a Blob cannot be made from bytes in React Native; the plain copy is read and deleted at once). */
async function blobOf(type: string, body: Uint8Array): Promise<Blob> {
  const uri = await makeTemp(type, body);
  try {
    const blob = await (await fetch(uri)).blob();
    return blob.type === type ? blob : blob.slice(0, blob.size, type);
  } finally {
    dropTemp(uri);
  }
}

export async function openFile(id: string, f: FileRef): Promise<Blob> {
  const { type, body } = await plainOf(id, f);
  return blobOf(type, body);
}

/** Keeps a file I sent, so it shows without downloading it again. */
export async function keepSent(id: string, bytes: Uint8Array<ArrayBuffer>, type: string) {
  await keep(id, type, bytes).catch(() => {});
}

/** A file kept on this phone under this id, if any. */
export async function keptFile(id: string): Promise<Blob | undefined> {
  const hit = await kept(id).catch(() => undefined);
  return hit ? blobOf(hit.type, hit.body).catch(() => undefined) : undefined;
}

/** Removes a file kept on this phone (a photo that was never sent). */
export async function forgetFile(id: string) {
  try {
    const place = await placeOf(id);
    if (place?.file.exists) place.file.delete();
  } catch {
    // Already gone.
  }
}

/** Removes every file kept for an account (it does not need to be open). */
export async function forgetAccountFiles(account: string) {
  try {
    const dir = await folderOf(account);
    if (dir.exists) dir.delete();
  } catch {
    // Already gone.
  }
}

/** Files here were never kept in the browser's older plain form: nothing to encrypt. */
export async function sealLegacyFiles(_ids: string[], _accounts: string[]) {}
