// Which AI writes the replies: Claude Code, a model running on this computer, or an API
// with the owner's own key. The choice lives in backend.json, the keys in keys.json (both
// in the AI friend's folder, never sent anywhere but to the AI they belong to). keys.json is
// encrypted by the operating system's store where there is one (secrets.mjs).
//
// Not supported on purpose: Antigravity (`agy -p`). Its terms forbid reaching it through
// third-party software. And nothing here ever holds the owner's sign-in to an AI service:
// Claude Code signs in by itself, every other backend takes an API key or no key at all.

import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountFor, forget, protect, refusePlain, storeKind, unprotect, warnPlain } from './secrets.mjs';
import { Vault } from './vault.mjs';

/**
 * kind: how the request is shaped. key: an API key is needed ('optional' for servers that
 * may have one). label: what the invite link shows as the model (philosophy #93).
 */
export const BACKENDS = {
  'claude-code': { kind: 'claude-code', label: () => 'Anthropic Claude' },
  command: { kind: 'command', label: () => '' },
  anthropic: { kind: 'anthropic', url: 'https://api.anthropic.com/v1', key: true, label: (m) => `Anthropic ${m}` },
  openai: { kind: 'openai', url: 'https://api.openai.com/v1', key: true, label: (m) => `OpenAI ${m}` },
  gemini: { kind: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta', key: true, label: (m) => `Google ${m}` },
  openrouter: { kind: 'openai', url: 'https://openrouter.ai/api/v1', key: true, label: (m) => `${m} (OpenRouter)` },
  ollama: { kind: 'openai', url: 'http://localhost:11434/v1', key: false, label: (m) => `${m} (Ollama)` },
  // Any server with the OpenAI chat API on this computer or network: llama.cpp, LM Studio, vLLM.
  local: { kind: 'openai', url: null, key: 'optional', label: (m) => `${m} (local)` },
};

/** Conversation turns kept per person for API backends (Claude Code keeps its own session). */
const HISTORY_TURNS = 20;

/**
 * How many steps Claude Code may take for one reply. With no tools, one answer is one step;
 * the second is slack. With tools (the owner opened them), a few more.
 */
export const MAX_TURNS = 2;
export const MAX_TURNS_WITH_TOOLS = 8;
/** The AI check's Claude Code is stopped after this long (check.mjs counts it as ASK_OWNER sooner). */
export const CHECK_PROCESS_TIMEOUT = 95_000;
const DAY = 86400;

export function readJson(dir, file, fallback) {
  try {
    return JSON.parse(readFileSync(join(dir, file), 'utf8'));
  } catch {
    return fallback;
  }
}

function writePrivate(dir, file, value) {
  const path = join(dir, file);
  writeFileSync(path, JSON.stringify(value, null, 2));
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows: the file sits in the user's own profile folder.
  }
}

/** The backend set for this AI friend (Claude Code when none is set). */
export function loadBackend(dir) {
  return readJson(dir, 'backend.json', { type: 'claude-code' });
}

/**
 * Checks and saves a backend. Returns the saved config.
 * Throws with a plain message when something is missing or not allowed.
 */
export function saveBackend(dir, { type, model, url, run: runLine }) {
  const b = BACKENDS[type];
  if (!b) {
    if (type === 'antigravity' || type === 'agy') throw new Error('Antigravity is not supported: its terms do not allow other programs to use it.');
    throw new Error(`Unknown backend "${type}". Use one of: ${Object.keys(BACKENDS).join(', ')}`);
  }
  const config = { type };
  if (b.kind === 'command') {
    const line = typeof runLine === 'string' ? runLine.trim() : '';
    if (!line) throw new Error('Give the command line: --run "<program that reads the request on stdin and prints the reply>"');
    config.run = line;
  } else if (b.kind !== 'claude-code') {
    if (!model) throw new Error(`Give the model name: --model <name> (as ${type} calls it).`);
    config.model = String(model);
    const base = url ?? b.url;
    if (!base) throw new Error('Give the server address: --url http://localhost:8080/v1');
    config.url = checkUrl(base);
  }
  mkdirSync(dir, { recursive: true });
  writePrivate(dir, 'backend.json', config);
  return config;
}

