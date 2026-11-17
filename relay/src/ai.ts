// AI keys: how much an AI may send, counted at the relay (concern 3).
//
// The app limits what an AI sends (client/src/lib/ai-permissions.ts: 5 a minute, 100 a day),
// and so does the official agent. A changed app or a changed agent can skip both, so the relay
// counts too. The relay cannot see inside an envelope (kind 1059), so it cannot tell which
// messages an AI wrote. Instead an AI's key says so itself: it registers as an AI with its owner
// card (POST /register {ai_card}), the kind 25070 event its owner's key signed for it
// (client/src/lib/ai-owner.ts). From then on the key is an AI key for good, and every envelope
// it publishes is counted against it and against its owner.
//
// What this does not stop: an AI that never declares itself. Its key then looks like a person's
// and gets a person's limits (index.ts RATE). The app of whoever receives its messages shows
// 「持ち主：未確認」 when an 'ai' tag carries no good card, so an undeclared AI cannot claim an
// owner. The relay does not check the 'ai' tag (it is inside the envelope) and the app does not
// ask the relay whether a sender declared itself.
//
// The AI follows its owner: when the operator stops the owner, the owner's AI keys are stopped
// too (with or without --invitees), and let back with the owner unless the operator stopped one
// by itself. When the owner deletes their account, the AI keys are stopped for good.
//
// Kept: the AI key, its owner's key and when it registered (ai_keys, as long as the relay runs;
// the row goes when the AI's account is deleted), the operator's per-owner limit if changed
// (ai_owner_limits), and how many envelopes each AI key and each owner published per UTC day
// (ai_counts, two days).
import { verifyEvent, type NostrEvent } from 'nostr-tools/pure';

export const OWNER_CARD_KIND = 25070;

// The app counts messages; the relay counts envelopes. One message is one envelope per member
// plus one for the sender's other devices, so a message to a group of five is six envelopes.
// Six times the app's numbers (5 a minute, 100 a day) lets an AI that keeps to the app's limits
// write to a group of five without ever reaching the relay's.
/** Envelopes one AI key may publish in a minute (a burst of 30, then one every 2 seconds). */
export const AI_PER_MINUTE = 30;
/** Envelopes one AI key may publish in a UTC day. */
export const AI_PER_DAY = 600;
/** Envelopes all of one owner's AI keys together may publish in a UTC day (the operator can change it per owner). */
export const AI_OWNER_PER_DAY = 600;

/** ai_keys.held: stopped because the owner was stopped (let back with the owner). */
export const HELD_OWNER_BANNED = 1;
/** ai_keys.held: stopped because the owner deleted their account (for good). */
export const HELD_OWNER_DELETED = 2;

const HEX = /^[0-9a-f]{64}$/;

function now() {
  return Math.floor(Date.now() / 1000);
}
const today = (t = now()) => Math.floor(t / 86400);

/**
 * The owner of AI key `ai` by this card, or why not. Read back from text: nostr-tools marks an
 * event it checked as verified and a copy keeps the mark, so never trust an object's mark.
 */
export function checkAiCard(raw: unknown, ai: string, t = now()): { owner: string } | { error: string } {
  let ev: NostrEvent;
  try {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (!text || text.length > 2000) return { error: 'ai-card-invalid' };
    ev = JSON.parse(text);
  } catch {
    return { error: 'ai-card-invalid' };
  }
  if (!ev || typeof ev !== 'object' || ev.kind !== OWNER_CARD_KIND || !HEX.test(ev.pubkey ?? '') || !Array.isArray(ev.tags)) {
    return { error: 'ai-card-invalid' };
  }
  if (ev.pubkey === ai) return { error: 'ai-card-self' };
  const p = ev.tags.filter((x) => Array.isArray(x) && x[0] === 'p');
  if (p.length !== 1 || p[0][1] !== ai) return { error: 'ai-card-other-key' };
  const until = Number(ev.tags.find((x) => Array.isArray(x) && x[0] === 'expiration')?.[1]);
  if (!Number.isInteger(until) || until <= t) return { error: 'ai-card-expired' };
  if (!Number.isInteger(ev.created_at) || ev.created_at > t + 600) return { error: 'ai-card-invalid' };
  try {
    if (!verifyEvent(ev)) return { error: 'ai-card-bad-signature' };
  } catch {
    return { error: 'ai-card-bad-signature' };
  }
  return { owner: ev.pubkey };
}

export class AiKeys {
  constructor(private sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS ai_keys (pubkey TEXT PRIMARY KEY, owner TEXT, created_at INTEGER)');
    sql.exec('CREATE INDEX IF NOT EXISTS ai_keys_owner ON ai_keys (owner)');
    // held: why the AI key is stopped because of its owner. 0 not for that, HELD_OWNER_BANNED,
    // or HELD_OWNER_DELETED. A key the operator stopped by itself has 0, so it stays stopped
    // when its owner is let back.
    try {
      sql.exec('ALTER TABLE ai_keys ADD COLUMN held INTEGER DEFAULT 0');
    } catch {
      // Already there.
    }
    sql.exec('CREATE TABLE IF NOT EXISTS ai_owner_limits (owner TEXT PRIMARY KEY, per_day INTEGER)');
    // k: 'ai:<key>' or 'owner:<key>'; day: days since 1970 (UTC).
    sql.exec('CREATE TABLE IF NOT EXISTS ai_counts (k TEXT, day INTEGER, n INTEGER, PRIMARY KEY (k, day))');
  }

