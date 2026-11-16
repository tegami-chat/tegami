// The owner's signature on the AI's key (concern 4): the owner's app hands the AI a card signed by
// the owner's key, the AI carries it on every message it writes as itself, and the app of anyone
// who gets such a message checks it (client/src/lib/ai-owner.ts) and shows whose AI it is.
// Claude Code is replaced by test/fake-claude.mjs, so nothing reaches an AI.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import * as nip17 from 'nostr-tools/nip17';
import * as nip19 from 'nostr-tools/nip19';
import * as nip59 from 'nostr-tools/nip59';
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import WebSocket from 'ws';

useWebSocketImplementation(WebSocket);
const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.RELAY_PORT || 7466);
const RELAY = `ws://localhost:${PORT}`;
const HTTP = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures++;
};

// The app's side of the card (TypeScript, read by Node with its types stripped).
const owner_ = await import('../../client/src/lib/ai-owner.ts');
const { OWNER_CARD_KIND, checkOwnerCard, ownerCardTemplate, ownerOfMessage } = owner_;
const lib = await import('../lib.mjs');

// ---------- the card itself ----------
const ownerSk = generateSecretKey();
const ownerPk = getPublicKey(ownerSk);
const aiSk = generateSecretKey();
const aiPk = getPublicKey(aiSk);
const now = Math.floor(Date.now() / 1000);
const card = finalizeEvent(ownerCardTemplate(aiPk, now), ownerSk);
check('the agent and the app use the same kind', lib.OWNER_CARD_KIND === OWNER_CARD_KIND);
check("a card signed by the owner's key checks out in the app", checkOwnerCard(card, aiPk)?.pubkey === ownerPk);
check('and in the agent', !!lib.checkOwnerCard(card, aiPk, ownerPk));
check('the agent does not take a card signed by someone other than its owner', !lib.checkOwnerCard(finalizeEvent(ownerCardTemplate(aiPk, now), generateSecretKey()), aiPk, ownerPk));
check('a card for another AI does not count', checkOwnerCard(card, getPublicKey(generateSecretKey())) === null);
check('a card whose owner was changed after signing does not count', checkOwnerCard({ ...card, pubkey: getPublicKey(generateSecretKey()) }, aiPk) === null);
check('a card whose time limit was stretched after signing does not count', checkOwnerCard({ ...card, tags: [['p', aiPk], ['expiration', String(now + 9e8)]] }, aiPk) === null);
check('a card that ran out does not count', checkOwnerCard(card, aiPk, now + 31 * 86400) === null);
check('an AI cannot sign itself as its own owner', checkOwnerCard(finalizeEvent(ownerCardTemplate(aiPk, now), aiSk), aiPk) === null);
check('broken text is not a card', checkOwnerCard('{nope', aiPk) === null);
const tag = lib.aiTag(aiPk, { model: 'M', name: 'AI' }, card);
check("a message's 'ai' tag with the card gives the owner", ownerOfMessage([tag], aiPk)?.pubkey === ownerPk);
check("an 'ai' tag with no card says no owner now", ownerOfMessage([lib.aiTag(aiPk, { model: 'M', name: 'AI' })], aiPk) === 'none');
check("an 'ai' tag with a bad card changes nothing", ownerOfMessage([['ai', aiPk, 'M', 'AI', '{"kind":1}']], aiPk) === undefined);
check("an AI writing in someone else's name says nothing about owners", ownerOfMessage([tag], ownerPk) === undefined);