/** The model name shown to people for this backend (the invite link's m=). */
export function backendLabel(config) {
  const b = BACKENDS[config?.type];
  return b ? b.label(config.model ?? '').slice(0, 60) : '';
}

function checkUrl(text) {
  let u;
  try {
    u = new URL(text);
  } catch {
    throw new Error(`Not an address: ${text}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`Use an http or https address: ${text}`);
  return u.toString().replace(/\/$/, '');
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** An API key may travel only over https, or to this computer itself. */
function keyMayGo(url) {
  const u = new URL(url);
  return u.protocol === 'https:' || LOOPBACK.has(u.hostname);
}

// ---------- keys ----------

// Opened keys, by folder, while keys.json stays the same (opening takes a moment on Windows).
const opened = new Map();

/** The API keys saved for this AI friend: { backend: key }. A plain keys.json is moved into the store. */
export function loadKeys(dir) {
  const path = join(dir, 'keys.json');
  let stamp;
  try {
    stamp = statSync(path).mtimeMs;
  } catch {
    return {};
  }
  const hit = opened.get(dir);
  if (hit?.stamp === stamp) return { ...hit.keys };
  const file = readJson(dir, 'keys.json', {});
  let keys;
  if (typeof file.store === 'string') keys = JSON.parse(unprotect(file));
  else {
    // From before the secret store: plain keys. Move them in now (the plain file is replaced).
    keys = file;
    if (Object.keys(keys).length && storeKind() !== 'plain') writeKeys(dir, keys, { existing: true });
  }
  opened.set(dir, { stamp: statSync(path).mtimeMs, keys });
  return { ...keys };
}

/** existing: plain keys from before; where there is still no store they stay as they are. */
function writeKeys(dir, keys, { existing = false } = {}) {
  const old = readJson(dir, 'keys.json', {});
  const kind = storeKind();
  const any = Object.keys(keys).length > 0;
  const sealed = kind === 'plain' || !any ? null : protect(JSON.stringify(keys), accountFor(dir, 'keys'), kind);
  if (!sealed && any && kind !== 'plain') {
    if (existing) return;
    refusePlain('the API keys');
  }
  if (!sealed && any) warnPlain('the API keys');
  writePrivate(dir, 'keys.json', sealed ?? keys);
  if (!sealed && typeof old.store === 'string') forget(old);
  opened.delete(dir);
}

export function saveKey(dir, type, key) {
  const keys = loadKeys(dir);
  if (key) keys[type] = key;
  else delete keys[type];
  writeKeys(dir, keys);
}

/** Removes every key from a text (error bodies, logs), so a key never ends up in a log. */
export function redact(text, keys) {
  let out = String(text);
  for (const k of Object.values(keys)) if (k && k.length >= 8) out = out.split(k).join('[key]');
  return out;
}

// ---------- replies ----------

/**
 * Makes the function that writes a reply.
 *   reply(prompt, { draft, peer }) -> Promise<string>
 * draft: a one-off reply draft for a friend's chat: no conversation, no tools, nothing kept.
 * check: the AI check (check.mjs) with its own instructions (checkSystem): run like a draft.
 * peer: whose conversation this continues (API backends keep the last turns per person).
 * settings (lib.mjs loadSettings): tools (Claude Code may use its tools), remember (keep the
 * conversation), keepDays (how long a conversation is kept).
 */
export function makeResponder({ dir, config, system, draftSystem, checkSystem = draftSystem, state, saveState, command, settings = {}, vault }) {
  // history.json is sealed by the AI friend's vault (vault.mjs). Without one it stays in memory.
  const records = vault ?? new Vault(dir, () => null);
  const { tools = false, remember = true, keepDays = 30 } = settings;
  const b = BACKENDS[config.type] ?? BACKENDS['claude-code'];
  const commandLine = command || (b.kind === 'command' ? config.run : '');
  if (commandLine)
    return async (prompt, { draft = false, check = false, peer = '', timeout } = {}) => {
      if (check) draft = true;
      const instructions = check ? checkSystem : draft ? draftSystem : system;
      return converse({
        records, peer, prompt, draft, remember, keepDays,
        ask: (turns) => runCommand(commandLine, commandInput(instructions, turns), join(dir, 'command-work'), check ? { timeout: timeout ?? CHECK_PROCESS_TIMEOUT } : {}),
      });
    };
  if (b.kind === 'command') throw new Error('The command backend needs a command line: tegami-agent backend command --run "<command>" (or --command "<command>" on watch).');
  if (b.kind === 'claude-code')
    return (prompt, opts = {}) =>
      opts.check
        ? runClaude({ dir, prompt, system, draftSystem: checkSystem, state, saveState, draft: true, check: true, timeout: opts.timeout ?? CHECK_PROCESS_TIMEOUT, tools, remember, keepDays })
        : runClaude({ dir, prompt, system, draftSystem, state, saveState, draft: !!opts.draft, peer: opts.peer ?? '', tools, remember, keepDays });
  return async (prompt, { draft = false, check = false, peer = '' } = {}) => {
    if (check) draft = true;
    const keys = loadKeys(dir);
    const key = keys[config.type] ?? '';
    if (b.key === true && !key) throw new Error(`No API key for ${config.type}. Run: tegami-agent key ${config.type}`);
    if (key && !keyMayGo(config.url)) throw new Error('The API key is only sent over https or to this computer.');
    return converse({
      records, peer, prompt, draft, remember, keepDays,
      ask: async (turns) => {
        let text;
        try {
          text = await callApi(b.kind, { url: config.url, model: config.model, key, system: check ? checkSystem : draft ? draftSystem : system, turns });
        } catch (e) {
          throw new Error(redact(e.message, keys));
        }
        if (!check) noteModel(dir, config.model);
        return text;
      },
    });
  };
}

/**
 * One reply with a conversation kept per person (history.json in the records): shared by the
 * API backends and the command backend. ask(turns) -> Promise<string> gets the turns, oldest
 * first, ending with the new message. A draft or a check keeps nothing; without a person
 * (peer) or with remember off, nothing is kept either.
 */
async function converse({ records, peer, prompt, draft, remember, keepDays, ask }) {
  const now = Math.floor(Date.now() / 1000);
  const since = now - keepDays * DAY;
  const keep = !draft && remember && !!peer;
  const history = keep ? (records.read('history.json', {})[peer] ?? []).filter((t) => (t.at ?? now) >= since) : [];
  const turns = [...history.map(({ role, text }) => ({ role, text })), { role: 'user', text: prompt }];
  const text = await ask(turns);
  if (keep) {
    const all = records.read('history.json', {});
    // Older than keepDays: gone, for everyone in the file (not only this person).
    for (const [k, list] of Object.entries(all)) {
      all[k] = list.filter((t) => (t.at ?? now) >= since);
      if (!all[k].length) delete all[k];
    }
    all[peer] = [...history, { role: 'user', text: prompt, at: now }, { role: 'assistant', text, at: now }].slice(-HISTORY_TURNS * 2);
    records.write('history.json', all);
  }
  return text;
}

/**
 * The one plain text a command gets on stdin: the instructions, the conversation so far (when
 * there is one), the new message, and a closing line. The words follow the language of the
 * instructions the agent gives (Japanese).
 */
export function commandInput(instructions, turns) {
  const last = turns[turns.length - 1].text;
  const before = turns.slice(0, -1);
  const lines = [instructions, ''];
  if (before.length) {
    lines.push('--- これまでの会話 ---');
    for (const t of before) lines.push(`${t.role === 'user' ? '相手' : 'あなた'}: ${t.text}`);
  }
  lines.push('--- 新しいメッセージ ---', last, '', '上の指示に従い、返事の本文だけを書いてください。');
  return lines.join('\n');
}

/**
 * The model that wrote the last reply (model.json), as the AI's service names it: claude-opus-5-5,
 * llama3.2. The AI puts it on its messages (lib.mjs aiTag) so friends see what is running now.
 */
export function noteModel(dir, model) {
  const m = String(model ?? '').trim().slice(0, 80);
  if (!m || readJson(dir, 'model.json', null)?.model === m) return;
  writePrivate(dir, 'model.json', { model: m, at: Math.floor(Date.now() / 1000) });
}

const TIMEOUT = 300_000;

async function post(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // not JSON: shown as text below
  }
  if (!res.ok) {
    const msg = json?.error?.message ?? json?.error ?? json?.[0]?.error?.message ?? raw.slice(0, 300);
    throw new Error(`HTTP ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  if (!json) throw new Error('The AI did not answer with JSON.');
  return json;
}

/** One request to an API. turns: [{role: 'user'|'assistant', text}], oldest first, ending with the user. */
export async function callApi(kind, { url, model, key, system, turns }) {
  if (kind === 'anthropic') {
    const json = await post(
      `${url}/messages`,
      { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      { model, max_tokens: 4096, system, messages: turns.map((t) => ({ role: t.role, content: t.text })) },
    );
    if (json.stop_reason === 'refusal') throw new Error('The AI declined to answer.');
    return (json.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  }
  if (kind === 'gemini') {
    const json = await post(
      `${url}/models/${encodeURIComponent(model)}:generateContent`,
      { 'x-goog-api-key': key },
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: turns.map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.text }] })),
      },
    );
    const parts = json.candidates?.[0]?.content?.parts;
    if (!parts) throw new Error(`The AI gave no answer${json.promptFeedback?.blockReason ? ` (${json.promptFeedback.blockReason})` : ''}.`);
    return parts.map((p) => p.text ?? '').join('');
  }
  // The OpenAI chat API: OpenAI, OpenRouter, Ollama, llama.cpp, LM Studio, vLLM.
  const json = await post(`${url}/chat/completions`, key ? { Authorization: `Bearer ${key}` } : {}, {
    model,
    messages: [{ role: 'system', content: system }, ...turns.map((t) => ({ role: t.role, content: t.text }))],
  });
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('The AI gave no answer.');
  return content;
}

