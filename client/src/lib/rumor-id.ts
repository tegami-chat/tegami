import { getEventHash, type UnsignedEvent } from 'nostr-tools/pure';

/** True when a rumor's id is the hash of its own content (the sender wrote the id, so check it). */
export function rumorIdMatches(rumor: UnsignedEvent & { id: string }): boolean {
  try {
    return getEventHash(rumor) === rumor.id;
  } catch {
    return false;
  }
}
