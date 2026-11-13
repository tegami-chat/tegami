// End-to-end test against a running relay (default: wrangler dev on ws://localhost:8787).
// Usage: npm test    or    RELAY=wss://relay.tegami.chat npm test
import * as nip42 from 'nostr-tools/nip42';
import * as nip59 from 'nostr-tools/nip59';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import WebSocket from 'ws';
import { trust } from './join.mjs';


const RELAY = process.env.RELAY ?? 'ws://localhost:8787';
let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures++;
};

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY);
    const inbox = [];
    let waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      inbox.push(msg);
      waiters = waiters.filter((w) => !w(msg));
    });
    ws.on('error', reject);
    const next = (pred, ms = 3000) =>
      new Promise((res, rej) => {
        const hit = inbox.find(pred);
        if (hit) return res(hit);
        const t = setTimeout(() => rej(new Error('timeout')), ms);
        waiters.push((m) => (pred(m) ? (clearTimeout(t), res(m), true) : false));
      });
    ws.on('open', () => resolve({ ws, next, send: (m) => ws.send(JSON.stringify(m)) }));
  });
}

async function login(c, sk) {
  const [, challenge] = await c.next((m) => m[0] === 'AUTH');
  const ev = finalizeEvent(nip42.makeAuthEvent(RELAY, challenge), sk);
  c.send(['AUTH', ev]);
  const ok = await c.next((m) => m[0] === 'OK' && m[1] === ev.id);
  return ok[2];
}

const alice = generateSecretKey();
const bob = generateSecretKey();
const eve = generateSecretKey();
const bobPub = getPublicKey(bob);
for (const k of [alice, bob, eve]) await trust(k);

const a = await connect();
const b = await connect();
const e = await connect();

// Before login, reading and writing are refused.
e.send(['REQ', 'x', { kinds: [1059], '#p': [getPublicKey(eve)] }]);
check('REQ before login is refused', (await e.next((m) => m[0] === 'CLOSED' && m[1] === 'x'))[2].startsWith('auth-required'));

check('alice logs in', await login(a, alice));
check('bob logs in', await login(b, bob));
check('eve logs in', await login(e, eve));

// Bob subscribes to his own envelopes.
b.send(['REQ', 'mine', { kinds: [1059], '#p': [bobPub] }]);
await b.next((m) => m[0] === 'EOSE' && m[1] === 'mine');

// Eve tries to read Bob's envelopes and to read everything.
e.send(['REQ', 'spy', { kinds: [1059], '#p': [bobPub] }]);
check("eve cannot read bob's envelopes", (await e.next((m) => m[0] === 'CLOSED' && m[1] === 'spy'))[2].startsWith('restricted'));
e.send(['REQ', 'all', {}]);
check('eve cannot read everything', (await e.next((m) => m[0] === 'CLOSED' && m[1] === 'all'))[2].startsWith('restricted'));

// Alice sends Bob a gift-wrapped message.
const rumor = nip59.createRumor({ kind: 14, content: 'hello bob', tags: [['p', bobPub]] }, alice);
const wrap = nip59.createWrap(nip59.createSeal(rumor, alice, bobPub), bobPub);
a.send(['EVENT', wrap]);
check('relay accepts the wrap', (await a.next((m) => m[0] === 'OK' && m[1] === wrap.id))[2] === true);
const live = await b.next((m) => m[0] === 'EVENT' && m[1] === 'mine' && m[2].id === wrap.id);
check('bob receives it live', !!live);
check('bob can open it', nip59.unwrapEvent(live[2], bob).content === 'hello bob');

// Plain notes are refused.
const note = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'public post' }, alice);
a.send(['EVENT', note]);
check('kind 1 is refused', (await a.next((m) => m[0] === 'OK' && m[1] === note.id))[2] === false);

// A reconnecting Bob gets the stored envelope.
const b2 = await connect();
await login(b2, bob);
b2.send(['REQ', 'again', { kinds: [1059], '#p': [bobPub] }]);
const stored = await b2.next((m) => m[0] === 'EVENT' && m[1] === 'again' && m[2].id === wrap.id);
check('stored envelope is delivered later', !!stored);

// Envelopes with an expiration tag (NIP-40): refused when already expired, not handed
// out after they expire. Moving an account to another device uses a 10-minute envelope.
const timed = (exp) =>
  finalizeEvent({ kind: 1059, created_at: Math.floor(Date.now() / 1000), tags: [['p', bobPub], ['expiration', String(exp)]], content: 'sealed' }, generateSecretKey());
const late = timed(Math.floor(Date.now() / 1000) - 1);
a.send(['EVENT', late]);
const lateOk = await a.next((m) => m[0] === 'OK' && m[1] === late.id);
check('an already expired envelope is refused', lateOk[2] === false && String(lateOk[3]).includes('expired'));
const soon = timed(Math.floor(Date.now() / 1000) + 3);
a.send(['EVENT', soon]);
check('an envelope that expires later is accepted', (await a.next((m) => m[0] === 'OK' && m[1] === soon.id))[2] === true);
const b3 = await connect();
await login(b3, bob);
b3.send(['REQ', 'before', { kinds: [1059], '#p': [bobPub] }]);
check('it is handed out before it expires', !!(await b3.next((m) => m[0] === 'EVENT' && m[1] === 'before' && m[2].id === soon.id)));
await new Promise((r) => setTimeout(r, 4000));
b3.send(['REQ', 'after', { kinds: [1059], '#p': [bobPub] }]);
await b3.next((m) => m[0] === 'EOSE' && m[1] === 'after');
await new Promise((r) => setTimeout(r, 300));
const stale = await b3.next((m) => m[0] === 'EVENT' && m[1] === 'after' && m[2].id === soon.id, 500).catch(() => null);
check('it is not handed out after it expires', !stale);
b3.ws.close();

// One key sending far too fast is slowed down, after a normal burst goes through.
const flooder = generateSecretKey();
await trust(flooder);
const f = await connect();
await login(f, flooder);
const target = getPublicKey(generateSecretKey());
const wraps = Array.from({ length: 200 }, (_, i) =>
  nip59.createWrap(nip59.createSeal(nip59.createRumor({ kind: 14, content: `spam ${i}`, tags: [['p', target]] }, flooder), flooder, target), target),
);
for (const w of wraps) f.send(['EVENT', w]);
const answers = await Promise.all(wraps.map((w) => f.next((m) => m[0] === 'OK' && m[1] === w.id, 10000)));
const accepted = answers.filter((m) => m[2] === true).length;
const limited = answers.filter((m) => m[2] === false && String(m[3]).startsWith('rate-limited')).length;
check(`a burst is accepted (${accepted} of 200)`, accepted >= 110);
check(`a flood is slowed down (${limited} of 200 refused)`, limited >= 50 && accepted + limited === 200);

for (const c of [a, b, e, b2, f]) c.ws.close();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
