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

export interface AiProvider {
  id: ProviderId;
  name: string;
  defaultModel: string;
  models: { id: string; name: string }[];
  call(args: CallArgs): Promise<string>;
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

export const KEY_WRONG_TEXT = 'キーが違います。キーを入れ直してください。';
export const LIMIT_TEXT = '使いすぎです。しばらくしてから、もう一度試してください。';

export const anthropic: AiProvider = {
  id: 'anthropic',
  name: 'Anthropic',
  defaultModel: 'claude-sonnet-5-5',
  models: [
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  ],
  async call({ key, model, system, messages, signal, fetchImpl }) {
    const f = fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await f('https://api.anthropic.com/v1/messages', {
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
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') throw e;
      throw new ProviderError('other', '通信できませんでした。電波を確かめて、もう一度試してください。');
    }
    if (res.status === 401) throw new ProviderError('key', KEY_WRONG_TEXT);
    if (res.status === 429) throw new ProviderError('limit', LIMIT_TEXT);
    if (!res.ok) throw new ProviderError('other', `AIの会社から、うまく返事が来ませんでした（${res.status}）。`);
    let data: { content?: { type?: string; text?: string }[] };
    try {
      data = await res.json();
    } catch {
      throw new ProviderError('other', 'AIの会社の返事を読めませんでした。');
    }
    const text = (data.content ?? [])
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    return text;
  },
};

const PROVIDERS: Record<ProviderId, AiProvider> = { anthropic };

export const PROVIDER_LIST: AiProvider[] = Object.values(PROVIDERS);

export function getProvider(id: ProviderId): AiProvider {
  return PROVIDERS[id];
}
