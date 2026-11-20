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
  const backupMember = generateSecretKey();
  await trust(backupMember);
  const ipA = `2001:db8:${randomBytes(2).toString('hex')}:1:aaaa::1`;
  const ipSame64 = ipA.replace('aaaa::1', 'bbbb::2');
  const put = async (ip) => {
    const sk = generateSecretKey();
    const id = randomBytes(32).toString('hex');
    const body = JSON.stringify({ v: 1, ct: 'x' });
    const url = `${HTTP}/backup/${id}`;
    const sign = (key) => 'Nostr ' + Buffer.from(JSON.stringify(finalizeEvent({ kind: 27235, created_at: nowSec(), content: '', tags: [['u', url], ['method', 'PUT'], ['payload', sha256hex(body)]] }, key))).toString('base64');
    // A new backup carries a second signature by a registered account's key.
    return (await fetch(url, { method: 'PUT', headers: { 'X-Test-Ip': ip, Authorization: sign(sk), 'X-Tegami-Member': sign(backupMember) }, body })).status;
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

// ================= five holes in the relay's limits (2026-11-20) =================
// X-Test-Opts (DEV_LOCAL only) lowers limits for one connection, so a test need not send thousands.
const optsH = (o) => ({ 'X-Test-Opts': JSON.stringify(o) });
const bigTo = (to, n) => finalizeEvent({ kind: 1059, created_at: nowSec(), tags: [['p', to]], content: 'x'.repeat(n) }, generateSecretKey());
const hex4 = () => randomBytes(2).toString('hex');
const reqDone = (c, id) => c.next((m) => (m[0] === 'EOSE' || m[0] === 'CLOSED') && m[1] === id);
const eventsOf = (c, id) => c.inbox.filter((m) => m[0] === 'EVENT' && m[1] === id).map((m) => m[2]);

// ---------- 1. REQ: one answer is cut at a number of envelopes and bytes; the app reads the rest with until ----------
{
  const { catchUp } = await import('../../client/src/lib/catch-up.ts');
  const rk = generateSecretKey();
  await trust(rk);
  const me = getPublicKey(rk);
  const w = await connect();
  await login(w, rk);
  const sent = [];
  for (let i = 0; i < 12; i++) {
    const ev = wrapTo(rk, me, `m${i}`);
    await sendAndWait(w, ev);
    sent.push(ev.id);
  }
  const c = await connect(optsH({ rows: 5 }));
  await login(c, rk);
  const f = { kinds: [1059], '#p': [me] };
  c.send(['REQ', 'a', f]);
  await reqDone(c, 'a');
  const first = eventsOf(c, 'a');
  check(`one answer holds at most the allowed number of envelopes (${first.length} of 12, cap 5)`, first.length === 5);
  check('...newest first', first.every((e, i) => i === 0 || first[i - 1].created_at >= e.created_at));
  // The app's way of reading the rest (client/src/lib/catch-up.ts): ask again with until.
  let n = 0;
  const page = async (until) => {
    const id = `p${n++}`;
    c.send(['REQ', id, { ...f, until }]);
    const end = await reqDone(c, id);
    c.send(['CLOSE', id]);
    return { events: eventsOf(c, id).map((e) => ({ id: e.id, created_at: e.created_at })), closed: end[0] === 'CLOSED' ? end[2] : null };
  };
  const seen = new Set(first.map((e) => e.id));
  const added = await catchUp({ seen, oldest: Math.min(...first.map((e) => e.created_at)), page });
  check(`asking again with until reads the whole mailbox (${seen.size} of 12, ${added} more)`, seen.size === 12 && sent.every((id) => seen.has(id)));
  c.ws.close();

  // Bytes: an answer stops before it passes the byte limit (it always holds at least one).
  const bk = generateSecretKey();
  await trust(bk);
  const bp = getPublicKey(bk);
  const bw = await connect();
  await login(bw, bk);
  for (let i = 0; i < 6; i++) await sendAndWait(bw, bigTo(bp, 800));
  const bc = await connect(optsH({ bytes: 3000 }));
  await login(bc, bk);
  bc.send(['REQ', 'b', { kinds: [1059], '#p': [bp] }]);
  await reqDone(bc, 'b');
  const got = eventsOf(bc, 'b').length;
  check(`one answer stops before the byte limit (${got} of 6 envelopes of about 1 KB, limit 3,000)`, got >= 1 && got <= 3);
  bc.ws.close();

  // A key's budget of rows: reading the same mailbox again and again is refused, then allowed when it has filled up.
  const gk = generateSecretKey();
  await trust(gk);
  const gp = getPublicKey(gk);
  const gw = await connect();
  await login(gw, gk);
  for (let i = 0; i < 7; i++) await sendAndWait(gw, wrapTo(gk, gp, `g${i}`));
  const gc = await connect(optsH({ rows: 5, budget: 8 }));
  await login(gc, gk);
  const answers = [];
  for (let i = 0; i < 5; i++) {
    gc.send(['REQ', `g${i}`, { kinds: [1059], '#p': [gp] }]);
    answers.push(await reqDone(gc, `g${i}`));
  }
  const refused = answers.filter((m) => m[0] === 'CLOSED');
  check(`a key that has read a lot is refused for a while (${answers.map((m) => m[0]).join(', ')})`, answers[0][0] === 'EOSE' && refused.length >= 1 && String(refused[0][2]).startsWith('rate-limited'));
  await sleep(2500);
  gc.send(['REQ', 'later', { kinds: [1059], '#p': [gp] }]);
  check('...and is served again when the budget has filled up', (await reqDone(gc, 'later'))[0] === 'EOSE');
  gc.ws.close();

  // A filter too big to keep in the connection's state is refused cleanly.
  const hc = await connect();
  await login(hc, rk);
  const ids = Array.from({ length: 1500 }, () => randomBytes(32).toString('hex'));
  hc.send(['REQ', 'huge', { kinds: [1059], '#p': [me], ids }]);
  const huge = await reqDone(hc, 'huge');
  check('a REQ too big to keep is refused with a reason', huge[0] === 'CLOSED' && String(huge[2]).startsWith('error'));
  hc.send(['REQ', 'after', f]);
  check('...and the connection still works', !!(await reqDone(hc, 'after')));
  hc.send(['REQ', 'neg', { ...f, limit: -1 }]);
  check('a negative limit does not turn the limit off', !!(await reqDone(hc, 'neg')));
  hc.ws.close();
  w.ws.close();
  bw.ws.close();
  gw.ws.close();
}

// ---------- 2a. invites: a key that joined with an invite may invite only 3 a day ----------
{
  const root = generateSecretKey();
  await trust(root);
  const rootCode = (await register(root)).json?.code;
  const kid = generateSecretKey();
  check("a key joins with the root's invite", (await register(kid, { invite: rootCode })).json?.via === 'invite');
  const kidCode = (await register(kid)).json?.code;
  const outcomes = [];
  for (let i = 0; i < 4; i++) outcomes.push((await register(generateSecretKey(), { invite: kidCode })).json);
  check('a key that joined with an invite can invite 3 a day', outcomes.slice(0, 3).every((o) => o?.via === 'invite'));
  check('...and the fourth is refused (invite-used-up)', outcomes[3]?.error === 'invite-used-up');
  const more = [];
  for (let i = 0; i < 5; i++) more.push((await register(generateSecretKey(), { invite: rootCode })).json?.via);
  check('a root key (trusted by the operator) still invites more than 3 a day', more.every((v) => v === 'invite'));
}

// ---------- 2b. mailbox: envelopes from people the recipient has not written to take only part of it ----------
{
  const r = generateSecretKey();
  const s1 = generateSecretKey();
  const s2 = generateSecretKey();
  for (const k of [r, s1, s2]) await trust(k);
  const rp = getPublicKey(r);
  const c1 = await connect(optsH({ strangerBox: 3 }));
  const c2 = await connect(optsH({ strangerBox: 3 }));
  await login(c1, s1);
  await login(c2, s2);
  const res = [];
  for (let i = 0; i < 5; i++) res.push(await sendAndWait(c1, wrapTo(s1, rp, `s${i}`)));
  check(`only a few envelopes from people the recipient has not written to wait (${res.filter((m) => m[2]).length} of 5, limit 3)`, res.slice(0, 3).every((m) => m[2]) && !res[3][2] && !res[4][2]);
  check('...with a reason', String(res[3][3]).startsWith('rate-limited'));
  check('another stranger is refused too', (await sendAndWait(c2, wrapTo(s2, rp, 'me too')))[2] === false);
  const cr = await connect();
  await login(cr, r);
  check('the recipient writes to the first sender', (await sendAndWait(cr, wrapTo(r, getPublicKey(s1), 'hello')))[2] === true);
  check('then that sender (now a friend) can write again', (await sendAndWait(c1, wrapTo(s1, rp, 'friend now')))[2] === true);
  check('...while the other stranger still cannot', (await sendAndWait(c2, wrapTo(s2, rp, 'still me')))[2] === false);
  cr.send(['REQ', 'mine', { kinds: [1059], '#p': [rp] }]);
  await reqDone(cr, 'mine');
  check('the recipient reads all they were sent (3 strangers and 1 friend)', eventsOf(cr, 'mine').length === 4);
  for (const x of [c1, c2, cr]) x.ws.close();
}

// ---------- 2c. room: bytes saved per key and per invite tree a day; a nearly full relay turns away new keys ----------
{
  const s = generateSecretKey();
  const r = generateSecretKey();
  await trust(s);
  await trust(r);
  const rp = getPublicKey(r);
  const c = await connect(optsH({ senderBytes: 3000 }));
  await login(c, s);
  const res = [];
  for (let i = 0; i < 6; i++) res.push(await sendAndWait(c, bigTo(rp, 700)));
  const taken = res.filter((m) => m[2]).length;
  check(`one key can save only so many bytes a day (${taken} of 6 envelopes of about 1 KB, limit 3,000)`, taken >= 1 && taken <= 3 && !res[5][2]);
  check('...with a reason', String(res[5][3]).includes('too much saved today from this key'));
  c.ws.close();

  const root = generateSecretKey();
  await trust(root);
  const kid = generateSecretKey();
  await register(kid, { invite: (await register(root)).json?.code });
  const other = generateSecretKey();
  await trust(other);
  const o = optsH({ treeBytes: 2500 });
  const cr = await connect(o);
  const ck = await connect(o);
  const co = await connect(o);
  await login(cr, root);
  await login(ck, kid);
  await login(co, other);
  check('the root saves an envelope', (await sendAndWait(cr, bigTo(rp, 700)))[2] === true);
  check('a key it invited saves one', (await sendAndWait(ck, bigTo(rp, 700)))[2] === true);
  const third = await sendAndWait(cr, bigTo(rp, 700));
  check('the next one from the same invite tree is refused, whichever key sends it', third[2] === false && String(third[3]).includes('from this invite'));
  check('another tree is not affected', (await sendAndWait(co, bigTo(rp, 700)))[2] === true);
  for (const x of [cr, ck, co]) x.ws.close();

  const n = generateSecretKey();
  await trust(n);
  const cn = await connect(optsH({ dbSize: 1 }));
  await login(cn, n);
  const nearlyFull = await sendAndWait(cn, bigTo(rp, 100));
  check('when the relay is nearly full, a key made in the last 7 days is turned away', nearlyFull[2] === false && String(nearlyFull[3]).includes('nearly full'));
  const old = await connect(optsH({ dbSize: 1, newKeySeconds: 0 }));
  await login(old, n);
  check('...while a key that has been here longer is not', (await sendAndWait(old, bigTo(rp, 100)))[2] === true);
  cn.ws.close();
  old.ws.close();
}

// ---------- 4. addresses: an IPv6 block counts as a whole at the /48 and /32 level too ----------
{
  const id = randomBytes(32).toString('hex');
  const get = async (ip) => (await fetch(`${HTTP}/backup/${id}`, { headers: { 'X-Test-Ip': ip } })).status;
  // Reading a backup: 30 at once per /64, 120 per /48, 480 per /32.
  const a48 = `2a01:${hex4()}:${hex4()}`;
  let ok = 0;
  for (let b = 1; b <= 4; b++) for (let i = 0; i < 30; i++) if ((await get(`${a48}:${b}::1`)) !== 429) ok++;
  check(`four /64 blocks of one /48 get their 30 each (${ok} of 120)`, ok >= 120 && ok <= 124);
  // The /48 refills a little while the 120 are sent, so count a few more.
  const ok5 = (await Promise.all(Array.from({ length: 10 }, () => get(`${a48}:5::1`)))).filter((x) => x !== 429).length;
  check(`a fifth /64 block of the same /48 is mostly refused although it has used nothing (${ok5} of 10 got through)`, ok5 <= 5);
  const a32 = `2a02:${hex4()}`;
  let ok32 = 0;
  for (let e = 1; e <= 4; e++) for (let b = 1; b <= 4; b++) for (let i = 0; i < 30; i++) if ((await get(`${a32}:e${e}:${b}::1`)) !== 429) ok32++;
  check(`sixteen /64 blocks in four /48 blocks of one /32 are served (${ok32} of 480)`, ok32 >= 470);
  // Sixty at once from two fresh /64 blocks of a fresh /48: they would all be served if the /32 had its allowance.
  const e9 = await Promise.all(Array.from({ length: 60 }, (_, i) => get(`${a32}:e9:${1 + (i % 2)}::1`)));
  const okE9 = e9.filter((x) => x !== 429).length;
  check(`another /48 of the same /32 is mostly refused (${okE9} of 60 got through)`, okE9 <= 30);
  check('a different IPv6 /32 is not affected', (await get(`2a03:${hex4()}:${hex4()}:1::1`)) !== 429);
}

// ---------- 4b. the table of limits: used-up records are dropped last ----------
{
  const id = randomBytes(32).toString('hex');
  const put = async (ip, extra = {}) => (await fetch(`${HTTP}/backup/${id}`, { method: 'PUT', body: 'x', headers: { 'X-Test-Ip': ip, ...extra } })).status;
  // Writing a backup: 60 at once per address, one more every 10 seconds. The table is lowered to 100 records.
  const A = '10.88.0.1';
  let last = 0;
  for (let i = 0; i < 61; i++) last = await put(A, { 'X-Test-Table-Max': '100' });
  check('an address that has used up its allowance is refused', last === 429);
  for (let i = 0; i < 99; i++) await put(`10.88.1.${i + 1}`);
  // Wait for the other records to fill up again. A asks now and then: the relay forgets everything when it has been
  // left alone for a few seconds (the limits are kept in memory only), and A's request is refused, so it takes nothing.
  for (let i = 0; i < 11; i++) {
    await sleep(1000);
    await put(A);
  }
  for (let i = 0; i < 20; i++) await put(`10.88.2.${i + 1}`); // the table is full: it makes room
  // A refilled a little in the meantime (one request per 10 seconds). A fresh record would let all 10 through.
  let okA = 0;
  for (let i = 0; i < 10; i++) if ((await put(A)) !== 429) okA++;
  check(`when the table is full, the record of a used-up address is kept (${okA} of 10 got through)`, okA <= 4);
  await put('10.88.3.1', { 'X-Test-Table-Max': '0' }); // back to the real size
}

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
