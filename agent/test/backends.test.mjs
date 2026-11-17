// The backends that write replies (backends.mjs), against a stand-in API server on this
// computer that answers like Anthropic, OpenAI (and OpenRouter, Ollama, llama.cpp) and Gemini.
// Nothing here reaches a real AI service.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { backendLabel, callApi, loadBackend, loadKeys, makeResponder, saveBackend, saveKey } from '../backends.mjs';
import { Vault } from '../vault.mjs';

const ROOT = resolve(import.meta.dirname, '..');
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

const KEY = 'sk-test-ABCDEFGHIJKLMNOP1234';
const requests = [];
let mode = 'ok';
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d)).on('end', () => {
    const json = body ? JSON.parse(body) : {};
    requests.push({ path: req.url, headers: req.headers, body: json });
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (mode === 'echo-key') return send(401, { error: { message: `bad key ${req.headers['x-api-key'] ?? req.headers.authorization}` } });
    if (mode === 'refusal') return send(200, { stop_reason: 'refusal', content: [] });
    const last = (list) => list[list.length - 1];
    if (req.url === '/v1/messages') {
      const text = last(json.messages).content;
      return send(200, { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: `anthropic: ${text}` }] });
    }
    if (req.url === '/v1/chat/completions') return send(200, { choices: [{ message: { role: 'assistant', content: `openai: ${last(json.messages).content}` } }] });
    const g = req.url.match(/^\/v1beta\/models\/([^:]+):generateContent$/);
    if (g) return send(200, { candidates: [{ content: { role: 'model', parts: [{ text: `gemini(${decodeURIComponent(g[1])}): ${last(json.contents).parts[0].text}` }] } }] });
    send(404, { error: { message: 'no such route' } });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const DIR = mkdtempSync(join(tmpdir(), 'tegami-backends-'));

