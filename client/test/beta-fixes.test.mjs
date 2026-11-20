// Tests for the beta fixes: file URLs, rumor ids, and the AI pairing switch.
// Run:  node test/beta-fixes.test.mjs   (Node 24 strips the TypeScript types)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('.') && !/\\.[a-z]+$/.test(spec)) {
    try { return await next(spec + '.ts', ctx); } catch {}
  }
  return next(spec, ctx);
}`),
);

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

import * as nip17 from 'nostr-tools/nip17';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

const F = await import('../src/lib/files.ts');
const { rumorIdMatches } = await import('../src/lib/rumor-id.ts');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const tags = [
  ['encryption-algorithm', 'aes-gcm'],
  ['decryption-key', 'aa'],
  ['decryption-nonce', 'bb'],
  ['x', 'cc'],
];
const ref = (url) => ({ url, type: 'image/jpeg', key: 'aa', nonce: 'bb', sha256: 'cc' });

test('a file is read only from our own file server', () => {
  assert.ok(F.fileFromRumor(`${F.FILE_SERVER}/f/abc`, tags));
  assert.equal(F.fileFromRumor('https://evil.example/f/abc', tags), null);
  assert.equal(F.fileFromRumor(`${F.FILE_SERVER}.evil.example/f/abc`, tags), null);
  assert.equal(F.fileFromRumor('http://relay.tegami.chat/f/abc', tags), null);
});

test('a profile or group file reference is held to the same rule', () => {
  assert.ok(F.validFileRef(ref(`${F.FILE_SERVER}/f/abc`)));
  assert.equal(F.validFileRef(ref('https://evil.example/f/abc')), null);
  assert.equal(F.validFileRef(ref(`${F.FILE_SERVER}@evil.example/f/abc`)), null);
});

test('opening a file never fetches from another host', async () => {
  let fetched = false;
  globalThis.fetch = async () => ((fetched = true), { ok: false, status: 500 });
  await assert.rejects(F.openFile('x', ref('https://evil.example/f/abc')));
  assert.equal(fetched, false);
});

test('a rumor id must be the hash of its content', () => {
  const sk = generateSecretKey();
  const rsk = generateSecretKey();
  const wrap = nip17.wrapEvent(sk, { publicKey: getPublicKey(rsk) }, 'こんにちは');
  const rumor = nip17.unwrapEvent(wrap, rsk);
  assert.equal(rumorIdMatches(rumor), true);
  // An id copied from another message does not match this content.
  assert.equal(rumorIdMatches({ ...rumor, id: 'f'.repeat(64) }), false);
  assert.equal(rumorIdMatches({ ...rumor, content: 'ちがう' }), false);
  assert.equal(rumorIdMatches({ ...rumor, tags: null }), false);
});

test('a pairing code in a scanned picture does not switch on "my AI"', () => {
  const src = readFileSync(new URL('../src/app/add.tsx', import.meta.url), 'utf8');
  assert.equal(/setAsMine\(\s*!!/.test(src), false);
  assert.equal(/setAsMine\(\s*true/.test(src), false);
  assert.match(src, /\[asMine, setAsMine\] = useState\(false\)/);
});

console.log(`${passed} passed`);
