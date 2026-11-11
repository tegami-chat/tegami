// Protects the Nostr secret key with a passkey (WebAuthn PRF extension).
//
// The passkey produces the same 32 secret bytes every time it is used with the
// same salt. We turn those bytes into an AES-GCM key and encrypt the Nostr key
// with it. Only the encrypted key is stored, so neither this device's storage
// nor Tegami can read it without the passkey.
//
// TODO(native): iOS and Android need a native passkey module.
// TODO(recovery): upload the encrypted vault so a new device can restore it.

export type Vault = {
  v: 1;
  credentialId: string; // base64url
  iv: string; // base64url
  ciphertext: string; // base64url
};

export class PasskeyUnsupportedError extends Error {}

const PRF_SALT = new TextEncoder().encode('tegami/nostr-key/v1');
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

function random(n: number) {
  return crypto.getRandomValues(new Uint8Array(n));
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
  const iv = random(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, secret);
  return { v: 1, credentialId, iv: toB64u(iv), ciphertext: toB64u(ct) };
}

export async function open(vault: Vault, prf: BufferSource): Promise<Uint8Array> {
  const key = await aesKeyFromPrf(prf);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(vault.iv) }, key, fromB64u(vault.ciphertext));
  return new Uint8Array(pt);
}

type PrfResults = { enabled?: boolean; results?: { first?: ArrayBuffer } };

function prfOf(cred: PublicKeyCredential): PrfResults | undefined {
  return (cred.getClientExtensionResults() as { prf?: PrfResults }).prf;
}

async function evaluate(credentialId: string): Promise<ArrayBuffer> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      allowCredentials: [{ type: 'public-key', id: fromB64u(credentialId) }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const out = cred && prfOf(cred)?.results?.first;
  if (!out) throw new PasskeyUnsupportedError('PRF result missing');
  return out;
}

export function passkeysAvailable() {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;
}

/** Creates a passkey and returns a vault holding `secret`. */
export async function createVault(secret: Uint8Array<ArrayBuffer>): Promise<Vault> {
  if (!passkeysAvailable()) throw new PasskeyUnsupportedError('WebAuthn unavailable');
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Tegami' },
      user: { id: random(16), name: 'Tegami', displayName: 'Tegami' },
      challenge: random(32),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('cancelled');
  const credentialId = toB64u(cred.rawId);
  const prf = prfOf(cred);
  if (prf?.enabled === false) throw new PasskeyUnsupportedError('PRF not supported by this passkey');
  // Some platforms return the PRF output at creation, others only on the next use.
  let out = prf?.results?.first;
  if (!out) {
    try {
      out = await evaluate(credentialId);
    } catch (e) {
      // The passkey was created, but using it again failed. Some password manager
      // extensions save a passkey yet cannot offer it back with PRF. A cancel here
      // looks the same, so the start screen offers both a retry and a fallback.
      if (e instanceof PasskeyUnsupportedError) throw e;
      throw new PasskeyUnsupportedError(`PRF unavailable after create: ${(e as Error)?.name ?? e}`);
    }
  }
  return seal(secret, out, credentialId);
}

/** Asks for the passkey and returns the Nostr secret key. */
export async function unlockVault(vault: Vault): Promise<Uint8Array> {
  return open(vault, await evaluate(vault.credentialId));
}
