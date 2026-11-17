// AI keys at the relay (src/ai.ts): an AI registers with its owner card, and from then on the
// envelopes it publishes count against AI limits, per AI key and per owner.
// Usage (fresh relay: wrangler dev with DEV_LOCAL=1 and the test admin key in ADMIN_PUBKEYS):
//   RELAY=ws://127.0.0.1:8787 HTTP=http://127.0.0.1:8787 node test/ai-limit.test.mjs
import * as nip42 from 'nostr-tools/nip42';
import * as nip59 from 'nostr-tools/nip59';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import WebSocket from 'ws';

import { admin, register, trust } from './join.mjs';

const RELAY = process.env.RELAY ?? 'ws://localhost:8787';
let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

function connect(sk) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY);
    const inbox = [];
    ws.on('error', reject);
    ws.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));
    const next = async (pred, ms = 5000) => {
      for (let i = 0; i < ms / 10; i++) {
        const hit = inbox.find(pred);
        if (hit) return hit;
        await wait(10);
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
          return (await next((m) => m[0] === 'OK' && m[1] === wrap.id)).slice(2);
        },
      });
    });
  });
}
const wrapTo = (from, to, text) => nip59.createWrap(nip59.createSeal(nip59.createRumor({ kind: 14, content: text, tags: [['p', to]] }, from), from, to), to);
const card = (ownerSk, ai, { at = now(), until = at + 30 * 86400, p = ai } = {}) =>
  finalizeEvent({ kind: 25070, created_at: at, content: '', tags: [['p', p], ['expiration', String(until)]] }, ownerSk);

/** Sends `n` envelopes from `sk` to `to`; returns the replies in order. */
async function burst(sk, to, n) {
  const c = await connect(sk);
  const wraps = Array.from({ length: n }, (_, i) => wrapTo(sk, to, `m${i}`));
  const out = [];
  for (const w of wraps) out.push(await c.send(w));
  c.ws.close();
  return out;
}

const target = generateSecretKey();
const targetPub = getPublicKey(target);
await trust(target);

// ---------- registering as an AI ----------
const owner = generateSecretKey();
const ownerPub = getPublicKey(owner);
await trust(owner);
const ai = generateSecretKey();
const aiPub = getPublicKey(ai);

const unreg = await register(ai, { ai_card: card(owner, aiPub) });
check('a key that did not register cannot declare itself an AI', unreg.status === 403);
await trust(ai);
check('a registered key is not an AI until it says so', (await register(ai)).json?.ai === false);

const someone = generateSecretKey();
const forged = { ...card(someone, aiPub), pubkey: ownerPub };
check("a card signed by someone else in the owner's name is refused", (await register(ai, { ai_card: forged })).json?.error === 'ai-card-bad-signature');
const changed = card(owner, aiPub);
changed.tags = [['p', aiPub], ['expiration', String(now() + 9e8)]];
check('a card changed after signing is refused', (await register(ai, { ai_card: changed })).json?.error === 'ai-card-bad-signature');
check('a card that ran out is refused', (await register(ai, { ai_card: card(owner, aiPub, { at: now() - 31 * 86400 }) })).json?.error === 'ai-card-expired');
check('a card for another key is refused', (await register(ai, { ai_card: card(owner, aiPub, { p: targetPub }) })).json?.error === 'ai-card-other-key');
check('an AI cannot be its own owner', (await register(ai, { ai_card: card(ai, aiPub) })).json?.error === 'ai-card-self');
const stranger = generateSecretKey();
check('a card from an owner who never registered is refused', (await register(ai, { ai_card: card(stranger, aiPub) })).json?.error === 'ai-card-owner-not-member');
check('a card that is not a card is refused', (await register(ai, { ai_card: { kind: 1 } })).status === 400);
check('after all those, the key is still not an AI', (await register(ai)).json?.ai === false);

const ok = await register(ai, { ai_card: card(owner, aiPub) });
check('a good card from a registered owner makes the key an AI', ok.status === 200 && ok.json?.ai === true);
check('the same owner can send a new card', (await register(ai, { ai_card: card(owner, aiPub) })).status === 200);
const other = generateSecretKey();
await trust(other);
check('a card from another owner cannot move the AI', (await register(ai, { ai_card: card(other, aiPub) })).status === 409);
check('an AI stays an AI (asking again)', (await register(ai)).json?.ai === true);

// ---------- per minute: an AI key against a person's key ----------
const replies = await burst(ai, targetPub, 31);
check('an AI key sends 30 envelopes at once', replies.slice(0, 30).every(([ok]) => ok === true));
check('…and the 31st is refused with the AI limit', replies[30][0] === false && String(replies[30][1]).startsWith('rate-limited: ai-minute'));
const person = generateSecretKey();
await trust(person);
const personReplies = await burst(person, targetPub, 31);
check("a person's key sending the same 31 is not refused", personReplies.every(([ok]) => ok === true));

// ---------- per owner: two AI keys share one owner's day ----------
const owner2 = generateSecretKey();
const owner2Pub = getPublicKey(owner2);
await trust(owner2);
const lim = await admin('ai-limit', owner2Pub, { per_day: 40 });
check("the operator lowers one owner's daily AI total", lim.status === 200 && lim.json?.per_day === 40);
const a2 = generateSecretKey();
const b2 = generateSecretKey();
for (const k of [a2, b2]) {
  await trust(k);
  await register(k, { ai_card: card(owner2, getPublicKey(k)) });
}
const ra = await burst(a2, targetPub, 25);
check('the first AI sends 25', ra.every(([ok]) => ok === true));
const rb = await burst(b2, targetPub, 16);
check('the second AI sends 15 more (40 for the owner)', rb.slice(0, 15).every(([ok]) => ok === true));
check("…and the 16th is refused with the owner's day", rb[15][0] === false && String(rb[15][1]).startsWith('rate-limited: ai-owner-day'));

const list = await admin('ais', undefined);
const row = Array.isArray(list.json) ? list.json.find((r) => r.owner === owner2Pub) : null;
check('the operator sees the owner with two AI keys and the count', row?.ais === 2 && row?.today === 40 && row?.per_day === 40);
const mine = await admin('ais', owner2Pub);
check("the operator sees that owner's AI keys", Array.isArray(mine.json) && mine.json.length === 2);
const bad = await admin('ai-limit', owner2Pub, { per_day: -1 });
check('a negative limit is refused', bad.status === 400);

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
