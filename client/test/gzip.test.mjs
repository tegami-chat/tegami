// The phone apps gzip history files with src/lib/gzip.native.ts (fflate). This checks it
// writes gzip that Node's zlib (the standard the browser's CompressionStream follows) opens,
// and opens gzip that zlib wrote.
// Run:  node test/gzip.test.mjs   (Node 24 strips the TypeScript types)

import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';

const { gunzipBytes, gzipBytes } = await import('../src/lib/gzip.native.ts');
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

const text = JSON.stringify({ messages: Array.from({ length: 500 }, (_, i) => ({ id: i, text: `message ${i} てがみ` })) });
const bytes = new TextEncoder().encode(text);

await test('fflate gzip opens with zlib', async () => {
  const packed = await gzipBytes(bytes);
  assert.equal(packed[0], 0x1f);
  assert.equal(packed[1], 0x8b);
  assert.ok(packed.length < bytes.length);
  assert.deepEqual(new Uint8Array(gunzipSync(packed)), bytes);
});

await test('gzip from zlib opens with fflate', async () => {
  assert.deepEqual(await gunzipBytes(new Uint8Array(gzipSync(bytes))), bytes);
});

await test('empty input round-trips', async () => {
  assert.equal((await gunzipBytes(await gzipBytes(new Uint8Array(0)))).length, 0);
});

console.log(`\n${passed} passed`);
