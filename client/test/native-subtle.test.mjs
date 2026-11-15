// The iPhone and Android apps use src/lib/native-subtle.ts in place of crypto.subtle.
// This checks that it gives the same bytes as Node's WebCrypto (the same standard the
// browser follows) for every call the app makes, so data sealed on one can be opened on
// the other (a recovery backup, a photo, a stamp).
// Run:  node test/native-subtle.test.mjs   (Node 24 strips the TypeScript types)

import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const { nativeSubtle: n } = await import('../src/lib/native-subtle.ts');
const w = webcrypto.subtle;
const enc = new TextEncoder();
const rnd = (len) => webcrypto.getRandomValues(new Uint8Array(len));
const hex = (b) => Buffer.from(new Uint8Array(b)).toString('hex');
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

await test('digest SHA-256', async () => {
  for (const data of [new Uint8Array(0), enc.encode('Tegami'), rnd(1000)]) {
    assert.equal(hex(await n.digest('SHA-256', data)), hex(await w.digest('SHA-256', data)));
  }
});

await test('AES-GCM encrypt matches, both directions decrypt', async () => {
  const raw = rnd(32);
  const iv = rnd(12);
  const data = enc.encode('言葉は自由だ');
  const nk = await n.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const wk = await w.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const nc = await n.encrypt({ name: 'AES-GCM', iv }, nk, data);
  const wc = await w.encrypt({ name: 'AES-GCM', iv }, wk, data);
  assert.equal(hex(nc), hex(wc));
  assert.equal(hex(await n.decrypt({ name: 'AES-GCM', iv }, nk, wc)), hex(data));
  assert.equal(hex(await w.decrypt({ name: 'AES-GCM', iv }, wk, nc)), hex(data));
});

await test('AES-GCM with additionalData (recovery backup)', async () => {
  const raw = rnd(32);
  const iv = rnd(12);
  const additionalData = enc.encode('backup-id');
  const data = rnd(300);
  const nk = await n.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const wk = await w.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const wc = await w.encrypt({ name: 'AES-GCM', iv, additionalData }, wk, data);
  assert.equal(hex(await n.encrypt({ name: 'AES-GCM', iv, additionalData }, nk, data)), hex(wc));
  assert.equal(hex(await n.decrypt({ name: 'AES-GCM', iv, additionalData }, nk, wc)), hex(data));
});

await test('AES-GCM refuses changed data and a wrong key like the browser', async () => {
  const iv = rnd(12);
  const nk = await n.importKey('raw', rnd(32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const other = await n.importKey('raw', rnd(32), 'AES-GCM', false, ['decrypt']);
  const c = new Uint8Array(await n.encrypt({ name: 'AES-GCM', iv }, nk, rnd(40)));
  await assert.rejects(n.decrypt({ name: 'AES-GCM', iv }, other, c), { name: 'OperationError' });
  c[3] ^= 1;
  await assert.rejects(n.decrypt({ name: 'AES-GCM', iv }, nk, c), { name: 'OperationError' });
});

await test('a key cannot be used for what it was not imported for', async () => {
  const nk = await n.importKey('raw', rnd(32), 'AES-GCM', false, ['encrypt']);
  await assert.rejects(n.decrypt({ name: 'AES-GCM', iv: rnd(12) }, nk, rnd(32)));
  await assert.rejects(n.exportKey('raw', nk));
});

await test('HKDF deriveBits (recovery code, stamps)', async () => {
  const ikm = rnd(20);
  const p = { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('tegami/recovery/v1'), info: enc.encode('id') };
  const nk = await n.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const wk = await w.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  assert.equal(hex(await n.deriveBits(p, nk, 256)), hex(await w.deriveBits(p, wk, 256)));
});

await test('HKDF deriveKey to AES-GCM (passkey vault) opens what the browser sealed', async () => {
  const prf = rnd(32);
  const p = { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('tegami vault aes-gcm') };
  const nb = await n.importKey('raw', prf, 'HKDF', false, ['deriveKey']);
  const wb = await w.importKey('raw', prf, 'HKDF', false, ['deriveKey']);
  const nk = await n.deriveKey(p, nb, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const wk = await w.deriveKey(p, wb, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = rnd(12);
  const secret = rnd(32);
  const wc = await w.encrypt({ name: 'AES-GCM', iv }, wk, secret);
  assert.equal(hex(await n.decrypt({ name: 'AES-GCM', iv }, nk, wc)), hex(secret));
});

await test('HMAC SHA-256 sign (stamps)', async () => {
  const raw = rnd(32);
  const data = rnd(500);
  const nk = await n.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const wk = await w.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  assert.equal(hex(await n.sign('HMAC', nk, data)), hex(await w.sign('HMAC', wk, data)));
});

await test('generateKey AES-GCM works and is not extractable when asked', async () => {
  const k = await n.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = rnd(12);
  const c = await n.encrypt({ name: 'AES-GCM', iv }, k, enc.encode('x'));
  assert.equal(new TextDecoder().decode(await n.decrypt({ name: 'AES-GCM', iv }, k, c)), 'x');
  await assert.rejects(n.exportKey('raw', k));
});

await test('calls the app does not make are refused, not imitated', async () => {
  await assert.rejects(n.digest('SHA-1', rnd(4)));
  await assert.rejects(n.importKey('jwk', {}, 'AES-GCM', false, ['encrypt']));
  await assert.rejects(n.importKey('raw', rnd(32), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']));
  await assert.rejects(n.encrypt({ name: 'AES-CBC', iv: rnd(16) }, await n.importKey('raw', rnd(32), 'AES-GCM', false, ['encrypt']), rnd(4)));
});

console.log(`\n${passed} passed`);
