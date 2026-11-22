// Unit tests for the replies my AI may not send with its own key (src/lib/ai-hold.ts).
// Run:  node test/ai-hold.test.mjs   (Node 24 strips the TypeScript types)

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

const H = await import('../src/lib/ai-hold.ts');
const A = await import('../src/lib/ai-actions.ts');
const R = await import('../src/lib/at-rest.ts');

const AI = 'a'.repeat(64);
const OTHER_AI = 'b'.repeat(64);
const FRIEND = '2'.repeat(64);
const STRANGER = '3'.repeat(64);
const NOW = 1_800_000_000;
const NSEC = 'nsec1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jq';
const ID1 = '1'.repeat(32);
const ID2 = '2'.repeat(32);
const ID3 = '3'.repeat(32);

const ask = (id, over = {}) => ({
  id: `rumor-${id}`,
  created_at: NOW,
  content: JSON.stringify({ v: 1, id, to: FRIEND, toName: 'テストB', text: '明日10時でどう？', reason: 'FIRST', ...over }),
});
const live = { stopped: false, now: NOW };
const myAi = { pubkey: AI, model: 'Claude', name: 'クロード' };

let n = 0;
function test(name, fn) {
  fn();
  n++;
  console.log(`ok  ${n} ${name}`);
}

test('the kinds are 25071 and 25072, and the AI ask is one the app routes', () => {
  assert.equal(A.AI_HOLD_ASK_KIND, 25071);
  assert.equal(A.AI_HOLD_RESULT_KIND, 25072);
  assert.ok(A.AI_ACTION_KINDS.includes(25071));
});

test('an ask joins the waiting list with who it is for, why, and when', () => {
  const r = H.receiveHold([], myAi, ask(ID1, { reason: 'MONEY', detail: 'x' }), live);
  assert.equal(r.result, undefined);
  assert.equal(r.holds.length, 1);
  assert.deepEqual(r.holds[0], { id: ID1, ai: AI, to: FRIEND, toName: 'テストB', text: '明日10時でどう？', reason: 'MONEY', detail: 'x', at: NOW, askAt: NOW });
});

test('every reason is read; an unknown reason, a bad id, a bad key and empty words are not', () => {
  for (const reason of ['CHECK', 'MONEY', 'FILE', 'LINK', 'FIRST']) assert.equal(H.receiveHold([], myAi, ask(ID1, { reason }), live).holds.length, 1, reason);
  for (const bad of [{ reason: 'OTHER' }, { id: 'zz' }, { to: 'nope' }, { text: '  ' }, { v: 2 }])
    assert.equal(H.receiveHold([], myAi, ask(ID1, bad), live).holds.length, 0, JSON.stringify(bad));
  assert.equal(H.receiveHold([], myAi, { id: 'r', created_at: NOW, content: 'not json' }, live).holds.length, 0);
});

test('a secret in the words is dropped and the AI is told secret', () => {
  const r = H.receiveHold([], myAi, ask(ID1, { text: `鍵は ${NSEC} です` }), live);
  assert.equal(r.holds.length, 0);
  assert.equal(r.result, 'secret');
  assert.equal(r.id, ID1);
});

test('with every AI stopped the ask is dropped and the AI is told stopped', () => {
  const r = H.receiveHold([], myAi, ask(ID1), { ...live, stopped: true });
  assert.equal(r.holds.length, 0);
  assert.equal(r.result, 'stopped');
});

test('the same ask twice is one; a newer ask for the same person from the same AI replaces the older', () => {
  const a = H.receiveHold([], myAi, ask(ID1), live).holds;
  assert.equal(H.receiveHold(a, myAi, ask(ID1), live).holds.length, 1);
  const b = H.receiveHold(a, myAi, ask(ID2, { text: 'こっちが新しい' }), live).holds;
  assert.deepEqual(b.map((h) => h.id), [ID2]);
  const c = H.receiveHold(b, myAi, ask(ID3, { to: STRANGER }), live).holds;
  assert.deepEqual(c.map((h) => h.id), [ID2, ID3]);
  const d = H.receiveHold(c, { pubkey: OTHER_AI }, ask('4'.repeat(32)), live).holds;
  assert.equal(d.length, 3);
});

test('送る: sent in my name to that person, with the mark that an AI wrote it, at the time of the ask', () => {
  const list = H.receiveHold([], myAi, ask(ID1, { to: STRANGER }), live).holds;
  const sent = [];
  const r = H.acceptHold(list, ID1, myAi, (plan) => sent.push(plan), live);
  assert.equal(r.result, 'sent');
  assert.equal(r.ai, AI);
  assert.deepEqual(r.holds, []);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, STRANGER);
  assert.equal(sent[0].text, '明日10時でどう？');
  assert.equal(sent[0].at, NOW);
  assert.deepEqual(sent[0].tags, [['ai', AI, 'Claude', 'クロード']]);
  assert.deepEqual(sent[0].tags, [A.aiTag(myAi)]);
});