// ---------- programs on this computer ----------

/** Runs a shell command line, feeding `input` on stdin. Resolves with the exit code and output. */
function run(commandLine, input, cwd, env = process.env, { timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    // One command line through the shell, so `claude` (claude.cmd on Windows) is found.
    // With a timeout on macOS and Linux, the shell leads its own process group, so killTree can
    // stop the group (the shell and `claude` under it), not only the shell.
    const detached = timeout > 0 && process.platform !== 'win32';
    const p = spawn(commandLine, { cwd, env, shell: true, windowsHide: true, detached, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timer;
    // timeout: the whole process tree is stopped (the shell and the program it started), and
    // the call fails. Used by the AI check, so a hung check never keeps a process alive.
    if (timeout > 0)
      timer = setTimeout(() => {
        killTree(p.pid);
        reject(Object.assign(new Error('the program took too long'), { code: 'TIMEOUT' }));
      }, timeout);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => (clearTimeout(timer), reject(e)));
    p.on('exit', (code) => (clearTimeout(timer), resolve({ code, out, err })));
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

/** Stops a process and what it started (on Windows the shell's child does not stop with it). */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

/**
 * A command of the owner's choice (any AI's command line). It runs in an empty folder of its
 * own, never in the AI friend's folder where the keys and records are. An exit code other
 * than 0, or an empty answer, is an error.
 */
async function runCommand(command, input, cwd, opts = {}) {
  mkdirSync(cwd, { recursive: true });
  const r = await run(command, input, cwd, process.env, opts);
  if (r.code !== 0) throw new Error(r.err.trim().slice(-300) || `the command exited with code ${r.code}`);
  const text = r.out.trim();
  if (!text) throw new Error(r.err.trim().slice(-300) || 'the command printed nothing');
  return text;
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

/**
 * The command line for Claude Code, headless.
 * By default it has no tools at all: no built-in tools (--tools ""), none of the MCP servers the
 * owner added to Claude Code (--strict-mcp-config, and --disallowedTools "mcp__*" as a second
 * lock), and a small --max-turns. The words it reads come from other people's messages, so they
 * must not be able to make it read files or use the owner's mail. tools: the owner opened them.
 * A draft never has tools. remember false, or a draft: nothing is kept (--no-session-persistence).
 * system must not contain double quotes (it goes inside "..." on the command line).
 */
export function claudeLine({ system, tools = false, remember = true, draft = false, session = '' }) {
  const parts = ['claude', '-p', '--output-format', 'json'];
  if (draft || !tools) parts.push('--tools', '""', '--strict-mcp-config', '--disallowedTools', '"mcp__*"', '--max-turns', String(MAX_TURNS));
  else parts.push('--max-turns', String(MAX_TURNS_WITH_TOOLS));
  if (draft || !remember) parts.push('--no-session-persistence');
  else if (session) parts.push('--resume', session);
  parts.push('--append-system-prompt', `"${system}"`);
  return parts.join(' ');
}

/**
 * Claude Code, headless. One conversation continues across messages (the AI remembers), for
 * keepDays at most: then a new one starts. With remember off, every reply starts afresh.
 * draft: a reply draft for a friend's chat instead. It runs once on its own: no tools (the
 * friend's words must not make it act), no saved session, and not added to the conversation.
 */
async function runClaude({ dir, prompt, system, draftSystem, state, saveState, draft, check = false, timeout = 0, peer = '', tools, remember, keepDays }) {
  const work = join(dir, check ? 'check' : draft ? 'draft' : 'work');
  mkdirSync(work, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  // One session per person (or group): what one friend wrote never sits in the context of another's reply.
  // The single session an older version kept mixed everyone's words, so it is dropped, not carried over.
  let dirty = false;
  // (Set to null, not deleted: saveState writes what changed, and a deleted key would come back from disk.)
  if (!draft && (state.claudeSession != null || state.claudeSessionAt != null)) {
    state.claudeSession = null;
    state.claudeSessionAt = null;
    dirty = true;
  }
  const sessions = (state.claudeSessions ??= {});
  for (const [k, v] of draft ? [] : Object.entries(sessions)) {
    if (!remember || (v?.at ?? 0) < now - keepDays * DAY) {
      delete sessions[k];
      dirty = true;
    }
  }
  if (dirty) saveState();
  // Without a person to key the session on, nothing is kept (--no-session-persistence).
  const keep = !draft && remember && !!peer;
  const line = claudeLine({ system: draft ? draftSystem : system, tools, remember: keep, draft, session: keep ? (sessions[peer]?.id ?? '') : '' });
  const r = await run(line, prompt, work, ownEnv(), { timeout });
  let out;
  try {
    out = JSON.parse(r.out);
  } catch {
    throw new Error(r.err.trim() || r.out.trim() || `claude exited ${r.code}`);
  }
  if (out.session_id && keep) {
    sessions[peer] = { id: out.session_id, at: out.session_id !== sessions[peer]?.id ? now : (sessions[peer].at ?? now) };
    saveState();
  }
  if (out.is_error) throw new Error(String(out.result ?? 'Claude returned an error'));
  // The model Claude Code really ran (its JSON names it under modelUsage), shown to friends.
  const used = Object.entries(out.modelUsage ?? {}).sort((x, y) => (y[1]?.outputTokens ?? 0) - (x[1]?.outputTokens ?? 0))[0]?.[0];
  if (used && !check) noteModel(dir, used);
  return String(out.result ?? '');
}
