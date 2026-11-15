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
let chain = Promise.resolve();
function test(name, fn) {
  chain = chain.then(async () => {
    await fn();
    n++;
    console.log(`ok ${n} ${name}`);
  });
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

test('settings from another device: unknown or broken values are dropped, the log stays', () => {
  const clean = P.cleanAiPermissions({
    all: { read: true, fly: true, send: 'yes' },
    models: { [MODEL]: { read: false }, empty: {} },
    ais: 'nope',
    friends: { [TEST_B]: { read: true, draft: 1 } },
  });
  assert.deepEqual(clean, { all: { read: true }, models: { [MODEL]: { read: false } }, ais: {}, friends: { [TEST_B]: { read: true } }, peerAis: {} });
  const logBefore = store.get('tegami.ai.log');
  P.replaceAiPermissions(clean);
  assert.equal(check({ action: 'read', friend: TEST_B }), 'model');
  assert.equal(store.get('tegami.ai.log'), logBefore);
});

test('an older bundle without settings turns every AI off', () => {
  setAiSwitch({ layer: 'all' }, 'read', true);
  setAiSwitch({ layer: 'friend', id: TEST_B }, 'read', true);
  for (const old of [undefined, null, 'x', []]) {
    P.replaceAiPermissions(old);
    assert.deepEqual(getAiPermissions(), { all: {}, models: {}, ais: {}, friends: {}, peerAis: {} });
    for (const action of P.AI_ACTIONS) assert.equal(check({ action, friend: TEST_B }), 'all');
  }
});

test('a bundle from the link or the recovery backup carries the settings; an older one has them off', async () => {
  const T = await import('../src/lib/transfer.ts');
  const base = { v: 1, secretHex: '1'.repeat(64), myName: 'x', contacts: [], groups: [] };
  assert.deepEqual(T.cleanBundle(base).ai, { all: {}, models: {}, ais: {}, friends: {}, peerAis: {} });
  const ai = { all: { read: true, draft: 'ask', send: { until: 2000000000 } }, models: {}, ais: {}, friends: { [TEST_B]: { read: true } }, peerAis: { [`${AI}>${AI2}`]: { until: 2000000000 } } };
  assert.deepEqual(T.cleanBundle({ ...base, ai }).ai, ai);
});

const PEER = 'e'.repeat(64);
const NOW = 1_800_000_000;
const at = (r, t = NOW) => P.checkAi(getAiPermissions(), { ai: AI, model: MODEL, ...r }, isFriend, t);
const reset = () => P.replaceAiPermissions(null);

test('ask each time: the strictest layer wins, and a lower layer cannot turn asking back into on', () => {
  reset();
  setAiSwitch({ layer: 'all' }, 'read', 'ask');
  setAiSwitch({ layer: 'friend', id: TEST_B }, 'read', true);
  assert.equal(at({ action: 'read', friend: TEST_B }), 'ask');
  setAiSwitch({ layer: 'all' }, 'read', true);
  assert.equal(at({ action: 'read', friend: TEST_B }), null);
  setAiSwitch({ layer: 'ai', id: AI }, 'read', 'ask');
  assert.equal(at({ action: 'read', friend: TEST_B }), 'ask');
  setAiSwitch({ layer: 'friend', id: STRANGER }, 'read', 'ask');
  assert.equal(at({ action: 'read', friend: STRANGER }), 'stranger');
});

test('a time limit: on until then, off afterwards, and the sweep turns it off and logs it', () => {
  reset();
  setAiSwitch({ layer: 'all' }, 'contacts', { until: NOW + 3600 });
  assert.equal(at({ action: 'contacts' }), null);
  assert.equal(at({ action: 'contacts' }, NOW + 3600), 'expired');
  setAiSwitch({ layer: 'all' }, 'read', true);
  setAiSwitch({ layer: 'friend', id: TEST_B }, 'read', { until: NOW + 60 });
  assert.equal(at({ action: 'read', friend: TEST_B }), null);
  assert.equal(at({ action: 'read', friend: TEST_B }, NOW + 61), 'expired');
  const before = JSON.parse(store.get('tegami.ai.log')).length;
  P.expireAiSwitches(NOW + 4000);
  assert.equal(getAiPermissions().all.contacts, false);
  assert.equal(getAiPermissions().friends[TEST_B].read, false);
  assert.equal(getAiPermissions().all.read, true);
  const log = JSON.parse(store.get('tegami.ai.log')).slice(before);
  assert.deepEqual(log.map((e) => [e.action, e.stoppedBy, e.expired.layer]), [['contacts', 'expired', 'all'], ['read', 'expired', 'friend']]);
});

test('read only in one go: see friends, read and draft on; nothing is sent', () => {
  reset();
  P.setAiSwitches({ layer: 'all' }, P.READ_ONLY);
  P.setAiSwitches({ layer: 'friend', id: TEST_B }, P.READ_ONLY);
  for (const action of ['contacts', 'read', 'draft']) assert.equal(at({ action, friend: TEST_B }), null, action);
  for (const action of ['send', 'autosend', 'otherAi']) assert.equal(at({ action, friend: TEST_B }), 'all', action);
});

test('sending without asking still asks for photos, videos, files, voice and money', () => {
  reset();
  for (const a of ['send', 'autosend']) {
    setAiSwitch({ layer: 'all' }, a, true);
    setAiSwitch({ layer: 'friend', id: TEST_B }, a, true);
  }
  const send = (content) => at({ action: 'autosend', friend: TEST_B, content });
  assert.equal(send({ kind: 'text', text: '明日の10時でどう？' }), null);
  for (const kind of ['photo', 'video', 'file', 'voice']) assert.equal(send({ kind }), 'always', kind);
  for (const text of ['3000円振り込んで', '口座はこちら', '¥5,000 です', '2万円かかる', 'ビットコインで払う']) assert.equal(send({ kind: 'text', text }), 'always', text);
  // Sending after the user saw the draft is already a look: no extra asking.
  assert.equal(at({ action: 'send', friend: TEST_B, content: { kind: 'photo' } }), null);
});

test("talking to another person's AI asks the first time, then not until the permission runs out", async () => {
  reset();
  setAiSwitch({ layer: 'all' }, 'otherAi', true);
  const peer = { pubkey: PEER, name: 'テストCの AI', model: 'OpenAI GPT' };
  assert.equal(at({ action: 'otherAi', peer }), 'firstPeer');
  assert.equal(at({ action: 'otherAi' }), 'stranger');
  // No confirm window on screen (as here): asking refuses and logs it.
  assert.equal(await P.askAi({ ai: AI, model: MODEL, action: 'otherAi', peer }, isFriend), false);
  P.replaceAiPermissions({ ...getAiPermissions(), peerAis: { [`${AI}>${PEER}`]: { until: NOW + 86400 } } });
  assert.equal(at({ action: 'otherAi', peer }), null);
  assert.equal(at({ action: 'otherAi', peer }, NOW + 86400), 'firstPeer');
  assert.equal(at({ action: 'otherAi', peer: { pubkey: AI2 } }), 'firstPeer');
});

test('the first version of the settings (only true and false) keeps its meaning', () => {
  P.replaceAiPermissions({ all: { read: true, send: false }, friends: { [TEST_B]: { read: true } } });
  assert.equal(at({ action: 'read', friend: TEST_B }), null);
  assert.equal(at({ action: 'send', friend: TEST_B }), 'all');
});

await chain;
console.log(`\n${n} passed`);
