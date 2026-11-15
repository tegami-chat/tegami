// Tests for the stamp storage (PUT /stamp, GET/HEAD/DELETE /stamp/<sha256>): kept until the keeper deletes it.
// Usage: RELAY=ws://127.0.0.1:8787 node test/stamps.test.mjs
import { createHash } from 'node:crypto';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { trust } from './join.mjs';

const RELAY = process.env.RELAY ?? 'ws://localhost:8787';
const BASE = RELAY.replace(/^ws/, 'http').replace(/\/$/, '');
let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures++;
};

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
function auth(sk, hash, { t = 'stamp', kind = 24242, expiration = Math.floor(Date.now() / 1000) + 300 } = {}) {
  const ev = finalizeEvent(
    { kind, created_at: Math.floor(Date.now() / 1000), content: t, tags: [['t', t], ['x', hash], ['expiration', String(expiration)]] },
    sk,
  );
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64');
}
const put = (body, headers = {}) => fetch(`${BASE}/stamp`, { method: 'PUT', body, headers });
const del = (hash, headers = {}) => fetch(`${BASE}/stamp/${hash}`, { method: 'DELETE', headers });

const a = generateSecretKey();
const b = generateSecretKey();
const stranger = generateSecretKey();
await trust(a);
await trust(b);

const file = Buffer.from(`encrypted stamp ${Math.random()}`.repeat(50));
const hash = sha(file);

check('a stamp without authorization is refused', (await put(file)).status === 401);
check('an upload authorization (t=upload) is not a stamp authorization', (await put(file, { Authorization: auth(a, hash, { t: 'upload' }) })).status === 401);
check('a stamp signed for another file is refused', (await put(file, { Authorization: auth(a, sha(Buffer.from('other'))) })).status === 401);
check('an expired authorization is refused', (await put(file, { Authorization: auth(a, hash, { expiration: 1 }) })).status === 401);
check('an unregistered key cannot keep stamps', (await put(file, { Authorization: auth(stranger, hash) })).status === 403);

const ok = await put(file, { Authorization: auth(a, hash) });
const desc = ok.status === 200 ? await ok.json() : {};
check(`a stamp is kept (${ok.status})`, ok.status === 200 && desc.sha256 === hash && desc.url.endsWith(`/stamp/${hash}`));
const got = await fetch(`${BASE}/stamp/${hash}`);
check('the stamp comes back with the same bytes, to any origin', got.status === 200 && Buffer.from(await got.arrayBuffer()).equals(file) && got.headers.get('access-control-allow-origin') === '*');
check('HEAD says it is there', (await fetch(`${BASE}/stamp/${hash}`, { method: 'HEAD' })).status === 200);
check('a stamp is not served as a 30-day file', (await fetch(`${BASE}/${hash}`)).status === 404);
check('the same stamp again is fine', (await put(file, { Authorization: auth(a, hash) })).status === 200);

const big = Buffer.alloc(512 * 1024 + 1);
check('a stamp over 512 KB is refused', (await put(big, { Authorization: auth(a, sha(big)) })).status === 413);

check('deleting without authorization is refused', (await del(hash)).status === 401);
check('deleting with a stamp authorization (t=stamp) is refused', (await del(hash, { Authorization: auth(a, hash) })).status === 401);
check('deleting signed for another file is refused', (await del(hash, { Authorization: auth(a, sha(Buffer.from('other')), { t: 'delete' }) })).status === 401);
check('a key that does not keep it can "delete" it, but nothing goes', (await del(hash, { Authorization: auth(b, hash, { t: 'delete' }) })).status === 204 && (await fetch(`${BASE}/stamp/${hash}`)).status === 200);

// Two keys keep the same file: it goes only when both have deleted it.
check('a second key keeps the same file', (await put(file, { Authorization: auth(b, hash) })).status === 200);
check('the first keeper deletes it', (await del(hash, { Authorization: auth(a, hash, { t: 'delete' }) })).status === 204);
check('it is still there for the second keeper', (await fetch(`${BASE}/stamp/${hash}`)).status === 200);
check('the second keeper deletes it', (await del(hash, { Authorization: auth(b, hash, { t: 'delete' }) })).status === 204);
check('then it is gone', (await fetch(`${BASE}/stamp/${hash}`)).status === 404);

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
