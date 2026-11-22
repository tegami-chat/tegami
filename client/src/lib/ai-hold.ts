// A reply my AI friend may not send with its own key (agent/lib.mjs askOwnerToSend): the AI's
// check stopped it, or it has money, a file or a link, or it is the first reply to that person.
// It waits on this device until I press 送る (it is sent in my name, with the mark that an AI wrote
// it) or 送らない. Not like lib/ai-actions.ts's send ask: the AI does not wait for the answer, and
// the ask stays on the relay for a day (HOLD_TTL), so a computer that was off still gets it.
//
//   AI to me   AI_HOLD_ASK_KIND    {v:1, id, to, toName?, text, reason, detail?, inReplyTo?}
//   me to AI   AI_HOLD_RESULT_KIND {id, result: sent | declined | secret | stopped | expired}
//
// Nothing here widens the gate: I press 送る myself, so the "send without asking" switch is not
// asked, but a secret is stopped again just before sending, and "すべてオフにする" stops it all.

import { AI_HOLD_ASK_KIND, AI_HOLD_RESULT_KIND, aiTag } from './ai-actions';
import { findSecret } from './ai-screen';
import { k, load, save } from './storage';

export { AI_HOLD_ASK_KIND, AI_HOLD_RESULT_KIND };
/** Seconds an ask lives on the relay and on this device. */
export const HOLD_TTL = 86400;
const TEXT_MAX = 5000;
const HEX = /^[0-9a-f]{64}$/;

export type HoldReason = 'CHECK' | 'MONEY' | 'FILE' | 'LINK' | 'FIRST';
export type HoldResult = 'sent' | 'declined' | 'secret' | 'stopped' | 'expired';
const REASONS: HoldReason[] = ['CHECK', 'MONEY', 'FILE', 'LINK', 'FIRST'];

/** at: when I got it; askAt: when the AI asked (the sent message gets this time, so two devices build the same one). */
export type AiHold = { id: string; ai: string; to: string; toName?: string; text: string; reason: HoldReason; detail?: string; inReplyTo?: string; at: number; askAt: number };

export function parseHoldAsk(content: string): Omit<AiHold, 'ai' | 'at' | 'askAt'> | null {
  try {
    const a = JSON.parse(content) as Record<string, unknown>;
    if (a.v !== 1 || typeof a.id !== 'string' || !/^[0-9a-f]{8,64}$/.test(a.id)) return null;
    if (typeof a.to !== 'string' || !HEX.test(a.to) || typeof a.text !== 'string' || !a.text.trim()) return null;
    if (typeof a.reason !== 'string' || !REASONS.includes(a.reason as HoldReason)) return null;
    return {
      id: a.id,
      to: a.to,
      text: a.text.slice(0, TEXT_MAX),
      reason: a.reason as HoldReason,
      ...(typeof a.toName === 'string' && a.toName ? { toName: a.toName.slice(0, 60) } : {}),
      ...(typeof a.detail === 'string' && a.detail ? { detail: a.detail.slice(0, 200) } : {}),
      ...(typeof a.inReplyTo === 'string' && HEX.test(a.inReplyTo) ? { inReplyTo: a.inReplyTo } : {}),
    };
  } catch {
    return null;
  }
}

/** An ask of this kind is fresh for a day (some clock skew allowed). */
export function freshHold(createdAt: number, now = Math.floor(Date.now() / 1000)) {
  return createdAt >= now - HOLD_TTL && createdAt <= now + 60;
}

export function loadHolds(now = Math.floor(Date.now() / 1000)): AiHold[] {
  return load<AiHold[]>(k('ai.holds'), []).filter((h) => h && now - h.at < HOLD_TTL);
}
export function saveHolds(list: AiHold[]) {
  save(k('ai.holds'), list.slice(-50));
}

