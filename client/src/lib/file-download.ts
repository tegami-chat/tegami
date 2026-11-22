// Downloading one encrypted file from this app's own file server, checking it and opening it.
// Shared by the browser cache (file-cache.ts) and the phone cache (file-cache.native.ts).

import { bytesToHex, hexToBytes } from 'nostr-tools/utils';

export const FILE_SERVER = (process.env.EXPO_PUBLIC_TEGAMI_FILES ?? 'https://relay.tegami.chat').replace(/\/$/, '');

/** True for an address on this app's own file server (the only place a file is fetched from). */
export function isOwnFileUrl(url: string): boolean {
  return url.startsWith(`${FILE_SERVER}/`);
}

export async function sha256Hex(bytes: BufferSource) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

/** Downloads a file, checks its hash and decrypts it (AES-GCM). Throws 'gone' when the server no longer has it. */
export async function downloadPlain(f: { url: string; key: string; nonce: string; sha256: string }): Promise<ArrayBuffer> {
  if (!isOwnFileUrl(f.url)) throw new Error('file is not on the file server');
  const res = await fetch(f.url);
  if (!res.ok) throw new Error(res.status === 404 ? 'gone' : `download failed: ${res.status}`);
  const cipher = new Uint8Array(await res.arrayBuffer());
  if ((await sha256Hex(cipher)) !== f.sha256) throw new Error('file does not match its hash');
  const key = await crypto.subtle.importKey('raw', hexToBytes(f.key) as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['decrypt']);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: hexToBytes(f.nonce) as Uint8Array<ArrayBuffer> }, key, cipher);
}