test('送る: nothing is sent when everything is stopped, when it is no longer my AI, or when a secret is in the words', () => {
  const list = H.receiveHold([], myAi, ask(ID1), live).holds;
  for (const [label, ai, opts] of [['stopped', myAi, { ...live, stopped: true }], ['not my AI', undefined, live], ['another AI', { pubkey: OTHER_AI }, live]]) {
    const sent = [];
    const r = H.acceptHold(list, ID1, ai, (p) => sent.push(p), opts);
    assert.equal(r.result, 'stopped', label);
    assert.equal(sent.length, 0, label);
    assert.deepEqual(r.holds, [], label);
  }
  const secret = [{ id: ID2, ai: AI, to: FRIEND, text: `鍵 ${NSEC}`, reason: 'FIRST', at: NOW, askAt: NOW }];
  const sent = [];
  const r = H.acceptHold(secret, ID2, myAi, (p) => sent.push(p), live);
  assert.equal(r.result, 'secret');
  assert.equal(sent.length, 0);
});

test('送る for an id that is not there does nothing', () => {
  const sent = [];
  const r = H.acceptHold([], ID1, myAi, (p) => sent.push(p), live);
  assert.equal(r.result, undefined);
  assert.equal(sent.length, 0);
});

test('送らない: it leaves the list and nothing is sent', () => {
  const list = H.receiveHold([], myAi, ask(ID1), live).holds;
  const r = H.declineHold(list, ID1);
  assert.deepEqual(r.holds, []);
  assert.equal(r.hold?.ai, AI);
  assert.equal(H.declineHold(r.holds, ID1).hold, undefined);
});

test('after a day it is gone from the list, and pressing 送る then sends nothing (expired)', () => {
  const list = H.receiveHold([], myAi, ask(ID1), live).holds;
  assert.equal(H.expireHolds(list, NOW + H.HOLD_TTL - 1).expired.length, 0);
  const e = H.expireHolds(list, NOW + H.HOLD_TTL);
  assert.equal(e.expired.length, 1);
  assert.deepEqual(e.holds, []);
  const sent = [];
  const r = H.acceptHold(list, ID1, myAi, (p) => sent.push(p), { stopped: false, now: NOW + H.HOLD_TTL });
  assert.equal(r.result, 'expired');
  assert.equal(sent.length, 0);
});

test('an ask is fresh for a day, with a minute of clock skew allowed', () => {
  assert.ok(H.freshHold(NOW - H.HOLD_TTL, NOW));
  assert.ok(!H.freshHold(NOW - H.HOLD_TTL - 1, NOW));
  assert.ok(H.freshHold(NOW + 60, NOW));
  assert.ok(!H.freshHold(NOW + 61, NOW));
});

// The list is saved encrypted (as the account's records), and what is older than a day is not loaded.
{
  const SECRET = new Uint8Array(32).fill(7);
  await R.openAtRest('main', SECRET);
  const list = H.receiveHold([], myAi, ask(ID1, { text: 'ひみつのてがみ-7f3a' }), live).holds;
  H.saveHolds(list);
  assert.equal(H.loadHolds(NOW + 10).length, 1);
  await R.flushAtRest();
  assert.ok(![...store.values()].some((v) => v.includes('ひみつのてがみ')), 'the words are not on the device in plain');
  R.closeAtRest();
  await R.openAtRest('main', SECRET);
  assert.equal(H.loadHolds(NOW + 10).length, 1);
  assert.equal(H.loadHolds(NOW + H.HOLD_TTL).length, 0);
  R.closeAtRest();
  n++;
  console.log(`ok  ${n} the list is saved encrypted, and what is older than a day is not loaded`);
}

test('the list is one of the names kept encrypted on the device', () => {
  assert.ok(R.isSealedKey('tegami.ai.holds'));
  assert.ok(R.isSealedKey('tegami@ab12cd34.ai.holds'));
  assert.ok(R.SEALED_NAMES.includes('ai.holds'));
});

test('each reason has a heading, and the explanation names the AI and the person', () => {
  assert.deepEqual(Object.keys(H.HOLD_TITLES).sort(), ['CHECK', 'FILE', 'FIRST', 'LINK', 'MONEY']);
  assert.equal(H.HOLD_TITLES.CHECK, 'AIの検査が止めた返事');
  assert.equal(H.HOLD_TITLES.FIRST, '初めての相手への返事');
  assert.equal(H.holdExplain('クロード', 'テストB', true), 'クロードがテストBさんに送ろうとしています。送ると、あなたの名前で送られ、相手の画面には AI が書いたと出ます。');
  assert.ok(!H.holdExplain('クロード', 'npub1abc…wxyz', false).includes('さん'));
  for (const t of [...Object.values(H.HOLD_TITLES), H.holdExplain('a', 'b', true)]) assert.ok(!t.includes('・'));
});

console.log(`\n${n} passed`);
