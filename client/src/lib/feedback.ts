// "Tegamiへの意見": a chat with the operator's official account (hello@tegami.chat), opened from
// the settings. It is an ordinary encrypted chat: the operator reads it with that account's key
// in any Nostr app that reads private messages (NIP-17) from relay.tegami.chat.
// It shows in the chat list only after the person opened it (or when it has messages), and it
// is neither a friend nor a stranger: it never goes to "知らない人から".

import { useSyncExternalStore } from 'react';

import { k, load, save } from './storage';

/** The official account's public key (hex). Tests build with EXPO_PUBLIC_TEGAMI_FEEDBACK. */
export const FEEDBACK_PUBKEY = (() => {
  const env = process.env.EXPO_PUBLIC_TEGAMI_FEEDBACK ?? '';
  return /^[0-9a-f]{64}$/.test(env) ? env : '10561058d7194e8f8575181852d6898ddb101d4e45fa05dea87017b16d72e2e1';
})();
export const FEEDBACK_NAME = 'Tegamiへの意見';

export function isFeedback(pubkey: string | null | undefined) {
  return pubkey === FEEDBACK_PUBKEY;
}

const listeners = new Set<() => void>();
let version = 0;
function changed() {
  version++;
  for (const fn of listeners) fn();
}

/** Whether the person opened the chat on this account (kept per account). */
export function feedbackOpened() {
  return load<boolean>(k('feedback'), false);
}

/** The settings opened the chat: from now on it is in the chat list. */
export function openFeedback() {
  if (feedbackOpened()) return;
  save(k('feedback'), true);
  changed();
}

/** The chat was deleted on this device: out of the chat list until a new message. */
export function closeFeedback() {
  save(k('feedback'), false);
  changed();
}

export function useFeedbackOpened() {
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => version,
    () => version,
  );
  return feedbackOpened();
}
