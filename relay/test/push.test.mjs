// Web Push test against `wrangler dev` with .dev.vars (a throwaway VAPID key, DEV_PUSH=1).
// A small local server stands in for the push service.
// Usage: npm run dev (in another window), then  node test/push.test.mjs
import { createServer } from 'node:http';
import * as nip42 from 'nostr-tools/nip42';
import * as nip59 from 'nostr-tools/nip59';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import WebSocket from 'ws';

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
function connect(sk) {
  return new Promise((resolve) => {
    const ws = new WebSocket(RELAY);
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

// ---------- tests ----------
const alice = generateSecretKey();
const bob = generateSecretKey();
const bobPub = getPublicKey(bob);

const key = await (await fetch(`${HTTP}/push/key`)).json();
check('the relay publishes its push key', typeof key.key === 'string' && Buffer.from(key.key, 'base64url').length === 65);

check('registering without a signature is refused', (await register(bob, endpoint('/bob'), 'POST', { sign: false })) === 401);
check('an address that is not a push service is refused', (await register(bob, 'https://example.com/push')) === 400);
check('bob registers a device', (await register(bob, endpoint('/bob'))) === 204);

const a = await connect(alice);
const b = await connect(bob);
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
check('push keys that are not keys are refused', (await register(carol, endpoint('/carol'), 'POST', { keys: { p256dh: 'x', auth: 'y' } })) === 400);
check('carol registers a device with its keys', (await register(carol, endpoint('/carol'), 'POST', { keys: deviceKeys })) === 204);
const carolGot = () => received.filter((r) => r.path === '/carol');
await a.send(wrapTo(alice, carolPub, 'hello carol'));
await wait(1500);
const first = carolGot()[0];
check('the push is encrypted for the device (aes128gcm)', first?.coding === 'aes128gcm' && first.body.length > 86);
check('…and says a message arrived', (await decryptPush(first.body).catch(() => null))?.t === 'message');
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
check('dave registers the shared device', (await register(dave, endpoint('/shared'))) === 204);
check('erin registers the same device', (await register(erin, endpoint('/shared'))) === 204);
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

a.ws.close();
b.ws.close();
push.close();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
