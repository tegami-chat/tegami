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

export const FILE_SERVER = (process.env.EXPO_PUBLIC_TEGAMI_FILES ?? 'https://relay.tegami.chat').replace(/\/$/, '');

/** What a kind 15 message carries about its file. */
export type FileRef = {
  url: string;
  type: string;
  key: string; // hex AES-GCM key
  nonce: string; // hex 12-byte nonce
  sha256: string; // of the encrypted bytes
  size?: number;
  dim?: string; // "WxH"
};

const MAX_SIDE = 1600;
const AVATAR_SIDE = 256;
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
  return { url: desc.url, type, key: bytesToHex(raw), nonce: bytesToHex(nonce), sha256: hash, size: bytes.byteLength, dim };
}

/** NIP-17 kind 15 tags for a file. */
export function fileTags(f: FileRef): string[][] {
  const tags = [
    ['file-type', f.type],
    ['encryption-algorithm', 'aes-gcm'],
    ['decryption-key', f.key],
    ['decryption-nonce', f.nonce],
    ['x', f.sha256],
  ];
  if (f.size) tags.push(['size', String(f.size)]);
  if (f.dim) tags.push(['dim', f.dim]);
  return tags;
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
  return {
    url: content,
    type: tag('file-type') ?? 'application/octet-stream',
    key,
    nonce,
    sha256,
    size: Number(tag('size')) || undefined,
    dim: tag('dim'),
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
  return {
    url: f.url,
    type: f.type,
    key: f.key,
    nonce: f.nonce,
    sha256: f.sha256,
    ...(typeof f.size === 'number' ? { size: f.size } : {}),
    ...(typeof f.dim === 'string' ? { dim: f.dim } : {}),
  };
}

// ---------- local cache (IndexedDB) ----------

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('tegami-files', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cached(id: string): Promise<Blob | undefined> {
  const d = await db();
  try {
    return await new Promise((resolve, reject) => {
      const r = d.transaction('files').objectStore('files').get(id);
      r.onsuccess = () => resolve(r.result as Blob | undefined);
      r.onerror = () => reject(r.error);
    });
  } finally {
    d.close();
  }
}

async function keep(id: string, blob: Blob) {
  const d = await db();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction('files', 'readwrite');
      tx.objectStore('files').put(blob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
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

/** Removes a file kept on this device (a photo that was never sent). */
export async function forgetFile(id: string) {
  const d = await db().catch(() => null);
  if (!d) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = d.transaction('files', 'readwrite');
      tx.objectStore('files').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } finally {
    d.close();
  }
}
