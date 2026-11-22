// Asking the phone's own AI: the one way every screen does it, so every ask passes the limits
// in guard.ts. The key comes from getKeyStore() and the call goes to the AI company directly.

import { findSecret } from '../ai-screen';
import { k, load, save } from '../storage';
import { PhoneAiRefused, phoneAiStopped, phoneMayAsk, recordPhoneAsk } from './guard';
import { getKeyStore, type ProviderId } from './key-store';
import { getProvider, type ChatMessage } from './providers';

/** Which company and which model the person chose (not secret; kept plain). */
export type PhoneChoice = { provider: ProviderId; model: string };

export function phoneChoice(): PhoneChoice {
  const c = load<Partial<PhoneChoice>>(k('ai.phoneChoice'), {});
  const provider: ProviderId = 'anthropic';
  const p = getProvider(provider);
  const model = p.models.some((m) => m.id === c.model) ? (c.model as string) : p.defaultModel;
  return { provider, model };
}

export function savePhoneChoice(c: PhoneChoice) {
  save(k('ai.phoneChoice'), c);
}

export type AskArgs = {
  /** Who this is for: a friend's key, or 'self' for the owner's own chat. */
  peer: string;
  system: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

/**
 * Sends the messages to the AI and returns its answer. Throws PhoneAiRefused before anything
 * leaves the device (stopped, no key, daily limit, a secret in the text), or after the answer
 * came back (a secret in the answer), and ProviderError for a failed call.
 */
export async function askPhoneAi({ peer, system, messages, signal, fetchImpl }: AskArgs): Promise<string> {
  if (phoneAiStopped()) throw new PhoneAiRefused('stopped');
  const { provider, model } = phoneChoice();
  const key = getKeyStore().get(provider);
  if (!key) throw new PhoneAiRefused('noKey');
  if (!phoneMayAsk(peer)) throw new PhoneAiRefused('daily');
  if (findSecret(system) || messages.some((m) => findSecret(m.content))) throw new PhoneAiRefused('secret');
  recordPhoneAsk(peer);
  const answer = await getProvider(provider).call({ key, model, system, messages, signal, fetchImpl });
  if (findSecret(answer)) throw new PhoneAiRefused('secretReply');
  return answer;
}

// ---------- the owner's own chat with the phone's AI ----------

export type PhoneLine = { role: 'user' | 'assistant'; text: string; at: number };
export const PHONE_CHAT_MAX = 50;

export function loadPhoneChat(): PhoneLine[] {
  const l = load<PhoneLine[]>(k('ai.phoneChat'), []);
  return Array.isArray(l) ? l.slice(-PHONE_CHAT_MAX) : [];
}

export function savePhoneChat(lines: PhoneLine[]) {
  save(k('ai.phoneChat'), lines.slice(-PHONE_CHAT_MAX));
}

export function clearPhoneChat() {
  save(k('ai.phoneChat'), []);
}
