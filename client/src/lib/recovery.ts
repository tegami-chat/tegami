// Recovery code: getting the account back after losing every device (philosophy #5, #13).
//
// Saving someone who lost every device needs something kept somewhere. Here the person
// chooses it in settings: the app makes a random recovery code, shows it once, and the
// person keeps it (a password manager or paper). The account (Nostr key, my name,
// contacts, groups: the same Bundle as moving to another device) is encrypted on this
// device with a key derived from the code, and only the ciphertext goes to the relay.
//
// What the relay keeps, per backup: an id, the ciphertext, the public key that signed the
// upload and the time of the last upload.
// - The id, the encryption key and a signing key are three separate HKDF outputs of the
//   code. None reveals the others, so the relay cannot decrypt (philosophy #26).
// - Uploads and deletes are signed with the signing key from the code, not with the
//   account's key, so the relay cannot tell which account a backup belongs to. Only
//   whoever holds the code can replace or delete it (and that person could take over
//   the account anyway).
// - Without the code nobody can find a backup: the id is 256 bits derived from a code
//   of 140 random bits, so ids cannot be guessed or listed.
// - The plaintext is padded to a multiple of 1 KB before encryption, so the size says
//   little about how many contacts there are.
// The relay still sees the network address an upload comes from, as for any request.
// Whoever has the code can take over the account, and without the code Tegami cannot
// restore it: the settings screen says both.
//
// While recovery is on, this device keeps what it needs to refresh the backup (the id,
// the encryption key and the signing key), encrypted with a key derived from the
// account's own secret key, so it can only be read while the account is open.

import { getPublicKey } from 'nostr-tools/pure';

import { load, save } from './storage';
import { relayHttp, signedFetch } from './relay-http';
import { cleanBundle, type Bundle } from './transfer';
import { fromB64u, toB64u } from './vault';

// 32 symbols: digits and capital letters without 0, 1, I and O, which are easy to mix up.
// 32 divides 256, so `byte & 31` picks each symbol with the same chance.
// 28 symbols × 5 bits = 140 random bits, shown as 7 groups of 4.
const SYMBOLS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 28;
const GROUP = 4;
const PAD = 1024;
export const MAX_BACKUP_BYTES = 64 * 1024;
const LOCAL = 'tegami.recovery';

export class RecoveryError extends Error {}

/** id: where the backup lives on the relay. key: AES-GCM key. signer: Nostr secret key that signs uploads and deletes. */
export type RecoveryKeys = { id: string; key: Uint8Array<ArrayBuffer>; signer: Uint8Array<ArrayBuffer> };
/** What is needed to delete an earlier backup. */
export type BackupRef = { id: string; signer: Uint8Array<ArrayBuffer> };

/** A new random recovery code: 7 groups of 4, e.g. "K7QM-3XRA-…". */
export function makeCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  const chars = [...bytes].map((b) => SYMBOLS[b & 31]);
  const groups: string[] = [];
  for (let i = 0; i < CODE_LENGTH; i += GROUP) groups.push(chars.slice(i, i + GROUP).join(''));
  return groups.join('-');
}

/** Reads a typed or pasted code: case, spaces and dashes do not matter. Null when it is not a code. */
export function normalizeCode(input: string): string | null {
  const s = input.normalize('NFKC').toUpperCase().replace(/[\s\-‐-―ー－]/g, '');
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) if (!SYMBOLS.includes(ch)) return null;
  return s;
}

const enc = new TextEncoder();

async function hkdf(ikm: BufferSource, salt: string, info: string) {
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(salt), info: enc.encode(info) }, base, 256));
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/**
 * The backup's id and encryption key, from the code.
 *
 * HKDF, not a password hash (PBKDF2, scrypt, Argon2): those slow down guessing of
 * secrets people choose, which have little randomness. This code is 140 bits from the
 * device's random number generator, so trying codes is hopeless at any speed, and a
 * slow hash would only make phones wait. HKDF with different `info` gives an id, an
 * encryption key and a signing key that say nothing about each other.
 */
export async function deriveKeys(code: string): Promise<RecoveryKeys> {
  const norm = normalizeCode(code);
  if (!norm) throw new RecoveryError('not a recovery code');
  const ikm = enc.encode(norm);
  const id = hex(await hkdf(ikm, 'tegami/recovery/v1', 'backup id'));
  const key = await hkdf(ikm, 'tegami/recovery/v1', 'backup key');
  const signer = await hkdf(ikm, 'tegami/recovery/v1', 'backup signer');
  // A secp256k1 secret key must be below the curve order; 32 random bytes are above it
  // with a chance of about 1 in 2^128, so this never happens in practice.
  getPublicKey(signer);
  return { id, key, signer };
}

async function aes(key: Uint8Array<ArrayBuffer>) {
  return crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypts the account for the relay. The id is bound in as additional data. */
export async function sealBackup(keys: RecoveryKeys, bundle: Bundle): Promise<string> {
  const json = JSON.stringify(bundle);
  const padded = json + ' '.repeat(PAD - (enc.encode(json).length % PAD));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(keys.id) }, await aes(keys.key), enc.encode(padded));
  return JSON.stringify({ v: 1, iv: toB64u(iv), ct: toB64u(ct) });
}

