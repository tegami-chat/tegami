// What an AI friend may ask its owner's app to do, behind the AI gate (lib/ai-permissions.ts).
//
// The owner's key never leaves this app. An AI that wants something done in its owner's name
// sends the app an ask (a sealed rumor of one of the kinds below, from the AI's own key), and
// the app decides with the owner's switches:
//
//   send      the AI writes a message for one friend. With "send after checking" the message
//             waits on this device for the owner to press 送る; with "send without asking" the
//             gate lets it go (photos, files, voice and money are always asked: needsConfirm).
//             What is sent carries an ["ai", <AI key>, <model>, <name>] tag, and the friend's
//             app shows「AIが書いた」(philosophy #102).
//   contacts  the AI gets the list of friends (people only, not other AIs or blocked people).
//   otherAi   the AI may talk to another person's AI: asked once in the confirm window, kept
//             for a day or 30 days, can be taken back, with a daily limit (philosophy #84).
//
// Asks and answers expire on the relay after AI_ASK_TTL seconds, and an ask is handled once
// (its id is remembered), so opening the app again cannot send the same message twice.
//
// The same works in a 1:1 chat with a friend (philosophy #94: calling my AI into a chat needs the
// other person's yes): the "group" is then the two of us.
//
// AI in a group (philosophy #72): an invitation and every member's answer travel to every
// member (and the AI) as AI_GROUP_KIND rumors. Each member's app sends its group messages to
// the AI only while, as far as that app knows, every member has said yes; a member who says no
// (or takes it back) stops at once on their own device, and the others stop when they hear it.

import * as nip59 from 'nostr-tools/nip59';

import { switchValue, type AiPermissions } from './ai-permissions';
import { k, load, save } from './storage';

/** Rumor kinds (Tegami's own, beside the reply drafts 25060/25061). Never shown as messages. */
export const AI_SEND_ASK_KIND = 25062;
export const AI_SEND_RESULT_KIND = 25063;
export const AI_CONTACTS_ASK_KIND = 25064;
export const AI_CONTACTS_KIND = 25065;
export const AI_PEER_ASK_KIND = 25066;
export const AI_PEER_RESULT_KIND = 25067;
/**
 * A reply my AI may not send with its own key (lib/ai-hold.ts): from the AI to me, and my answer
 * back. Unlike the asks above it lives for a day, and nobody waits for the answer.
 */
export const AI_HOLD_ASK_KIND = 25071;
export const AI_HOLD_RESULT_KIND = 25072;
/** An invitation of an AI into a group, and the members' answers. Kept by the relay like messages. */
export const AI_GROUP_KIND = 10104;
/**
 * From my app to each of my AIs (すべてオフにする, and the first switch turned on again after it):
 * content {"v":1,"stop":true,"at":<unix seconds>} or {"v":1,"stop":false,"at":...}, a p tag for
 * the AI, sealed for the AI only, not expiring. The newest `at` wins. With stop true the AI stops
 * replying and sending (its own replies, its MCP tools, its talks with other AIs) until stop false.
 */
export const AI_STOP_KIND = 25069;
export const AI_ACTION_KINDS = [AI_SEND_ASK_KIND, AI_SEND_RESULT_KIND, AI_CONTACTS_ASK_KIND, AI_CONTACTS_KIND, AI_PEER_ASK_KIND, AI_PEER_RESULT_KIND, AI_HOLD_ASK_KIND, AI_GROUP_KIND];

/** Seconds an ask lives; older asks are not handled. */
export const AI_ASK_TTL = 600;
/** Messages a day between my AI and one other person's AI, both ways (philosophy #84). */
export const PEER_AI_DAILY_LIMIT = 20;
/** A message waiting for the owner to press 送る is dropped after this many seconds. */
export const PROPOSAL_TTL = 86400;
const TEXT_MAX = 2000;
const HEX = /^[0-9a-f]{64}$/;

export type Rumor = ReturnType<typeof nip59.createRumor>;

