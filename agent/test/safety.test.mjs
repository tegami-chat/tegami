// The AI friend's safety rules (concerns 1, 7, 8, 9, 11 and 16 in the AI connection review):
// Claude Code without tools, what is kept and for how long, keys in the system's store,
// the daily limit, limits between two AIs, "do not let an AI read this", and stop / resume.
// Claude Code is replaced by test/fake-claude.mjs (put first on PATH), so nothing reaches an AI.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import * as nip17 from 'nostr-tools/nip17';
import * as nip19 from 'nostr-tools/nip19';
import * as nip59 from 'nostr-tools/nip59';
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import WebSocket from 'ws';

useWebSocketImplementation(WebSocket);
const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.RELAY_PORT || 7464);
const RELAY = `ws://localhost:${PORT}`;
const HTTP = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures++;
};
const throws = async (fn) => {
  try {
    await fn();
    return '';
  } catch (e) {
    return e.message;
  }
};

// ---------- a fake `claude` first on PATH ----------
const FAKE = mkdtempSync(join(tmpdir(), 'tegami-fake-claude-'));
// Copied next to the .cmd: cmd.exe reads a .cmd in the system code page, which would garble a
// project folder with Japanese in its name.
const fakeScript = join(FAKE, 'fake-claude.mjs');
writeFileSync(fakeScript, readFileSync(join(ROOT, 'test', 'fake-claude.mjs')));
writeFileSync(join(FAKE, 'claude.cmd'), `@"${process.execPath}" "${fakeScript}" %*\r\n`);
writeFileSync(join(FAKE, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`, { mode: 0o755 });
const CALLS = join(FAKE, 'calls.jsonl');
process.env.PATH = `${FAKE}${delimiter}${process.env.PATH}`;
process.env.FAKE_CLAUDE_LOG = CALLS;
const calls = () => (existsSync(CALLS) ? readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const resetCalls = () => rmSync(CALLS, { force: true });
const closed = (argv) => {
  const at = (f) => argv.indexOf(f);
  return argv[at('--tools') + 1] === '' && at('--tools') >= 0 && at('--strict-mcp-config') >= 0 && argv[at('--disallowedTools') + 1] === 'mcp__*' && Number(argv[at('--max-turns') + 1]) > 0;
};

const homes = [];
const newHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'tegami-safety-'));
  homes.push(h);
  return h;
};
/** A fresh copy of lib.mjs for one folder (it reads TEGAMI_AGENT_HOME when an Agent is made). */
const agentIn = async (dir) => {
  process.env.TEGAMI_AGENT_HOME = dir;
  const { Agent } = await import('../lib.mjs');
  return new Agent('x');
};

const relay = spawn(process.execPath, [join(ROOT, '../client/dev/relay.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
await sleep(800);
const procs = [];
try {
  const { claudeLine, loadKeys, makeResponder, saveBackend, saveKey } = await import('../backends.mjs');
  const lib = await import('../lib.mjs');

  // ---------- 1. Claude Code without tools ----------
  const D1 = newHome();
  const state = { lastRead: 0, replied: [] };
  const responder = (settings) => makeResponder({ dir: D1, config: { type: 'claude-code' }, system: 'SYS', draftSystem: 'DRAFT', state, saveState: () => {}, settings });
  resetCalls();
  await responder({})('こんにちは', { peer: 'a' });
  check('everyday replies call Claude Code with no tools, no MCP and a turn limit', closed(calls()[0].argv));
  check('the model Claude Code ran is written down for friends to see', JSON.parse(readFileSync(join(D1, 'model.json'), 'utf8')).model === 'claude-fake-1');
  check('the first reply starts a conversation that is kept', !calls()[0].argv.includes('--no-session-persistence') && state.claudeSession === 'session-1');
  await responder({})('2回目', { peer: 'a' });
  check('the next reply continues it', calls()[1].argv.join(' ').includes('--resume session-1'));
  await responder({ tools: true })('下書き', { draft: true });
  check('a draft has no tools even when the owner opened them, and keeps nothing', closed(calls()[2].argv) && calls()[2].argv.includes('--no-session-persistence'));
  await responder({ tools: true })('道具あり', { peer: 'a' });
  check('tools open only when the owner opens them', !calls()[3].argv.includes('--tools') && !calls()[3].argv.includes('--strict-mcp-config'));
  await responder({ remember: false })('覚えない', { peer: 'a' });
  check('remember off: --no-session-persistence, and the old conversation is not resumed', calls()[4].argv.includes('--no-session-persistence') && !calls()[4].argv.includes('--resume') && !state.claudeSession);
  state.claudeSession = 'old';
  state.claudeSessionAt = Math.floor(Date.now() / 1000) - 31 * 86400;
  await responder({ keepDays: 30 })('古い会話', { peer: 'a' });
  check('a conversation older than keepDays is not resumed', !calls()[5].argv.includes('--resume') && state.claudeSessionAt > Math.floor(Date.now() / 1000) - 60);
  check('the command line keeps the closed form', claudeLine({ system: 'S' }).includes('--tools "" --strict-mcp-config --disallowedTools "mcp__*" --max-turns'));

  // ---------- 9. what API backends keep ----------
  const D2 = newHome();
  const keep = (settings, prompt, peer = 'p') =>
    makeResponder({ dir: D2, config: { type: 'command' }, system: 'S', draftSystem: 'D', state: {}, saveState: () => {}, settings, command: `node "${join(ROOT, 'test/echo.mjs')}"` })(prompt, { peer });
  await keep({}, 'x');
  check('a --command responder writes no history', !existsSync(join(D2, 'history.json')));
  // history.json with an API backend (a fake server is not needed: an old entry is pruned on write).
  const old = Math.floor(Date.now() / 1000) - 40 * 86400;
  writeFileSync(join(D2, 'history.json'), JSON.stringify({ p: [{ role: 'user', text: '古い', at: old }, { role: 'assistant', text: '古い返事', at: old }], q: [{ role: 'user', text: '別の古い', at: old }] }));
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d)).on('end', () => {
      const j = JSON.parse(b);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: `n=${j.messages.length}` } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const api = (settings) => makeResponder({ dir: D2, config: { type: 'ollama', model: 'm', url: `http://127.0.0.1:${server.address().port}/v1` }, system: 'S', draftSystem: 'D', state: {}, saveState: () => {}, settings });
  const r1 = await api({ keepDays: 30 })('新しい', { peer: 'p' });
  const hist = JSON.parse(readFileSync(join(D2, 'history.json'), 'utf8'));
  check('turns older than keepDays are not sent to the AI', r1 === 'n=2');
  check('and are removed from history.json, for everyone', !JSON.stringify(hist).includes('古い') && !hist.q && hist.p.every((t) => t.at));
  rmSync(join(D2, 'history.json'));
  await api({ remember: false })('覚えない', { peer: 'p' });
  check('remember off: history.json is not written', !existsSync(join(D2, 'history.json')));
  server.close();

  // ---------- 11. settings ----------
  check('the daily limit cannot be 0', (await throws(() => lib.saveSettings(D2, { dailyReplies: 0 }))).includes('cannot be 0'));
  check('the daily limit cannot be unlimited', !!(await throws(() => lib.saveSettings(D2, { dailyReplies: 'none' }))));
  check('the daily limit is 50 by default', lib.loadSettings(newHome()).dailyReplies === 50);

  // ---------- 11. two AIs ----------
  const D3 = newHome();
  const a3 = await agentIn(D3);
  a3.init({ name: 'A' });
  const otherAi = bytesToHex(generateSecretKey()).padStart(64, '0');
  a3.state.peerAis[otherAi] = { until: Math.floor(Date.now() / 1000) + 3600, limit: 100 };
  a3.saveState();
  let why = '';
  for (let i = 0; i < 7; i++) why = a3.aiTalkCheck(otherAi);
  check('more than 6 messages a minute with another AI pause the talk', why.includes('Too many messages'));
  check('send refuses while paused', (await throws(() => a3.send(otherAi, 'x'))).includes('Too many'));
  a3.state.aiTalk[otherAi] = { times: [], chain: 20, pausedUntil: 0 };
  a3.saveState();
  check('20 messages in a row with no person stepping in stop the talk', (await throws(() => a3.send(otherAi, 'x'))).includes('no person stepped in'));
  a3.setStopped(false);
  check('resume lets the two AIs talk again', a3.aiTalkCheck(otherAi, { count: false }) === '');

  // ---------- 16. a permission taken back by another program stays taken back ----------
  const b3 = await agentIn(D3);
  check('two programs see the same permission', !!b3.peerGrant(otherAi) && !!a3.peerGrant(otherAi));
  delete b3.state.peerAis[otherAi];
  b3.saveState();
  a3.state.lastRead = 123; // the other program saves something of its own afterwards
  a3.saveState();
  const c3 = await agentIn(D3);
  check('a program that saved later does not bring the permission back', !c3.peerGrant(otherAi) && c3.state.lastRead === 123);
  await sleep(600);
  check('and it sees the permission is gone', !a3.peerGrant(otherAi));

  // ---------- 8. keys in the system's store ----------
  const D4 = newHome();
  const hex = bytesToHex(generateSecretKey());
  writeFileSync(join(D4, 'key.json'), JSON.stringify({ secretHex: hex }));
  writeFileSync(join(D4, 'keys.json'), JSON.stringify({ openai: 'sk-test-ABCDEFGHIJKLMNOP' }));
  const storeOk = process.platform === 'win32';
  if (storeOk) {
    process.env.TEGAMI_SECRET_STORE = 'dpapi';
    const a4 = await agentIn(D4);
    const file = readFileSync(join(D4, 'key.json'), 'utf8');
    check('a plain key.json is moved into the store at start', !file.includes(hex) && JSON.parse(file).store === 'dpapi' && a4.pubkey === getPublicKey(Buffer.from(hex, 'hex')));
    const a4b = await agentIn(D4);
    check('the key opens again from the store', bytesToHex(a4b.secret) === hex);
    check('a plain keys.json is moved into the store too', loadKeys(D4).openai === 'sk-test-ABCDEFGHIJKLMNOP' && !readFileSync(join(D4, 'keys.json'), 'utf8').includes('sk-test'));
    saveKey(D4, 'gemini', 'gm-test-1234567890');
    check('a new API key is kept encrypted', !readFileSync(join(D4, 'keys.json'), 'utf8').includes('gm-test') && loadKeys(D4).gemini === 'gm-test-1234567890');
    process.env.TEGAMI_SECRET_STORE = 'plain';
  } else console.log('SKIP the system store test runs on Windows only');

  // ---------- end to end: the watcher, through a relay ----------
  const HOME = newHome();
  const env = { ...process.env, TEGAMI_AGENT_HOME: HOME, TEGAMI_RELAYS: RELAY, TEGAMI_SECRET_STORE: 'plain' };
  const cli = (...args) => execFileSync(process.execPath, [join(ROOT, 'agent.mjs'), ...args], { env, encoding: 'utf8' });
  const ai = nip19.decode(cli('init', '--name', 'テストAI').match(/npub1[0-9a-z]+/)[0]).data;

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
        if (r.pubkey !== pk) inbox.push(r.content);
      },
    });
    const say = async (kind, content, tags = []) => {
      const rumor = nip59.createRumor({ kind, content, tags: [['p', ai], ...tags] }, sk);
      await Promise.any(pool.publish([RELAY], nip59.createWrap(nip59.createSeal(rumor, sk, ai), ai), { onauth }));
    };
    const waitFor = async (pred, ms = 8000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (inbox.some(pred)) return true;
        await sleep(100);
      }
      return false;
    };
    return { sk, pk, npub: nip19.npubEncode(pk), pool, inbox, say, send: (t, tags) => say(14, t, tags), waitFor };
  };
  const owner = user();
  const friend = user();
  for (const u of [owner, friend]) await fetch(`${HTTP}/_trust`, { method: 'POST', body: JSON.stringify({ pubkey: u.pk }) });
  const code = (await (async () => {
    const text = '{}';
    const url = `${HTTP}/register`;
    const auth = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['u', url], ['method', 'POST'], ['payload', createHash('sha256').update(text).digest('hex')]] }, owner.sk);
    return (await fetch(url, { method: 'POST', headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString('base64')}` }, body: text })).json();
  })()).code;
  cli('add', `https://app.tegami.chat/i#${owner.npub}&n=${encodeURIComponent('テストA')}&c=${code}`, '--trust');
  cli('add', friend.npub, '--name', 'ともだち');
  cli('setting', 'dailyReplies', '3');

  resetCalls();
  let out = '';
  const watch = spawn(process.execPath, [join(ROOT, 'agent.mjs'), 'watch'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(watch);
  watch.stdout.on('data', (d) => (out += d));
  while (!out.includes('is listening')) await sleep(100);
  check('the watcher says where its records are kept', /Records: .*keep 30 days/.test(out));
  check('the watcher does not say tools are open when they are not', !out.includes('道具を使える状態'));

  await owner.send('1通目');
  check('the watcher answers the owner', await owner.waitFor((t) => t === 'fake: テストA: 1通目'));
  check('the watcher called Claude Code with no tools', calls().length === 1 && closed(calls()[0].argv));

  // A message its writer kept from AIs: not answered, and its words are not kept.
  await owner.send('AIに見せないで', [['noai']]);
  await sleep(2000);
  check('a message tagged noai is not handed to the AI', !calls().some((c) => c.prompt.includes('AIに見せないで')));
  check("and its words are not written down", !readFileSync(join(HOME, 'messages.json'), 'utf8').includes('AIに見せないで'));

  // A contact whose profile card says "no AI": their words are not shown through MCP even when opened.
  await friend.say(10100, JSON.stringify({ avatar: null, noai: true }));
  await sleep(500);
  await friend.send('友だちの文');
  await sleep(1500);
  check('a contact who chose "no AI" in their profile card: their words are not kept', !readFileSync(join(HOME, 'messages.json'), 'utf8').includes('友だちの文'));

  // 16. Stop from someone who is not the owner: ignored. From the owner: no replies until resume.
  await friend.say(25069, JSON.stringify({ stop: true }));
  await sleep(1000);
  check('a stop from someone who is not the owner is ignored', !existsSync(join(HOME, 'stop.json')));
  await owner.say(25069, JSON.stringify({ v: 1, stop: true, at: Math.floor(Date.now() / 1000) }));
  await sleep(1500);
  check("the owner's stop is written down", JSON.parse(readFileSync(join(HOME, 'stop.json'), 'utf8')).stopped === true);
  check('the watcher says it stopped', out.includes('stopped by the owner'));
  resetCalls();
  await owner.send('止まっている間');
  await sleep(2500);
  check('stopped: no reply, and the AI is not even asked', !owner.inbox.includes('fake: テストA: 止まっている間') && calls().length === 0);
  check('stopped: tegami-agent send refuses', (() => {
    try {
      cli('send', 'テストA', 'x');
      return false;
    } catch (e) {
      return String(e.stderr).includes('Stopped by your owner');
    }
  })());
  await owner.say(25069, JSON.stringify({ v: 1, stop: false, at: Math.floor(Date.now() / 1000) }));
  await sleep(1500);
  await owner.send('再開後');
  check("after the owner's resume the AI answers again", await owner.waitFor((t) => t === 'fake: テストA: 再開後'));
  check('what came while stopped is not answered later', !owner.inbox.includes('fake: テストA: 止まっている間'));

  // Stopped while the AI is writing: the reply is not sent.
  cli('setting', 'dailyReplies', '10');
  process.env.FAKE_CLAUDE_DELAY = '3000';
  watch.kill();
  await new Promise((r) => watch.on('exit', r));
  const env2 = { ...env, FAKE_CLAUDE_DELAY: '3000' };
  out = '';
  const watch2 = spawn(process.execPath, [join(ROOT, 'agent.mjs'), 'watch'], { env: env2, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(watch2);
  watch2.stdout.on('data', (d) => (out += d));
  while (!out.includes('is listening')) await sleep(100);
  await owner.send('書いている途中');
  await sleep(1200);
  cli('stop');
  await sleep(4000);
  check('a stop while the AI is writing keeps the reply from being sent', !owner.inbox.includes('fake: テストA: 書いている途中'));
  cli('resume');
  watch2.kill();
  await new Promise((r) => watch2.on('exit', r));
  delete process.env.FAKE_CLAUDE_DELAY;

  // 11. The daily limit: the owner is told once.
  cli('setting', 'dailyReplies', '1');
  const sentToday = JSON.parse(readFileSync(join(HOME, 'state.json'), 'utf8')).sendCount;
  check('messages sent today are counted per chat', Object.values(sentToday).some((c) => c.n >= 1));
  const day = new Date().toISOString().slice(0, 10);
  const st = JSON.parse(readFileSync(join(HOME, 'state.json'), 'utf8'));
  st.sendCount = { [owner.pk]: { day, n: 0 } };
  writeFileSync(join(HOME, 'state.json'), JSON.stringify(st));
  out = '';
  const watch3 = spawn(process.execPath, [join(ROOT, 'agent.mjs'), 'watch'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(watch3);
  watch3.stdout.on('data', (d) => (out += d));
  while (!out.includes('is listening')) await sleep(100);
  await owner.send('上限1');
  check('within the limit the AI answers', await owner.waitFor((t) => t === 'fake: テストA: 上限1'));
  resetCalls();
  await owner.send('上限2');
  check('over the limit the owner is told once', await owner.waitFor((t) => t.includes('上限の1通に達した')));
  check('over the limit the AI is not asked', calls().length === 0 && !owner.inbox.includes('fake: テストA: 上限2'));
  await owner.send('上限3');
  await sleep(2500);
  check('the owner is told only once a day', owner.inbox.filter((t) => t.includes('上限の1通に達した')).length === 1);
  watch3.kill();
  // The limit holds for every way of sending (tegami-agent send, the MCP server), not only the watcher.
  check('send refuses past the daily limit too', (() => {
    try {
      cli('send', 'ともだち', '1通目');
      cli('send', 'ともだち', '2通目');
      return false;
    } catch (e) {
      return String(e.stderr).includes("Today's limit of 1");
    }
  })());

  // 1. Tools opened by the owner: the watcher says so.
  cli('setting', 'tools', 'on');
  out = '';
  const watch4 = spawn(process.execPath, [join(ROOT, 'agent.mjs'), 'watch'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(watch4);
  watch4.stdout.on('data', (d) => (out += d));
  while (!out.includes('is listening')) await sleep(100);
  check('with tools opened, the watcher says so', out.includes('道具を使える状態で動いています'));
  watch4.kill();

  for (const u of [owner, friend]) u.pool.destroy();
} finally {
  for (const p of procs) p.kill();
  relay.kill();
  await sleep(300);
  for (const h of [...homes, FAKE]) rmSync(h, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
