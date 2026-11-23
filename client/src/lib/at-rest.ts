// What the app keeps on this device, encrypted (design: 2026-11-19).
//
// Messages, friends, groups and the like are not kept as plain text in localStorage. They
// are encrypted with a key made from the account's Nostr secret key and kept in IndexedDB
// ("tegami-store", store "records", under the same name localStorage used). The key lives in
// memory only: it is made again each time the account is opened, from the secret key that the
// passkey (vault.ts) or the device key (device-vault.ts) gives back. It is not made from the
// passkey's PRF value, so an account restored from a recovery code reads its data again too.
//
// The app's code stays synchronous: openAtRest() reads and decrypts every name of the account
// into memory once, and load/save in storage.ts then work on that memory. save() changes the
// memory at once and writes the encrypted copy a moment later (one write per name, the last
// value). Before the account is open nothing here can be read, and a save is dropped (the app
// must not save before it has loaded; see the order in tegami.tsx).
//
// Data from before this (plain JSON in localStorage) is moved in by openAtRest(): encrypted,
// written, read back and compared, and only then is the plain copy removed.
//
// The iPhone and Android apps have no IndexedDB: the same encrypted records are kept in
// localStorage (expo-sqlite) under "tegami-store:<name>".
//
// callNetwork (the person's own TURN server and its password) and ai.permissions (which AI may do
// what) were plain until 2026-11-20 and are moved in the same way.
//
// What stays plain on purpose (it is needed before the account opens, or holds nothing of
// a person): the vault, the device vault, the account's name for the list, switches and
// stamps of time, the notification registration, and the service worker's store (sw-store.ts).

import { keyFor } from './store-names';
import { fromB64u, toB64u } from './vault';

/** The names (without the account prefix) that are kept encrypted. */
export const SEALED_NAMES: readonly string[] = [
  'messages',
  'contacts',
  'groups',
  'outbox',
  'blocked',
  'deleted',
  'readAt',
  'cleared',
  'sync',
  'syncSent',
  'ai.log',
  'ai.proposals',
  'ai.holds',
  'ai.peerNames',
  'ai.groups',
  'ai.ownerCards',
  'ai.permissions',
  'callNetwork',
  'ai.sent',
  'ai.apiKeys',
  'ai.phoneSent',
  'ai.phoneChat',
  'noaiChats',
  'stamps',
  'stampsUsed',
  'avatar',
  'historyPending',
];
const SEALED = new Set(SEALED_NAMES);

const KEY_NAME = /^tegami(?:@[^.]+)?\.(.+)$/;
/** Whether a storage name (as k() makes it) is one that is kept encrypted. */
export function isSealedKey(key: string) {
  const m = KEY_NAME.exec(key);
  return !!m && SEALED.has(m[1]);
}

const INFO = new TextEncoder().encode('tegami/at-rest/v1');
const DB = 'tegami-store';
const STORE = 'records';
const LS_PREFIX = 'tegami-store:';

export type SealedRecord = { v: 1; iv: Uint8Array; ct: Uint8Array };

// ---------- the place the encrypted records are kept ----------

const hasIdb = () => typeof indexedDB !== 'undefined';

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const d = await idb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = d.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? (req.result as T) : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    d.close();
  }
}

async function getRecord(key: string): Promise<SealedRecord | undefined> {
  if (hasIdb()) return (await withStore<SealedRecord>('readonly', (s) => s.get(key) as IDBRequest<SealedRecord>)) ?? undefined;
  const raw = globalThis.localStorage?.getItem(LS_PREFIX + key);
  if (!raw) return undefined;
  const o = JSON.parse(raw) as { v: number; iv: string; ct: string };
  return { v: 1, iv: fromB64u(o.iv), ct: fromB64u(o.ct) };
}