  /** The owner of this AI key, or null when the key never registered as an AI. */
  owner(pubkey: string): string | null {
    return (this.sql.exec('SELECT owner FROM ai_keys WHERE pubkey = ?', pubkey).toArray()[0]?.owner as string | undefined) ?? null;
  }

  /**
   * Marks `pubkey` as an AI of `owner`. Once an AI, always an AI, and always the same owner (so a
   * new card cannot move its count to someone else). Returns false when it already has another owner.
   */
  declare(pubkey: string, owner: string): boolean {
    const cur = this.owner(pubkey);
    if (cur) return cur === owner;
    this.sql.exec('INSERT INTO ai_keys (pubkey, owner, created_at) VALUES (?, ?, ?)', pubkey, owner, now());
    return true;
  }

  ownerLimit(owner: string): number {
    return (this.sql.exec('SELECT per_day FROM ai_owner_limits WHERE owner = ?', owner).toArray()[0]?.per_day as number | undefined) ?? AI_OWNER_PER_DAY;
  }

  count(k: string, day = today()): number {
    return (this.sql.exec('SELECT n FROM ai_counts WHERE k = ? AND day = ?', k, day).toArray()[0]?.n as number | undefined) ?? 0;
  }

  /** Why this AI may not publish another envelope today ('' when it may). Counts nothing. */
  dayFull(pubkey: string, owner: string): string {
    if (this.count(`ai:${pubkey}`) >= AI_PER_DAY) return 'rate-limited: ai-day: this AI sent its envelopes for today';
    if (this.count(`owner:${owner}`) >= this.ownerLimit(owner)) return "rate-limited: ai-owner-day: the owner's AIs sent their envelopes for today";
    return '';
  }

  /** Counts one published envelope for the AI and its owner. */
  add(pubkey: string, owner: string) {
    const d = today();
    for (const k of [`ai:${pubkey}`, `owner:${owner}`]) {
      this.sql.exec('INSERT INTO ai_counts (k, day, n) VALUES (?, ?, 1) ON CONFLICT (k, day) DO UPDATE SET n = n + 1', k, d);
    }
  }

  /** Counts older than yesterday are not needed. */
  forgetOld() {
    this.sql.exec('DELETE FROM ai_counts WHERE day < ?', today() - 1);
  }

  /**
   * Stops every AI key of `owner` that is not stopped already (the owner was stopped or deleted
   * its account: an AI is part of its owner, so it cannot go on sending alone). Returns how many.
   */
  holdAisOf(owner: string, why: number): number {
    let n = 0;
    for (const r of this.sql.exec('SELECT pubkey, held FROM ai_keys WHERE owner = ?', owner).toArray()) {
      const k = r.pubkey as string;
      // Already held for the owner's ban and now the owner is gone: never let back.
      if (why === HELD_OWNER_DELETED && r.held === HELD_OWNER_BANNED) {
        this.sql.exec('UPDATE ai_keys SET held = ? WHERE pubkey = ?', why, k);
        continue;
      }
      if (!this.sql.exec('UPDATE members SET banned = 1 WHERE pubkey = ? AND banned = 0', k).rowsWritten) continue;
      this.sql.exec('UPDATE ai_keys SET held = ? WHERE pubkey = ?', why, k);
      n++;
    }
    return n;
  }

  /** Lets back the AI keys that were stopped only because their owner was stopped. Returns how many. */
  releaseAisOf(owner: string): number {
    let n = 0;
    for (const r of this.sql.exec('SELECT pubkey FROM ai_keys WHERE owner = ? AND held = ?', owner, HELD_OWNER_BANNED).toArray()) {
      const k = r.pubkey as string;
      if (this.sql.exec('UPDATE members SET banned = 0 WHERE pubkey = ? AND banned = 1', k).rowsWritten) n++;
      this.sql.exec('UPDATE ai_keys SET held = 0 WHERE pubkey = ?', k);
    }
    return n;
  }

  /** The operator stopped or let back this key by itself: no longer held for its owner. */
  clearHold(pubkey: string) {
    this.sql.exec('UPDATE ai_keys SET held = 0 WHERE pubkey = ?', pubkey);
  }

  /** The AI's account was deleted. */
  forget(pubkey: string) {
    this.sql.exec('DELETE FROM ai_keys WHERE pubkey = ?', pubkey);
    this.sql.exec('DELETE FROM ai_counts WHERE k = ?', `ai:${pubkey}`);
  }

  /** For the operator: owners with their number of AI keys, today's count and limit. No AI keys listed. */
  list() {
    const d = today();
    return this.sql
      .exec('SELECT owner, COUNT(*) AS ais FROM ai_keys GROUP BY owner ORDER BY ais DESC LIMIT 500')
      .toArray()
      .map((r) => ({ owner: r.owner as string, ais: r.ais as number, today: this.count(`owner:${r.owner}`, d), per_day: this.ownerLimit(r.owner as string) }));
  }

  /** For the operator: the AI keys of one owner. */
  ofOwner(owner: string) {
    return this.sql
      .exec('SELECT pubkey, created_at FROM ai_keys WHERE owner = ?', owner)
      .toArray()
      .map((r) => ({ pubkey: r.pubkey as string, created_at: r.created_at as number, today: this.count(`ai:${r.pubkey}`) }));
  }

  /** The operator changes one owner's daily total. Null when the number is not allowed. */
  setOwnerLimit(owner: string, n: unknown): number | null {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 100_000) return null;
    this.sql.exec('INSERT INTO ai_owner_limits (owner, per_day) VALUES (?, ?) ON CONFLICT (owner) DO UPDATE SET per_day = ?', owner, n, n);
    return 1;
  }
}
