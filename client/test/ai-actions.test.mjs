// Unit tests for what AI friends may ask the app to do (src/lib/ai-actions.ts).
// Run:  node test/ai-actions.test.mjs   (Node 24 strips the TypeScript types)

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

const A = await import('../src/lib/ai-actions.ts');
const ME = '1'.repeat(64);
const B = '2'.repeat(64);
const C = '3'.repeat(64);
const AI = 'a'.repeat(64);
const everyone = [ME, B, C].sort();
const room = [B, C].sort().join(',');

let n = 0;
function test(name, fn) {
  fn();
  n++;
  console.log(`ok  ${name}`);
}

const invite = (from, at) => A.applyAiGroup({}, { t: 'invite', members: everyone, ai: AI, name: 'クロード' }, from, at);
const answer = (all, from, yes, at) => A.applyAiGroup(all, { t: 'answer', members: everyone, ai: AI, yes }, from, at);

test('the one who invites says yes by inviting; the AI is in only when everyone says yes', () => {
  let g = invite(ME, 10);
  assert.deepEqual(A.approvedAis(g, room, ME), []);
  g = answer(g, B, true, 11);
  assert.deepEqual(A.approvedAis(g, room, ME), []);
  g = answer(g, C, true, 12);
  assert.deepEqual(A.approvedAis(g, room, ME), [AI]);
});

test('one member taking the yes back takes the AI out', () => {
  let g = answer(answer(invite(ME, 10), B, true, 11), C, true, 12);
  g = answer(g, C, false, 13);
  assert.deepEqual(A.approvedAis(g, room, ME), []);
});

test('an older answer does not replace a newer one, and someone outside the group cannot answer', () => {
  let g = answer(answer(invite(ME, 10), B, true, 11), C, false, 13);
  g = answer(g, C, true, 12);
  assert.deepEqual(A.approvedAis(g, room, ME), []);
  const outsider = '9'.repeat(64);
  const same = answer(g, outsider, true, 20);
  assert.equal(same, g);
});

test('a new invitation starts over', () => {
  let g = answer(answer(invite(ME, 10), B, true, 11), C, false, 13);
  g = A.applyAiGroup(g, { t: 'invite', members: everyone, ai: AI, name: 'クロード' }, ME, 20);
  assert.deepEqual(Object.keys(g[everyone.join(',')][AI].answers), [ME]);
});

test("a message written by the AI belongs to the group only while everyone said yes; otherwise it is dropped", () => {
  const pending = answer(invite(ME, 10), B, true, 11);
  assert.equal(A.groupOfAiMessage(pending, AI, [B, C], ME), 'drop');
  const ok = answer(pending, C, true, 12);
  assert.equal(A.groupOfAiMessage(ok, AI, [B, C], ME), room);
  // Someone who is not an invited AI: not a group AI message.
  assert.equal(A.groupOfAiMessage(ok, B, [C], ME), null);
  // An AI writing to me alone (my own AI friend): not a group AI message.
  assert.equal(A.groupOfAiMessage(ok, AI, [], ME), null);
});

test('a 1:1 chat works the same way with two people', () => {
  const two = [ME, B].sort();
  let g = A.applyAiGroup({}, { t: 'invite', members: two, ai: AI, name: 'クロード' }, ME, 10);
  assert.deepEqual(A.approvedAis(g, B, ME), []);
  g = A.applyAiGroup(g, { t: 'answer', members: two, ai: AI, yes: true }, B, 11);
  assert.deepEqual(A.approvedAis(g, B, ME), [AI]);
  assert.equal(A.groupOfAiMessage(g, AI, [B], ME), B);
});

test('malformed asks and group notes are refused', () => {
  assert.equal(A.parseSendAsk(JSON.stringify({ v: 1, to: 'x', text: 'hi' })), null);
  assert.equal(A.parseSendAsk(JSON.stringify({ v: 1, to: B, text: '  ' })), null);
  assert.deepEqual(A.parseSendAsk(JSON.stringify({ v: 1, to: B, text: 'hi', n: 0.5 })), { to: B, text: 'hi' });
  assert.equal(A.parseAiGroup(JSON.stringify({ t: 'invite', members: [ME], ai: AI, name: 'x' })), null);
  // The AI cannot be one of the members.
  assert.equal(A.parseAiGroup(JSON.stringify({ t: 'invite', members: [ME, AI], ai: AI, name: 'x' })), null);
});

test('the AI-written tag: only the key shape is trusted', () => {
  assert.deepEqual(A.aiOf([A.aiTag({ pubkey: AI, model: 'Anthropic Claude', name: 'クロード' })]), { pubkey: AI, model: 'Anthropic Claude', name: 'クロード' });
  assert.equal(A.aiOf([['ai', 'not-a-key']]), undefined);
});

test('an ask is handled once', () => {
  assert.equal(A.handledAsk('x'), false);
  A.markHandled('x');
  assert.equal(A.handledAsk('x'), true);
});

console.log(`${n} passed`);
