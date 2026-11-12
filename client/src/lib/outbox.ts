// Messages waiting to be sent (philosophy #78: written offline, sent when the connection returns).
//
// Each message is sealed and wrapped once, when it is written. The finished envelopes are
// kept on this device and sent as they are, so a retry never makes a second copy: the relay
// and the other person see the same envelope id and the same message id. Each envelope is
// marked done when the relay says OK and is never sent again after that.
// The copy for my own devices goes last: while a message is waiting, it is on none of them.

import type { NostrEvent, EventTemplate } from 'nostr-tools/core';
import type { SimplePool } from 'nostr-tools/pool';
import type { finalizeEvent } from 'nostr-tools/pure';

import { load, save } from './storage';

export type Outgoing = {
  /** The message id in the chat: the rumor id, or "local:…" for a photo not uploaded yet. */
  id: string;
  peer: string;
  /** created_at of the rumor (unix seconds). */
  at: number;
  /** Envelopes in sending order: the other people first, my own copy last. Empty until a photo is uploaded. */
  wraps: NostrEvent[];
  /** Ids of the envelopes the relay accepted. */
  done: string[];
  /** A photo whose upload has not succeeded. Its bytes are kept on this device under id. */
  photo?: { type: string; dim: string; size: number };
};

const KEY = 'tegami.outbox';

export function loadOutbox(): Outgoing[] {
  return load<Outgoing[]>(KEY, []);
}

export function saveOutbox(list: Outgoing[]) {
  save(KEY, list);
}

/** Retry waits: 2 s, 4 s, 8 s … up to a minute. */
export function backoff(failures: number) {
  return Math.min(60_000, 2000 * 2 ** Math.max(0, failures - 1));
}

type Auth = (t: EventTemplate) => Promise<ReturnType<typeof finalizeEvent>>;

/** Sends one envelope. True when at least one relay accepted it. Never throws. */
export async function publishOne(pool: SimplePool, relays: string[], wrap: NostrEvent, onauth: Auth | undefined, ms = 15_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sent = Promise.any(pool.publish(relays, wrap, { onauth }));
    const late = new Promise<never>((_, fail) => {
      timer = setTimeout(() => fail(new Error('timeout')), ms);
    });
    await Promise.race([sent, late]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
