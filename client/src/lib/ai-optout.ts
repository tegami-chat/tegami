// Letting the people I talk with keep their words away from my AI (concerns #2 plan A and #5).
//
// Two ways to say no, both kept by the official app only (a changed app does not follow them):
//
// - A person can turn on「自分の文を相手のAIに読ませない」in the settings. The choice travels in
//   the private profile card (rumor kind 10100, field `noai: true`) to every friend, and to my
//   own devices in the ledger (own-sync.ts, entry "p:noai"). While it is on, every message I
//   send also carries the tag below, so it holds even for a friend whose app has not seen my
//   profile card yet.
// - A sender can mark one message (or every message while the chat's switch is on) with the
//   tag ["noai"] inside the sealed rumor. The relay never sees it.
//
// What the official app never hands to an AI (reply drafts, copies of group messages for an AI
// every member said yes to, and anything else that gives an AI my chats):
// - a message from a friend whose profile card says noai,
// - a message with the ["noai"] tag,
// - a message whose rumor carries a mark of a message that is meant not to stay (concern #5):
//   a NIP-40 ["expiration", …] tag today. Messages that disappear, can be taken back or must
//   not be saved do not exist yet; when they are made, their tag goes into STAY_AWAY_TAGS so the
//   gate keeps them away from AIs from the first day.

import { k, load, save } from './storage';

/** The tag inside a rumor: "do not give this message to an AI". */
export const NOAI_TAG = ['noai'] as const;
/** Rumor tags (by name) that keep a message away from every AI. */
export const STAY_AWAY_TAGS = ['noai', 'expiration'] as const;

/** Whether a rumor's tags keep the message away from AIs (the noai mark or a "does not stay" mark). */
export function keptFromAi(tags: string[][]): boolean {
  return tags.some((t) => (STAY_AWAY_TAGS as readonly string[]).includes(t[0]));
}

/** Adds the noai tag to tags, once. */
export function withNoAi(tags: string[][]): string[][] {
  return tags.some((t) => t[0] === 'noai') ? tags : [...tags, [...NOAI_TAG]];
}

type Readable = { from: string; text: string; noai?: true; file?: unknown; call?: unknown; notice?: true };
type Person = { pubkey: string; noai?: true };

/** Why nothing from a chat can be handed to an AI. */
export type NothingToRead = 'optout' | 'marked' | 'empty';

/**
 * The messages of a chat an AI may be given: not marked, and not written by someone who said
 * no. My own messages count unless I marked them. `me` is my key.
 */
export function aiReadable<T extends Readable>(list: T[], people: Person[], me: string): T[] {
  const refused = new Set(people.filter((p) => p.noai).map((p) => p.pubkey));
  return list.filter((m) => !m.noai && (m.from === me || !refused.has(m.from)));
}

/**
 * Whether a reply draft has anything to go on: at least one message from the friend that may
 * be read. Null when it has; else why not (the friend said no, every one of their messages is
 * marked, or they have written nothing yet).
 */
export function nothingToRead(list: Readable[], friend: Person | undefined, me: string): NothingToRead | null {
  if (!friend) return 'empty';
  const theirs = list.filter((m) => m.from === friend.pubkey && m.text && !m.file && !m.call && !m.notice);
  if (!theirs.length) return 'empty';
  if (friend.noai) return 'optout';
  if (theirs.every((m) => m.noai)) return 'marked';
  return null;
}

/** The line shown to the person for each reason (the chat screen's dialog). */
export function nothingToReadText(reason: NothingToRead, name: string): string {
  if (reason === 'optout') return `${name}さんは、自分の文を相手のAIに読ませない設定にしています。${name}さんの文はAIに渡しません。`;
  if (reason === 'marked') return `${name}さんの文には、どれも「AIに読ませない」の印が付いています。印の付いた文はAIに渡しません。`;
  return `${name}さんの文がまだないので、下書きを頼めません。`;
}

// ---------- my own choice (this device; my other devices get it through the ledger) ----------

/** Whether I keep my words away from my friends' AIs. */
export function myNoAi(): boolean {
  return load<boolean>(k('noai'), false) === true;
}
export function saveMyNoAi(on: boolean) {
  save(k('noai'), on);
}

// ---------- the chat's switch: mark every message I send in this chat (this device only) ----------

export function chatNoAi(peer: string): boolean {
  return load<Record<string, boolean>>(k('noaiChats'), {})[peer] === true;
}
/** The chats where every message I send carries the noai mark (this device). */
export function noAiChats(): string[] {
  return Object.keys(load<Record<string, boolean>>(k('noaiChats'), {}));
}
export function saveChatNoAi(peer: string, on: boolean) {
  const all = { ...load<Record<string, boolean>>(k('noaiChats'), {}) };
  if (on) all[peer] = true;
  else delete all[peer];
  save(k('noaiChats'), all);
}

/** Reads `noai` from a profile card's content: true, false, or undefined when the card says nothing. */
export function profileNoAi(data: { noai?: unknown }): boolean | undefined {
  if (data.noai === true) return true;
  if (data.noai === false) return false;
  return undefined;
}
