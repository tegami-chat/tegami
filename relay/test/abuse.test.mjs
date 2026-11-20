// Limits against abuse, against a running relay (wrangler dev with DEV_LOCAL=1 or DEV_PUSH=1 in .dev.vars).
// Usage: npm run dev (in another window), then  node test/abuse.test.mjs
// Tests may pose as another address (X-Test-Ip) and ask for a small daily limit (X-Test-Limit); the relay
// honours both only in dev.
import { createHash, randomBytes } from 'node:crypto';
import * as nip42 from 'nostr-tools/nip42';
import * as nip59 from 'nostr-tools/nip59';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import WebSocket from 'ws';
import { HTTP, admin, register, trust } from './join.mjs';

const RELAY = process.env.RELAY ?? 'ws://localhost:8787';
let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
const sha256hex = (x) => createHash('sha256').update(x).digest('hex');

function connect(headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY, { headers: { 'X-Test-Ip': `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...headers } });
    const inbox = [];
    let waiters = [];
    let closed = null;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      inbox.push(msg);
      waiters = waiters.filter((w) => !w(msg));
    });
    ws.on('close', (code) => (closed = code));
    ws.on('error', reject);
    const next = (pred, ms = 5000) =>
      new Promise((res, rej) => {
        const hit = inbox.find(pred);
        if (hit) return res(hit);
        const t = setTimeout(() => rej(new Error('timeout')), ms);
        waiters.push((m) => (pred(m) ? (clearTimeout(t), res(m), true) : false));
      });
    ws.on('open', () => resolve({ ws, inbox, next, send: (m) => ws.send(JSON.stringify(m)), closedCode: () => closed }));
  });
}

async function login(c, sk) {
  const [, challenge] = await c.next((m) => m[0] === 'AUTH');
  const ev = finalizeEvent(nip42.makeAuthEvent(RELAY, challenge), sk);
  c.send(['AUTH', ev]);
  return (await c.next((m) => m[0] === 'OK' && m[1] === ev.id))[2];
}

const wrapTo = (from, to, text, extraTags = []) => {
  const w = nip59.createWrap(nip59.createSeal(nip59.createRumor({ kind: 14, content: text, tags: [['p', to]] }, from), from, to), to);
  if (!extraTags.length) return w;
  return finalizeEvent({ kind: 1059, created_at: nowSec(), tags: [['p', to], ...extraTags], content: 'sealed' }, generateSecretKey());
};
const sendAndWait = async (c, ev) => (await (c.send(['EVENT', ev]), c.next((m) => m[0] === 'OK' && m[1] === ev.id)));

// ---------- REQ: how many filters, how often ----------
{
  const k = generateSecretKey();
  await trust(k);
  const me = getPublicKey(k);
  const c = await connect();
  await login(c, k);
  const f = { kinds: [1059], '#p': [me] };
  c.send(['REQ', 'ten', ...Array(10).fill(f)]);
  check('a REQ with 10 filters is answered', !!(await c.next((m) => m[0] === 'EOSE' && m[1] === 'ten')));
  c.send(['REQ', 'eleven', ...Array(11).fill(f)]);
  const closed = await c.next((m) => m[0] === 'CLOSED' && m[1] === 'eleven');
  check('a REQ with 11 filters is refused', String(closed[2]).includes('too many filters'));

  const c2 = await connect();
  await login(c2, k);
  for (let i = 0; i < 80; i++) c2.send(['REQ', 'again', f]);
  await sleep(1500);
  const limited = c2.inbox.filter((m) => m[0] === 'CLOSED' && m[1] === 'again' && String(m[2]).startsWith('rate-limited')).length;
  const served = c2.inbox.filter((m) => m[0] === 'EOSE' && m[1] === 'again').length;
  check(`REQs come at a limited pace (${served} served, ${limited} refused of 80)`, served >= 30 && limited >= 20 && served + limited === 80);
  c.ws.close();
  c2.ws.close();
}

// ---------- AUTH: a connection may try only so often ----------
{
  const c = await connect();
  await c.next((m) => m[0] === 'AUTH');
  const bad = finalizeEvent(nip42.makeAuthEvent(RELAY, 'not-the-challenge'), generateSecretKey());
  for (let i = 0; i < 14; i++) c.send(['AUTH', bad]);
  await sleep(1000);
  const refused = c.inbox.filter((m) => m[0] === 'OK' && m[2] === false);
  check('failed logins are answered', refused.length >= 10);
  check('too many tries end with a refusal', refused.some((m) => String(m[3]).includes('too many login attempts')));
  check('…and the connection is closed', c.closedCode() === 4008);
}

// ---------- the same sender to the same recipient is limited per day, and not to oneself ----------
{
  const sender = generateSecretKey();
  const rcpt = generateSecretKey();
  await trust(sender);
  await trust(rcpt);
  const rp = getPublicKey(rcpt);
  const c = await connect({ 'X-Test-Limit': '4' });
  await login(c, sender);
  const results = [];
  for (let i = 0; i < 6; i++) results.push((await sendAndWait(c, wrapTo(sender, rp, `m${i}`)))[2]);
  check(`one sender can send only so many to one recipient a day (${results.filter(Boolean).length} of 6)`, results.slice(0, 4).every(Boolean) && !results[4] && !results[5]);
  const why = await sendAndWait(c, wrapTo(sender, rp, 'again'));
  check('…and is told why', String(why[3]).startsWith('rate-limited'));
  const other = generateSecretKey();
  await trust(other);
  check('the same sender can still write to someone else', (await sendAndWait(c, wrapTo(sender, getPublicKey(other), 'hi')))[2] === true);
  const own = [];
  for (let i = 0; i < 6; i++) own.push((await sendAndWait(c, wrapTo(sender, getPublicKey(sender), `own${i}`)))[2]);
  check('copies to oneself are not limited', own.every(Boolean));
  c.ws.close();
}

// ---------- recipients that are not registered ----------
{
  const sender = generateSecretKey();
  await trust(sender);
  const c = await connect();
  await login(c, sender);
  const nobody = getPublicKey(generateSecretKey());
  const plain = await sendAndWait(c, wrapTo(sender, nobody, 'to nobody'));
  check('an ordinary envelope to a key that is not registered is refused', plain[2] === false && String(plain[3]).startsWith('restricted'));
  const longLived = await sendAndWait(c, wrapTo(sender, nobody, 'x', [['expiration', String(nowSec() + 3600)]]));
  check('so is one that lives an hour', longLived[2] === false);
  const T = getPublicKey(generateSecretKey());
  const move = await sendAndWait(c, wrapTo(sender, T, 'x', [['expiration', String(nowSec() + 600)]]));
  check('a 10-minute envelope to a one-time key (moving an account) is accepted', move[2] === true);
  const more = [];
  for (let i = 0; i < 4; i++) more.push((await sendAndWait(c, wrapTo(sender, T, 'x', [['expiration', String(nowSec() + 600)]])))[2]);
  check(`only a few wait for a key that is not registered (${more.filter(Boolean).length} more of 4)`, more.filter(Boolean).length === 2 && !more[3]);
  const sent = [];
  for (let i = 0; i < 55; i++) sent.push((await sendAndWait(c, wrapTo(sender, getPublicKey(generateSecretKey()), 'x', [['expiration', String(nowSec() + 600)]])))[2]);
  check(`one key can reach only so many unregistered keys a day (${sent.filter(Boolean).length} of 55)`, sent.filter(Boolean).length < 55 && sent.filter(Boolean).length >= 40);
  c.ws.close();
}

// ---------- recovery backups: new ones per address ----------
{
  const ipA = `2001:db8:${randomBytes(2).toString('hex')}:1:aaaa::1`;
  const ipSame64 = ipA.replace('aaaa::1', 'bbbb::2');
  const put = async (ip) => {
    const sk = generateSecretKey();
    const id = randomBytes(32).toString('hex');
    const body = JSON.stringify({ v: 1, ct: 'x' });
    const url = `${HTTP}/backup/${id}`;
    const ev = finalizeEvent({ kind: 27235, created_at: nowSec(), content: '', tags: [['u', url], ['method', 'PUT'], ['payload', sha256hex(body)]] }, sk);
    return (await fetch(url, { method: 'PUT', headers: { 'X-Test-Ip': ip, Authorization: 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64') }, body })).status;
  };
  const statuses = [];
  for (let i = 0; i < 10; i++) statuses.push(await put(i % 2 ? ipA : ipSame64));
  check('10 new backups from one address are stored (two addresses of one IPv6 /64 count together)', statuses.every((s) => s === 204));
  check('the 11th new backup from that /64 is refused', (await put(ipA)) === 429);
  check('another address is not affected', (await put(`2001:db8:${randomBytes(2).toString('hex')}:9::1`)) === 204);
}

// ---------- files: a total per key per day ----------
{
  const sk = generateSecretKey();
  await trust(sk);
  const upload = async (n) => {
    const file = randomBytes(n);
    const hash = sha256hex(file);
    const ev = finalizeEvent({ kind: 24242, created_at: nowSec(), content: 'Upload', tags: [['t', 'upload'], ['x', hash], ['expiration', String(nowSec() + 300)]] }, sk);
    return (await fetch(`${HTTP}/upload`, { method: 'PUT', body: file, headers: { 'X-Test-Limit': '3000', 'X-Test-Ip': '10.9.9.9', Authorization: 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64') } })).status;
  };
  const a = await upload(1400);
  const b = await upload(1400);
  const c = await upload(1400);
  check(`a key can upload only so many bytes a day (${a}, ${b}, ${c})`, a === 200 && b === 200 && c === 429);
}

// ---------- the invite tree: stopping a key stops everyone below it ----------
{
  const chain = [generateSecretKey()];
  await trust(chain[0]);
  for (let i = 1; i <= 12; i++) {
    const code = (await register(chain[i - 1])).json?.code;
    const next = generateSecretKey();
    const r = await register(next, { invite: code });
    if (r.json?.via !== 'invite') throw new Error(`chain broke at ${i}: ${JSON.stringify(r)}`);
    chain.push(next);
  }
  const stopped = await admin('ban', getPublicKey(chain[0]), { invitees: true });
  check('banning with invitees reaches the whole tree down to 10 levels (11 keys)', stopped.status === 200 && stopped.json?.changed === 11);
  const state = async (k) => (await register(k)).status;
  check('a key 1 level down is stopped', (await state(chain[1])) === 403);
  check('a key 10 levels down is stopped', (await state(chain[10])) === 403);
  check('a key 11 levels down is not (the depth is bounded)', (await state(chain[11])) === 200);
  const undone = await admin('unban', getPublicKey(chain[0]), { invitees: true });
  check('unbanning with invitees undoes it down the tree', undone.json?.changed === 11 && (await state(chain[10])) === 200);
}

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
