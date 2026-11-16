// The owner's signature on an AI's key (concern 4). A model name in an invite link is only what
// an AI says of itself; this card is what its owner says, and anyone can check it with the
// owner's public key alone.
//
// The card is a Nostr event signed by the owner's key, never published on its own:
//   { kind: 25070, content: '', tags: [['p', <the AI's key>], ['expiration', <unix>]] }
// The owner's app hands it to the AI (rumor kind 25070, {"v":1,"card":<event>} or
// {"v":1,"card":null} when the mark「自分のAI」is taken away), and signs a new one before the
// old one runs out. The AI (agent/lib.mjs) puts it as the fifth element of the 'ai' tag on every
// message it writes as itself; a message with the 'ai' tag and no card says "no owner now".
import { verifyEvent, type Event } from 'nostr-tools/pure';

export const OWNER_CARD_KIND = 25070;
/** How long one card is good for. */
export const OWNER_CARD_TTL = 30 * 24 * 3600;
/** The owner's app signs a new card when the last one is older than this. */
export const OWNER_CARD_RENEW = 10 * 24 * 3600;

const HEX = /^[0-9a-f]{64}$/;

/** What an app keeps of a checked card: whose AI it is, when it was signed and until when. */
export type OwnerMark = { pubkey: string; at: number; until: number };

/** The card the owner signs for one AI (an event template; the app signs it with finalizeEvent). */
export function ownerCardTemplate(ai: string, now = Math.floor(Date.now() / 1000)) {
  return { kind: OWNER_CARD_KIND, created_at: now, content: '', tags: [['p', ai], ['expiration', String(now + OWNER_CARD_TTL)]] };
}

/**
 * Checks a card for the AI `ai`: the owner's signature, that it names this AI, and that it has
 * not run out. Returns who the owner is, or null. `raw` is the card as JSON text or as an object.
 */
export function checkOwnerCard(raw: unknown, ai: string, now = Math.floor(Date.now() / 1000)): OwnerMark | null {
  // Always read back from text: nostr-tools marks an event it signed or checked as "verified",
  // and a copy keeps that mark, so a card changed after signing would pass on an object.
  let ev: unknown;
  try {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (!text || text.length > 2000) return null;
    ev = JSON.parse(text);
  } catch {
    return null;
  }
  if (!ev || typeof ev !== 'object') return null;
  const e = ev as Event;
  if (e.kind !== OWNER_CARD_KIND || !HEX.test(e.pubkey ?? '') || !Array.isArray(e.tags)) return null;
  // An AI cannot be its own owner.
  if (e.pubkey === ai) return null;
  const p = e.tags.filter((t) => Array.isArray(t) && t[0] === 'p');
  if (p.length !== 1 || p[0][1] !== ai) return null;
  const until = Number(e.tags.find((t) => Array.isArray(t) && t[0] === 'expiration')?.[1]);
  if (!Number.isInteger(until) || until <= now) return null;
  if (!Number.isInteger(e.created_at) || e.created_at > now + 600) return null;
  try {
    if (!verifyEvent(e)) return null;
  } catch {
    return null;
  }
  return { pubkey: e.pubkey, at: e.created_at, until };
}

/**
 * What a message from AI `ai` (written as itself) says about its owner:
 * a checked card, 'none' (the 'ai' tag has no card: no owner now), or undefined (nothing usable:
 * not an AI's own message, or a card that does not check out, which changes nothing).
 */
export function ownerOfMessage(tags: string[][], ai: string, now?: number): OwnerMark | 'none' | undefined {
  const t = tags.find((x) => x[0] === 'ai' && x[1] === ai);
  if (!t) return undefined;
  if (!t[4]) return 'none';
  return checkOwnerCard(t[4], ai, now) ?? undefined;
}

/** The owner mark still good now. */
export function liveOwner(o: OwnerMark | undefined, now = Math.floor(Date.now() / 1000)) {
  return o && o.pubkey && o.until > now ? o : undefined;
}
