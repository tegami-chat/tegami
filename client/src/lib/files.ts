// Photos and files (NIP-17 kind 15 + Blossom).
//
// Sending: the photo is made smaller on this device, encrypted with a fresh AES-GCM
// key, and only the encrypted bytes are uploaded. The key travels inside the
// end-to-end encrypted message, so the file server cannot open the photo.
// Receiving: the encrypted bytes are downloaded, decrypted here, and kept in this
// device's IndexedDB. The server deletes its copy after 30 days; this device keeps it.
//
// Resizing (shrink.ts) and the local cache (file-cache.ts) have a browser version and a
// phone version (.native.ts).

import { finalizeEvent } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';


import { FILE_SERVER, isOwnFileUrl, sha256Hex } from './file-download';

export { FILE_SERVER, isOwnFileUrl };

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
  // Only this app's own file server: another host would learn the reader's address and time.
  if (!isOwnFileUrl(content)) return null;
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
    !isOwnFileUrl(f.url) ||
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

export { forgetAccountFiles, forgetFile, keepSent, keptFile, openFile, openFileUri, releaseFileUri, sealLegacyFiles } from './file-cache';
export { shrinkAvatar, shrinkImage, shrinkStamp } from './shrink';
