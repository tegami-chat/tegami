// Local storage on this device. Messages and contacts never leave the device
// except as encrypted gift wraps sent through the relay.
// TODO(native): use expo-secure-store for the key and a database for messages.
//
// One browser can hold several accounts (lib/accounts.ts). Everything an account keeps
// is stored under its own names: the first account keeps the names it always had
// ("tegami.vault", "tegami.messages" …), so nothing is moved or copied; an account added
// later uses "tegami@<id>.vault" and so on. Only device-wide choices use fixed names.

export const FIRST_ACCOUNT = 'main';
let account = FIRST_ACCOUNT;

/** Which account the account-scoped names point at. Set before the account's screens mount. */
export function setStorageAccount(id: string) {
  account = id;
}
export function storageAccount() {
  return account;
}

/** The storage name of `name` for an account (the current one by default). */
export function keyFor(id: string, name: string) {
  return id === FIRST_ACCOUNT ? `tegami.${name}` : `tegami@${id}.${name}`;
}
/** The storage name of `name` for the current account. */
export function k(name: string) {
  return keyFor(account, name);
}

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private mode). The app keeps working in memory.
  }
}

export function remove(key: string) {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // Storage unavailable: nothing to remove.
  }
}
