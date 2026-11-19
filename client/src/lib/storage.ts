// Local storage on this device. Messages and contacts never leave the device
// except as encrypted gift wraps sent through the relay.
// TODO(native): use expo-secure-store for the key and a database for messages.
//
// One browser can hold several accounts (lib/accounts.ts). Everything an account keeps
// is stored under its own names: the first account keeps the names it always had
// ("tegami.vault", "tegami.messages" …), so nothing is moved or copied; an account added
// later uses "tegami@<id>.vault" and so on. Only device-wide choices use fixed names.

import { isSealedKey, removeSealed, saveSealed, sealedRaw } from './at-rest';
import { FIRST_ACCOUNT, keyFor } from './store-names';

export { FIRST_ACCOUNT, keyFor };

// Names that hold a person's words (messages, friends, groups …) are kept encrypted, not in
// localStorage (lib/at-rest.ts): load/save/remove send them there. Before the account is
// open they read as empty and a save is dropped.

let account = FIRST_ACCOUNT;

/** Which account the account-scoped names point at. Set before the account's screens mount. */
export function setStorageAccount(id: string) {
  account = id;
}
export function storageAccount() {
  return account;
}

/** The storage name of `name` for the current account. */
export function k(name: string) {
  return keyFor(account, name);
}

/** The stored text of a name, to tell whether it changed (null when none). */
export function rawOf(key: string): string | null {
  if (isSealedKey(key)) return sealedRaw(key);
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function load<T>(key: string, fallback: T): T {
  if (isSealedKey(key)) {
    try {
      const raw = sealedRaw(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  }
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  if (isSealedKey(key)) {
    try {
      saveSealed(key, JSON.stringify(value));
    } catch {
      // A value that cannot be written as JSON is not kept.
    }
    return;
  }
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private mode). The app keeps working in memory.
  }
}

export function remove(key: string) {
  if (isSealedKey(key)) {
    removeSealed(key);
    return;
  }
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // Storage unavailable: nothing to remove.
  }
}
