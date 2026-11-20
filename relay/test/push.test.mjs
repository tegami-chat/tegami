// Web Push test against `wrangler dev` with .dev.vars (a throwaway VAPID key, DEV_PUSH=1).
// A small local server stands in for the push service.
// Usage: npm run dev (in another window), then  node test/push.test.mjs
import { createServer } from 'node:http';
import * as nip42 from 'nostr-tools/nip42';
import * as nip59 from 'nostr-tools/nip59';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import WebSocket from 'ws';
import { register as registerKey, trust } from './join.mjs';

const HTTP = process.env.HTTP ?? 'http://localhost:8787';
const RELAY = HTTP.replace(/^http/, 'ws');
const PUSH_PORT = 9911;
let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (buf) => Buffer.from(buf).toString('base64url');

// ---------- the stand-in push service ----------
const received = []; // { path, auth, ttl, coding, body }
const push = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received.push({ path: req.url, auth: req.headers.authorization ?? '', ttl: req.headers.ttl, coding: req.headers['content-encoding'], body: Buffer.concat(chunks) });
    res.writeHead(req.url === '/gone' ? 410 : 201);
    res.end();
  });
}).listen(PUSH_PORT);

// ---------- a device's push keys, and decrypting what it receives (RFC 8291 / 8188) ----------
const device = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const devicePublic = new Uint8Array(await crypto.subtle.exportKey('raw', device.publicKey));
const authSecret = crypto.getRandomValues(new Uint8Array(16));
const deviceKeys = { p256dh: Buffer.from(devicePublic).toString('base64url'), auth: Buffer.from(authSecret).toString('base64url') };
async function hkdf(salt, ikm, info, bytes) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bytes * 8));
}
async function decryptPush(body) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const cipher = body.subarray(21 + idlen);
  const as = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: as }, device.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, Buffer.concat([Buffer.from('WebPush: info\0'), devicePublic, asPublic]), 32);
  const cek = await hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, cipher));
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--; // padding
  return JSON.parse(Buffer.from(plain.subarray(0, end)).toString()); // plain[end] is the 0x02 delimiter
}
const endpoint = (path) => `http://localhost:${PUSH_PORT}${path}`;

// ---------- helpers ----------
async function sha256hex(text) {
  return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex');
}
async function register(sk, ep, method = 'POST', { sign = true, keys } = {}) {
  const body = JSON.stringify(keys ? { endpoint: ep, keys } : { endpoint: ep });
  const headers = { 'Content-Type': 'application/json' };
  if (sign) {
    const ev = finalizeEvent(
      { kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['u', `${HTTP}/push`], ['method', method], ['payload', await sha256hex(body)]] },
      sk,
    );
    headers.Authorization = 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64');
  }
  return (await fetch(`${HTTP}/push`, { method, headers, body })).status;
}
function connect(sk, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(RELAY, { headers });
    const inbox = [];
    ws.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));
    const next = async (pred) => {
      for (let i = 0; i < 100; i++) {
        const hit = inbox.find(pred);
        if (hit) return hit;
        await wait(50);
      }
      throw new Error('timeout');
    };
    ws.on('open', async () => {
      const [, ch] = await next((m) => m[0] === 'AUTH');
      const auth = finalizeEvent(nip42.makeAuthEvent(RELAY, ch), sk);
      ws.send(JSON.stringify(['AUTH', auth]));
      await next((m) => m[0] === 'OK' && m[1] === auth.id);
      resolve({
        ws,
        send: async (wrap) => {
          ws.send(JSON.stringify(['EVENT', wrap]));
          return (await next((m) => m[0] === 'OK' && m[1] === wrap.id))[2];
        },
      });
    });
  });
}
const wrapTo = (from, to, text) => nip59.createWrap(nip59.createSeal(nip59.createRumor({ kind: 14, content: text, tags: [['p', to]] }, from), from, to), to);

const short2 = (to, tags) =>
  finalizeEvent({ kind: 1059, created_at: Math.floor(Date.now() / 1000), tags: [['p', to], ['expiration', String(Math.floor(Date.now() / 1000) + 60)], ...tags], content: 'sealed' }, generateSecretKey());

