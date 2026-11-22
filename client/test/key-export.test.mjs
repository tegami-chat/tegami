// Unit tests for writing the secret key out as NIP-49 (src/lib/key-export.ts).
// Run:  node test/key-export.test.mjs   (Node 24 strips the TypeScript types)

import assert from 'node:assert/strict';
import { register } from 'node:module';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('.') && !/\.[a-z]+$/.test(spec)) {
    try { return await next(spec + '.ts', ctx); } catch {}
  }
  return next(spec, ctx);
}`),
);

const { exportEncryptedKey, KeyExportError, MIN_PASSWORD } = await import('../src/lib/key-export.ts');
const { decrypt } = await import('nostr-tools/nip49');

const SECRET = new Uint8Array(32).map((_, i) => i + 1);
const PW = 'correct horse battery';
const yes = async () => true;
let n = 0;
async function test(name, fn) {
  await fn();
  n++;
  console.log(`ok ${n} ${name}`);
}
const refuses = async (reason, p) => {
  await assert.rejects(p, (e) => e instanceof KeyExportError && e.reason === reason);
};

await test('writes ncryptsec1 text that opens with the same password', async () => {
  const text = await exportEncryptedKey({ secret: SECRET, password: PW, again: PW, verify: yes });
  assert.ok(text.startsWith('ncryptsec1'));
  assert.deepEqual(decrypt(text, PW), SECRET);
});

await test('a different password does not open it', async () => {
  const text = await exportEncryptedKey({ secret: SECRET, password: PW, again: PW, verify: yes });
  assert.throws(() => decrypt(text, PW + 'x'));
});

await test('a password under the minimum is refused, and the check is not asked', async () => {
  let asked = false;
  const short = 'x'.repeat(MIN_PASSWORD - 1);
  await refuses('short', exportEncryptedKey({ secret: SECRET, password: short, again: short, verify: async () => (asked = true) }));
  assert.equal(asked, false);
});

await test('two entries that differ are refused', async () => {
  await refuses('mismatch', exportEncryptedKey({ secret: SECRET, password: PW, again: PW + '!', verify: yes }));
});

await test('a failed, refused or cancelled owner check writes nothing', async () => {
  await refuses('unverified', exportEncryptedKey({ secret: SECRET, password: PW, again: PW, verify: async () => false }));
  await refuses('unverified', exportEncryptedKey({ secret: SECRET, password: PW, again: PW, verify: async () => { throw new Error('cancelled'); } }));
});

console.log(`${n} passed`);
