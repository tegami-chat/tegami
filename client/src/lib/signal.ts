// Call signaling (offer, answer, ICE candidates, hang-up, decline) travels like a message:
// a rumor sealed for one person and gift-wrapped (kind 1059), so the relay sees only an
// envelope for someone. Two differences from chat messages:
// - The rumor has its own kind, so a signal never shows up as a message.
// - The wrap carries a NIP-40 expiration a minute ahead. The relay refuses to hand it out
//   after that, so a call is never kept for 30 days like a message.

import * as nip44 from 'nostr-tools/nip44';
import * as nip59 from 'nostr-tools/nip59';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';

/** Rumor kind for call signals. Not 14/15, so they are never read as chat messages. */
export const SIGNAL_KIND = 25050;
/** Seconds a signal lives. Older signals are ignored (late after a reconnect: must not ring). */
export const SIGNAL_TTL = 60;

export type Rumor = ReturnType<typeof nip59.createRumor>;

/** Seals the rumor for `to` and wraps it with an expiration tag (nip59.createWrap has no tags). */
export function wrapSignal(rumor: Rumor, secret: Uint8Array, to: string, now = Math.floor(Date.now() / 1000)) {
  const seal = nip59.createSeal(rumor, secret, to);
  const k = generateSecretKey();
  return finalizeEvent(
    {
      kind: 1059,
      created_at: now,
      tags: [
        ['p', to],
        ['expiration', String(now + SIGNAL_TTL)],
      ],
      content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(k, to)),
    },
    k,
  );
}

/** A signal is fresh when its rumor was written within SIGNAL_TTL seconds (some clock skew allowed). */
export function freshSignal(createdAt: number, now = Math.floor(Date.now() / 1000)) {
  return createdAt >= now - SIGNAL_TTL && createdAt <= now + SIGNAL_TTL;
}
