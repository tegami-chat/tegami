// Several accounts in one browser (philosophy #4: LINE allows only one).
//
// The list lives under "tegami.accounts". Each entry has a local id (it names the
// account's storage, lib/storage.ts), and the public key and name last seen while the
// account was open, so the list can show who is who without opening each account.
// Public keys and names are not secret; the keys themselves stay in each account's vault.
//
// Only one account is open at a time: the app connects to the relay with that account's
// key, and switching remounts the whole app on the other account. Opening every account
// at once would mean asking for every passkey each time the app opens.

import { useEffect, useState, useSyncExternalStore } from 'react';

import { FIRST_ACCOUNT, keyFor, load, remove, save, setStorageAccount } from './storage';
import { newMarks, shareAccounts } from './sw-store';

export type AccountEntry = { id: string; pubkey?: string; name?: string };
type Index = { v: 1; current: string; list: AccountEntry[]; back?: string };

const INDEX = 'tegami.accounts';

/** Names an account keeps (without the prefix). Used to tell an account with data from an empty one. */
const KEY_NAMES = ['vault', 'device', 'account'];

let index: Index = read();
openFromAddress();
setStorageAccount(index.current);
const listeners = new Set<() => void>();

function read(): Index {
  const i = load<Index | null>(INDEX, null);
  if (i && i.v === 1 && Array.isArray(i.list) && i.list.some((a) => a.id === i.current)) return i;
  return { v: 1, current: FIRST_ACCOUNT, list: [{ id: FIRST_ACCOUNT }] };
}

function write(next: Index) {
  index = next;
  save(INDEX, next);
  share();
  for (const fn of listeners) fn();
}

/** Tells the service worker who is who, so a notification can carry the account's name. */
function share() {
  void shareAccounts(index.list.filter((a) => a.pubkey).map((a) => ({ pubkey: a.pubkey!, name: a.name ?? '' })));
}

/**
 * A notification tapped while the app was closed opens /?a=<public key>: start on that
 * account. The address is put back to / at once (the key is public, but it need not stay).
 */
function openFromAddress() {
  if (typeof window === 'undefined') return;
  const a = new URLSearchParams(window.location.search).get('a');
  if (a === null) return;
  const entry = index.list.find((x) => x.pubkey === a);
  if (entry && entry.id !== index.current) index = { ...index, current: entry.id, back: undefined };
  save(INDEX, index);
  // The router remembered the address when it loaded and writes it back after the first
  // screen, so take the query out again a few times after that (as transfer.ts does).
  const strip = () => {
    if (new URLSearchParams(window.location.search).has('a')) {
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.hash);
    }
  };
  strip();
  for (const ms of [0, 50, 200, 500, 1000, 2000]) setTimeout(strip, ms);
}

/** Whether an account has a key stored on this device (an account being added has none yet). */
export function hasKey(id: string) {
  try {
    return KEY_NAMES.some((n) => globalThis.localStorage?.getItem(keyFor(id, n)) != null);
  } catch {
    return false;
  }
}

/** Drops added accounts that never got a key (the app closed while adding one). */
function tidy() {
  const keep = index.list.filter((a) => a.id === FIRST_ACCOUNT || a.id === index.current || hasKey(a.id));
  if (keep.length !== index.list.length) {
    for (const a of index.list) if (!keep.includes(a)) forgetStorage(a.id);
    write({ ...index, list: keep });
  }
}
tidy();
share();

function forgetStorage(id: string) {
  if (id === FIRST_ACCOUNT) return;
  try {
    const ls = globalThis.localStorage;
    if (!ls) return;
    const prefix = keyFor(id, '');
    const names: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const n = ls.key(i);
      if (n?.startsWith(prefix)) names.push(n);
    }
    for (const n of names) remove(n);
  } catch {
    // Storage unavailable.
  }
}

export function accounts() {
  return index;
}

export function useAccounts() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => index,
    () => index,
  );
}

/** Accounts with a key on this device (the one being added is left out). */
export function readyAccounts(i: Index = index) {
  return i.list.filter((a) => hasKey(a.id) || a.pubkey);
}

/** Opens another account: the app remounts on it. */
export function switchAccount(id: string) {
  if (id === index.current || !index.list.some((a) => a.id === id)) return;
  const leaving = index.current;
  setStorageAccount(id);
  write({ v: 1, current: id, list: index.list });
  // Leaving an account that was being added and never got a key: nothing to keep.
  if (leaving !== FIRST_ACCOUNT && !hasKey(leaving)) {
    forgetStorage(leaving);
    write({ ...index, list: index.list.filter((a) => a.id !== leaving) });
  }
}

/** Starts adding an account: the app remounts on an empty one, which shows the first screen. */
export function addAccount() {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
  const back = index.current;
  setStorageAccount(id);
  write({ v: 1, current: id, list: [...index.list, { id }], back });
  return id;
}

/** Gives up adding: back to the account that was open before. */
export function cancelAdd() {
  const back = index.back && index.list.some((a) => a.id === index.back) ? index.back : readyAccounts()[0]?.id;
  if (back) switchAccount(back);
}

/** Whether the open account is one being added (so the first screen can offer to go back). */
export function adding() {
  return !hasKey(index.current) && readyAccounts().some((a) => a.id !== index.current);
}

/** Remembers who the open account is, for the list. */
export function describeAccount(pubkey: string, name: string) {
  const cur = index.list.find((a) => a.id === index.current);
  if (!cur || (cur.pubkey === pubkey && (cur.name ?? '') === name)) return;
  write({ ...index, back: undefined, list: index.list.map((a) => (a.id === index.current ? { ...a, pubkey, name } : a)) });
}

/** Another account on this device with this public key, if any. */
export function accountWithKey(pubkey: string) {
  return index.list.find((a) => a.id !== index.current && a.pubkey === pubkey);
}

/** Other accounts' storage names for one thing (for example who has notifications on). */
export function otherAccountsHave(name: string) {
  return index.list.some((a) => a.id !== index.current && load<unknown>(keyFor(a.id, name), null) != null);
}

/** The account with this public key, if it is on this device. */
export function accountByKey(pubkey: string) {
  return index.list.find((a) => a.pubkey === pubkey);
}

/**
 * Public keys of accounts that got a notification since they were last open (see sw-store.ts).
 * Follows new notifications while the app is open, and the list when the app comes back.
 */
export function useNewMarks() {
  const [marks, setMarks] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let alive = true;
    const refresh = () => void newMarks().then((m) => alive && setMarks(m));
    refresh();
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.tegami === 'new') refresh();
    };
    const onVisible = () => {
      if (globalThis.document?.visibilityState === 'visible') refresh();
    };
    sw?.addEventListener('message', onMessage);
    globalThis.document?.addEventListener?.('visibilitychange', onVisible);
    return () => {
      alive = false;
      sw?.removeEventListener('message', onMessage);
      globalThis.document?.removeEventListener?.('visibilitychange', onVisible);
    };
  }, []);
  return marks;
}
