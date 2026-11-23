// The AI companies the phone can call directly with the person's own API key.
// Nothing is sent through Tegami's relay or servers: the app calls the company's API itself.

import type { ProviderId } from './key-store';

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export type CallArgs = {
  key: string;
  model: string;
  system: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  /** For tests: replaces fetch. */
  fetchImpl?: typeof fetch;
};

/** How a company's API is called. Two shapes cover the three companies; a new shape is a new function below. */
export type ApiStyle = 'anthropic' | 'openai';

/** One row per AI company. To add a company, add one row to PROVIDERS. */
export interface AiProvider {
  id: ProviderId;
  name: string;
  /** The page where the person makes an API key. */
  keyUrl: string;
  style: ApiStyle;
  baseUrl: string;
  defaultModel: string;
  models: { id: string; name: string }[];
}

/** What went wrong with a call, in words for the person. */
export type CallFailure = 'key' | 'limit' | 'other';

export class ProviderError extends Error {
  kind: CallFailure;
  constructor(kind: CallFailure, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
  }
}

export const KEY_WRONG_TEXT = 'APIキーが正しくありません。設定の「AIのAPIキー」で入れ直してください。';
export const LIMIT_TEXT = '使える回数の上限に達しています。しばらく待ってからお試しください。';

async function send(f: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await f(url, init);
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw e;
    throw new ProviderError('other', '通信できませんでした。電波を確かめてください。');
  }
}

async function failIfBad(res: Response) {
  if (res.status === 401) throw new ProviderError('key', KEY_WRONG_TEXT);
  if (res.status === 429) throw new ProviderError('limit', LIMIT_TEXT);
  if (res.status === 400) {
    // Google answers a wrong key with 400 and says so in the body.
    let body = '';
    try {
      body = await res.text();
    } catch {}
    if (/API key not valid|API_KEY_INVALID/.test(body)) throw new ProviderError('key', KEY_WRONG_TEXT);
  }
  if (!res.ok) throw new ProviderError('other', `AIの会社から返事をもらえませんでした（エラー${res.status}）。`);
}

async function readJson<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new ProviderError('other', 'AIの会社からの返事を読み取れませんでした。');
  }
}

async function callAnthropic(p: AiProvider, { key, model, system, messages, signal, fetchImpl }: CallArgs): Promise<string> {
  const res = await send(fetchImpl ?? fetch, `${p.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      // Needed on the web, where the call is made from the browser.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model, max_tokens: 1024, system, messages }),
    signal,
  });
  await failIfBad(res);
  const data = await readJson<{ content?: { type?: string; text?: string }[] }>(res);
  return (data.content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

// OpenAI's Chat Completions shape, which Google's Gemini also answers. Only these two headers:
// an extra header makes Google answer 403.
async function callOpenAi(p: AiProvider, { key, model, system, messages, signal, fetchImpl }: CallArgs): Promise<string> {
  const res = await send(fetchImpl ?? fetch, `${p.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, ...messages], max_completion_tokens: 1024 }),
    signal,
  });
  await failIfBad(res);
  const data = await readJson<{ choices?: { message?: { content?: unknown } }[] }>(res);
  const text = data.choices?.[0]?.message?.content;
  return typeof text === 'string' ? text : '';
}

const CALLERS: Record<ApiStyle, (p: AiProvider, a: CallArgs) => Promise<string>> = { anthropic: callAnthropic, openai: callOpenAi };

export const PROVIDERS: Record<ProviderId, AiProvider> = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    style: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-5-5',
    models: [
      { id: 'claude-fable-5-2', name: 'Claude Fable 5.2' },
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
    ],
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    keyUrl: 'https://platform.openai.com/settings/organization/api-keys',
    style: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-6.2-sol',
    models: [
      { id: 'gpt-6.2-astra', name: 'GPT-6.2 Astra' },
      { id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' },
      { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra' },
      { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
    ],
  },
  google: {
    id: 'google',
    name: 'Google',
    keyUrl: 'https://aistudio.google.com/api-keys',
    style: 'openai',
    // Gemini's OpenAI-compatible window.
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-4-carbon',
    models: [
      { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
      { id: 'gemini-4-neon', name: 'Gemini 4 Neon' },
      { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
    ],
  },
};

/** The companies in the order the screen lists them. */
export const PROVIDER_LIST: AiProvider[] = Object.values(PROVIDERS);

export function hasProvider(id: unknown): id is ProviderId {
  if (typeof id !== 'string') return false;
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id);
}

export function getProvider(id: ProviderId): AiProvider {
  return PROVIDERS[id];
}

/** Calls the company's API in its own shape. */
export function callProvider(id: ProviderId, args: CallArgs): Promise<string> {
  const p = getProvider(id);
  return CALLERS[p.style](p, args);
}
