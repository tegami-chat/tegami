// Unit tests for the choice of whether the friend's screen shows the AI mark (src/lib/ai-mark.ts).
// Run:  node test/ai-mark.test.mjs   (Node 24 strips the TypeScript types)

import assert from 'node:assert/strict';
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

const M = await import('../src/lib/ai-mark.ts');
const R = await import('../src/lib/at-rest.ts');

const AI1 = 'a'.repeat(64);
const AI2 = 'b'.repeat(64);
const F1 = '1'.repeat(64);
const F2 = '2'.repeat(64);
const SECRET = new Uint8Array(32).fill(7);

let n = 0;
async function test(name, fn) {
  await fn();
  n++;
  console.log(`ok  ${n} ${name}`);
}
const base = { all: true, ais: {}, friends: {} };

await test('with nothing set the mark is on', () => {
  assert.equal(M.aiMarkWanted(base, AI1, F1), true);
  assert.deepEqual(M.cleanAiMark(undefined), base);
  assert.deepEqual(M.cleanAiMark({ all: 'x', ais: { zz: true }, friends: { [F1]: 'no' } }), base);
});

await test('all off turns it off for every AI and friend', () => {
  const m = { ...base, all: false };
  assert.equal(M.aiMarkWanted(m, AI1, F1), false);
  assert.equal(M.aiMarkWanted(m, AI2, F2), false);
});

await test('an AI overrules all, both ways, and the other AI follows all', () => {
  assert.equal(M.aiMarkWanted({ all: false, ais: { [AI1]: true }, friends: {} }, AI1, F1), true);
  assert.equal(M.aiMarkWanted({ all: false, ais: { [AI1]: true }, friends: {} }, AI2, F1), false);
  assert.equal(M.aiMarkWanted({ all: true, ais: { [AI1]: false }, friends: {} }, AI1, F1), false);
  assert.equal(M.aiMarkWanted({ all: true, ais: { [AI1]: false }, friends: {} }, AI2, F1), true);
});

await test('a friend overrules the AI and all, both ways; another friend follows the AI', () => {
  const off = { all: true, ais: { [AI1]: true }, friends: { [F1]: false } };
  assert.equal(M.aiMarkWanted(off, AI1, F1), false);
  assert.equal(M.aiMarkWanted(off, AI1, F2), true);
  const on = { all: false, ais: { [AI1]: false }, friends: { [F1]: true } };
  assert.equal(M.aiMarkWanted(on, AI1, F1), true);
  assert.equal(M.aiMarkWanted(on, AI1, F2), false);
});

await test('the choice shown for a layer: follow, on, off', () => {
  assert.equal(M.choiceOf(undefined), 'follow');
  assert.equal(M.choiceOf(true), 'on');
  assert.equal(M.choiceOf(false), 'off');
});

await test('settings are kept encrypted, and survive closing and opening the account', async () => {
  assert.ok(R.SEALED_NAMES.includes('ai.mark'));
  assert.ok(R.SEALED_NAMES.includes('ai.marked'));
  await R.openAtRest('main', SECRET);
  assert.equal(M.getAiMark().all, true);
  M.setAiMarkAll(false);
  M.setAiMarkChoice('ai', AI1, 'on');
  M.setAiMarkChoice('friend', F1, 'off');
  assert.equal(M.aiMarkWanted(M.getAiMark(), AI1, F2), true);
  assert.equal(M.aiMarkWanted(M.getAiMark(), AI1, F1), false);
  M.setAiMarkChoice('ai', AI1, 'follow');
  assert.deepEqual(M.getAiMark().ais, {});
  M.setAiMarkChoice('ai', AI1, 'on');
  await R.flushAtRest();
  R.closeAtRest();
  await R.openAtRest('main', SECRET);
  assert.deepEqual(M.getAiMark(), { all: false, ais: { [AI1]: true }, friends: { [F1]: false } });
  R.closeAtRest();
});

await test('a message sent without the mark is remembered with its AI, newest 2000 only', async () => {
  await R.openAtRest('main', SECRET);
  M.rememberMarked('id-1', { pubkey: AI1, model: 'Claude', name: 'クロード' });
  assert.deepEqual(M.markedBy('id-1'), { pubkey: AI1, model: 'Claude', name: 'クロード' });
  assert.equal(M.markedBy('id-x'), undefined);
  for (let i = 0; i < M.MARKED_MAX; i++) M.rememberMarked(`m-${i}`, { pubkey: AI2 });
  assert.equal(M.markedBy('id-1'), undefined);
  assert.deepEqual(M.markedBy(`m-${M.MARKED_MAX - 1}`), { pubkey: AI2 });
  assert.ok(M.markedBy('m-0'));
  await R.flushAtRest();
  R.closeAtRest();
  await R.openAtRest('main', SECRET);
  assert.ok(M.markedBy('m-5'));
  R.closeAtRest();
});

console.log(`\n${n} passed`);
