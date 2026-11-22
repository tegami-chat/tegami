// Where an AI company's API key is kept for the phone's own AI (lib/phone-ai).
//
// The key is kept on this device only, inside the same encrypted storage as the messages
// (lib/at-rest.ts: the name 'ai.apiKeys' is in SEALED_NAMES). It is not in the move to a new
// device (transfer.ts), not in the recovery backup (recovery.ts), not in the ledger between my
// devices (own-sync.ts) and not passed to other tabs (SHARED_NAMES): a key someone pays for does
// not travel with the account, so the person enters it again on each device.
//
// Callers use getKeyStore() only. When a Nostr way to keep keys across devices is agreed
// (NIP-FA, a draft), another ApiKeyStore can replace this one through setKeyStore() without
// changing the callers.

import { atRestOpen } from '../at-rest';
import { k, load, save } from '../storage';

/** The AI companies this app can call. */
export type ProviderId = 'anthropic';

export interface ApiKeyStore {
  /** Where the keys live. 'device' means this device only. */
  readonly kind: 'device';
  get(provider: ProviderId): string | null;
  /** Throws KeyStoreClosedError when the keys cannot be kept safely. */
  set(provider: ProviderId, key: string): void;
  remove(provider: ProviderId): void;
}

/** The account is not open, so a key cannot be kept encrypted: nothing is written. */
export class KeyStoreClosedError extends Error {
  constructor() {
    super('アカウントを開いてから、キーを保存してください。');
    this.name = 'KeyStoreClosedError';
  }
}

const NAME = 'ai.apiKeys';

type Keys = Partial<Record<ProviderId, string>>;

export const deviceKeyStore: ApiKeyStore = {
  kind: 'device',
  get(provider) {
    const v = load<Keys>(k(NAME), {})[provider];
    return typeof v === 'string' && v ? v : null;
  },
  set(provider, key) {
    if (!atRestOpen()) throw new KeyStoreClosedError();
    save(k(NAME), { ...load<Keys>(k(NAME), {}), [provider]: key.trim() });
  },
  remove(provider) {
    if (!atRestOpen()) return;
    const { [provider]: _, ...rest } = load<Keys>(k(NAME), {});
    save(k(NAME), rest);
  },
};

let current: ApiKeyStore = deviceKeyStore;

/** The store the phone's AI reads keys from. */
export function getKeyStore(): ApiKeyStore {
  return current;
}

/** Replaces the store (for a future cross-device store, and for tests). */
export function setKeyStore(store: ApiKeyStore) {
  current = store;
}

/** The last 4 characters, the only part of a saved key the screen shows. */
export function keyTail(key: string | null): string {
  return key ? key.slice(-4) : '';
}
