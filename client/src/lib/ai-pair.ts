// Pairing with an AI on my computer by QR code (agent/ `tegami-agent pair`).
//
// The AI shows its invite link with a one-time code (&p=). When I add the AI from that link,
// the app sends the code and my own invite link back to the AI, sealed for the AI only. The
// AI then knows I am its owner (it replies to me) and registers with the invite code in my
// link. Someone who reads the same QR code later gets nothing: the code works once, for a
// few minutes, and the AI shows on the computer who it paired with.

import * as nip59 from 'nostr-tools/nip59';

import { wrapExpiring } from './ai-draft';

/** Rumor kind (Tegami's own, next to the reply drafts). Never shown as a message. */
export const AI_PAIR_KIND = 25068;

/** The one-time pairing code in an AI's invite link, or ''. */
export function pairCodeOf(input: string): string {
  const m = input.match(/[#&]p=([a-z2-7]{16})(?:&|\s|$)/);
  return m ? m[1] : '';
}

/** The sealed answer to an AI's pairing code: for the AI only, gone from the relay in 10 minutes. */
export function pairWrap(secret: Uint8Array, ai: string, code: string, myInvite: string) {
  const rumor = nip59.createRumor(
    { kind: AI_PAIR_KIND, content: JSON.stringify({ v: 1, code, invite: myInvite }), tags: [['p', ai]], created_at: Math.floor(Date.now() / 1000) },
    secret,
  );
  return wrapExpiring(rumor, secret, ai);
}
