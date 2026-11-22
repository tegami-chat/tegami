// Files kept on the phone: plain files in the app's cache folder (the phone's own file
// protection covers them), one folder per account, named by the SHA-256 of the file's id.
// A file's type is kept beside it in "<name>.type". The browser keeps its files encrypted in
// IndexedDB (file-cache.ts); nothing here touches IndexedDB, canvas or Blob([bytes]).

import { Directory, File, Paths } from 'expo-file-system';

import { atRestAccount } from './at-rest';
import { downloadPlain, sha256Hex } from './file-download';
import type { FileRef } from './files';

const ROOT = 'tegami-files';

async function folderOf(account: string | null): Promise<Directory> {
  const name = await sha256Hex(new TextEncoder().encode(account ?? '(none)'));
  return new Directory(Paths.cache, ROOT, name.slice(0, 32));
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

async function placeOf(id: string): Promise<{ dir: Directory; name: string; kind: File }> {
  const dir = await folderOf(atRestAccount());
  const name = await sha256Hex(new TextEncoder().encode(id));
  return { dir, name, kind: new File(dir, `${name}.type`) };
}

async function write(id: string, bytes: Uint8Array, type: string): Promise<File> {
  const { dir, name, kind } = await placeOf(id);
  dir.create({ intermediates: true, idempotent: true });
  const body = new File(dir, `${name}.${extensionOf(type)}`);
  body.create({ overwrite: true });
  body.write(bytes);
  kind.create({ overwrite: true });
  kind.write(type);
  return body;
}

async function kept(id: string): Promise<{ body: File; type: string } | undefined> {
  const { dir, name, kind } = await placeOf(id);
  if (!kind.exists) return undefined;
  const type = await kind.text();
  const body = new File(dir, `${name}.${extensionOf(type)}`);
  return body.exists ? { body, type } : undefined;
}

/** A Blob that reads from a kept file (a Blob cannot be made from bytes in React Native). */
async function blobOf(file: { body: File; type: string }): Promise<Blob> {
  const blob = await (await fetch(file.body.uri)).blob();
  return blob.type === file.type ? blob : blob.slice(0, blob.size, file.type);
}

/** The address of the decrypted file on this phone, downloaded and kept first if needed. */
export async function openFileUri(id: string, f: FileRef): Promise<string> {
  const hit = await kept(id).catch(() => undefined);
  if (hit) return hit.body.uri;
  const plain = await downloadPlain(f);
  return (await write(id, new Uint8Array(plain), f.type)).uri;
}

/** Nothing to give back: the file stays in the cache folder. */
export function releaseFileUri(_uri: string) {}

export async function openFile(id: string, f: FileRef): Promise<Blob> {
  const uri = await openFileUri(id, f);
  return blobOf({ body: new File(uri), type: f.type });
}

/** Keeps a file I sent, so it shows without downloading it again. */
export async function keepSent(id: string, bytes: Uint8Array<ArrayBuffer>, type: string) {
  await write(id, bytes, type).catch(() => {});
}

/** A file kept on this phone under this id, if any. */
export async function keptFile(id: string): Promise<Blob | undefined> {
  const hit = await kept(id).catch(() => undefined);
  return hit ? blobOf(hit).catch(() => undefined) : undefined;
}

/** Removes a file kept on this phone (a photo that was never sent). */
export async function forgetFile(id: string) {
  try {
    const hit = await kept(id);
    if (hit) hit.body.delete();
    const { kind } = await placeOf(id);
    if (kind.exists) kind.delete();
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
