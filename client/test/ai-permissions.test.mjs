// Unit tests for the AI permission gate (src/lib/ai-permissions.ts).
// Run:  node test/ai-permissions.test.mjs   (Node 24 strips the TypeScript types)

import assert from 'node:assert/strict';
import { register } from 'node:module';

// The app imports its own files without an extension ("./storage"); add ".ts" for Node.
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

const P = await import('../src/lib/ai-permissions.ts');
const { checkAi, gateAi, setAiSwitch, getAiPermissions, stopAllAi } = P;

const AI = 'a'.repeat(64);
const AI2 = 'b'.repeat(64);
const TEST_B = 'c'.repeat(64);
const STRANGER = 'd'.repeat(64);
const MODEL = 'Anthropic Claude';
const friends = new Set([TEST_B]);
const isFriend = (k) => friends.has(k);
const check = (r) => checkAi(getAiPermissions(), { ai: AI, model: MODEL, ...r }, isFriend);

let n = 0;
function test(name, fn) {
  fn();
  n++;
  console.log(`ok ${n} ${name}`);
}

test('everything is off at first', () => {
  for (const action of P.AI_ACTIONS) assert.equal(check({ action, friend: TEST_B }), 'all');
});

test('"all AI" on lets a non-friend action through', () => {
  setAiSwitch({ layer: 'all' }, 'contacts', true);
  assert.equal(check({ action: 'contacts' }), null);
});

test('friend actions also need the friend picked', () => {
  setAiSwitch({ layer: 'all' }, 'read', true);
  assert.equal(check({ action: 'read', friend: TEST_B }), 'friend');
  setAiSwitch({ layer: 'friend', id: TEST_B }, 'read', true);
  assert.equal(check({ action: 'read', friend: TEST_B }), null);
});

test('strangers are never reachable, whatever the switches', () => {
  setAiSwitch({ layer: 'friend', id: STRANGER }, 'read', true);
  assert.equal(check({ action: 'read', friend: STRANGER }), 'stranger');
  assert.equal(check({ action: 'read' }), 'stranger');
});

test('turning one AI off stops only that AI', () => {
  setAiSwitch({ layer: 'ai', id: AI }, 'read', false);
  assert.equal(check({ action: 'read', friend: TEST_B }), 'ai');
  assert.equal(checkAi(getAiPermissions(), { ai: AI2, model: MODEL, action: 'read', friend: TEST_B }, isFriend), null);
  setAiSwitch({ layer: 'ai', id: AI }, 'read', true);
});

test('turning a model off stops every AI of that model', () => {
  setAiSwitch({ layer: 'model', id: MODEL }, 'read', false);
  assert.equal(check({ action: 'read', friend: TEST_B }), 'model');
  assert.equal(checkAi(getAiPermissions(), { ai: AI2, model: MODEL, action: 'read', friend: TEST_B }, isFriend), 'model');
  assert.equal(checkAi(getAiPermissions(), { ai: AI2, model: 'Other', action: 'read', friend: TEST_B }, isFriend), null);
  setAiSwitch({ layer: 'model', id: MODEL }, 'read', true);
});

test('a lower layer cannot widen what "all AI" stops', () => {
  setAiSwitch({ layer: 'ai', id: AI }, 'send', true);
  setAiSwitch({ layer: 'friend', id: TEST_B }, 'send', true);
  assert.equal(check({ action: 'send', friend: TEST_B }), 'all');
});

test('sending without asking needs sending with asking', () => {
  setAiSwitch({ layer: 'all' }, 'autosend', true);
  setAiSwitch({ layer: 'friend', id: TEST_B }, 'autosend', true);
  assert.equal(check({ action: 'autosend', friend: TEST_B }), 'needs');
  setAiSwitch({ layer: 'all' }, 'send', true);
  assert.equal(check({ action: 'autosend', friend: TEST_B }), null);
});

test('the gate writes every decision to the log', () => {
  assert.equal(gateAi({ ai: AI, model: MODEL, action: 'read', friend: TEST_B }, isFriend), true);
  assert.equal(gateAi({ ai: AI, model: MODEL, action: 'read', friend: STRANGER }, isFriend), false);
  const log = JSON.parse(store.get('tegami.ai.log'));
  assert.equal(log.length, 2);
  assert.deepEqual([log[0].allowed, log[1].allowed, log[1].stoppedBy], [true, false, 'stranger']);
});

