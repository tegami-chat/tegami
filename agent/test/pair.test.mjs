// Pairing by QR code (`tegami-agent pair`), end to end through the development relay, and a
// watcher that answers with an API backend (a stand-in OpenAI server on this computer).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as nip17 from 'nostr-tools/nip17';
import * as nip19 from 'nostr-tools/nip19';
import * as nip44 from 'nostr-tools/nip44';
import * as nip59 from 'nostr-tools/nip59';
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import WebSocket from 'ws';

useWebSocketImplementation(WebSocket);
const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.RELAY_PORT || process.env.PORT || 7449);
const RELAY = `ws://localhost:${PORT}`;
const HTTP = `http://localhost:${PORT}`;
const HOME = mkdtempSync(join(tmpdir(), 'tegami-agent-'));
const env = { ...process.env, TEGAMI_AGENT_HOME: HOME, TEGAMI_RELAYS: RELAY };

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Tegami user who can answer a pairing code like the app does (client/src/lib/ai-pair.ts). */
function user(name) {
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
      if (r.pubkey !== pk && r.kind === 14) inbox.push(r.content);
    },
  });
  const publish = (w) => Promise.any(pool.publish([RELAY], w, { onauth }));
  const pair = async (ai, code, invite) => {
    const rumor = nip59.createRumor({ kind: 25068, content: JSON.stringify({ v: 1, code, invite }), tags: [['p', ai]] }, sk);
    const now = Math.floor(Date.now() / 1000);
    const seal = nip59.createSeal(rumor, sk, ai);
    const k = generateSecretKey();
    await publish(
      finalizeEvent({ kind: 1059, created_at: now, tags: [['p', ai], ['expiration', String(now + 600)]], content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(k, ai)) }, k),
    );
  };
  const send = async (to, text) => {
    const rumor = nip59.createRumor({ kind: 14, content: text, tags: [['p', to]] }, sk);
    await publish(nip59.createWrap(nip59.createSeal(rumor, sk, to), to));
  };
  const waitFor = async (pred, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = inbox.find(pred);
      if (hit) return hit;
      await sleep(100);
    }
    return null;
  };
  return { sk, pk, npub: nip19.npubEncode(pk), name, pool, pair, send, waitFor, link: (code) => `https://app.tegami.chat/i#${nip19.npubEncode(pk)}&n=${encodeURIComponent(name)}${code ? `&c=${code}` : ''}` };
}
async function inviteCode(sk) {
  const text = '{}';
  const url = `${HTTP}/register`;
  const auth = finalizeEvent(
    { kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['u', url], ['method', 'POST'], ['payload', createHash('sha256').update(text).digest('hex')]] },
    sk,
  );
  return (await (await fetch(url, { method: 'POST', headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString('base64')}` }, body: text })).json()).code;
}

/** Runs a command and collects what it prints. */
function start(args) {
  const p = spawn(process.execPath, [join(ROOT, 'agent.mjs'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = '';
  p.stdout.on('data', (d) => (p.out += d));
  p.stderr.on('data', (d) => (p.out += d));
  p.done = new Promise((r) => p.on('exit', r));
  p.waitOut = async (s, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !p.out.includes(s)) await sleep(100);
    return p.out.includes(s);
  };
  return p;
}

// The stand-in for an OpenAI-style server (Ollama, llama.cpp ...) on this computer.
const seen = [];
const api = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d)).on('end', () => {
    const json = JSON.parse(body);
    seen.push(json);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: `local: ${json.messages[json.messages.length - 1].content}` } }] }));
  });
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));

const relay = spawn(process.execPath, [join(ROOT, '../client/dev/relay.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
// Wait until it answers (the relay of the previous test may still be closing on this port).
for (let i = 0; i < 50; i++) {
  if (await fetch(`${HTTP}/_members`).then((r) => r.ok, () => false)) break;
  await sleep(200);
}
const procs = [];
try {
  const owner = user('テストA');
  const stranger = user('しらない');
  for (const u of [owner, stranger]) await fetch(`${HTTP}/_trust`, { method: 'POST', body: JSON.stringify({ pubkey: u.pk }) });
  const ownerCode = await inviteCode(owner.sk);

  const pair = start(['pair', '--name', 'ローカルAI', '--minutes', '2']);
  procs.push(pair);
  check('pair prints a QR code and the link with a one-time code', await pair.waitOut('&p='));
  check('the QR code is drawn in the terminal', /[█▀▄]{10}/.test(pair.out));
  const link = pair.out.match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0];
  const code = link.match(/&p=([a-z2-7]{16})/)?.[1];
  const ai = nip19.decode(link.match(/npub1[0-9a-z]+/)[0]).data;
  check('the link carries the name and the model', link.includes(`n=${encodeURIComponent('ローカルAI')}`) && link.includes('m=Anthropic%20Claude'));
  check('the code itself is not kept on disk (only its hash)', !readFileSync(join(HOME, 'pair.json'), 'utf8').includes(code));
  await sleep(1000);

  await owner.pair(ai, 'aaaaaaaaaaaaaaaa', owner.link(ownerCode));
  check('a wrong code is ignored', await pair.waitOut('wrong code'));
  await stranger.pair(ai, code, owner.link(ownerCode));
  check("the right code with someone else's invite link is ignored", await pair.waitOut("not the sender's"));
  await owner.pair(ai, code, owner.link(ownerCode));
  check('the right code pairs the owner', await pair.waitOut('Paired with テストA'));
  check('the AI registers with the code in the owner\'s link', await pair.waitOut('Registered with the Tegami relay'));
  check('pair exits when done', (await pair.done) === 0);
  const contacts = JSON.parse(readFileSync(join(HOME, 'contacts.json'), 'utf8'));
  check('the owner is a trusted contact, named from their link', contacts.length === 1 && contacts[0].pubkey === owner.pk && contacts[0].trusted && contacts[0].name === 'テストA');
  check('the code is used up', !existsSync(join(HOME, 'pair.json')));

  // A watcher answering with a model on this computer (the OpenAI chat API).
  const set = start(['backend', 'local', '--model', 'tiny', '--url', `http://127.0.0.1:${api.address().port}/v1`]);
  await set.done;
  check('backend local: shown as the model', set.out.includes('Shown as: tiny (local)'));
  const watch = start(['watch']);
  procs.push(watch);
  check('the watcher starts', await watch.waitOut('is listening'));
  // The same code again, from someone who saw the QR code: too late.
  await stranger.pair(ai, code, stranger.link());
  await owner.send(ai, 'こんにちは');
  check('the watcher answers the owner with the local model', !!(await owner.waitFor((t) => t === 'local: テストA: こんにちは')));
  check('the model got the instructions and the message', seen[0]?.model === 'tiny' && seen[0].messages[0].role === 'system');
  await stranger.send(ai, 'ねえ');
  await sleep(2500);
  check('a used code does not make anyone else trusted', JSON.parse(readFileSync(join(HOME, 'contacts.json'), 'utf8')).every((c) => c.pubkey !== stranger.pk));
  check('the stranger gets no reply', !(await stranger.waitFor(() => true, 500)) && seen.length === 1);

  // A pairing code answered while the watcher runs: the watcher pairs too.
  const { Agent } = await import(`../lib.mjs?home=${Date.now()}`);
  process.env.TEGAMI_AGENT_HOME = HOME;
  const local = new Agent('x');
  const second = local.startPairing(120);
  const friend = user('テストB');
  await fetch(`${HTTP}/_trust`, { method: 'POST', body: JSON.stringify({ pubkey: friend.pk }) });
  await friend.pair(ai, second.code, friend.link(await inviteCode(friend.sk)));
  check('a running watcher accepts a pairing too', await watch.waitOut('Paired with テストB'));
  await friend.send(ai, 'はじめまして');
  check('and then answers that person right away', !!(await friend.waitFor((t) => t === 'local: テストB: はじめまして')));
  check('each person starts their own conversation', seen.at(-1).messages.length === 2);
  const trustedNow = () => JSON.parse(readFileSync(join(HOME, 'contacts.json'), 'utf8')).filter((c) => c.trusted).map((c) => c.pubkey);
  await stranger.pair(ai, second.code, stranger.link());
  await sleep(2500);
  check('the code the watcher used works only once', !trustedNow().includes(stranger.pk));

  // Someone trusted by another command (add) while the watcher runs is answered without a restart.
  const later = user('あとから');
  await fetch(`${HTTP}/_trust`, { method: 'POST', body: JSON.stringify({ pubkey: later.pk }) });
  await start(['add', later.link(), '--trust']).done;
  await sleep(500);
  await later.send(ai, 'よろしく');
  check('a running watcher sees contacts trusted by another command', !!(await later.waitFor((t) => t === 'local: あとから: よろしく')));

  // Expiry, without waiting minutes: the time is passed in.
  const third = local.startPairing(60, 1000);
  const late = local.acceptPair({ pubkey: owner.pk, content: JSON.stringify({ v: 1, code: third.code, invite: owner.link() }) }, 1061);
  check('an expired code is refused and removed', !late.ok && late.reason.includes('expired') && !existsSync(join(HOME, 'pair.json')));
  for (const u of [owner, stranger, friend, later]) u.pool.destroy();
} finally {
  for (const p of procs) p.kill();
  relay.kill();
  api.close();
  await sleep(300);
  rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
