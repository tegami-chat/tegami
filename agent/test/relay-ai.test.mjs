// The relay's AI limits from the agent's side (relay/src/ai.ts): the agent registers its key as
// an AI with its owner card, and when the relay refuses an envelope for its AI limit, the agent
// sends nothing more until that window is over.
// The first part needs nothing. The second part runs only with RELAY set to a fresh `wrangler dev`
// relay (DEV_LOCAL=1 and the test admin key in ADMIN_PUBKEYS, as relay/test/ai-limit.test.mjs):
//   RELAY=ws://127.0.0.1:8787 node test/relay-ai.test.mjs
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as nip59 from 'nostr-tools/nip59';
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import WebSocket from 'ws';

useWebSocketImplementation(WebSocket);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures++;
};

const RELAY = process.env.RELAY;
process.env.TEGAMI_RELAYS = RELAY ?? 'ws://127.0.0.1:1';
process.env.TEGAMI_SECRET_STORE = 'plain';
const newHome = () => (process.env.TEGAMI_AGENT_HOME = mkdtempSync(join(tmpdir(), 'tegami-relay-ai-')));
newHome();
const { Agent, aiLimitUntil } = await import('../lib.mjs');

// ---------- the reasons ----------
const t = 1_800_000_000;
check('a minute refusal holds back for a minute', aiLimitUntil('rate-limited: ai-minute: this AI sends too fast', t) === t + 60);
check("an AI's day holds back until the next UTC day", aiLimitUntil('rate-limited: ai-day: …', t) === (Math.floor(t / 86400) + 1) * 86400);
check("the owner's day too", aiLimitUntil("rate-limited: ai-owner-day: the owner's AIs …", t) === (Math.floor(t / 86400) + 1) * 86400);
check("a person's rate limit is not an AI limit", aiLimitUntil('rate-limited: slow down', t) === 0);

// ---------- holding back, with a stand-in relay ----------
{
  const a = new Agent('hold');
  a.init({ name: 'Hold', model: 'Fake' });
  let calls = 0;
  a.pool = { publish: () => [(calls++, Promise.reject(new Error('rate-limited: ai-minute: this AI sends too fast')))] };
  const told = [];
  a.aiLimitListeners.add((reason, until) => told.push({ reason, until }));
  const first = await a.publish([{ id: 'x' }]).catch((e) => e);
  check('a refusal for the AI limit fails with AI_LIMIT', first?.code === 'AI_LIMIT');
  check('…and is told once, with until when', told.length === 1 && told[0].until > Date.now() / 1000 + 50);
  const second = await a.publish([{ id: 'y' }]).catch((e) => e);
  check('the next send fails at once without asking the relay', second?.code === 'AI_LIMIT' && calls === 1 && told.length === 1);
  a.aiPausedUntil = 0;
  a.pool = { publish: () => [Promise.reject(new Error('rate-limited: slow down'))] };
  const other = await a.publish([{ id: 'z' }]).catch((e) => e);
  check('another refusal is passed on as it is and holds nothing back', other?.code !== 'AI_LIMIT' && !a.aiPaused());
}

// ---------- against a real relay ----------
if (!RELAY) {
  console.log('SKIP the real relay part (set RELAY to a fresh wrangler dev relay)');
} else {
  const { admin, register, trust } = await import('../../relay/test/join.mjs');
  const ownerSk = generateSecretKey();
  const ownerPk = getPublicKey(ownerSk);
  await trust(ownerSk);
  const card = (ai) =>
    finalizeEvent({ kind: 25070, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['p', ai], ['expiration', String(Math.floor(Date.now() / 1000) + 30 * 86400)]] }, ownerSk);

  // A card that arrives from the owner's app: the agent keeps it and tells the relay.
  newHome();
  const ai = new Agent('relay-a');
  ai.init({ name: 'A', model: 'Fake' });
  await trust(ai.secret);
  ai.addContact({ pubkey: ownerPk, name: 'owner', trusted: true });
  await ai.connect();
  check('before the card the relay does not take the key for an AI', (await register(ai.secret)).json?.ai === false);
  const pool = new SimplePool();
  const onauth = async (e) => finalizeEvent(e, ownerSk);
  pool.automaticallyAuth = () => onauth;
  const rumor = nip59.createRumor({ kind: 25070, content: JSON.stringify({ v: 1, card: card(ai.pubkey) }), tags: [['p', ai.pubkey]], created_at: Math.floor(Date.now() / 1000) }, ownerSk);
  await Promise.any(pool.publish([RELAY], nip59.createWrap(nip59.createSeal(rumor, ownerSk, ai.pubkey), ai.pubkey), { onauth }));
  let isAi = false;
  for (let i = 0; i < 40 && !isAi; i++) {
    await sleep(200);
    isAi = (await register(ai.secret)).json?.ai === true;
  }
  check('when the owner card arrives, the agent registers its key as an AI', isAi);

  // Sending until the relay's minute limit: the agent stops there.
  const told = [];
  ai.aiLimitListeners.add((reason) => told.push(reason));
  let sent = 0;
  let refusal = null;
  for (let i = 0; i < 31 && !refusal; i++) {
    const r = nip59.createRumor({ kind: 14, content: `m${i}`, tags: [['p', ownerPk]], created_at: Math.floor(Date.now() / 1000) }, ai.secret);
    try {
      await ai.publish([nip59.createWrap(nip59.createSeal(r, ai.secret, ownerPk), ownerPk)]);
      sent++;
    } catch (e) {
      refusal = e;
    }
  }
  check('the relay takes 30 envelopes from the AI in a minute', sent === 30);
  check('…then the agent gets AI_LIMIT and is told once', refusal?.code === 'AI_LIMIT' && told.length === 1 && told[0].startsWith('rate-limited: ai-minute'));
  check('…and holds back', ai.aiPaused());

  // A card kept from an earlier run: the agent tells the relay when it connects.
  newHome();
  const b = new Agent('relay-b');
  b.init({ name: 'B', model: 'Fake' });
  await trust(b.secret);
  b.addContact({ pubkey: ownerPk, name: 'owner', trusted: true });
  writeFileSync(join(b.dir, 'owner-card.json'), JSON.stringify({ at: Math.floor(Date.now() / 1000), card: card(b.pubkey) }));
  await b.connect();
  let bAi = false;
  for (let i = 0; i < 40 && !bAi; i++) {
    await sleep(200);
    bAi = (await register(b.secret)).json?.ai === true;
  }
  check('with a card kept from before, the agent registers as an AI when it connects', bAi);
  const list = await admin('ais', ownerPk);
  check('the relay counts both AI keys under the owner', Array.isArray(list.json) && list.json.length === 2);
  for (const x of [ai, b]) x.pool?.destroy?.();
  pool.destroy();
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
