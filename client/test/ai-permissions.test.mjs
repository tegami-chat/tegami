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
  // A second copy of the app's modules (a second browser tab): everything it imports is a copy too.
  const r = await next(spec, ctx);
  if (ctx.parentURL && ctx.parentURL.includes('?tabB') && r.url.startsWith('file:') && !r.url.includes('node_modules')) return { ...r, url: r.url.split('?')[0] + '?tabB' };
  return r;
}`),
);

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// Most tests here check the gate with every stage open; the stage itself is tested at the end.
process.env.EXPO_PUBLIC_TEGAMI_AI_STAGE = '3';
// The log is kept encrypted (src/lib/at-rest.ts): open an account first, as the app does.
const A = await import('../src/lib/at-rest.ts');
await A.openAtRest('main', new Uint8Array(32).fill(1));
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
  assert.equal(check({ action: 'autosend', friend: TEST_B, readOthers: false }), null);
});

test('the gate writes every decision to the log', () => {
  assert.equal(gateAi({ ai: AI, model: MODEL, action: 'read', friend: TEST_B }, isFriend), true);
  assert.equal(gateAi({ ai: AI, model: MODEL, action: 'read', friend: STRANGER }, isFriend), false);
  const log = JSON.parse(A.sealedRaw('tegami.ai.log'));
  assert.equal(log.length, 2);
  assert.deepEqual([log[0].allowed, log[1].allowed, log[1].stoppedBy], [true, false, 'stranger']);
});

test('the log keeps which messages were handed over, only when allowed', () => {
  const range = { count: 3, from: 100, to: 200 };
  gateAi({ ai: AI, model: MODEL, action: 'read', friend: TEST_B, range }, isFriend);
  gateAi({ ai: AI, model: MODEL, action: 'read', friend: STRANGER, range }, isFriend);
  const log = JSON.parse(A.sealedRaw('tegami.ai.log'));
  assert.deepEqual(log.at(-2).range, range);
  assert.equal(log.at(-1).range, undefined);
});

test('a switch turned off in another tab stops the gate at once', async () => {
  assert.equal(gateAi({ ai: AI, model: MODEL, action: 'read', friend: TEST_B }, isFriend), true);
  // Tab B: its own copy of the modules and its own memory, opened from what tab A has written.
  await A.flushAtRest();
  const AB = await import('../src/lib/at-rest.ts?tabB');
  assert.notEqual(AB, A, 'a second copy');
  await AB.openAtRest('main', new Uint8Array(32).fill(1));
  const PB = await import('../src/lib/ai-permissions.ts?tabB');
  const gateB = () => PB.gateAi({ ai: AI, model: MODEL, action: 'read', friend: TEST_B }, isFriend);
  assert.equal(gateB(), true, 'tab B starts with the same switches');
  let told = 0;
  const off = AB.onSealedChange(() => told++);
  // Tab A turns the switch off; tab B is not touched directly.
  setAiSwitch({ layer: 'friend', id: TEST_B }, 'read', false);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(gateB(), false, 'tab B stops at once');
  assert.equal(PB.getAiPermissions().friends[TEST_B].read, false);
  assert.ok(told >= 1, 'tab B was told, so its screens draw again');
  // Tab B must not write the received value back: only tab A's write reaches the records.
  await AB.flushAtRest();
  await A.flushAtRest();
  setAiSwitch({ layer: 'friend', id: TEST_B }, 'read', true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(gateB(), true, 'and the switch coming back on reaches tab B too');
  off();
  AB.closeAtRest(true);
  await A.flushAtRest();
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
  const logBefore = A.sealedRaw('tegami.ai.log');
  P.replaceAiPermissions(clean);
  assert.equal(check({ action: 'read', friend: TEST_B }), 'model');
  assert.equal(A.sealedRaw('tegami.ai.log'), logBefore);
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
  const before = JSON.parse(A.sealedRaw('tegami.ai.log')).length;
  P.expireAiSwitches(NOW + 4000);
  assert.equal(getAiPermissions().all.contacts, false);
  assert.equal(getAiPermissions().friends[TEST_B].read, false);
  assert.equal(getAiPermissions().all.read, true);
  const log = JSON.parse(A.sealedRaw('tegami.ai.log')).slice(before);
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
  const send = (content) => at({ action: 'autosend', friend: TEST_B, content, readOthers: false });
  assert.equal(send({ kind: 'text', text: '明日の10時でどう？' }), null);
  for (const kind of ['photo', 'video', 'file', 'voice']) assert.equal(send({ kind }), 'always', kind);
  for (const text of ['3000円振り込んで', '口座はこちら', '¥5,000 送って', '2万円かかるから今日中に払って', 'ビットコインで払う', 'PayPayで2000円送っておいて', '三万円貸してくれない？', 'Amazonギフト券を買ってきて']) assert.equal(send({ kind: 'text', text }), 'always', text);
  // A price said in passing is not money talk (findMoney): the AI may send it.
  for (const text of ['ランチ1200円だった', '2万円かかるらしい', '一万歩歩いたよ']) assert.equal(send({ kind: 'text', text }), null, text);
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

test('"stop all AI" also takes back every permission to talk to other AIs, and says which', () => {
  reset();
  P.replaceAiPermissions({ all: { otherAi: true }, peerAis: { [`${AI}>${PEER}`]: { until: NOW + 999999999 }, [`${AI2}>${TEST_B}`]: { until: NOW + 999999999 } } });
  const taken = stopAllAi();
  assert.deepEqual(taken.sort(), [[AI, PEER], [AI2, TEST_B]].sort());
  assert.deepEqual(getAiPermissions().peerAis, {});
  assert.deepEqual(stopAllAi(), []);
});

test('stages: at stage 2, sending without asking, other AIs and AI in a group are refused whatever the switches say', () => {
  reset();
  P.replaceAiPermissions({ all: { send: true, autosend: true, otherAi: true, read: true }, friends: { [TEST_B]: { send: true, autosend: true, read: true } } });
  const d = (r, stage) => P.decideAi(getAiPermissions(), { ai: AI, model: MODEL, ...r }, isFriend, NOW, stage);
  assert.deepEqual(d({ action: 'autosend', friend: TEST_B, content: { kind: 'text', text: 'こんにちは' } }, 2), { verdict: 'deny', by: 'stage' });
  assert.deepEqual(d({ action: 'otherAi', peer: { pubkey: PEER } }, 2), { verdict: 'deny', by: 'stage' });
  assert.equal(d({ action: 'send', friend: TEST_B }, 2).verdict, 'allow');
  assert.equal(d({ action: 'read', friend: TEST_B }, 2).verdict, 'allow');
  assert.equal(d({ action: 'send', friend: TEST_B }, 1).by, 'stage');
  assert.equal(d({ action: 'autosend', friend: TEST_B, content: { kind: 'text', text: 'こんにちは' }, readOthers: false }, 3).verdict, 'allow');
  assert.equal(P.aiStageAllows('group', 2), false);
  assert.equal(P.aiStageAllows('group', 3), true);
  assert.equal(P.AI_STAGE_OF.autosend, 3);
});

test('links always ask, like money (only what looks like money: words and amounts)', () => {
  reset();
  P.replaceAiPermissions({ all: { send: true, autosend: true }, friends: { [TEST_B]: { send: true, autosend: true } } });
  const send = (text) => at({ action: 'autosend', friend: TEST_B, content: { kind: 'text', text }, readOthers: false });
  for (const text of ['ここ見て https://example.com/x', 'www.example.jp', 'bit.ly/abc を開いて', 'Example.COM にログイン']) assert.equal(send(text), 'always', text);
  assert.equal(send('3.14は円周率'), null);
  assert.equal(send('ok. done'), null);
});

test('limits on sending without asking: per minute, in a row in one chat, per day; changeable, never off', () => {
  reset();
  const p = () => getAiPermissions();
  assert.deepEqual(P.aiLimits(p()), { minute: 5, chat: 20, day: 100 });
  const sent = (n, ago = 0) => Array.from({ length: n }, (_, i) => ({ at: NOW - ago - i, to: TEST_B }));
  assert.equal(P.overAiLimit(p(), sent(4), 0, NOW), null);
  assert.equal(P.overAiLimit(p(), sent(5), 0, NOW), 'minute');
  assert.equal(P.overAiLimit(p(), sent(5, 61), 0, NOW), null);
  assert.equal(P.overAiLimit(p(), [], 20, NOW), 'chat');
  assert.equal(P.overAiLimit(p(), [], 19, NOW), null);
  assert.equal(P.overAiLimit(p(), sent(100, 120), 0, NOW), 'day');
  assert.equal(P.overAiLimit(p(), sent(100, 86400), 0, NOW), null);
  P.setAiLimit('minute', 0);
  assert.equal(P.aiLimits(p()).minute, 1, 'a limit cannot be 0');
  P.setAiLimit('day', 1e9);
  assert.equal(P.aiLimits(p()).day, 1000, 'a limit cannot be taken off');
  P.setAiLimit('chat', 3);
  assert.equal(P.overAiLimit(p(), [], 3, NOW), 'chat');
  // From outside: broken values fall back, out-of-range ones are kept in range.
  const clean = P.cleanAiPermissions({ limits: { minute: -5, chat: 'x', day: 50, fly: 3 } });
  assert.deepEqual(clean.limits, { minute: 1, day: 50 });
  assert.deepEqual(P.aiLimits(clean), { minute: 1, chat: 20, day: 50 });
});

test('widened: what my other device let AIs do more is noticed; narrowing is not', () => {
  const base = P.cleanAiPermissions({ all: { read: true, send: 'ask' }, ais: { [AI]: { read: false } }, friends: { [TEST_B]: { read: { until: NOW + 60 } } } });
  const w = (next) => P.aiWidened(base, P.cleanAiPermissions(next), NOW);
  assert.equal(w({ all: { read: true, send: 'ask' }, ais: { [AI]: { read: false } }, friends: { [TEST_B]: { read: { until: NOW + 60 } } } }), false, 'the same');
  assert.equal(w({ all: { read: true, send: true }, ais: { [AI]: { read: false } }, friends: { [TEST_B]: { read: { until: NOW + 60 } } } }), true, 'ask to on');
  assert.equal(w({ all: { read: true, send: 'ask', draft: true }, ais: { [AI]: { read: false } }, friends: { [TEST_B]: { read: { until: NOW + 60 } } } }), true, 'a new switch');
  assert.equal(w({ all: { read: true, send: 'ask' }, ais: {}, friends: { [TEST_B]: { read: { until: NOW + 60 } } } }), true, "an AI's off now follows");
  assert.equal(w({ all: { read: true, send: 'ask' }, ais: { [AI]: { read: false } }, friends: { [TEST_B]: { read: { until: NOW + 3600 } } } }), true, 'longer');
  assert.equal(w({ all: { read: true, send: 'ask' }, ais: { [AI]: { read: false } }, friends: { [TEST_B]: { read: true } } }), true, 'for good');
  assert.equal(w({ all: { read: true, send: 'ask' }, ais: { [AI]: { read: false } }, friends: { [TEST_B]: { read: { until: NOW + 60 } } }, peerAis: { [`${AI}>${PEER}`]: { until: NOW + 99 } } }), true, 'another AI');
  assert.equal(w({ all: { read: true, send: 'ask' }, ais: { [AI]: { read: false } }, friends: { [TEST_B]: { read: { until: NOW + 60 } } }, limits: { day: 500 } }), true, 'a higher limit');
  assert.equal(w({ all: { read: false }, ais: { [AI]: { read: false } }, friends: {} }), false, 'narrower');
  assert.equal(w({ all: { read: true, send: 'ask' }, ais: { [AI]: { read: false } }, friends: { [TEST_B]: { read: { until: NOW + 60 } } }, limits: { day: 10 } }), false, 'a lower limit');
});

test('AIの検査: a key, a recovery code, a card number or an API key is never sent by an AI, whatever the switches say', () => {
  reset();
  P.replaceAiPermissions({ all: { send: true, autosend: true }, friends: { [TEST_B]: { send: true, autosend: true } } });
  const d = (action, text) => P.decideAi(getAiPermissions(), { ai: AI, model: MODEL, action, friend: TEST_B, content: { kind: 'text', text }, readOthers: false }, isFriend, NOW, 3);
  const secrets = [
    'これ使って nsec1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqgj4a9e',
    `鍵は ${'ab'.repeat(32)} です`,
    '復旧コード K7QM-3XRA-ABCD-EFGH-JKLM-NPQR-STUV',
    'https://app.tegami.chat/link#k=abc123',
    'キーは sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx です',
    'カード 4242 4242 4242 4242',
    '全角でも ｎｓｅｃ１ｑｑｑｓｙｑｃｙｑ５ｒｑｗｚｑｆｐｇ９ｓｃｒｇｗｐｕｇｐｚｙ',
    '見えない文字 nsec​1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs',
  ];
  for (const text of secrets) {
    assert.deepEqual(d('autosend', text), { verdict: 'deny', by: 'secret' }, text);
    assert.deepEqual(d('send', text), { verdict: 'deny', by: 'secret' }, text);
  }
  // Everyday Japanese is not stopped: phone numbers, dates, times, prices, an npub to share.
  for (const text of ['電話は 090-1234-5678 です', '2026年11月17日 10:30 に', '会員番号 12345678', 'npub1zptpqkxhr98glpt4rqv9945f3hd3q82wghaqth4gwqtmzmtjutsse5a98k', '明日の10時でどう？'])
    assert.equal(d('autosend', text).verdict, 'allow', text);
});

test('Rule of Two: what an AI sends after reading what others wrote always waits for the user', () => {
  reset();
  P.replaceAiPermissions({ all: { send: true, autosend: true }, friends: { [TEST_B]: { send: true, autosend: true } } });
  const d = (r) => P.decideAi(getAiPermissions(), { ai: AI, model: MODEL, action: 'autosend', friend: TEST_B, content: { kind: 'text', text: '了解です' }, ...r }, isFriend, NOW, 3);
  assert.deepEqual(d({ readOthers: true }), { verdict: 'ask', by: 'others' });
  // An AI program that does not say counts as having read others.
  assert.deepEqual(d({}), { verdict: 'ask', by: 'others' });
  assert.equal(d({ readOthers: false }).verdict, 'allow');
  // Sending after the user saw it is a look already: not stopped.
  assert.equal(P.decideAi(getAiPermissions(), { ai: AI, action: 'send', friend: TEST_B, content: { kind: 'text', text: '了解です' }, readOthers: true }, isFriend, NOW, 3).verdict, 'allow');
});

test('permissions given for a while end when something about the AI changes (endAiGrants)', () => {
  reset();
  const later = Math.floor(Date.now() / 1000) + 3600;
  const PEER = 'e'.repeat(64);
  P.replaceAiPermissions({
    all: { read: true, send: true, autosend: true },
    ais: { [AI]: { read: { until: later }, send: true, autosend: 'ask' }, [AI2]: { read: { until: later } } },
    peerAis: { [`${AI}>${PEER}`]: { until: later }, [`${AI2}>${PEER}`]: { until: later } },
  });
  const before = P.getAiPermissions;
  const logBefore = JSON.parse(A.sealedRaw('tegami.ai.log') ?? '[]').length;
  assert.deepEqual(P.endAiGrants(AI, 'unmarked'), [PEER]);
  const p = before();
  // The time-limited switch is off now; ずっと and 毎回確認 stay as the user set them.
  assert.deepEqual(p.ais[AI], { read: false, send: true, autosend: 'ask' });
  assert.equal(p.peerAis[`${AI}>${PEER}`], undefined);
  // Another AI keeps what it was given.
  assert.deepEqual(p.ais[AI2], { read: { until: later } });
  assert.ok(p.peerAis[`${AI2}>${PEER}`]);
  // Each ended permission is in the log with the reason.
  const log = JSON.parse(A.sealedRaw('tegami.ai.log'));
  const ended = log.slice(logBefore).filter((e) => e.ended === 'unmarked');
  assert.deepEqual(ended.map((e) => e.action).sort(), ['otherAi', 'read']);
  // Nothing left to end: nothing changes and nothing is logged.
  assert.deepEqual(P.endAiGrants(AI, 'model'), []);
  // A removed AI friend keeps nothing, so adding it again starts from the defaults.
  P.endAiGrants(AI2, 'removed');
  assert.equal(P.getAiPermissions().ais[AI2], undefined);
  assert.equal(P.getAiPermissions().peerAis[`${AI2}>${PEER}`], undefined);
});

await chain;
console.log(`\n${n} passed`);
