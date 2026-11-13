// Registering test keys with the relay (POST /register and POST /admin, NIP-98 signed).
// The admin key is made from a fixed phrase; .dev.vars lists its public key in ADMIN_PUBKEYS.
// Only a relay run with wrangler dev trusts it.
import { createHash } from 'node:crypto';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';

const RELAY = process.env.RELAY ?? 'ws://localhost:8787';
export const HTTP = RELAY.replace(/^ws/, 'http').replace(/\/$/, '');
export const ADMIN = createHash('sha256').update('tegami test admin').digest();

const sha256hex = (text) => createHash('sha256').update(text).digest('hex');

/** POST `path` with `body`, signed by `sk`. Returns { status, json }. */
export async function signedPost(path, sk, body, { url } = {}) {
  const text = JSON.stringify(body);
  const ev = finalizeEvent(
    { kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['u', url ?? `${HTTP}${path}`], ['method', 'POST'], ['payload', sha256hex(text)]] },
    sk,
  );
  const res = await fetch(`${HTTP}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64') },
    body: text,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

export const register = (sk, body = {}) => signedPost('/register', sk, body);
export const admin = (action, pubkey, extra = {}) => signedPost('/admin', ADMIN, { action, pubkey, ...extra });

/** Makes `sk` a key that may write and reach strangers (as if invited). */
export async function trust(sk) {
  const r = await admin('trust', getPublicKey(sk));
  if (r.status !== 200) throw new Error(`trust failed: ${r.status}`);
}
