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
//       --log <file>: also write the log to a file (used when started at login).
//       Only one watcher runs per AI friend; a second one exits (code 3).
//       Messages that arrived while the watcher was off (up to a day) are answered.
//   tegami-agent autostart on | off | status
//       Windows: a Task Scheduler task runs `keep`, hidden, every time you sign in.
//   tegami-agent keep [--log <file>]
//       Runs `watch` and starts it again 10 seconds after it stops.
//   tegami-agent mcp
//       MCP server over stdio, so Claude Code (or any MCP client) can read and send
//       Tegami messages during a conversation.
//
// Options: --agent <folder name> (default "claude") picks which AI friend to use.

import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, needsInit, parseInvite, shortId } from './lib.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const DAY = 86400;
let logFile = null;

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
  async add() {
    needsInit(agent);
    const trusted = !!flag('trust');
    const name = flag('name');
    const p = parseInvite(argv[0] ?? '');
    if (!p) throw new Error('Give an invite link or an npub.');
    const c = agent.addContact({ pubkey: p.pubkey, name: typeof name === 'string' ? name : p.name, trusted });
    console.log(`Added ${c.name}${c.trusted ? ' (the AI replies to this person)' : ''}`);
    // The relay only takes messages from registered keys. An invite link carries its
    // owner's invite code (&c=); the AI registers with it, as invited by that person.
    if (p.code) {
      const r = await agent.register({ invite: p.code }).catch((e) => ({ member: false, error: e.message }));
      if (r.member && !r.inviteError) console.log('Registered with the Tegami relay (invited by this person).');
      else if (!r.member) console.log(`Could not register with the relay: ${r.error ?? 'unknown'}. Ask for a new invite link.`);
    }
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
    const logTo = flag('log');
    if (typeof logTo === 'string') logFile = logTo;
    if (!takeLock()) {
      log('another watcher is already running for this AI friend');
      process.exit(3);
    }
    process.on('uncaughtException', (e) => {
      log(`stopped: ${e.stack ?? e.message}`);
      process.exit(1);
    });
    // Answer what arrived while the watcher was off (the PC was shut down), up to a day back.
    const now = Math.floor(Date.now() / 1000);
    const started = agent.state.alive ? Math.max(agent.state.alive - 60, now - DAY) : now - 5;
    const beat = () => {
      agent.state.alive = Math.floor(Date.now() / 1000);
      agent.saveState();
    };
    beat();
    setInterval(beat, 60_000);
    const queue = [];
    const seen = new Set();
    let busy = false;
    const consider = (m) => {
      if (m.from === agent.pubkey || m.at < started || !agent.isTrusted(m.from)) return;
      // Groups: an AI joins a group only when every member agrees (not built yet), so no replies there.
      if (m.peer.includes(',')) return;
      if (agent.state.replied.includes(m.id) || seen.has(m.id)) return;
      seen.add(m.id);
      queue.push(m);
      void drain();
    };
    // Not registered: replies would be refused by the relay. Say so (the log) and keep going.
    agent
      .register()
      .then((r) => {
        if (!r.member) log('not registered with the relay: replies will be refused. Run: tegami-agent add "<your invite link>" --trust');
      })
      .catch(() => {});
    // Listen before connecting: the relay hands over waiting messages right after login.
    agent.listeners.add(consider);
    await agent.connect();
    // Messages saved earlier (by `send` or the MCP server) but never answered.
    for (const m of agent.messages) consider(m);
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
  autostart() {
    needsInit(agent);
    const action = argv[0] ?? 'status';
    if (process.platform !== 'win32') {
      throw new Error('autostart is only built for Windows so far. Run `watch` under launchd (macOS) or systemd (Linux).');
    }
    const logPath = join(agent.dir, 'watch.log');
    const task = `Tegami agent ${agentName}`;
    // The first version put a script in the Startup folder; it vanished around a Windows upgrade.
    const legacy = join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `tegami-agent-${agentName}.vbs`);
    rmSync(legacy, { force: true });
    const schtasks = (...args) => execFileSync('schtasks', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const exists = () => {
      try {
        schtasks('/Query', '/TN', task);
        return true;
      } catch {
        return false;
      }
    };
    if (action === 'on') {
      const xml = join(agent.dir, 'task.xml');
      writeFileSync(xml, '﻿' + taskXml(logPath), 'utf16le');
      try {
        schtasks('/Create', '/TN', task, '/XML', xml, '/F');
      } finally {
        rmSync(xml, { force: true });
      }
      // Start it now too, so there is no need to sign out and in.
      if (!runningPid(keepLockFile())) schtasks('/Run', '/TN', task);
      console.log(`On. ${agent.profile.name} starts hidden every time you sign in (Task Scheduler: "${task}").`);
      console.log(`Log: ${logPath}`);
    } else if (action === 'off') {
      if (exists()) schtasks('/Delete', '/TN', task, '/F');
      let stopped = false;
      for (const pid of [runningPid(keepLockFile()), runningPid()]) {
        if (!pid) continue;
        try {
          execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
          stopped = true;
        } catch {
          // already gone
        }
      }
      console.log(`Off. ${agent.profile.name} no longer starts at sign-in${stopped ? ', and the running watcher was stopped' : ''}.`);
    } else if (action === 'status') {
      const pid = runningPid();
      console.log(`Starts at sign-in: ${exists() ? 'yes' : 'no'}`);
      console.log(`Running now:       ${pid ? `yes (process ${pid})` : 'no'}`);
      if (agent.state.alive) console.log(`Last heartbeat:    ${new Date(agent.state.alive * 1000).toLocaleString()}`);
      if (existsSync(logPath)) {
        const tail = readFileSync(logPath, 'utf8').trimEnd().split('\n').slice(-5);
        console.log(`\nLast log lines (${logPath}):\n${tail.join('\n')}`);
      }
    } else {
      throw new Error('Use: autostart on | off | status');
    }
  },
  async keep() {
    // Runs the watcher and starts it again 10 seconds after it stops, unless another
    // watcher is already running (exit code 3). Task Scheduler starts this at sign-in.
    needsInit(agent);
    const logTo = flag('log');
    if (typeof logTo === 'string') logFile = logTo;
    if (!takeLock(keepLockFile())) return;
    for (;;) {
      const args = [SCRIPT, 'watch', '--agent', agentName, ...(logFile ? ['--log', logFile] : [])];
      const code = await new Promise((resolve) => {
        const child = spawn(process.execPath, args, { stdio: 'ignore', windowsHide: true });
        child.on('exit', resolve);
        child.on('error', () => resolve(1));
      });
      if (code === 3) return;
      log(`watcher stopped (exit ${code}); starting again in 10 seconds`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  },
  async mcp() {
    needsInit(agent);
    const { startMcp } = await import('./mcp.mjs');
    await startMcp(agent);
  },
};

function log(text) {
  const line = `[${new Date().toLocaleString()}] ${text}`;
  console.log(line);
  if (!logFile) return;
  try {
    // Keep the log small: one older copy, about 1 MB each.
    if (existsSync(logFile) && statSync(logFile).size > 1_000_000) renameSync(logFile, `${logFile}.old`);
    appendFileSync(logFile, line + '\n');
  } catch {
    // A log that cannot be written must not stop the replies.
  }
}

// ---------- one watcher per AI friend ----------

const lockFile = () => join(agent.dir, 'watch.pid');
const keepLockFile = () => join(agent.dir, 'keep.pid');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function runningPid(file = lockFile()) {
  try {
    const pid = Number(readFileSync(file, 'utf8'));
    return pid && pid !== process.pid && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

function takeLock(file = lockFile()) {
  if (runningPid(file)) return false;
  writeFileSync(file, String(process.pid));
  const release = () => {
    try {
      if (readFileSync(file, 'utf8') === String(process.pid)) rmSync(file);
    } catch {
      // nothing to release
    }
  };
  process.on('exit', release);
  for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(s, () => process.exit(0));
  return true;
}

/**
 * The Task Scheduler task: at this person's sign-in, run `keep` with no window
 * (conhost --headless), as this person, with no time limit and also on battery.
 */
function taskXml(logPath) {
  const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  const args = `--headless "${process.execPath}" "${SCRIPT}" keep --agent "${agentName}" --log "${logPath}"`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Tegami: keeps the AI friend "${x(agentName)}" answering messages (tegami-agent). Turn off with: node agent.mjs autostart off</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${x(user)}</UserId>
      <Delay>PT20S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${x(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>10</Count>
    </RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${x(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'conhost.exe'))}</Command>
      <Arguments>${x(args)}</Arguments>
      <WorkingDirectory>${x(agent.dir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** Runs a shell command line, feeding `input` on stdin. Resolves with the exit code and output. */
function run(commandLine, input, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    // One command line through the shell, so `claude` (claude.cmd on Windows) is found.
    const p = spawn(commandLine, { cwd, env, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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

/**
 * The environment for the AI's own Claude Code. When the watcher was started from inside
 * a Claude Code session (CLAUDECODE is set), that session's variables point Claude Code at
 * the session's own connection instead of the owner's sign-in, so they are removed.
 */
export function ownEnv(env = process.env) {
  if (!env.CLAUDECODE) return env;
  const clean = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k.startsWith('CLAUDE_AGENT_SDK_') || k === 'ANTHROPIC_BASE_URL') continue;
    if (['CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_PREVIEW_CLASSIFIER_FLOOR'].includes(k)) continue;
    clean[k] = v;
  }
  return clean;
}

/** Claude Code, headless. One conversation continues across messages (the AI remembers). */
async function runClaude(prompt) {
  const work = join(agent.dir, 'work');
  mkdirSync(work, { recursive: true });
  // SYSTEM has no double quotes, so quoting it is safe in both cmd.exe and sh.
  let line = `claude -p --output-format json --append-system-prompt "${SYSTEM}"`;
  if (agent.state.claudeSession) line += ` --resume ${agent.state.claudeSession}`;
  const r = await run(line, prompt, work, ownEnv());
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
  console.log("Commands: init, invite, add, contacts, send, watch, keep, autostart, mcp");
  process.exit(cmd ? 1 : 0);
}
Promise.resolve(fn()).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
