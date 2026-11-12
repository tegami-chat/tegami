// What the app and the service worker (public/sw.js) share, in IndexedDB "tegami-sw":
//   accounts: [{ pubkey, name }] for the accounts on this device, so a notification can
//             say which account it is for (only when there is more than one).
//   new:      { [pubkey]: count } messages told by notifications since each account was last
//             open, so the account list can show a number for an account that is not open.
// The app cannot see an account that is not open (it is not connected with its key), so
// these marks come only from notifications: an account without notifications gets none.
// public/sw.js has its own copy of the open/get/put code below; keep the two in step.

const DB = 'tegami-sw';
const STORE = 'kv';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function get<T>(key: string): Promise<T | undefined> {
  const d = await db();
  try {
    return await new Promise((resolve, reject) => {
      const r = d.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result as T | undefined);
      r.onerror = () => reject(r.error);
    });
  } finally {
    d.close();
  }
}

async function update<T>(key: string, fn: (old: T | undefined) => T) {
  const d = await db();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(STORE, 'readwrite');
      const s = tx.objectStore(STORE);
      const r = s.get(key);
      r.onsuccess = () => s.put(fn(r.result as T | undefined), key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    d.close();
  }
}

const available = () => typeof indexedDB !== 'undefined';

export type SwAccount = { pubkey: string; name: string };

export async function shareAccounts(list: SwAccount[]) {
  if (!available()) return;
  await update<SwAccount[]>('accounts', () => list).catch(() => {});
}

export async function newMarks(): Promise<Record<string, number>> {
  if (!available()) return {};
  return (await get<Record<string, number>>('new').catch(() => undefined)) ?? {};
}

export async function clearNewMark(pubkey: string) {
  if (!available()) return;
  await update<Record<string, number>>('new', (old) => {
    const next = { ...(old ?? {}) };
    delete next[pubkey];
    return next;
  }).catch(() => {});
}
