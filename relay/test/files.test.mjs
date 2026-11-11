// Tests for the file endpoints (Blossom). Usage: RELAY=ws://127.0.0.1:8787 node test/files.test.mjs
import { createHash } from 'node:crypto';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';

const RELAY = process.env.RELAY ?? 'ws://localhost:8787';
const BASE = RELAY.replace(/^ws/, 'http').replace(/\/$/, '');
let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures++;
};

const sk = generateSecretKey();
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
function auth(hash, { kind = 24242, t = 'upload', expiration = Math.floor(Date.now() / 1000) + 300 } = {}) {
  const ev = finalizeEvent(
    { kind, created_at: Math.floor(Date.now() / 1000), content: 'Upload', tags: [['t', t], ['x', hash], ['expiration', String(expiration)]] },
    sk,
  );
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64');
}
const put = (body, headers = {}) => fetch(`${BASE}/upload`, { method: 'PUT', body, headers });

const file = Buffer.from(`encrypted bytes ${Math.random()}`.repeat(100));
const hash = sha(file);

check('upload without authorization is refused', (await put(file)).status === 401);
check('upload signed for a different file is refused', (await put(file, { Authorization: auth(sha(Buffer.from('other'))) })).status === 401);
check('expired authorization is refused', (await put(file, { Authorization: auth(hash, { expiration: 1 }) })).status === 401);
check('authorization of another kind is refused', (await put(file, { Authorization: auth(hash, { kind: 1 }) })).status === 401);

const ok = await put(file, { Authorization: auth(hash) });
const desc = ok.status === 200 ? await ok.json() : {};
check(`upload is accepted (${ok.status})`, ok.status === 200 && desc.sha256 === hash && desc.url.endsWith(`/${hash}`));

const got = await fetch(`${BASE}/${hash}`);
const back = Buffer.from(await got.arrayBuffer());
check('download returns the same bytes', got.status === 200 && back.equals(file));
check('download allows any origin (the app fetches it)', got.headers.get('access-control-allow-origin') === '*');
check('unknown file is 404', (await fetch(`${BASE}/${'0'.repeat(64)}`)).status === 404);

const big = Buffer.alloc(10 * 1024 * 1024 + 1);
check('a file over 10 MB is refused', (await put(big, { Authorization: auth(sha(big)) })).status === 413);

const pre = await fetch(`${BASE}/upload`, { method: 'OPTIONS' });
check('preflight allows PUT with Authorization', pre.status === 204 && /Authorization/.test(pre.headers.get('access-control-allow-headers') ?? ''));

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