try {
  const state = { lastRead: 0, replied: [] };
  // The records key stands in for one from the AI's key (vault.mjs).
  const vault = new Vault(DIR, () => randomBytes(32));
  const responder = () => makeResponder({ dir: DIR, config: loadBackend(DIR), system: 'SYS', draftSystem: 'DRAFT', state, saveState: () => {}, vault });

  // ---------- Anthropic ----------
  saveBackend(DIR, { type: 'anthropic', model: 'claude-test', url: `${BASE}/v1` });
  check('without a key, an API backend says how to save one', (await throws(() => responder()('x', { peer: 'a' }))).includes('tegami-agent key anthropic'));
  saveKey(DIR, 'anthropic', KEY);
  requests.length = 0;
  check('Anthropic: the reply is the text, without thinking blocks', (await responder()('こんにちは', { peer: 'a' })) === 'anthropic: こんにちは');
  const a = requests[0];
  check('Anthropic: the key goes in x-api-key with an anthropic-version', a.headers['x-api-key'] === KEY && !!a.headers['anthropic-version'] && !a.headers.authorization);
  check('Anthropic: model, system and message are sent', a.body.model === 'claude-test' && a.body.system === 'SYS' && a.body.messages.length === 1 && a.body.max_tokens > 0);
  await responder()('2回目', { peer: 'a' });
  const second = requests[1].body.messages;
  check('Anthropic: the conversation with a person continues', second.length === 3 && second[0].content === 'こんにちは' && second[1].role === 'assistant' && second[2].content === '2回目');
  await responder()('別の人', { peer: 'b' });
  check('each person has their own conversation', requests[2].body.messages.length === 1);
  await responder()('下書き', { draft: true, peer: 'a' });
  check('a draft has no conversation and its own instructions', requests[3].body.messages.length === 1 && requests[3].body.system === 'DRAFT');
  check('a draft is not kept in the conversation', !JSON.stringify(vault.read('history.json', {})).includes('下書き') && JSON.stringify(vault.read('history.json', {})).includes('2回目'));
  check('history.json on disk shows no words', !readFileSync(join(DIR, 'history.json'), 'utf8').includes('2回目'));
  mode = 'refusal';
  check('Anthropic: a refusal is an error, not an empty reply', (await throws(() => responder()('x', { peer: 'a' }))).includes('declined'));
  mode = 'echo-key';
  const err = await throws(() => responder()('x', { peer: 'a' }));
  check(`an error that repeats the key does not show the key (${err})`, err.includes('401') && !err.includes(KEY) && err.includes('[key]'));
  mode = 'ok';

  // ---------- OpenAI and the servers that speak its API ----------
  for (const [type, label] of [
    ['openai', 'OpenAI gpt-test'],
    ['openrouter', 'vendor/model-test (OpenRouter)'],
  ]) {
    const model = type === 'openai' ? 'gpt-test' : 'vendor/model-test';
    saveBackend(DIR, { type, model, url: `${BASE}/v1` });
    saveKey(DIR, type, KEY);
    requests.length = 0;
    const r = await responder()('やあ', { peer: 'c' });
    const q = requests[0];
    check(`${type}: reply`, r === 'openai: やあ');
    check(`${type}: Bearer key, system first, model`, q.headers.authorization === `Bearer ${KEY}` && q.body.messages[0].role === 'system' && q.body.messages[0].content === 'SYS' && q.body.model === model);
    check(`${type}: the invite shows "${label}"`, backendLabel(loadBackend(DIR)) === label);
  }
  saveBackend(DIR, { type: 'ollama', model: 'llama3.2', url: `${BASE}/v1` });
  requests.length = 0;
  check('Ollama: works without a key and sends none', (await responder()('ローカル', { peer: 'd' })) === 'openai: ローカル' && !requests[0].headers.authorization);
  check('Ollama: the invite shows the model and Ollama', backendLabel(loadBackend(DIR)) === 'llama3.2 (Ollama)');
  check('Ollama: the default address is this computer', saveBackend(DIR, { type: 'ollama', model: 'llama3.2' }).url === 'http://localhost:11434/v1');
  check('local (llama.cpp) needs an address', (await throws(() => saveBackend(DIR, { type: 'local', model: 'm' }))).includes('--url'));
  saveBackend(DIR, { type: 'local', model: 'qwen', url: `${BASE}/v1/` });
  requests.length = 0;
  check('local: replies through the OpenAI chat API', (await responder()('llama', { peer: 'e' })) === 'openai: llama' && requests[0].path === '/v1/chat/completions');

  // ---------- Gemini ----------
  saveBackend(DIR, { type: 'gemini', model: 'gemini-test', url: `${BASE}/v1beta` });
  saveKey(DIR, 'gemini', KEY);
  requests.length = 0;
  check('Gemini: reply', (await responder()('はろー', { peer: 'f' })) === 'gemini(gemini-test): はろー');
  const g = requests[0];
  check('Gemini: key in x-goog-api-key, not in the address', g.headers['x-goog-api-key'] === KEY && !g.path.includes(KEY));
  check('Gemini: system instruction and user role', g.body.systemInstruction.parts[0].text === 'SYS' && g.body.contents[0].role === 'user');
  await responder()('つづき', { peer: 'f' });
  check('Gemini: earlier replies go back as the model role', requests[1].body.contents.map((c) => c.role).join() === 'user,model,user');

  // ---------- rules ----------
  check('Antigravity is refused', (await throws(() => saveBackend(DIR, { type: 'antigravity' }))).includes('not supported'));
  check('an API backend needs a model', (await throws(() => saveBackend(DIR, { type: 'openai' }))).includes('--model'));
  saveBackend(DIR, { type: 'openai', model: 'x', url: 'http://example.com/v1' });
  check('a key is never sent over plain http to another computer', (await throws(() => responder()('x', { peer: 'g' }))).includes('https'));
  check('Claude Code is the default and shows as Anthropic Claude', backendLabel({ type: 'claude-code' }) === 'Anthropic Claude' && loadBackend(mkdtempSync(join(tmpdir(), 'tegami-empty-'))).type === 'claude-code');
  check('the Anthropic API is called directly too', (await callApi('anthropic', { url: `${BASE}/v1`, model: 'm', key: KEY, system: 's', turns: [{ role: 'user', text: 'hi' }] })) === 'anthropic: hi');

  // ---------- the command line ----------
  const HOME = mkdtempSync(join(tmpdir(), 'tegami-agent-'));
  const env = { ...process.env, TEGAMI_AGENT_HOME: HOME, TEGAMI_RELAYS: 'ws://127.0.0.1:1' };
  const cli = (args, input) => execFileSync(process.execPath, [join(ROOT, 'agent.mjs'), ...args], { env, encoding: 'utf8', input });
  cli(['init', '--name', 'テスト']);
  const set = cli(['backend', 'openai', '--model', 'gpt-test', '--url', `${BASE}/v1`]);
  check('backend: says the key is still needed', set.includes('tegami-agent key openai'));
  check('backend: the invite link now shows the model', decodeURIComponent(cli(['invite'])).includes('m=OpenAI gpt-test'));
  cli(['key', 'openai'], `${KEY}\n`);
  check('key: read from stdin and saved', loadKeys(HOME).openai === KEY);
  check('key: not readable in the file where the system has a store', process.env.TEGAMI_SECRET_STORE === 'plain' || process.platform !== 'win32' || !readFileSync(join(HOME, 'keys.json'), 'utf8').includes(KEY));
  check('backend: shows that a key is saved, not the key', (() => {
    const out = cli(['backend']);
    return out.includes('API key: saved') && !out.includes(KEY);
  })());
  requests.length = 0;
  // Not execFileSync: the stand-in server runs in this process and must keep answering.
  const tried = (await promisify(execFile)(process.execPath, [join(ROOT, 'agent.mjs'), 'try', 'テストです'], { env, encoding: 'utf8' })).stdout;
  check('try: asks the AI once', tried.trim() === 'openai: テストです');
  const files = readdirSync(HOME).filter((f) => f !== 'keys.json');
  check(`the key is in keys.json only (${files.join(', ')})`, files.every((f) => !readFileSync(join(HOME, f), 'utf8').includes(KEY)));
  cli(['key', 'openai', '--remove']);
  check('key --remove deletes it', !readFileSync(join(HOME, 'keys.json'), 'utf8').includes(KEY));
  check('backend --label overrides what is shown', cli(['backend', 'ollama', '--model', 'gemma', '--label', 'My Gemma']).includes('Shown as: My Gemma'));
  rmSync(HOME, { recursive: true, force: true });
} finally {
  server.close();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