/** The "written by an AI" tag on a message: ["ai", <AI key>, <model>, <name>]. */
export function aiTag(ai: { pubkey: string; model?: string; name?: string }): string[] {
  return ['ai', ai.pubkey, (ai.model ?? '').slice(0, 60), (ai.name ?? '').slice(0, 60)];
}
/** Reads the "written by an AI" tag of a message, if any. */
export function aiOf(tags: string[][]): { pubkey: string; model?: string; name?: string } | undefined {
  const t = tags.find((x) => x[0] === 'ai' && HEX.test(x[1] ?? ''));
  if (!t) return undefined;
  return { pubkey: t[1], ...(t[2] ? { model: t[2].slice(0, 60) } : {}), ...(t[3] ? { name: t[3].slice(0, 60) } : {}) };
}

/** An ask is handled only while fresh (some clock skew allowed). */
export function freshAsk(createdAt: number, now = Math.floor(Date.now() / 1000)) {
  return createdAt >= now - AI_ASK_TTL && createdAt <= now + 60;
}

// ---------- asks handled once ----------

export function handledAsk(id: string) {
  return load<string[]>(k('ai.handled'), []).includes(id);
}
export function markHandled(id: string) {
  save(k('ai.handled'), [...load<string[]>(k('ai.handled'), []).filter((x) => x !== id), id].slice(-500));
}

// ---------- reading asks ----------

/** readOthers is false only when the AI's program says so (Agents Rule of Two); left out counts as read. */
export function parseSendAsk(content: string): { to: string; text: string; readOthers: boolean } | null {
  try {
    const a = JSON.parse(content) as { v?: unknown; to?: unknown; text?: unknown; readOthers?: unknown };
    if (a.v !== 1 || typeof a.to !== 'string' || !HEX.test(a.to) || typeof a.text !== 'string' || !a.text.trim()) return null;
    return { to: a.to, text: a.text.slice(0, TEXT_MAX), readOthers: a.readOthers !== false };
  } catch {
    return null;
  }
}

export function parsePeerAsk(content: string): { pubkey: string; name?: string; model?: string } | null {
  try {
    const a = JSON.parse(content) as { v?: unknown; peer?: { pubkey?: unknown; name?: unknown; model?: unknown } };
    const p = a.peer;
    if (a.v !== 1 || !p || typeof p.pubkey !== 'string' || !HEX.test(p.pubkey)) return null;
    return {
      pubkey: p.pubkey,
      ...(typeof p.name === 'string' && p.name ? { name: p.name.slice(0, 60) } : {}),
      ...(typeof p.model === 'string' && p.model ? { model: p.model.slice(0, 60) } : {}),
    };
  } catch {
    return null;
  }
}

// ---------- messages waiting for the owner (send after checking) ----------

/** askAt: when the AI asked (the sent message gets this time, so two devices build the same one). */
export type AiProposal = { id: string; ai: string; to: string; text: string; at: number; askAt?: number };

export function loadProposals(now = Math.floor(Date.now() / 1000)): AiProposal[] {
  return load<AiProposal[]>(k('ai.proposals'), []).filter((p) => p && now - p.at < PROPOSAL_TTL);
}
export function saveProposals(list: AiProposal[]) {
  save(k('ai.proposals'), list.slice(-50));
}

// ---------- other people's AIs my AI may talk to ----------

/** Names of other people's AIs, as my AI gave them, to show instead of keys. */
export function peerAiNames(): Record<string, { name?: string; model?: string }> {
  return load(k('ai.peerNames'), {});
}
export function rememberPeerAi(pubkey: string, info: { name?: string; model?: string }) {
  const all = peerAiNames();
  const keys = Object.keys(all);
  if (keys.length >= 500 && !all[pubkey]) delete all[keys[0]];
  save(k('ai.peerNames'), { ...all, [pubkey]: info });
}

// ---------- AI in a group ----------

export type AiGroupAnswer = { yes: boolean; at: number };
export type AiInGroup = { name: string; model?: string; by: string; at: number; answers: Record<string, AiGroupAnswer> };
/** Keyed by everyone in the group (sorted, joined with ','), then by the AI's key. */
export type AiGroups = Record<string, Record<string, AiInGroup>>;

export type AiGroupRumor =
  | { t: 'invite'; members: string[]; ai: string; name: string; model?: string }
  | { t: 'answer'; members: string[]; ai: string; yes: boolean };

