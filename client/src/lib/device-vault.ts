// Keeps the Nostr secret key on this device when no passkey can protect it.
//
// Some passkey providers (for example some password manager extensions) do not
// support the WebAuthn PRF extension, so `vault.ts` cannot derive a key from the
// passkey. Instead, this file creates a random AES-GCM key that the browser marks
// as non-extractable and keeps it in IndexedDB. The Nostr key is encrypted with it.
//
// What this protects: the raw key never sits in localStorage, and a script cannot
// copy the AES key out of the browser. What it does not protect: anyone who can run
// code in this browser profile can still ask the browser to decrypt. That is weaker
// than a passkey, and the start screen says so.

import { fromB64u, toB64u } from './vault';

export type DeviceVault = { v: 2; kind: 'device'; iv: string; ciphertext: string };

const DB = 'tegami';
const STORE = 'keys';
const KEY_ID = 'device';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(d.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    d.close();
  }
}

async function deviceKey(create: boolean): Promise<CryptoKey | null> {
  const found = await run<CryptoKey | undefined>('readonly', (s) => s.get(KEY_ID));
  if (found || !create) return found ?? null;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await run('readwrite', (s) => s.put(key, KEY_ID));
  return key;
}

export function deviceVaultAvailable() {
  return typeof indexedDB !== 'undefined' && typeof crypto !== 'undefined' && !!crypto.subtle;
}

export async function createDeviceVault(secret: Uint8Array<ArrayBuffer>): Promise<DeviceVault> {
  const key = (await deviceKey(true))!;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, secret);
  return { v: 2, kind: 'device', iv: toB64u(iv), ciphertext: toB64u(ct) };
}

export async function openDeviceVault(vault: DeviceVault): Promise<Uint8Array> {
  const key = await deviceKey(false);
  if (!key) throw new Error('device key missing');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(vault.iv) }, key, fromB64u(vault.ciphertext));
  return new Uint8Array(pt);
}
