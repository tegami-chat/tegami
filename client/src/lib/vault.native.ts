// iPhone and Android: the passkey vault (vault.ts in the browser).
//
// The vault format and the encryption are the same as in the browser (HKDF from the
// passkey's PRF value, then AES-GCM), so a vault made in one place opens in the other
// once the PRF value is the same. What is missing is the passkey itself: the apps need a
// native passkey module that returns the PRF value (react-native-passkey 3.3+ says it does
// on Android and iOS 18+; not tried yet), plus the Associated Domains entry
// (webcredentials:tegami.chat) and /.well-known/apple-app-site-association and
// /.well-known/assetlinks.json on tegami.chat. Until then passkeysAvailable() is false, the
// start screen offers "start without a passkey", and the key is kept by
// device-vault.native.ts in the Keychain / Keystore.

export type Vault = {
  v: 1;
  credentialId: string; // base64url
  iv: string; // base64url
  ciphertext: string; // base64url
};

export class PasskeyUnsupportedError extends Error {}

const HKDF_INFO = new TextEncoder().encode('tegami vault aes-gcm');

export function toB64u(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function aesKeyFromPrf(prf: BufferSource) {
  const base = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: HKDF_INFO },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function seal(secret: Uint8Array<ArrayBuffer>, prf: BufferSource, credentialId: string): Promise<Vault> {
  const key = await aesKeyFromPrf(prf);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, secret);
  return { v: 1, credentialId, iv: toB64u(iv), ciphertext: toB64u(ct) };
}

export async function open(vault: Vault, prf: BufferSource): Promise<Uint8Array> {
  const key = await aesKeyFromPrf(prf);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(vault.iv) }, key, fromB64u(vault.ciphertext));
  return new Uint8Array(pt);
}

export function passkeysAvailable() {
  return false;
}

export async function createVault(_secret: Uint8Array<ArrayBuffer>): Promise<Vault> {
  throw new PasskeyUnsupportedError('passkeys are not built into the app yet');
}

export async function unlockVault(_vault: Vault): Promise<Uint8Array> {
  throw new PasskeyUnsupportedError('passkeys are not built into the app yet');
}