export function parseAiGroup(content: string): AiGroupRumor | null {
  try {
    const r = JSON.parse(content) as Record<string, unknown>;
    const members = Array.isArray(r.members) ? r.members.filter((m): m is string => typeof m === 'string' && HEX.test(m)) : [];
    if (members.length < 2 || members.length > 100 || typeof r.ai !== 'string' || !HEX.test(r.ai) || members.includes(r.ai)) return null;
    const sorted = [...new Set(members)].sort();
    if (r.t === 'invite' && typeof r.name === 'string')
      return { t: 'invite', members: sorted, ai: r.ai, name: r.name.slice(0, 60), ...(typeof r.model === 'string' && r.model ? { model: r.model.slice(0, 60) } : {}) };
    if (r.t === 'answer' && typeof r.yes === 'boolean') return { t: 'answer', members: sorted, ai: r.ai, yes: r.yes };
    return null;
  } catch {
    return null;
  }
}

export function loadAiGroups(): AiGroups {
  return load<AiGroups>(k('ai.groups'), {});
}

/**
 * Applies an invitation or an answer written by `from` at `at`. Only a member can write; the
 * one who invites says yes by inviting. A newer answer of the same member replaces an older one.
 */
export function applyAiGroup(all: AiGroups, r: AiGroupRumor, from: string, at: number): AiGroups {
  if (!r.members.includes(from)) return all;
  const everyone = r.members.join(',');
  const cur = all[everyone]?.[r.ai];
  let next: AiInGroup;
  if (r.t === 'invite') {
    // A new invitation starts over (an older one may have been answered no).
    if (cur && cur.at >= at) return all;
    next = { name: r.name, ...(r.model ? { model: r.model } : {}), by: from, at, answers: { [from]: { yes: true, at } } };
  } else {
    if (!cur || at < cur.at) return all;
    if ((cur.answers[from]?.at ?? -1) > at) return all;
    next = { ...cur, answers: { ...cur.answers, [from]: { yes: r.yes, at } } };
  }
  return { ...all, [everyone]: { ...all[everyone], [r.ai]: next } };
}

/** Everyone in a group as seen from me: the chat id plus my own key. */
export function everyoneIn(room: string, me: string) {
  return [...new Set([...room.split(','), me])].sort().join(',');
}

/** Every member has said yes, and nobody has taken it back. */
export function aiApproved(entry: AiInGroup | undefined, everyone: string) {
  if (!entry) return false;
  return everyone.split(',').every((m) => entry.answers[m]?.yes === true);
}

/** The AIs that are in this group chat now (every member said yes). */
export function approvedAis(all: AiGroups, room: string, me: string): string[] {
  const everyone = everyoneIn(room, me);
  return Object.entries(all[everyone] ?? {})
    .filter(([, e]) => aiApproved(e, everyone))
    .map(([ai]) => ai);
}

/**
 * The group chat a message written by an AI belongs to: the members it was written for, when
 * that AI is in that group as far as I know. 'drop' when the writer is an AI invited to that
 * group but not every member has said yes (nobody should have sent it anything yet).
 */
export function groupOfAiMessage(all: AiGroups, author: string, othersWithoutAuthor: string[], me: string): string | 'drop' | null {
  const room = [...new Set(othersWithoutAuthor)].sort().join(',');
  if (!room) return null;
  const everyone = everyoneIn(room, me);
  const entry = all[everyone]?.[author];
  if (!entry) return null;
  return aiApproved(entry, everyone) ? room : 'drop';
}

/**
 * Whether the owner's switches let one of my own AI friends read my messages at all ("AI の使用",
 * its model and the AI itself, for reading). Used for my messages in a group the AI was invited to.
 */
export function myAiMayRead(p: AiPermissions, ai: { pubkey: string; model?: string }) {
  return (
    switchValue(p, { layer: 'all' }, 'read') &&
    (!ai.model || switchValue(p, { layer: 'model', id: ai.model }, 'read')) &&
    switchValue(p, { layer: 'ai', id: ai.pubkey }, 'read')
  );
}