export async function openBackup(keys: RecoveryKeys, body: string): Promise<Bundle> {
  try {
    const { v, iv, ct } = JSON.parse(body) as { v: number; iv: string; ct: string };
    if (v !== 1) throw new Error('unknown version');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(iv), additionalData: enc.encode(keys.id) }, await aes(keys.key), fromB64u(ct));
    const bundle = cleanBundle(JSON.parse(new TextDecoder().decode(pt)));
    if (!bundle) throw new Error('unknown format');
    return bundle;
  } catch (e) {
    throw new RecoveryError(String((e as Error)?.message ?? e));
  }
}

// ---------- relay ----------

/** Thrown by a refresh when the backup is gone: recovery was turned off or given a new code on another device. */
export class BackupGoneError extends RecoveryError {}

/**
 * Uploads the backup. `refresh` only replaces a backup that is still there, so a device
 * that missed a new code or turning off (made on another device) does not bring the
 * old code back to life.
 */
export async function putBackup(keys: RecoveryKeys, bundle: Bundle, refresh = false) {
  const body = await sealBackup(keys, bundle);
  if (body.length > MAX_BACKUP_BYTES) throw new RecoveryError('too large');
  const res = await signedFetch('PUT', `/backup/${keys.id}`, body, keys.signer, refresh ? { 'If-Match': '*' } : {});
  if (res.status === 412) throw new BackupGoneError('gone');
  if (!res.ok) throw new RecoveryError(`relay said ${res.status}`);
}

/** Deletes a backup. A backup that is already gone counts as deleted. */
export async function deleteBackup(ref: BackupRef) {
  const res = await signedFetch('DELETE', `/backup/${ref.id}`, '', ref.signer);
  if (!res.ok && res.status !== 404) throw new RecoveryError(`relay said ${res.status}`);
}

/** On a new device: fetches and opens the backup for this code. */
export async function restoreFromCode(code: string): Promise<{ bundle: Bundle; keys: RecoveryKeys }> {
  const keys = await deriveKeys(code);
  let res: Response;
  try {
    res = await fetch(`${relayHttp()}/backup/${keys.id}`);
  } catch (e) {
    throw new RecoveryError(`network: ${(e as Error)?.message ?? e}`);
  }
  if (!res.ok) throw new RecoveryError(res.status === 404 ? 'not found' : `relay said ${res.status}`);
  return { bundle: await openBackup(keys, await res.text()), keys };
}

// A restore waiting for the person to protect the key on this device. Recovery stays on
// with the same code afterwards, so the backup keeps being refreshed from here.
let restored: RecoveryKeys | null = null;
export function setRestoredKeys(keys: RecoveryKeys | null) {
  restored = keys;
}
export function takeRestoredKeys() {
  const k = restored;
  restored = null;
  return k;
}

// ---------- what this device keeps while recovery is on ----------

type LocalRecord = { v: 1; iv: string; ct: string };
/** Ids of earlier backups that still have to be deleted from the relay (it was offline). */
export type LocalRecovery = { keys: RecoveryKeys; stale: BackupRef[] };

async function localKey(secret: Uint8Array) {
  const raw = await hkdf(secret as Uint8Array<ArrayBuffer>, 'tegami/recovery-local/v1', 'local record');
  return aes(raw);
}

export function recoveryOnHere() {
  return !!load<LocalRecord | null>(LOCAL, null);
}

export async function saveLocal(secret: Uint8Array, rec: LocalRecovery) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = enc.encode(
    JSON.stringify({
      id: rec.keys.id,
      key: toB64u(rec.keys.key),
      signer: toB64u(rec.keys.signer),
      stale: rec.stale.map((r) => ({ id: r.id, signer: toB64u(r.signer) })),
    }),
  );
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await localKey(secret), pt);
  save(LOCAL, { v: 1, iv: toB64u(iv), ct: toB64u(ct) } satisfies LocalRecord);
}

export async function loadLocal(secret: Uint8Array): Promise<LocalRecovery | null> {
  const r = load<LocalRecord | null>(LOCAL, null);
  if (!r) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(r.iv) }, await localKey(secret), fromB64u(r.ct));
    const o = JSON.parse(new TextDecoder().decode(pt)) as { id: string; key: string; signer: string; stale?: { id: string; signer: string }[] };
    if (!o.signer) return null;
    const stale = (Array.isArray(o.stale) ? o.stale : []).filter((r) => r?.id && r?.signer).map((r) => ({ id: r.id, signer: fromB64u(r.signer) }));
    return { keys: { id: o.id, key: fromB64u(o.key), signer: fromB64u(o.signer) }, stale };
  } catch {
    return null;
  }
}

export function clearLocal() {
  try {
    globalThis.localStorage?.removeItem(LOCAL);
    globalThis.localStorage?.removeItem('tegami.recovery.failures');
  } catch {
    // Storage unavailable: nothing to clear.
  }
}
