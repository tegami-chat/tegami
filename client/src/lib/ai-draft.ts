// Asking an AI friend for a reply draft: the first feature behind the AI gate (lib/ai-permissions.ts).
//
// The app decides, never the AI: only when every layer allows both "read the chat" and "make a
// draft" for this AI and this friend does the app put the friend's chat into an envelope for
// the AI. The AI's PC never sees a chat it was not handed, and never a stranger's.
//
// - The ask carries the last AI_DRAFT_MESSAGES text messages of one 1:1 chat with a friend
//   (no photos, files or calls), sealed for the AI only (no copy for my other devices).
// - Both the ask and the draft that comes back expire after AI_DRAFT_TTL seconds (NIP-40), so
//   the relay never keeps the friend's words for 30 days like a message.
// - The draft goes into the composer of that chat only. Nothing is sent until the person
//   presses send; the two "send" switches are not used here.

import * as nip44 from 'nostr-tools/nip44';
import * as nip59 from 'nostr-tools/nip59';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';

import { checkAi, type AiPermissions, type AiRange } from './ai-permissions';
import { k, load, save } from './storage';

/** Rumor kinds (Tegami's own, in the ephemeral range like call signals). Never shown as messages. */
export const AI_DRAFT_ASK_KIND = 25060;
export const AI_DRAFT_KIND = 25061;
/** Seconds an ask or a draft lives on the relay. */
export const AI_DRAFT_TTL = 600;
/** How many of the latest text messages the AI is given. */
export const AI_DRAFT_MESSAGES = 30;
/** Each message is cut to this many characters, and the draft too. */
const TEXT_MAX = 2000;

export type DraftAsk = {
  v: 1;
  /** The friend's name and my name, as this device knows them. */
  friend: string;
  me: string;
  messages: { mine: boolean; text: string; at: number }[];
};

type ChatMessage = { peer: string; from: string; text: string; at: number; file?: unknown; call?: unknown };

/** The ask for one chat: the latest text messages, oldest first, and the range they cover. */
export function draftAsk(all: ChatMessage[], friend: string, me: string, names: { friend: string; me: string }) {
  const texts = all.filter((m) => m.peer === friend && !m.file && !m.call && m.text).slice(-AI_DRAFT_MESSAGES);
  const ask: DraftAsk = {
    v: 1,
    friend: names.friend.slice(0, 60),
    me: names.me.slice(0, 60),
    messages: texts.map((m) => ({ mine: m.from === me, text: m.text.slice(0, TEXT_MAX), at: m.at })),
  };
  const range: AiRange = { count: texts.length, from: texts[0]?.at ?? 0, to: texts[texts.length - 1]?.at ?? 0 };
  return { ask, range };
}

/**
 * Whether this AI may be asked for a draft in this friend's chat (both "read" and "draft"
 * allowed). For showing the button only: asking goes through gateAi, which logs.
 */
export function mayDraft(p: AiPermissions, ai: { pubkey: string; model?: string }, friend: string, isFriend: (pk: string) => boolean) {
  const r = { ai: ai.pubkey, model: ai.model, friend };
  return !checkAi(p, { ...r, action: 'read' }, isFriend) && !checkAi(p, { ...r, action: 'draft' }, isFriend);
}

/** Reads a draft rumor's content: the ask it answers and the text, or null when malformed. */
export function parseDraft(content: string): { re: string; text: string } | null {
  try {
    const d = JSON.parse(content) as { re?: unknown; text?: unknown };
    if (typeof d.re !== 'string' || !/^[0-9a-f]{64}$/.test(d.re) || typeof d.text !== 'string') return null;
    return { re: d.re, text: d.text.slice(0, TEXT_MAX) };
  } catch {
    return null;
  }
}

/** Seals the rumor for `to` and wraps it with an expiration (nip59.createWrap has no tags). */
export function wrapExpiring(rumor: ReturnType<typeof nip59.createRumor>, secret: Uint8Array, to: string, now = Math.floor(Date.now() / 1000)) {
  const seal = nip59.createSeal(rumor, secret, to);
  const key = generateSecretKey();
  return finalizeEvent(
    {
      kind: 1059,
      created_at: now,
      tags: [['p', to], ['expiration', String(now + AI_DRAFT_TTL)]],
      content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(key, to)),
    },
    key,
  );
}

/** Whether the person has been told, once, that a chat given to an AI leaves Tegami's encryption. */
export function readNoticeSeen() {
  return load<boolean>(k('ai.readNotice'), false);
}
export function markReadNoticeSeen() {
  save(k('ai.readNotice'), true);
}
