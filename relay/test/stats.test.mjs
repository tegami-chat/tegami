// Tests for GET /stats. Usage: RELAY=ws://127.0.0.1:8787 node test/stats.test.mjs
import { createHash } from 'node:crypto';
import * as nip42 from 'nostr-tools/nip42';
import * as nip59 from 'nostr-tools/nip59';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import WebSocket from 'ws';

const RELAY = process.env.RELAY ?? 'ws://localhost:8787';
const BASE = RELAY.replace(/^ws/, 'http').replace(/\/$/, '');
let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures++;
};
const today = async () => {
  const body = await (await fetch(`${BASE}/stats`)).text();
  const day = new Date().toISOString().slice(0, 10);
  return { body, t: JSON.parse(body).days.find((d) => d.day === day) ?? { envelopes: 0, files: 0, file_bytes: 0, logins: 0, keys: 0 } };
};

function login(sk) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY);
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m[0] === 'AUTH') ws.send(JSON.stringify(['AUTH', finalizeEvent(nip42.makeAuthEvent(RELAY, m[1]), sk)]));
      if (m[0] === 'OK' && m[2] === true && !ws.ready) {
        ws.ready = true;
        resolve(ws);
      }
    });
  });
}
const sendAndWait = (ws, ev) =>
  new Promise((resolve) => {
    const on = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m[0] === 'OK' && m[1] === ev.id) {
        ws.off('message', on);
        resolve(m[2]);
      }
    };
    ws.on('message', on);
    ws.send(JSON.stringify(['EVENT', ev]));
  });

const before = (await today()).t;
const keys = [generateSecretKey(), generateSecretKey(), generateSecretKey()];
const sockets = [];
for (const k of keys) sockets.push(await login(k));
sockets.push(await login(keys[0])); // the same key again: one more login, not one more key

const to = getPublicKey(keys[1]);
for (let i = 0; i < 2; i++) {
  const rumor = nip59.createRumor({ kind: 14, content: `stats ${i}`, tags: [['p', to]] }, keys[0]);
  await sendAndWait(sockets[0], nip59.createWrap(nip59.createSeal(rumor, keys[0], to), to));
}
const file = Buffer.from(`stats file ${Math.random()}`);
const hash = createHash('sha256').update(file).digest('hex');
const auth = finalizeEvent(
  { kind: 24242, created_at: Math.floor(Date.now() / 1000), content: 'Upload', tags: [['t', 'upload'], ['x', hash], ['expiration', String(Math.floor(Date.now() / 1000) + 300)]] },
  keys[0],
);
await fetch(`${BASE}/upload`, { method: 'PUT', body: file, headers: { Authorization: 'Nostr ' + Buffer.from(JSON.stringify(auth)).toString('base64') } });
await new Promise((r) => setTimeout(r, 500));

const { body, t: after } = await today();
check(`logins counted (+${after.logins - before.logins})`, after.logins - before.logins === 4);
check(`different keys estimated (+${after.keys - before.keys}, expected about 3)`, after.keys - before.keys >= 2 && after.keys - before.keys <= 4);
check(`envelopes counted (+${after.envelopes - before.envelopes})`, after.envelopes - before.envelopes === 2);
check(`files counted (+${after.files - before.files}, +${after.file_bytes - before.file_bytes} bytes)`, after.files - before.files === 1 && after.file_bytes - before.file_bytes === file.length);
const pubkeys = keys.map((k) => getPublicKey(k));
check('stats contain no key', !pubkeys.some((p) => body.includes(p)) && !/[0-9a-f]{64}/.test(body));
check('stats say what is counted', JSON.parse(body).counted?.keys?.includes('HyperLogLog'));

for (const s of sockets) s.close();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