async function writeRecords(entries: [string, SealedRecord | null][]) {
  if (!entries.length) return;
  if (hasIdb()) {
    await withStore('readwrite', (s) => {
      for (const [key, rec] of entries) {
        if (rec) s.put(rec, key);
        else s.delete(key);
      }
    });
    return;
  }
  const ls = globalThis.localStorage;
  if (!ls) throw new Error('no storage');
  for (const [key, rec] of entries) {
    if (rec) ls.setItem(LS_PREFIX + key, JSON.stringify({ v: 1, iv: toB64u(rec.iv), ct: toB64u(rec.ct) }));
    else ls.removeItem(LS_PREFIX + key);
  }
}

// ---------- the key and the cipher ----------

async function deriveKey(secret: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', secret as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: INFO },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function encryptWith(key: CryptoKey, aad: string, data: Uint8Array<ArrayBuffer>): Promise<SealedRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, data);
  return { v: 1, iv, ct: new Uint8Array(ct) };
}

async function decryptWith(key: CryptoKey, aad: string, rec: SealedRecord): Promise<Uint8Array> {
  if (!rec || rec.v !== 1 || !(rec.iv instanceof Uint8Array) || !(rec.ct instanceof Uint8Array)) throw new Error('bad record');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: rec.iv as Uint8Array<ArrayBuffer>, additionalData: enc.encode(aad) },
    key,
    rec.ct as Uint8Array<ArrayBuffer>,
  );
  return new Uint8Array(pt);
}

// ---------- the open account ----------

type Session = {
  account: string;
  fingerprint: string;
  key: CryptoKey;
  /** The JSON text of each name of this account, as localStorage would hold it (null: none). */
  cache: Map<string, string | null>;
  dirty: Set<string>;
  timer: ReturnType<typeof setTimeout> | undefined;
  chain: Promise<void>;
};

let cur: Session | null = null;
let opening: { account: string; fingerprint: string; promise: Promise<void> } | null = null;

function fingerprintOf(secret: Uint8Array) {
  // Only to tell "the same secret key again" from another one; never stored.
  let h = 0;
  for (const b of secret) h = (h * 31 + b) >>> 0;
  return `${secret.length}:${h}`;
}

/** Whether an account is open (its names can be read and saved). */
export function atRestOpen(account?: string) {
  return !!cur && (account === undefined || cur.account === account);
}

/** The text kept for a name (null when none, or the account is not open). Used to notice changes. */
export function sealedRaw(key: string): string | null {
  return cur?.cache.get(key) ?? null;
}

/** Whether `key` belongs to the open account (so a read or a save can work). */
function mine(key: string) {
  return !!cur && cur.cache.has(key);
}

/** Keeps a name's JSON text. Dropped when the account is not open (a save from an empty screen would erase data). */
export function saveSealed(key: string, json: string | undefined) {
  if (!cur || !mine(key)) {
    if (process.env.EXPO_PUBLIC_TEGAMI_TEST_HOOKS === '1') console.error(`[at-rest] save before open dropped: ${key}`);
    return;
  }
  cur.cache.set(key, json === undefined ? null : json);
  touch(cur, key);
  announce(key, json === undefined ? null : json);
}

/** Removes a name. Works without the key (removing an account that is not open). */
export function removeSealed(key: string) {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // Storage unavailable.
  }
  if (cur && mine(key)) {
    cur.cache.set(key, null);
    touch(cur, key);
    announce(key, null);
    return;
  }
  void writeRecords([[key, null]]).catch(() => {});
}

// ---------- other tabs of the same browser ----------
// Sealed names live only in each tab's memory, so a switch turned off in one tab would not
// reach another open tab until it reloads. The names below (settings that gate what an AI or a
// call may do) are therefore passed to the other tabs over a BroadcastChannel (same origin,
// in memory only, never stored). A receiving tab updates its memory and does not write it back:
// the tab that changed it writes the encrypted copy. Where there is no BroadcastChannel (the
// phone apps) nothing happens.

const SHARED_NAMES = new Set(['ai.permissions', 'callNetwork']);
type Shared = { account: string; key: string; raw: string | null };
const changeListeners = new Set<() => void>();
/** Calls `l` when another tab changed a shared name (so a hook can read it again). Returns the way to stop. */
export function onSealedChange(l: () => void) {
  changeListeners.add(l);
  return () => {
    changeListeners.delete(l);
  };
}

