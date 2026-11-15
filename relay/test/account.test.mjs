// Deleting an account (DELETE /account): everything the relay keeps under the key goes.
// Against `wrangler dev` with DEV_LOCAL=1 (or DEV_PUSH=1) and the test admin key in .dev.vars.
// Usage: RELAY=ws://127.0.0.1:8787 HTTP=http://127.0.0.1:8787 node test/account.test.mjs
import { createHash } from 'node:crypto';
import * as nip42 from 'nostr-tools/nip42';
import * as nip59 from 'nostr-tools/nip59';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import WebSocket from 'ws';
import { admin, register, signedPost, trust } from './join.mjs';

const RELAY = process.env.RELAY ?? 'ws://localhost:8787';
const HTTP = process.env.HTTP ?? RELAY.replace(/^ws/, 'http');
let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures++;
};
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A NIP-98 signed request with any method. */
async function signed(method, path, sk, text, { url } = {}) {
  const ev = finalizeEvent(
    { kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['u', url ?? `${HTTP}${path}`], ['method', method], ['payload', sha(text)]] },
    sk,
  );
  return fetch(`${HTTP}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64') }, body: text });
}
const deleteAccount = (sk, body = { delete: 'account' }, opts) => signed('DELETE', '/account', sk, JSON.stringify(body), opts);

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY);
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
    const next = (pred, ms = 3000) =>
      new Promise((res, rej) => {
        const hit = inbox.find(pred);
        if (hit) return res(hit);
        const t = setTimeout(() => rej(new Error('timeout')), ms);
        waiters.push((m) => (pred(m) ? (clearTimeout(t), res(m), true) : false));
      });
    ws.on('open', () => resolve({ ws, next, inbox, closed: () => closed, send: (m) => ws.send(JSON.stringify(m)) }));
  });
}
async function login(c, sk) {
  const [, challenge] = await c.next((m) => m[0] === 'AUTH');
  const ev = finalizeEvent(nip42.makeAuthEvent(RELAY, challenge), sk);
  c.send(['AUTH', ev]);
  return (await c.next((m) => m[0] === 'OK' && m[1] === ev.id))[2];
}
const wrapFor = (from, to, text) => {
  const rumor = nip59.createRumor({ kind: 14, content: text, tags: [['p', to]] }, from);
  return nip59.createWrap(nip59.createSeal(rumor, from, to), to);
};
async function publish(c, ev) {
  c.send(['EVENT', ev]);
  return c.next((m) => m[0] === 'OK' && m[1] === ev.id);
}
/** How many envelopes for me the relay hands out. */
async function mailbox(c, pub) {
  const id = `q${Math.random()}`;
  c.send(['REQ', id, { kinds: [1059], '#p': [pub] }]);
  await c.next((m) => m[0] === 'EOSE' && m[1] === id);
  return c.inbox.filter((m) => m[0] === 'EVENT' && m[1] === id).length;
}
function stampAuth(sk, hash, t = 'stamp') {
  const ev = finalizeEvent(
    { kind: 24242, created_at: Math.floor(Date.now() / 1000), content: t, tags: [['t', t], ['x', hash], ['expiration', String(Math.floor(Date.now() / 1000) + 300)]] },
    sk,
  );
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64');
}
const putStamp = (sk, body) => fetch(`${HTTP}/stamp`, { method: 'PUT', body, headers: { Authorization: stampAuth(sk, sha(body)) } });

const carol = generateSecretKey(); // the account that is deleted
const dave = generateSecretKey(); // a friend
const carolPub = getPublicKey(carol);
const davePub = getPublicKey(dave);
await trust(carol);
await trust(dave);

// What carol has on the relay before deleting.
const c = await connect();
const d = await connect();
check('carol logs in', await login(c, carol));
check('dave logs in', await login(d, dave));
for (let i = 0; i < 3; i++) check(`dave writes to carol (${i + 1})`, (await publish(d, wrapFor(dave, carolPub, `hi ${i}`)))[2] === true);
check('carol writes to dave', (await publish(c, wrapFor(carol, davePub, 'hello dave')))[2] === true);
check('carol has 3 envelopes waiting', (await mailbox(c, carolPub)) === 3);
const own = Buffer.from(`carol's stamp ${Math.random()}`.repeat(30));
const shared = Buffer.from(`a stamp both keep ${Math.random()}`.repeat(30));
check('carol keeps a stamp', (await putStamp(carol, own)).status === 200);
check('carol keeps a stamp dave also keeps', (await putStamp(carol, shared)).status === 200);
check('dave keeps the same stamp', (await putStamp(dave, shared)).status === 200);
const endpoint = `https://fcm.googleapis.com/fcm/send/test-${Math.random().toString(36).slice(2)}`;
check('carol turns on notifications', (await signed('POST', '/push', carol, JSON.stringify({ endpoint }))).status === 204);
const before = (await register(carol)).json;
check('carol is registered and has an invite code', before?.member === true && typeof before.code === 'string');
const invitee = generateSecretKey();
check('someone registers with carol\'s invite', (await register(invitee, { invite: before.code })).json?.via === 'invite');
check('dave reports carol (kept for the operator)', (await signedPost('/report', dave, { pubkey: carolPub, reason: 'spam' })).status === 204);

// Refused requests.
check('without a signature: 401', (await fetch(`${HTTP}/account`, { method: 'DELETE', body: JSON.stringify({ delete: 'account' }) })).status === 401);
check('a signature for another address: 401', (await deleteAccount(carol, undefined, { url: `${HTTP}/push` })).status === 401);
check('a body that does not ask to delete: 400', (await deleteAccount(carol, { delete: 'stamps' })).status === 400);
check('POST is not the delete route', !(await (await signed('POST', '/account', carol, JSON.stringify({ delete: 'account' }))).text()).includes('"deleted"'));
check('nothing was deleted by those', (await mailbox(c, carolPub)) === 3 && (await register(carol)).json?.member === true);

// Deleting.
const res = await deleteAccount(carol);
const out = res.status === 200 ? await res.json() : {};
check(`carol deletes her account (${res.status})`, res.status === 200 && out.deleted === true && out.already === false);
check('it says what went: 3 envelopes, 2 stamps, 1 notification address', out.envelopes === 3 && out.stamps === 2 && out.push === 1);
await wait(300);
check("carol's connection is closed", c.closed() === 4001);
check("carol's own stamp file is gone", (await fetch(`${HTTP}/stamp/${sha(own)}`)).status === 404);
check('the stamp dave also keeps stays for him', (await fetch(`${HTTP}/stamp/${sha(shared)}`)).status === 200);
const again = await register(carol);
check('carol is no longer registered and cannot register again', again.status === 403 && again.json?.error === 'deleted');
check('not with a Turnstile pass either', (await register(carol, { turnstile: 'dev-pass' })).json?.error === 'deleted');
check('not with an invite either', (await register(carol, { invite: (await register(dave)).json?.code })).json?.error === 'deleted');
check('her invite code no longer works', (await register(generateSecretKey(), { invite: before.code })).json?.error === 'invite-invalid');
check('she cannot turn notifications on again', (await signed('POST', '/push', carol, JSON.stringify({ endpoint }))).status === 403);
check('she cannot keep stamps', (await putStamp(carol, Buffer.from('new'.repeat(40)))).status === 403);
const c2 = await connect();
check('carol can still log in (nothing to read)', await login(c2, carol));
check('her mailbox is empty', (await mailbox(c2, carolPub)) === 0);
check('she cannot write', (await publish(c2, wrapFor(carol, davePub, 'still here?')))[2] === false);
const late = wrapFor(dave, carolPub, 'are you there?');
check('a message sent to her now is answered OK (the sender learns nothing)', (await publish(d, late))[2] === true);
check('…but not kept', (await mailbox(c2, carolPub)) === 0);
check("dave's envelope from carol is still his", (await mailbox(d, davePub)) >= 1);
const again2 = await deleteAccount(carol);
check('asking again answers the same (already deleted)', again2.status === 200 && (await again2.json()).already === true);
const reports = await admin('reports', carolPub);
check('the report about carol stays for the operator (90 days)', reports.status === 200 && reports.json?.reports?.length === 1);
const counts = await signedPost('/admin', (await import('./join.mjs')).ADMIN, { action: 'members' });
check('the operator counts deleted accounts', counts.status === 200 && counts.json?.deleted >= 1);

for (const x of [c, c2, d]) x.ws.close();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
