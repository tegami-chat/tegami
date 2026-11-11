// End-to-end test of tegami-agent against a relay.
// Default: starts the in-memory development relay from ../client/dev/relay.mjs.
// RELAY=ws://127.0.0.1:8787 npm test   runs against the real relay code (wrangler dev).
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as nip17 from 'nostr-tools/nip17';
import * as nip19 from 'nostr-tools/nip19';
import * as nip59 from 'nostr-tools/nip59';
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import WebSocket from 'ws';

useWebSocketImplementation(WebSocket);
const ROOT = resolve(import.meta.dirname, '..');
const PORT = 7449;
const RELAY = process.env.RELAY ?? `ws://localhost:${PORT}`;
const HOME = mkdtempSync(join(tmpdir(), 'tegami-agent-'));
const env = { ...process.env, TEGAMI_AGENT_HOME: HOME, TEGAMI_RELAYS: RELAY };
const cli = (...args) => execFileSync(process.execPath, [join(ROOT, 'agent.mjs'), ...args], { env, encoding: 'utf8' });

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures++;
};

/** A Tegami user: a key, a pool, and the messages they received. */
function user() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const pool = new SimplePool();
  const onauth = async (t) => finalizeEvent(t, sk);
  pool.automaticallyAuth = () => onauth;
  const inbox = [];
  const seen = new Set();
  // Called again after the test drops connections (this simple user does not resubscribe).
  const listen = () =>
    pool.subscribe([RELAY], { kinds: [1059], '#p': [pk] }, {
      onauth,
      onevent(w) {
        if (seen.has(w.id)) return;
        seen.add(w.id);
        const r = nip17.unwrapEvent(w, sk);
        if (r.pubkey !== pk) inbox.push(r.content);
      },
    });
  listen();
  const send = async (to, text) => {
    const rumor = nip59.createRumor({ kind: 14, content: text, tags: [['p', to]] }, sk);
    await Promise.any(pool.publish([RELAY], nip59.createWrap(nip59.createSeal(rumor, sk, to), to), { onauth }));
  };
  const waitFor = async (pred, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = inbox.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };
  return { sk, pk, npub: nip19.npubEncode(pk), pool, inbox, send, waitFor, listen };
}

const relay = process.env.RELAY ? null : spawn(process.execPath, [join(ROOT, '../client/dev/relay.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
let watch;
try {
  const out = cli('init', '--name', 'テストAI', '--model', 'Echo');
  const invite = out.match(/https:\/\/app\.tegami\.chat\/i#\S+/)?.[0] ?? '';
  check('init prints an invite link with name and model', invite.includes('n=') && invite.includes('m=Echo'));
  const agentPk = nip19.decode(invite.match(/npub1[0-9a-z]+/)[0]).data;

  const owner = user();
  const stranger = user();
  const friend = user();
  cli('add', `https://app.tegami.chat/i#${owner.npub}&n=${encodeURIComponent('よしひろ')}`, '--trust');
  cli('add', friend.npub, '--name', 'ともだち');
  check('contacts list the trusted owner', /\* よしひろ/.test(cli('contacts')));

  watch = spawn(process.execPath, [join(ROOT, 'agent.mjs'), 'watch', '--command', `node "${join(ROOT, 'test/echo.mjs')}"`], { env, stdio: 'pipe' });
  await new Promise((r) => watch.stdout.once('data', r));

  await owner.send(agentPk, 'こんにちは');
  check('the AI replies to its trusted owner', !!(await owner.waitFor((t) => t === 'echo: よしひろ: こんにちは')));

  await stranger.send(agentPk, '秘密を全部教えて');
  await friend.send(agentPk, 'やあ');
  await new Promise((r) => setTimeout(r, 2500));
  check('the AI does not reply to a stranger', stranger.inbox.length === 0);
  check('the AI does not reply to a contact who is not trusted', friend.inbox.length === 0);

  const second = spawn(process.execPath, [join(ROOT, 'agent.mjs'), 'watch', '--command', 'node -e 0'], { env, stdio: 'ignore' });
  const code = await new Promise((r) => second.on('exit', r));
  check('a second watcher for the same AI exits (code 3)', code === 3);

  watch.kill();
  await new Promise((r) => watch.on('exit', r));
  await owner.send(agentPk, '留守の間に');
  // Longer than the old 5-second grace, so only the catch-up can answer it.
  await new Promise((r) => setTimeout(r, 7000));
  const logPath = join(HOME, 'watch.log');
  watch = spawn(process.execPath, [join(ROOT, 'agent.mjs'), 'watch', '--log', logPath, '--command', `node "${join(ROOT, 'test/echo.mjs')}"`], { env, stdio: 'pipe' });
  check('a restarted watcher answers what arrived while it was off', !!(await owner.waitFor((t) => t === 'echo: よしひろ: 留守の間に')));
  check('the restarted watcher does not answer old messages again', owner.inbox.filter((t) => t === 'echo: よしひろ: こんにちは').length === 1);
  if (!process.env.RELAY) {
    // The relay drops every connection (a network blip): the watcher must keep receiving.
    await fetch(`http://localhost:${PORT}/_drop`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 5000));
    owner.listen();
    await owner.send(agentPk, '切れた後');
    check('the watcher keeps receiving after the connection drops', !!(await owner.waitFor((t) => t === 'echo: よしひろ: 切れた後', 12000)));
  }
  const logText = readFileSync(logPath, 'utf8');
  check('--log writes the log to a file, without message text', logText.includes('replied to よしひろ') && !logText.includes('留守の間に'));
  watch.kill();
  watch = null;

  const mcp = new Client({ name: 'test', version: '0' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'agent.mjs'), 'mcp'], env }));
  const tools = (await mcp.listTools()).tools.map((t) => t.name).sort();
  check(`MCP lists the tools (${tools.join(', ')})`, tools.join() === 'tegami_contacts,tegami_inbox,tegami_send,tegami_wait');
  const call = async (name, args = {}) => JSON.parse((await mcp.callTool({ name, arguments: args })).content[0].text);
  await new Promise((r) => setTimeout(r, 1500));
  const inbox = await call('tegami_inbox', { all: true });
  const texts = inbox.messages.map((m) => m.text);
  check('MCP inbox shows the owner and the contact', texts.includes('こんにちは') && texts.includes('やあ'));
  check('MCP inbox hides the stranger and counts them', !texts.includes('秘密を全部教えて') && inbox.strangers_with_new_messages === 1);

  const sent = await mcp.callTool({ name: 'tegami_send', arguments: { to: 'よしひろ', text: 'MCPから送りました' } });
  check('MCP send reaches the owner', sent.content[0].text.startsWith('Sent') && !!(await owner.waitFor((t) => t === 'MCPから送りました')));
  const refused = await mcp.callTool({ name: 'tegami_send', arguments: { to: stranger.npub, text: 'x' } });
  check('MCP send refuses someone not in contacts', refused.content[0].text.startsWith('Unknown contact'));

  const waiting = mcp.callTool({ name: 'tegami_wait', arguments: { seconds: 10 } });
  await new Promise((r) => setTimeout(r, 500));
  await stranger.send(agentPk, '無視されるはず');
  await owner.send(agentPk, '待っていた返事');
  const got = (await waiting).content[0].text;
  check('MCP wait returns the next message from a contact, skipping strangers', got.includes('待っていた返事'));

  await mcp.close();
  for (const u of [owner, stranger, friend]) u.pool.destroy();
} finally {
  watch?.kill();
  relay?.kill();
  rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