test('the log keeps which messages were handed over, only when allowed', () => {
  const range = { count: 3, from: 100, to: 200 };
  gateAi({ ai: AI, model: MODEL, action: 'read', friend: TEST_B, range }, isFriend);
  gateAi({ ai: AI, model: MODEL, action: 'read', friend: STRANGER, range }, isFriend);
  const log = JSON.parse(store.get('tegami.ai.log'));
  assert.deepEqual(log.at(-2).range, range);
  assert.equal(log.at(-1).range, undefined);
});

test('a switch turned off in another tab stops the gate at once', () => {
  assert.equal(gateAi({ ai: AI, model: MODEL, action: 'read', friend: TEST_B }, isFriend), true);
  // Another tab of this browser writes the stored switches; this tab's cache is not told.
  const stored = JSON.parse(store.get('tegami.ai.permissions'));
  stored.friends[TEST_B].read = false;
  store.set('tegami.ai.permissions', JSON.stringify(stored));
  assert.equal(gateAi({ ai: AI, model: MODEL, action: 'read', friend: TEST_B }, isFriend), false);
  setAiSwitch({ layer: 'friend', id: TEST_B }, 'read', true);
});

// ---------- reply drafts (src/lib/ai-draft.ts) ----------

const D = await import('../src/lib/ai-draft.ts');

test('a draft needs both "read" and "draft" allowed, and never for a stranger', () => {
  const ai = { pubkey: AI, model: MODEL };
  setAiSwitch({ layer: 'all' }, 'draft', false);
  assert.equal(D.mayDraft(getAiPermissions(), ai, TEST_B, isFriend), false);
  setAiSwitch({ layer: 'all' }, 'draft', true);
  assert.equal(D.mayDraft(getAiPermissions(), ai, TEST_B, isFriend), false); // friend layer still off
  setAiSwitch({ layer: 'friend', id: TEST_B }, 'draft', true);
  assert.equal(D.mayDraft(getAiPermissions(), ai, TEST_B, isFriend), true);
  setAiSwitch({ layer: 'friend', id: STRANGER }, 'draft', true);
  assert.equal(D.mayDraft(getAiPermissions(), ai, STRANGER, isFriend), false);
  setAiSwitch({ layer: 'friend', id: TEST_B }, 'read', false);
  assert.equal(D.mayDraft(getAiPermissions(), ai, TEST_B, isFriend), false);
  setAiSwitch({ layer: 'friend', id: TEST_B }, 'read', true);
});

test('the ask holds the latest texts of that one chat only', () => {
  const ME = 'e'.repeat(64);
  const all = [
    ...Array.from({ length: 40 }, (_, i) => ({ peer: TEST_B, from: i % 2 ? ME : TEST_B, text: `t${i}`, at: 1000 + i })),
    { peer: TEST_B, from: TEST_B, text: '', at: 2000, file: {} },
    { peer: TEST_B, from: TEST_B, text: '通話', at: 2001, call: {} },
    { peer: STRANGER, from: STRANGER, text: 'ほかのトーク', at: 2002 },
  ];
  const { ask, range } = D.draftAsk(all, TEST_B, ME, { friend: 'テストB', me: 'テストA' });
  assert.equal(ask.messages.length, D.AI_DRAFT_MESSAGES);
  assert.equal(ask.messages[0].text, 't10');
  assert.equal(ask.messages.at(-1).text, 't39');
  assert.ok(!ask.messages.some((m) => m.text === 'ほかのトーク' || m.text === '通話'));
  assert.deepEqual(range, { count: 30, from: 1010, to: 1039 });
  assert.equal(ask.messages[1].mine, true);
});

test('a malformed draft is refused', () => {
  assert.equal(D.parseDraft('{"re":"x","text":"a"}'), null);
  assert.equal(D.parseDraft('not json'), null);
  assert.deepEqual(D.parseDraft(JSON.stringify({ re: 'f'.repeat(64), text: 'ok' })), { re: 'f'.repeat(64), text: 'ok' });
});

test('"stop all AI" stops everything at once', () => {
  stopAllAi();
  for (const action of P.AI_ACTIONS) assert.equal(check({ action, friend: TEST_B }), 'all');
});

console.log(`\n${n} passed`);