/** Takes out the asks older than a day. `expired` are the ones taken out, so the AI can be told. */
export function expireHolds(list: AiHold[], now = Math.floor(Date.now() / 1000)): { holds: AiHold[]; expired: AiHold[] } {
  const expired = list.filter((h) => now - h.at >= HOLD_TTL);
  return expired.length ? { holds: list.filter((h) => now - h.at < HOLD_TTL), expired } : { holds: list, expired };
}

/**
 * My AI's ask arrived. A secret in the words is dropped ('secret'); with all AIs stopped it is
 * dropped ('stopped'); otherwise it joins the list (no result yet: it waits for me). One chat has
 * one open ask per AI: a newer one replaces the older.
 */
export function receiveHold(
  list: AiHold[],
  ai: { pubkey: string },
  rumor: { id: string; content: string; created_at: number },
  { stopped, now = Math.floor(Date.now() / 1000) }: { stopped: boolean; now?: number },
): { holds: AiHold[]; id?: string; result?: HoldResult } {
  const a = parseHoldAsk(rumor.content);
  if (!a) return { holds: list };
  if (stopped) return { holds: list, id: a.id, result: 'stopped' };
  if (findSecret(a.text)) return { holds: list, id: a.id, result: 'secret' };
  if (list.some((h) => h.id === a.id)) return { holds: list, id: a.id };
  const next: AiHold = { ...a, ai: ai.pubkey, at: now, askAt: rumor.created_at };
  return { holds: [...list.filter((h) => !(h.ai === ai.pubkey && h.to === a.to)), next], id: a.id };
}

/** What is sent when I press 送る: in my name, to `to`, with the mark that my AI wrote it. */
export function holdSendPlan(h: AiHold, ai: { pubkey: string; model?: string; name?: string }) {
  const by = { pubkey: ai.pubkey, ...(ai.model ? { model: ai.model } : {}), ...(ai.name ? { name: ai.name } : {}) };
  return { to: h.to, text: h.text, tags: [aiTag(by)], at: h.askAt, ai: by };
}

/**
 * 送る: the ask leaves the list either way. It is sent only while my AI is still my AI, nothing is
 * stopped, the ask is not older than a day and the words carry no secret (checked again now).
 */
export function acceptHold(
  list: AiHold[],
  id: string,
  ai: { pubkey: string; model?: string; name?: string } | undefined,
  send: (plan: ReturnType<typeof holdSendPlan>) => void,
  { stopped, now = Math.floor(Date.now() / 1000) }: { stopped: boolean; now?: number },
): { holds: AiHold[]; result?: HoldResult; ai?: string } {
  const h = list.find((x) => x.id === id);
  if (!h) return { holds: list };
  const holds = list.filter((x) => x.id !== id);
  if (now - h.at >= HOLD_TTL) return { holds, result: 'expired', ai: h.ai };
  if (stopped || !ai || ai.pubkey !== h.ai) return { holds, result: 'stopped', ai: h.ai };
  if (findSecret(h.text)) return { holds, result: 'secret', ai: h.ai };
  send(holdSendPlan(h, ai));
  return { holds, result: 'sent', ai: h.ai };
}

/** 送らない. */
export function declineHold(list: AiHold[], id: string): { holds: AiHold[]; hold?: AiHold } {
  const hold = list.find((x) => x.id === id);
  return hold ? { holds: list.filter((x) => x.id !== id), hold } : { holds: list };
}

/** The heading of a waiting reply, by why it waits. */
export const HOLD_TITLES: Record<HoldReason, string> = {
  CHECK: '安全の確認で止めた返事',
  MONEY: 'お金の話が入った返事',
  FILE: 'ファイルが入った返事',
  LINK: 'リンクが入った返事',
  FIRST: '初めての相手への返事',
};

/** known: the one it is for is in my friends (otherwise `to` is the short form of the key, with no さん). */
export function holdExplain(aiName: string, to: string, known: boolean) {
  return `${aiName}が${to}${known ? 'さん' : ''}に送ろうとしています。送ると、あなたの名前で届き、相手の画面には「AIが書いた」と出ます。`;
}