const channel: BroadcastChannel | null = (() => {
  try {
    if (typeof BroadcastChannel !== 'function') return null;
    const c = new BroadcastChannel('tegami-at-rest');
    (c as unknown as { unref?: () => void }).unref?.();
    c.onmessage = (e: MessageEvent) => {
      const m = e.data as Shared | null;
      if (!m || typeof m.key !== 'string' || typeof m.account !== 'string' || !(typeof m.raw === 'string' || m.raw === null)) return;
      if (!cur || cur.account !== m.account || !mine(m.key) || !isShared(m.key)) return;
      cur.cache.set(m.key, m.raw);
      // The other tab writes it; writing it here too would only fight over the same record.
      cur.dirty.delete(m.key);
      for (const l of [...changeListeners]) l();
    };
    return c;
  } catch {
    return null;
  }
})();

function isShared(key: string) {
  const m = KEY_NAME.exec(key);
  return !!m && SHARED_NAMES.has(m[1]);
}

function announce(key: string, raw: string | null) {
  if (!channel || !cur || !isShared(key)) return;
  try {
    channel.postMessage({ account: cur.account, key, raw } satisfies Shared);
  } catch {
    // The channel is closed: the other tabs read it when they next open.
  }
}

function touch(s: Session, key: string) {
  s.dirty.add(key);
  if (s.timer === undefined) s.timer = setTimeout(() => void flush(s), 0);
}

function flush(s: Session): Promise<void> {
  if (s.timer !== undefined) {
    clearTimeout(s.timer);
    s.timer = undefined;
  }
  const names = [...s.dirty];
  s.dirty.clear();
  if (!names.length) return s.chain;
  // The values are taken now: a later save of the same name starts a new write.
  const values = names.map((n) => [n, s.cache.get(n) ?? null] as const);
  s.chain = s.chain.then(async () => {
    try {
      const entries: [string, SealedRecord | null][] = [];
      for (const [n, v] of values) entries.push([n, v === null ? null : await encryptWith(s.key, n, enc.encode(v))]);
      await writeRecords(entries);
    } catch {
      // Storage full or unavailable: the next save of these names tries again.
      for (const [n] of values) s.dirty.add(n);
    }
  });
  return s.chain;
}

/** Writes everything not yet written. Resolves when the writes are done. */
export function flushAtRest(): Promise<void> {
  return cur ? flush(cur) : Promise.resolve();
}

// A page being hidden or closed may not run a timer again: start the writes at once, so a
// message just sent or received is not lost with the tab.
globalThis.addEventListener?.('pagehide', () => void flushAtRest());
globalThis.document?.addEventListener?.('visibilitychange', () => {
  if (globalThis.document?.visibilityState === 'hidden') void flushAtRest();
});

/**
 * Closes the open account: its unwritten changes are written (with `discard`, thrown away: the
 * account is being removed), and its key and memory are dropped.
 */
export function closeAtRest(discard = false) {
  const s = cur;
  cur = null;
  opening = null;
  if (!s) return;
  if (discard) {
    if (s.timer !== undefined) clearTimeout(s.timer);
    s.timer = undefined;
    s.dirty.clear();
    return;
  }
  void flush(s);
}

/**
 * Opens an account: makes its key from the secret key, reads and decrypts each name into
 * memory, and moves data kept as plain text before this into the encrypted records.
 * Opening another account closes the open one. Opening the same one again does nothing.
 */
export function openAtRest(account: string, secret: Uint8Array): Promise<void> {
  const fingerprint = fingerprintOf(secret);
  if (cur && cur.account === account && cur.fingerprint === fingerprint) return Promise.resolve();
  if (opening && opening.account === account && opening.fingerprint === fingerprint) return opening.promise;
  if (cur) closeAtRest();
  const promise: Promise<void> = readAll(account, fingerprint, secret).finally(() => {
    if (opening?.promise === promise) opening = null;
  });
  opening = { account, fingerprint, promise };
  return promise;
}