// ---------- tests ----------
const alice = generateSecretKey();
const bob = generateSecretKey();
const bobPub = getPublicKey(bob);
await trust(alice);
await trust(bob);

const key = await (await fetch(`${HTTP}/push/key`)).json();
check('the relay publishes its push key', typeof key.key === 'string' && Buffer.from(key.key, 'base64url').length === 65);

check('registering without a signature is refused', (await register(bob, endpoint('/bob'), 'POST', { sign: false })) === 401);
check('an address that is not a push service is refused', (await register(bob, 'https://example.com/push')) === 400);
check('bob registers a device', (await register(bob, endpoint('/bob'))) === 204);

const a = await connect(alice);
const b = await connect(bob);
const aliceKey = getPublicKey(alice);
// A recipient that has written to the sender counts as a friend; the stranger limits (below) do not apply.
check('bob writes to alice, so they are mutual', (await b.send(wrapTo(bob, aliceKey, 'hello alice'))) === true);
check('alice writes to bob', (await a.send(wrapTo(alice, bobPub, 'hi'))) === true);
await wait(1500);
const got = received.filter((r) => r.path === '/bob');
check('bob\'s device is told', got.length === 1);

// The push is signed with the relay's key for this push service (RFC 8292).
const m = got[0]?.auth.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
let signed = false;
if (m) {
  const claims = JSON.parse(Buffer.from(m[2], 'base64url').toString());
  const pub = await crypto.subtle.importKey('raw', Buffer.from(m[4], 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  signed =
    m[4] === key.key &&
    claims.aud === `http://localhost:${PUSH_PORT}` &&
    claims.exp > Date.now() / 1000 &&
    (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Buffer.from(m[3], 'base64url'), Buffer.from(`${m[1]}.${m[2]}`)));
}
check('the push carries a valid VAPID signature for that push service', signed);
check('the push has no message in it (empty body, only a time to live)', got[0]?.ttl === '86400');

await wait(3500);
check('bob\'s own copy of a message he sent does not notify him', (await b.send(wrapTo(bob, bobPub, 'my copy'))) === true);
await wait(1500);
check('…no push for it', received.filter((r) => r.path === '/bob').length === 1);

// A device that is gone (410) is removed.
check('bob registers a second device that will be gone', (await register(bob, endpoint('/gone'))) === 204);
await a.send(wrapTo(alice, bobPub, 'two'));
await wait(1500);
check('both devices are told', received.filter((r) => r.path === '/bob').length === 2 && received.filter((r) => r.path === '/gone').length === 1);
await wait(3500);
await a.send(wrapTo(alice, bobPub, 'three'));
await wait(1500);
check('the gone device is not told again', received.filter((r) => r.path === '/gone').length === 1 && received.filter((r) => r.path === '/bob').length === 3);

// Unregistering stops the pushes.
check('bob turns notifications off', (await register(bob, endpoint('/bob'), 'DELETE')) === 204);
await wait(3500);
await a.send(wrapTo(alice, bobPub, 'four'));
await wait(1500);
check('no push after turning off', received.filter((r) => r.path === '/bob').length === 3);

// A device that registered its keys learns what arrived: a message or a ringing call,
// encrypted for that device. The rest of a call's signals do not notify.
const carol = generateSecretKey();
const carolPub = getPublicKey(carol);
await trust(carol);
check('push keys that are not keys are refused', (await register(carol, endpoint('/carol'), 'POST', { keys: { p256dh: 'x', auth: 'y' } })) === 400);
check('carol registers a device with its keys', (await register(carol, endpoint('/carol'), 'POST', { keys: deviceKeys })) === 204);
const carolGot = () => received.filter((r) => r.path === '/carol');
const c = await connect(carol);
await c.send(wrapTo(carol, aliceKey, 'hello alice'));
await a.send(wrapTo(alice, carolPub, 'hello carol'));
await wait(1500);
const first = carolGot()[0];
check('the push is encrypted for the device (aes128gcm)', first?.coding === 'aes128gcm' && first.body.length > 86);
const firstPayload = await decryptPush(first.body).catch(() => null);
check('…and says a message arrived', firstPayload?.t === 'message');
check('…and for which account (its public key)', firstPayload?.p === carolPub);
const short = (tags) =>
  finalizeEvent({ kind: 1059, created_at: Math.floor(Date.now() / 1000), tags: [['p', carolPub], ['expiration', String(Math.floor(Date.now() / 1000) + 60)], ...tags], content: 'sealed' }, generateSecretKey());
await a.send(short([['t', 'call']]));
await wait(1500);
check('a ringing call notifies at once, and says it is a call', carolGot().length === 2 && (await decryptPush(carolGot()[1].body).catch(() => null))?.t === 'call');
await wait(3500);
await a.send(short([]));
await wait(1500);
check('other short-lived envelopes (the rest of a call) do not notify', carolGot().length === 2);

// One device (one push address) with two Tegami accounts: both are told, and turning
// one account off leaves the other on.
await wait(3500);
const dave = generateSecretKey();
const erin = generateSecretKey();
await trust(dave);
await trust(erin);
check('dave registers the shared device', (await register(dave, endpoint('/shared'))) === 204);
check('erin registers the same device', (await register(erin, endpoint('/shared'))) === 204);
for (const sk of [dave, erin]) {
  const x = await connect(sk);
  await x.send(wrapTo(sk, aliceKey, 'hello alice'));
  x.ws.close();
}
const sharedGot = () => received.filter((r) => r.path === '/shared').length;
await a.send(wrapTo(alice, getPublicKey(dave), 'to dave'));
await wait(1500);
check('a message to the first account reaches the shared device', sharedGot() === 1);
await a.send(wrapTo(alice, getPublicKey(erin), 'to erin'));
await wait(1500);
check('a message to the second account reaches it too', sharedGot() === 2);
check('erin turns notifications off on the shared device', (await register(erin, endpoint('/shared'), 'DELETE')) === 204);
await wait(3500);
await a.send(wrapTo(alice, getPublicKey(erin), 'to erin again'));
await a.send(wrapTo(alice, getPublicKey(dave), 'to dave again'));
await wait(1500);
check('…then only the first account is told', sharedGot() === 3);

// Messages close together: the first is told at once, the rest in one more push after
// the 3 seconds, with their number (n), so the device can count all of them.
await wait(3500);
const before = carolGot().length;
for (const word of ['one', 'two', 'three']) await a.send(wrapTo(alice, carolPub, word));
await wait(4500);
const burst = await Promise.all(carolGot().slice(before).map((r) => decryptPush(r.body).catch(() => null)));
check('three messages close together make two pushes', burst.length === 2);
check('…which tell of three messages together', burst.reduce((sum, d) => sum + (d?.n ?? 0), 0) === 3);

// A key registered without an invite never rings: the relay cannot tell whether the
// person counts it as a friend, and their app hides it from strangers.
await wait(3500);
const loner = generateSecretKey();
await registerKey(loner, { turnstile: 'dev-pass' });
const l = await connect(loner);
const beforeOpen = carolGot().length;
check('an open key writes to carol', (await l.send(wrapTo(loner, carolPub, 'from an open key'))) === true);
await wait(1500);
check('…and carol is not notified', carolGot().length === beforeOpen);
l.ws.close();

// t=quiet (a friend's new picture): kept for the person, but no push.
await wait(3500);
const beforeQuiet = carolGot().length;
const quietWrap = finalizeEvent(
  { kind: 1059, created_at: Math.floor(Date.now() / 1000), tags: [['p', carolPub], ['t', 'quiet']], content: 'sealed' },
  generateSecretKey(),
);
check('a quiet envelope is accepted', (await a.send(quietWrap)) === true);
await wait(1500);
check('…and rings nothing', carolGot().length === beforeQuiet);

// Strangers: a key the recipient has never written to rings once, then is held for 10 minutes.
await wait(3500);
const fred = generateSecretKey();
const gina = generateSecretKey();
const ginaPub = getPublicKey(gina);
await trust(fred);
await trust(gina);
check('gina registers a device', (await register(gina, endpoint('/gina'))) === 204);
const ginaGot = () => received.filter((r) => r.path === '/gina').length;
const f = await connect(fred);
const g = await connect(gina);
await f.send(wrapTo(fred, ginaPub, 'first'));
await wait(1500);
check('a stranger rings once', ginaGot() === 1);
await wait(3500);
await f.send(wrapTo(fred, ginaPub, 'second'));
await wait(1500);
check('…and is held for 10 minutes after that (the message is still stored)', ginaGot() === 1);
check('a short-lived call from the same stranger is accepted', (await f.send(short2(ginaPub, [['t', 'call']]))) === true);
await wait(1500);
check('…a first call rings (its own limit per kind)', ginaGot() === 2);
await wait(3500);
await f.send(short2(ginaPub, [['t', 'call']]));
await wait(1500);
check('…a second call is held too', ginaGot() === 2);
await g.send(wrapTo(gina, getPublicKey(fred), 'hi fred'));
await wait(3500);
await f.send(wrapTo(fred, ginaPub, 'third'));
await wait(1500);
check('after gina writes back, the same sender rings freely', ginaGot() === 3);
await wait(3500);
await f.send(wrapTo(fred, ginaPub, 'fourth'));
await wait(1500);
check('…again, with no 10 minute wait', ginaGot() === 4);
f.ws.close();
g.ws.close();

// At most STRANGER_PUSH_PER_HOUR (here 2, set by a test header) pushes an hour per recipient across strangers.
await wait(3500);
const hank = generateSecretKey();
const hankPub = getPublicKey(hank);
await trust(hank);
check('hank registers a device', (await register(hank, endpoint('/hank'))) === 204);
const hankGot = () => received.filter((r) => r.path === '/hank').length;
for (let i = 0; i < 3; i++) {
  const sk = generateSecretKey();
  await trust(sk);
  const x = await connect(sk, { 'X-Test-Push-Cap': '2' });
  await x.send(wrapTo(sk, hankPub, 'stranger ' + i));
  await wait(1500);
  x.ws.close();
  if (i === 1) check('two different strangers ring hank', hankGot() === 2);
  await wait(3500);
}
check('a third stranger within the hour is held', hankGot() === 2);

// Friends are limited too (the recipient can be made to write one line to anyone): per sender and recipient, and
// per recipient across friends. Test options lower the bursts to 1 (the real ones are 10 a minute and 300 an hour).
await wait(3500);
{
  const jack = generateSecretKey();
  const jackPub = getPublicKey(jack);
  await trust(jack);
  check('jack registers a device', (await register(jack, endpoint('/jack'))) === 204);
  const jackGot = () => received.filter((r) => r.path === '/jack').length;
  const j = await connect(jack);
  const ivy = generateSecretKey();
  const kate = generateSecretKey();
  await trust(ivy);
  await trust(kate);
  await j.send(wrapTo(jack, getPublicKey(ivy), 'hi ivy'));
  await j.send(wrapTo(jack, getPublicKey(kate), 'hi kate'));
  const i1 = await connect(ivy, { 'X-Test-Opts': JSON.stringify({ friendPair: 1 }) });
  const k1 = await connect(kate, { 'X-Test-Opts': JSON.stringify({ friendHour: 1 }) });
  await i1.send(wrapTo(ivy, jackPub, 'friend one'));
  await wait(1500);
  check('a friend (jack wrote to ivy) rings', jackGot() === 1);
  await wait(3500);
  await i1.send(wrapTo(ivy, jackPub, 'friend two'));
  await wait(1500);
  check('…the next message from the same friend is held once the one-minute limit for that pair is used (stored, not rung)', jackGot() === 1);
  await wait(3500);
  await k1.send(wrapTo(kate, jackPub, 'another friend'));
  await wait(1500);
  check('another friend rings (its own pair)', jackGot() === 2);
  await wait(3500);
  await k1.send(wrapTo(kate, jackPub, 'another friend again'));
  await wait(1500);
  check('…and is held once the one-hour limit for jack across all friends is used', jackGot() === 2);
  i1.ws.close();
  k1.ws.close();
  j.ws.close();
}

a.ws.close();
b.ws.close();
c.ws.close();
push.close();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
