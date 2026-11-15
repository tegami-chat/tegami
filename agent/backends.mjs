// Which AI writes the replies: Claude Code, a model running on this computer, or an API
// with the owner's own key. The choice lives in backend.json, the keys in keys.json (both
// in the AI friend's folder, never sent anywhere but to the AI they belong to).
//
// Not supported on purpose: Antigravity (`agy -p`). Its terms forbid reaching it through
// third-party software. And nothing here ever holds the owner's sign-in to an AI service:
// Claude Code signs in by itself, every other backend takes an API key or no key at all.

import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
export function saveBackend(dir, { type, model, url }) {
  const b = BACKENDS[type];
  if (!b) {
    if (type === 'antigravity' || type === 'agy') throw new Error('Antigravity is not supported: its terms do not allow other programs to use it.');
    throw new Error(`Unknown backend "${type}". Use one of: ${Object.keys(BACKENDS).join(', ')}`);
  }
  const config = { type };
  if (b.kind !== 'claude-code' && b.kind !== 'command') {
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

export function loadKeys(dir) {
  return readJson(dir, 'keys.json', {});
}

export function saveKey(dir, type, key) {
  const keys = loadKeys(dir);
  if (key) keys[type] = key;
  else delete keys[type];
  writePrivate(dir, 'keys.json', keys);
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
 * peer: whose conversation this continues (API backends keep the last turns per person).
 */
export function makeResponder({ dir, config, system, draftSystem, state, saveState, command }) {
  if (command) return (prompt) => runCommand(command, prompt, dir);
  const b = BACKENDS[config.type] ?? BACKENDS['claude-code'];
  if (b.kind === 'claude-code') return (prompt, opts = {}) => runClaude({ dir, prompt, system, draftSystem, state, saveState, draft: !!opts.draft });
  if (b.kind === 'command') throw new Error('The command backend needs --command "<program>" on watch.');
  return async (prompt, { draft = false, peer = '' } = {}) => {
    const keys = loadKeys(dir);
    const key = keys[config.type] ?? '';
    if (b.key === true && !key) throw new Error(`No API key for ${config.type}. Run: tegami-agent key ${config.type}`);
    if (key && !keyMayGo(config.url)) throw new Error('The API key is only sent over https or to this computer.');
    const history = draft ? [] : readJson(dir, 'history.json', {})[peer] ?? [];
    const turns = [...history, { role: 'user', text: prompt }];
    let text;
    try {
      text = await callApi(b.kind, { url: config.url, model: config.model, key, system: draft ? draftSystem : system, turns });
    } catch (e) {
      throw new Error(redact(e.message, keys));
    }
    if (!draft && peer) {
      const all = readJson(dir, 'history.json', {});
      all[peer] = [...turns, { role: 'assistant', text }].slice(-HISTORY_TURNS * 2);
      writePrivate(dir, 'history.json', all);
    }
    return text;
  };
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

async function runCommand(command, prompt, cwd) {
  const r = await run(command, prompt, cwd);
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

/**
 * Claude Code, headless. One conversation continues across messages (the AI remembers).
 * draft: a reply draft for a friend's chat instead. It runs once on its own: no tools (the
 * friend's words must not make it act), no saved session, and not added to the conversation.
 * system and draftSystem must not contain double quotes (they go inside "..." on the command line).
 */
async function runClaude({ dir, prompt, system, draftSystem, state, saveState, draft }) {
  const work = join(dir, draft ? 'draft' : 'work');
  mkdirSync(work, { recursive: true });
  let line = draft
    ? `claude -p --output-format json --no-session-persistence --tools "" --append-system-prompt "${draftSystem}"`
    : `claude -p --output-format json --append-system-prompt "${system}"`;
  if (!draft && state.claudeSession) line += ` --resume ${state.claudeSession}`;
  const r = await run(line, prompt, work, ownEnv());
  let out;
  try {
    out = JSON.parse(r.out);
  } catch {
    throw new Error(r.err.trim() || r.out.trim() || `claude exited ${r.code}`);
  }
  if (out.session_id && !draft) {
    state.claudeSession = out.session_id;
    saveState();
  }
  if (out.is_error) throw new Error(String(out.result ?? 'Claude returned an error'));
  return String(out.result ?? '');
}