async function readAll(account: string, fingerprint: string, secret: Uint8Array) {
  const key = await deriveKey(secret);
  const cache = new Map<string, string | null>();
  const unwritten: string[] = [];
  for (const name of SEALED_NAMES) {
    const k = keyFor(account, name);
    let plain: string | null = null;
    try {
      plain = globalThis.localStorage?.getItem(k) ?? null;
    } catch {
      plain = null;
    }
    let record: SealedRecord | undefined;
    try {
      record = await getRecord(k);
    } catch {
      record = undefined;
    }
    let stored: string | null = null;
    let readable = false;
    if (record) {
      try {
        stored = dec.decode(await decryptWith(key, k, record));
        readable = true;
      } catch {
        // Another key, another name, or damaged: it cannot be read, so it counts as not there.
        stored = null;
      }
    }
    if (readable) {
      // The encrypted record is the one that counts. A plain copy beside it is left over.
      cache.set(k, stored);
      if (plain !== null) removePlain(k);
    } else if (plain !== null) {
      cache.set(k, plain);
      if (await moveIn(key, k, plain)) removePlain(k);
      else unwritten.push(k);
    } else {
      cache.set(k, null);
    }
  }
  const s: Session = { account, fingerprint, key, cache, dirty: new Set(), timer: undefined, chain: Promise.resolve() };
  // What could not be written yet is tried again with the next write.
  for (const k of unwritten) s.dirty.add(k);
  cur = s;
  if (s.dirty.size) s.timer = setTimeout(() => void flush(s), 0);
}

function removePlain(k: string) {
  try {
    globalThis.localStorage?.removeItem(k);
  } catch {
    // Storage unavailable.
  }
}

/** Encrypts a plain value, writes it, reads it back and compares. True only when it is safely kept. */
async function moveIn(key: CryptoKey, k: string, plain: string): Promise<boolean> {
  try {
    await writeRecords([[k, await encryptWith(key, k, enc.encode(plain))]]);
    const back = await getRecord(k);
    if (!back) return false;
    return dec.decode(await decryptWith(key, k, back)) === plain;
  } catch {
    return false;
  }
}

/** Removes every encrypted record of an account (it does not need to be open). */
export async function forgetAccountRecords(account: string) {
  if (cur && cur.account === account) closeAtRest(true);
  const prefix = keyFor(account, '');
  if (hasIdb()) {
    await withStore('readwrite', (s) => {
      s.delete(IDBKeyRange.bound(prefix, prefix + '￿'));
    }).catch(() => {});
    return;
  }
  for (const name of SEALED_NAMES) {
    try {
      globalThis.localStorage?.removeItem(LS_PREFIX + keyFor(account, name));
    } catch {
      // Storage unavailable.
    }
  }
}

// ---------- bytes for other stores (photos, lib/files.ts) ----------

/** Encrypts bytes for another store, bound to `aad` (the place they are kept under). Null when no account is open. */
export async function sealBytes(aad: string, data: Uint8Array<ArrayBuffer>): Promise<SealedRecord | null> {
  const s = cur;
  if (!s) return null;
  return encryptWith(s.key, aad, data);
}

/** Decrypts bytes sealed by sealBytes. Null when no account is open or they cannot be read. */
export async function openBytes(aad: string, rec: unknown): Promise<Uint8Array | null> {
  const s = cur;
  if (!s) return null;
  try {
    return await decryptWith(s.key, aad, rec as SealedRecord);
  } catch {
    return null;
  }
}

/** The open account's id, for keys of other stores. */
export function atRestAccount() {
  return cur?.account ?? null;
}

// ---------- for the tests (a build with EXPO_PUBLIC_TEGAMI_TEST_HOOKS=1) ----------

if (process.env.EXPO_PUBLIC_TEGAMI_TEST_HOOKS === '1') {
  (globalThis as unknown as { __tegamiStore: unknown }).__tegamiStore = {
    getItem: (k: string) => sealedRaw(k),
    setItem: (k: string, v: string) => saveSealed(k, v),
    removeItem: (k: string) => removeSealed(k),
    flush: () => flushAtRest(),
    open: () => atRestOpen(),
  };
}
