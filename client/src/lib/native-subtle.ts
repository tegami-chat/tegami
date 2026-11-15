// The part of WebCrypto (crypto.subtle) that Tegami uses, written with @noble for the
// iPhone and Android apps. React Native's JavaScript engine (Hermes) has no crypto.subtle,
// and the app's code (vault, recovery, files, relay-http) calls it directly, so the apps
// put this object in its place (platform-setup.native.ts). The browser keeps its own.
//
// Only what the app calls is here: digest SHA-256; importKey "raw" for AES-GCM, HKDF and
// HMAC (SHA-256); generateKey AES-GCM; encrypt and decrypt AES-GCM (with additionalData);
// deriveBits and deriveKey with HKDF SHA-256; sign HMAC. Anything else throws, so a new
// use shows up at once instead of doing something different from the browser.
//
// Difference from the browser: a browser key marked non-extractable cannot be read by
// script; here the key bytes live in JavaScript memory. Keys kept between launches are in
// the Keychain or Keystore (device-vault.native.ts), not here.

import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

type Alg = 'AES-GCM' | 'HKDF' | 'HMAC';

class NativeKey {
  readonly type = 'secret';
  readonly algorithm: { name: Alg; length?: number; hash?: { name: string } };
  readonly extractable: boolean;
  readonly usages: string[];
  readonly bytes: Uint8Array;
  constructor(algorithm: NativeKey['algorithm'], extractable: boolean, usages: string[], bytes: Uint8Array) {
    this.algorithm = algorithm;
    this.extractable = extractable;
    this.usages = usages;
    this.bytes = bytes;
  }
}

function bytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('native-subtle: expected bytes');
}

function nameOf(alg: unknown): string {
  return (typeof alg === 'string' ? alg : (alg as { name?: string })?.name ?? '').toUpperCase();
}

function hashName(alg: unknown): string {
  const h = (alg as { hash?: unknown })?.hash;
  return nameOf(h);
}

function needSha256(alg: unknown) {
  if (hashName(alg) !== 'SHA-256') throw new Error(`native-subtle: only SHA-256 (${hashName(alg) || 'none'})`);
}

function keyOf(key: unknown, name: Alg, usage: string): NativeKey {
  if (!(key instanceof NativeKey) || key.algorithm.name !== name) throw new Error(`native-subtle: not a ${name} key`);
  if (!key.usages.includes(usage)) throw new Error(`native-subtle: key not usable for ${usage}`);
  return key;
}

function out(b: Uint8Array): ArrayBuffer {
  return b.slice().buffer as ArrayBuffer;
}

function aesGcm(params: unknown, key: unknown, usage: 'encrypt' | 'decrypt') {
  if (nameOf(params) !== 'AES-GCM') throw new Error(`native-subtle: ${nameOf(params)} not supported`);
  const p = params as { iv: unknown; additionalData?: unknown; tagLength?: number };
  if (p.tagLength !== undefined && p.tagLength !== 128) throw new Error('native-subtle: tag must be 128 bits');
  const k = keyOf(key, 'AES-GCM', usage);
  return gcm(k.bytes, bytes(p.iv), p.additionalData === undefined ? undefined : bytes(p.additionalData));
}

function hkdfBits(params: unknown, key: unknown, usage: string, bits: number) {
  if (nameOf(params) !== 'HKDF') throw new Error(`native-subtle: ${nameOf(params)} not supported`);
  needSha256(params);
  if (bits % 8) throw new Error('native-subtle: length must be whole bytes');
  const p = params as { salt: unknown; info: unknown };
  const k = keyOf(key, 'HKDF', usage);
  return hkdf(sha256, k.bytes, bytes(p.salt), bytes(p.info), bits / 8);
}

export const nativeSubtle = {
  async digest(alg: unknown, data: unknown): Promise<ArrayBuffer> {
    if (nameOf(alg) !== 'SHA-256') throw new Error(`native-subtle: digest ${nameOf(alg)} not supported`);
    return out(sha256(bytes(data)));
  },

  async importKey(format: string, data: unknown, alg: unknown, extractable: boolean, usages: string[]) {
    if (format !== 'raw') throw new Error(`native-subtle: importKey ${format} not supported`);
    const raw = bytes(data).slice();
    const name = nameOf(alg);
    if (name === 'AES-GCM') {
      if (![16, 24, 32].includes(raw.length)) throw new Error('native-subtle: AES key must be 128, 192 or 256 bits');
      return new NativeKey({ name: 'AES-GCM', length: raw.length * 8 }, extractable, usages, raw);
    }
    if (name === 'HKDF') return new NativeKey({ name: 'HKDF' }, false, usages, raw);
    if (name === 'HMAC') {
      needSha256(alg);
      return new NativeKey({ name: 'HMAC', hash: { name: 'SHA-256' } }, extractable, usages, raw);
    }
    throw new Error(`native-subtle: importKey ${name} not supported`);
  },

  async generateKey(alg: unknown, extractable: boolean, usages: string[]) {
    if (nameOf(alg) !== 'AES-GCM') throw new Error(`native-subtle: generateKey ${nameOf(alg)} not supported`);
    const length = (alg as { length?: number }).length ?? 256;
    if (![128, 192, 256].includes(length)) throw new Error('native-subtle: AES key must be 128, 192 or 256 bits');
    const raw = globalThis.crypto.getRandomValues(new Uint8Array(length / 8));
    return new NativeKey({ name: 'AES-GCM', length }, extractable, usages, raw);
  },

  async exportKey(format: string, key: unknown): Promise<ArrayBuffer> {
    if (format !== 'raw' || !(key instanceof NativeKey) || !key.extractable) throw new Error('native-subtle: key not extractable');
    return out(key.bytes);
  },

  async encrypt(params: unknown, key: unknown, data: unknown): Promise<ArrayBuffer> {
    return out(aesGcm(params, key, 'encrypt').encrypt(bytes(data)));
  },

  async decrypt(params: unknown, key: unknown, data: unknown): Promise<ArrayBuffer> {
    try {
      return out(aesGcm(params, key, 'decrypt').decrypt(bytes(data)));
    } catch (e) {
      // The browser rejects a wrong key or changed data with an OperationError.
      const err = new Error((e as Error)?.message ?? 'decrypt failed');
      err.name = 'OperationError';
      throw err;
    }
  },

  async deriveBits(params: unknown, key: unknown, length: number): Promise<ArrayBuffer> {
    return out(hkdfBits(params, key, 'deriveBits', length));
  },

  async deriveKey(params: unknown, key: unknown, derived: unknown, extractable: boolean, usages: string[]) {
    if (nameOf(derived) !== 'AES-GCM') throw new Error(`native-subtle: deriveKey to ${nameOf(derived)} not supported`);
    const length = (derived as { length?: number }).length ?? 256;
    const raw = hkdfBits(params, key, 'deriveKey', length);
    return new NativeKey({ name: 'AES-GCM', length }, extractable, usages, raw);
  },

  async sign(alg: unknown, key: unknown, data: unknown): Promise<ArrayBuffer> {
    if (nameOf(alg) !== 'HMAC') throw new Error(`native-subtle: sign ${nameOf(alg)} not supported`);
    const k = keyOf(key, 'HMAC', 'sign');
    return out(hmac(sha256, k.bytes, bytes(data)));
  },
};
