// Web Push for the Tegami relay: "you have a new message", nothing more.
//
// A device registers its push subscription (POST /push, signed with the person's
// Nostr key, NIP-98). When an envelope for that key arrives, the relay sends an
// empty push (no payload) to each registered device, signed with the relay's VAPID
// key. The push says nothing about who wrote or what: the app's service worker shows
// "新しいメッセージがあります". The relay never pushes for a person's own copy of a
// message they sent (the sending connection is logged in as that person).
//
// Only push services' own https addresses are accepted, so the relay cannot be used
// to send requests to arbitrary places.

import { verifyEvent, type NostrEvent } from 'nostr-tools/pure';

export const MAX_DEVICES = 10;
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];

function b64u(bytes: ArrayBuffer | Uint8Array) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64u(text: string) {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** Whether the relay may send to this endpoint. `allowLocal` is for tests only. */
export function allowedEndpoint(endpoint: unknown, allowLocal = false): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 1000) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (allowLocal && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
  return u.protocol === 'https:' && PUSH_HOSTS.some((h) => h.test(u.hostname));
}

/**
 * Checks a NIP-98 Authorization header ("Nostr <base64 event>") for an accepted URL and this method,
 * with the body's sha256 in a payload tag. Returns the person's pubkey, or null.
 */
export async function nip98(req: Request, body: string, urlOk: (u: string) => boolean): Promise<string | null> {
  let ev: NostrEvent;
  try {
    ev = JSON.parse(atob((req.headers.get('Authorization') ?? '').replace(/^Nostr /, '')));
  } catch {
    return null;
  }
  const tag = (n: string) => ev?.tags?.find((t) => t[0] === n)?.[1];
  const hash = b64hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
  const fresh = Math.abs(Math.floor(Date.now() / 1000) - (ev?.created_at ?? 0)) <= 60;
  if (ev?.kind !== 27235 || !urlOk(tag('u') ?? '') || tag('method') !== req.method || tag('payload') !== hash || !fresh) return null;
  return verifyEvent(ev) ? ev.pubkey : null;
}

function b64hex(buf: ArrayBuffer) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The relay's VAPID key, from the Worker secret VAPID_JWK (a P-256 private JWK). */
export class Vapid {
  private key: Promise<CryptoKey>;
  readonly publicKey: string; // uncompressed point, base64url (applicationServerKey)
  constructor(jwkText: string, private subject = 'mailto:hello@tegami.chat') {
    const jwk = JSON.parse(jwkText) as JsonWebKey;
    this.key = crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const x = fromB64u(jwk.x!);
    const y = fromB64u(jwk.y!);
    const point = new Uint8Array(65);
    point[0] = 4;
    point.set(x, 1);
    point.set(y, 33);
    this.publicKey = b64u(point);
  }

  /** The Authorization header for one push service (RFC 8292). */
  async header(endpoint: string): Promise<string> {
    const enc = (o: object) => b64u(new TextEncoder().encode(JSON.stringify(o)));
    const aud = new URL(endpoint).origin;
    const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: this.subject })}`;
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await this.key, new TextEncoder().encode(unsigned));
    return `vapid t=${unsigned}.${b64u(sig)}, k=${this.publicKey}`;
  }

  /**
   * Sends one push. With the device's keys, the push carries `payload`, encrypted for that
   * device only (RFC 8291); the push service cannot read it. Without keys (devices that
   * registered before keys were kept), an empty push. Returns the HTTP status
   * (404 or 410: the subscription is gone).
   */
  async send(endpoint: string, payload?: string, keys?: PushKeys | null): Promise<number> {
    const headers: Record<string, string> = { Authorization: await this.header(endpoint), TTL: '86400', Urgency: 'high' };
    let body: Uint8Array | undefined;
    if (payload && keys) {
      body = await encryptPayload(new TextEncoder().encode(payload), keys);
      headers['Content-Encoding'] = 'aes128gcm';
      headers['Content-Type'] = 'application/octet-stream';
    } else {
      headers['Content-Length'] = '0';
    }
    const res = await fetch(endpoint, { method: 'POST', headers, body });
    return res.status;
  }
}

/** A device's push keys: its public key (p256dh, 65 bytes) and auth secret (16 bytes), base64url. */
export type PushKeys = { p256dh: string; auth: string };

export function validKeys(k: unknown): k is PushKeys {
  const o = k as PushKeys;
  try {
    return !!o && fromB64u(o.p256dh).length === 65 && fromB64u(o.auth).length === 16;
  } catch {
    return false;
  }
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};
const text = (s: string) => new TextEncoder().encode(s);

/** Web Push message encryption (RFC 8291) with the aes128gcm content coding (RFC 8188), one record. */
export async function encryptPayload(plain: Uint8Array, keys: PushKeys): Promise<Uint8Array> {
  const uaPublic = fromB64u(keys.p256dh);
  const authSecret = fromB64u(keys.auth);
  const as = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', as.publicKey)) as ArrayBuffer);
  const ua = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  // Workers' types call the field $public; the runtime reads "public" (the standard name).
  const ecdh = { name: 'ECDH', public: ua } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, as.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(text('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, text('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, text('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 0x02: the last (and only) record.
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plain, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}
