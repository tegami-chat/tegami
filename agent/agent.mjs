#!/usr/bin/env node
// tegami-agent: puts an AI on your own computer into Tegami as a friend.
//
//   tegami-agent init [--name Claude] [--model "Anthropic Claude"]
//       Makes the AI's own Tegami key and prints its invite link.
//       Open the link in Tegami to add the AI as a friend.
//   tegami-agent add <your invite link> [--trust]
//       Adds you to the AI's contacts. --trust lets the watcher reply to you.
//   tegami-agent contacts | invite | send <name or link> <text>
//   tegami-agent watch [--command "<cmd>"]
//       Keeps running. Each message from a trusted contact is answered by the AI.
//       Default: Claude Code (`claude -p`), one conversation that continues over time.
//       --command: any program that reads the prompt on stdin and prints the reply.
//   tegami-agent mcp
//       MCP server over stdio, so Claude Code (or any MCP client) can read and send
//       Tegami messages during a conversation.
//
// Options: --agent <folder name> (default "claude") picks which AI friend to use.

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Agent, needsInit, parseInvite, shortId } from './lib.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, v && !v.startsWith('--') ? 2 : 1);
  return v && !v.startsWith('--') ? v : true;
};
const agentName = flag('agent') ?? 'claude';
const agent = new Agent(agentName);
const cmd = argv.shift();

const SYSTEM = [
  'あなたは Tegami というメッセージアプリの中で、持ち主の友達として返事をする AI です。',
  'あなたの返事は、そのまま1通のメッセージとして相手に送られます。',
  '前置きや見出しを付けず、話し言葉で短く返してください。',
].join('');

const commands = {
  init() {
    const name = flag('name');
    const model = flag('model');
    agent.init({ name: typeof name === 'string' ? name : undefined, model: typeof model === 'string' ? model : undefined });
    console.log(`AI friend: ${agent.profile.name}${agent.profile.model ? ` (${agent.profile.model})` : ''}`);
    console.log(`Folder:    ${agent.dir}`);
    console.log(`\nOpen this link in Tegami to add the AI as a friend:\n${agent.invite}`);
    console.log(`\nThen give the AI your own invite link:\n  tegami-agent add "<your invite link>" --trust`);
  },
  invite() {
    needsInit(agent);
    console.log(agent.invite);
  },
  add() {
    needsInit(agent);
    const trusted = !!flag('trust');
    const name = flag('name');
    const p = parseInvite(argv[0] ?? '');
    if (!p) throw new Error('Give an invite link or an npub.');
    const c = agent.addContact({ pubkey: p.pubkey, name: typeof name === 'string' ? name : p.name, trusted });
    console.log(`Added ${c.name}${c.trusted ? ' (the AI replies to this person)' : ''}`);
  },
  contacts() {
    needsInit(agent);
    for (const c of agent.contacts) console.log(`${c.trusted ? '*' : ' '} ${c.name}  ${c.pubkey}`);
  },
  async send() {
    needsInit(agent);
    const to = agent.contact(argv[0] ?? '');
    if (!to) throw new Error(`Unknown contact: ${argv[0]}`);
    await agent.send(to.pubkey, argv.slice(1).join(' '));
    console.log(`Sent to ${to.name}`);
    agent.close();
  },
  async watch() {
    needsInit(agent);
    const command = flag('command');
    await agent.connect();
    const started = Math.floor(Date.now() / 1000) - 5;
    const queue = [];
    let busy = false;
    agent.listeners.add((m) => {
      if (m.from === agent.pubkey || m.at < started || !agent.isTrusted(m.from)) return;
      // Groups: an AI joins a group only when every member agrees (not built yet), so no replies there.
      if (m.peer.includes(',')) return;
      if (agent.state.replied.includes(m.id)) return;
      queue.push(m);
      void drain();
    });
    async function drain() {
      if (busy) return;
      busy = true;
      while (queue.length) {
        const peer = queue[0].from;
        const batch = queue.filter((m) => m.from === peer);
        queue.splice(0, queue.length, ...queue.filter((m) => m.from !== peer));
        const name = agent.contacts.find((c) => c.pubkey === peer)?.name ?? shortId(peer);
        const prompt = batch.map((m) => `${name}: ${m.text}`).join('\n');
        try {
          const reply = typeof command === 'string' ? await runCommand(command, prompt) : await runClaude(prompt);
          if (reply.trim()) await agent.send(peer, reply.trim());
          log(`replied to ${name}`);
        } catch (e) {
          log(`could not reply to ${name}: ${e.message}`);
        }
        agent.state.replied = [...agent.state.replied, ...batch.map((m) => m.id)].slice(-1000);
        agent.saveState();
      }
      busy = false;
    }
    log(`${agent.profile.name} is listening. Trusted: ${agent.contacts.filter((c) => c.trusted).map((c) => c.name).join(', ') || 'nobody yet'}`);
  },
  async mcp() {
    needsInit(agent);
    const { startMcp } = await import('./mcp.mjs');
    await startMcp(agent);
  },
};

function log(text) {
  console.log(`[${new Date().toLocaleTimeString()}] ${text}`);
}

/** Runs a shell command line, feeding `input` on stdin. Resolves with the exit code and output. */
function run(commandLine, input, cwd) {
  return new Promise((resolve, reject) => {
    // One command line through the shell, so `claude` (claude.cmd on Windows) is found.
    const p = spawn(commandLine, { cwd, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('exit', (code) => resolve({ code, out, err }));
    p.stdin.end(input);
  });
}

async function runCommand(command, prompt) {
  const r = await run(command, prompt, agent.dir);
  if (r.code !== 0) throw new Error(r.err.trim() || `exit ${r.code}`);
  return r.out;
}

/** Claude Code, headless. One conversation continues across messages (the AI remembers). */
async function runClaude(prompt) {
  const work = join(agent.dir, 'work');
  mkdirSync(work, { recursive: true });
  // SYSTEM has no double quotes, so quoting it is safe in both cmd.exe and sh.
  let line = `claude -p --output-format json --append-system-prompt "${SYSTEM}"`;
  if (agent.state.claudeSession) line += ` --resume ${agent.state.claudeSession}`;
  const r = await run(line, prompt, work);
  let out;
  try {
    out = JSON.parse(r.out);
  } catch {
    throw new Error(r.err.trim() || r.out.trim() || `claude exited ${r.code}`);
  }
  if (out.session_id) {
    agent.state.claudeSession = out.session_id;
    agent.saveState();
  }
  if (out.is_error) throw new Error(String(out.result ?? 'Claude returned an error'));
  return String(out.result ?? '');
}

const fn = commands[cmd];
if (!fn) {
  console.log('Commands: init, invite, add, contacts, send, watch, mcp');
  process.exit(cmd ? 1 : 0);
}
Promise.resolve(fn()).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