// ---------- end to end: through a relay ----------
const FAKE = mkdtempSync(join(tmpdir(), 'tegami-fake-claude-'));
const fakeScript = join(FAKE, 'fake-claude.mjs');
writeFileSync(fakeScript, readFileSync(join(ROOT, 'test', 'fake-claude.mjs')));
writeFileSync(join(FAKE, 'claude.cmd'), `@"${process.execPath}" "${fakeScript}" %*\r\n`);
writeFileSync(join(FAKE, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`, { mode: 0o755 });
process.env.PATH = `${FAKE}${delimiter}${process.env.PATH}`;
const HOME = mkdtempSync(join(tmpdir(), 'tegami-owner-'));

const relay = spawn(process.execPath, [join(ROOT, '../client/dev/relay.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
await sleep(800);
let watch;
try {
  const env = { ...process.env, TEGAMI_AGENT_HOME: HOME, TEGAMI_RELAYS: RELAY, TEGAMI_SECRET_STORE: 'plain' };
  const cli = (...args) => execFileSync(process.execPath, [join(ROOT, 'agent.mjs'), ...args], { env, encoding: 'utf8' });
  const ai = nip19.decode(cli('init', '--name', 'テストAI', '--model', 'Fake').match(/npub1[0-9a-z]+/)[0]).data;

  const user = () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const pool = new SimplePool();
    const onauth = async (t) => finalizeEvent(t, sk);
    pool.automaticallyAuth = () => onauth;
    const inbox = [];
    pool.subscribe([RELAY], { kinds: [1059], '#p': [pk] }, {
      onauth,
      onevent(w) {
        const r = nip17.unwrapEvent(w, sk);
        if (r.pubkey !== pk) inbox.push(r);
      },
    });
    const say = async (kind, content, at = Math.floor(Date.now() / 1000)) => {
      const rumor = nip59.createRumor({ kind, content, tags: [['p', ai]], created_at: at }, sk);
      await Promise.any(pool.publish([RELAY], nip59.createWrap(nip59.createSeal(rumor, sk, ai), ai), { onauth }));
    };
    const waitFor = async (pred, ms = 8000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const r = inbox.find(pred);
        if (r) return r;
        await sleep(100);
      }
      return null;
    };
    return { sk, pk, npub: nip19.npubEncode(pk), pool, inbox, say, waitFor };
  };
  const owner = user();
  const friend = user();
  const stranger = user();
  for (const u of [owner, friend, stranger]) await fetch(`${HTTP}/_trust`, { method: 'POST', body: JSON.stringify({ pubkey: u.pk }) });
  const text = '{}';
  const url = `${HTTP}/register`;
  const auth = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['u', url], ['method', 'POST'], ['payload', createHash('sha256').update(text).digest('hex')]] }, owner.sk);
  const code = (await (await fetch(url, { method: 'POST', headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString('base64')}` }, body: text })).json()).code;
  cli('add', `https://app.tegami.chat/i#${owner.npub}&n=${encodeURIComponent('テストA')}&c=${code}`, '--trust');
  cli('add', friend.npub, '--name', 'ともだち');
  cli('setting', 'dailyReplies', '20');

  let out = '';
  watch = spawn(process.execPath, [join(ROOT, 'agent.mjs'), 'watch'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  watch.stdout.on('data', (d) => (out += d));
  while (!out.includes('is listening')) await sleep(100);

  const sendAndRead = async (words) => {
    cli('send', 'ともだち', words);
    return friend.waitFor((r) => r.kind === 14 && r.content === words);
  };
  const cardFile = join(HOME, 'owner-card.json');
  const waitFile = async (pred) => {
    for (let i = 0; i < 40; i++) {
      if (existsSync(cardFile) && pred(JSON.parse(readFileSync(cardFile, 'utf8')))) return true;
      await sleep(100);
    }
    return false;
  };

  const before = await sendAndRead('署名の前');
  check('before any card, the AI says no owner on its messages', ownerOfMessage(before?.tags ?? [], ai) === 'none');

  // Someone who is not the owner cannot give the AI a card, even one signed by their own key.
  const fake = finalizeEvent(ownerCardTemplate(ai), stranger.sk);
  await stranger.say(OWNER_CARD_KIND, JSON.stringify({ v: 1, card: fake }));
  await sleep(1200);
  check("a card from someone who is not the owner is not kept", !existsSync(cardFile));

  const signed = finalizeEvent(ownerCardTemplate(ai), owner.sk);
  await owner.say(OWNER_CARD_KIND, JSON.stringify({ v: 1, card: signed }));
  check("the owner's card is kept", await waitFile((d) => d.card?.id === signed.id));
  const after = await sendAndRead('署名の後');
  const said = ownerOfMessage(after?.tags ?? [], ai);
  check("the friend's app reads the owner from the AI's message", said !== 'none' && said?.pubkey === owner.pk);

  // An older word than the kept card changes nothing.
  await owner.say(OWNER_CARD_KIND, JSON.stringify({ v: 1, card: null }), Math.floor(Date.now() / 1000) - 3600);
  await sleep(1200);
  check('an older "no card" does not take the card away', JSON.parse(readFileSync(cardFile, 'utf8')).card?.id === signed.id);

  // The owner takes the mark away: the AI stops carrying the card.
  await sleep(1100);
  await owner.say(OWNER_CARD_KIND, JSON.stringify({ v: 1, card: null }));
  check('the owner takes the card back', await waitFile((d) => d.card === null));
  const taken = await sendAndRead('取り消しの後');
  check('after that, the AI says no owner on its messages', ownerOfMessage(taken?.tags ?? [], ai) === 'none');

  for (const u of [owner, friend, stranger]) u.pool.destroy();
} finally {
  watch?.kill();
  relay.kill();
  await sleep(300);
  for (const h of [HOME, FAKE]) rmSync(h, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
