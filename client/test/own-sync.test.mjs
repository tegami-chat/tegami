// Unit tests for syncing my own devices (src/lib/own-sync.ts) and the history files (src/lib/history.ts).
// Run:  node test/own-sync.test.mjs   (Node 24 strips the TypeScript types)

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

import * as nip59 from 'nostr-tools/nip59';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

const S = await import('../src/lib/own-sync.ts');
const { wrapQuiet } = await import('../src/lib/signal.ts');
const H = await import('../src/lib/history.ts');
const T = await import('../src/lib/transfer.ts');

const X = 'a'.repeat(64);
const Y = 'b'.repeat(64);
const Z = 'c'.repeat(64);
const EMPTY_AI = { all: {}, models: {}, ais: {}, friends: {}, peerAis: {} };
const lists = (o = {}) => ({ contacts: [], groups: [], blocked: [], ai: EMPTY_AI, ...o });
const all = (ledger, l, at) => S.stampAll(ledger, l, at);
/** Sends A's ledger to B as an envelope would carry it, and returns B's lists after merging. */
function deliver(from, toLedger, toLists, at) {
  let remote = {};
  for (const part of S.syncParts(from, 0)) Object.assign(remote, S.readSyncPart(part));
  const { ledger, changed } = S.merge(all(toLedger, toLists, at), remote);
  return { ledger, changed, lists: S.materialize(ledger, toLists) };
}

let n = 0;
const test = (name, fn) => {
  fn();
  n++;
  console.log(`  ok    ${name}`);
};

test('an account from before syncing starts at the oldest time, so any real change wins', () => {
  const l = all(null, lists({ contacts: [{ pubkey: X, name: 'えっくす' }] }), 5000);
  assert.equal(l[`c:${X}`].at, S.BASELINE_AT);
  const again = S.stamp(l, 'c', lists({ contacts: [{ pubkey: X, name: 'えっくす' }] }), 6000);
  assert.equal(again.changed, false);
});

test('a friend added on one device appears on the other', () => {
  const a = all(null, lists(), 1000);
  const a2 = S.stamp(a, 'c', lists({ contacts: [{ pubkey: X, name: 'えっくす', model: 'Anthropic Claude' }] }), 2000).ledger;
  const b = deliver(a2, null, lists(), 2500);
  assert.deepEqual(b.lists.contacts, [{ pubkey: X, name: 'えっくす', model: 'Anthropic Claude' }]);
  assert(b.changed.has('c'));
});

test('two devices that change different things at the same time keep both', () => {
  const base = lists({ contacts: [{ pubkey: X, name: 'えっくす' }] });
  let a = all(null, base, 1000);
  let b = all(null, base, 1000);
  a = S.stamp(a, 'c', lists({ contacts: [{ pubkey: X, name: 'えっくす' }, { pubkey: Y, name: 'わい' }] }), 2000).ledger;
  b = S.stamp(b, 'c', lists({ contacts: [{ pubkey: X, name: 'X さん' }] }), 2001).ledger;
  const atB = deliver(a, b, lists({ contacts: [{ pubkey: X, name: 'X さん' }] }), 3000);
  const atA = deliver(b, a, lists({ contacts: [{ pubkey: X, name: 'えっくす' }, { pubkey: Y, name: 'わい' }] }), 3000);
  const names = (l) => l.contacts.map((c) => `${c.pubkey[0]}:${c.name}`).sort();
  assert.deepEqual(names(atB.lists), ['a:X さん', 'b:わい']);
  assert.deepEqual(names(atA.lists), names(atB.lists));
});

test('a removed friend stays removed: a device that has not heard of it does not bring it back', () => {
  const base = lists({ contacts: [{ pubkey: X, name: 'えっくす' }] });
  let a = S.stamp(all(null, lists(), 1), 'c', base, 1000).ledger;
  const b = deliver(a, null, lists(), 1100).ledger; // B learns of X at 1000
  a = S.stamp(a, 'c', lists(), 2000).ledger; // A removes X
  assert.equal(a[`c:${X}`].v, undefined);
  // B still has X and sends its (older) ledger to A: X stays gone on A.
  const atA = deliver(b, a, lists(), 2100);
  assert.deepEqual(atA.lists.contacts, []);
  // A's ledger reaches B: X goes there too.
  const atB = deliver(a, b, base, 2200);
  assert.deepEqual(atB.lists.contacts, []);
});

test('blocks and unblocks move between devices', () => {
  let a = all(null, lists(), 1);
  a = S.stamp(a, 'b', lists({ blocked: [Z] }), 1000).ledger;
  let atB = deliver(a, null, lists(), 1001);
  assert.deepEqual(atB.lists.blocked, [Z]);
  a = S.stamp(a, 'b', lists({ blocked: [] }), 2000).ledger;
  atB = deliver(a, atB.ledger, atB.lists, 2001);
  assert.deepEqual(atB.lists.blocked, []);
});

test('a group is shared, but deleting a chat stays on this device', () => {
  const id = [X, Y].sort().join(',');
  let a = all(null, lists(), 1);
  a = S.stamp(a, 'g', lists({ groups: [{ id, name: '家族', members: id.split(',') }] }), 1000).ledger;
  const atB = deliver(a, null, lists(), 1001);
  assert.deepEqual(atB.lists.groups, [{ id, name: '家族', members: id.split(',') }]);
  // A deletes the chat: its tombstone is local and never sent.
  a = S.stamp(a, 'g', lists(), 2000).ledger;
  assert(a[`g:${id}`].local);
  assert(!(`g:${id}` in S.shareable(a, 0)));
  // B's older group entry does not bring it back on A.
  const atA = deliver(atB.ledger, a, lists(), 2100);
  assert.deepEqual(atA.lists.groups, []);
});

test('AI switches are synced one by one: turning one off on one device stops it on the other', () => {
  const on = { ...EMPTY_AI, all: { read: true, draft: true }, friends: { [X]: { read: true } } };
  let a = all(null, lists({ ai: on }), 1);
  let b = deliver(a, null, lists(), 2);
  assert.deepEqual(b.lists.ai.all, { read: true, draft: true });
  assert.deepEqual(b.lists.ai.friends, { [X]: { read: true } });
  // A turns reading off; at the same time B turns drafting to "ask".
  a = S.stamp(a, 'a', lists({ ai: { ...on, all: { read: false, draft: true } } }), 1000).ledger;
  const bLedger = S.stamp(b.ledger, 'a', lists({ ai: { ...on, all: { read: true, draft: 'ask' } } }), 1001).ledger;
  const atB = deliver(a, bLedger, lists({ ai: { ...on, all: { read: true, draft: 'ask' } } }), 1100);
  assert.deepEqual(atB.lists.ai.all, { read: false, draft: 'ask' });
});

test('tombstones older than a year are no longer sent; live entries always are', () => {
  const now = Date.now();
  const l = { [`c:${X}`]: { at: now - S.TOMBSTONE_MS - 1 }, [`c:${Y}`]: { at: now - 1000 }, [`b:${Z}`]: { at: 1, v: 1 } };
  assert.deepEqual(Object.keys(S.shareable(l, now)), [`b:${Z}`, `c:${Y}`]);
});

test('broken entries from outside are dropped', () => {
  const got = S.cleanEntries({
    [`c:${X}`]: [5, { n: 'ok' }],
    'c:nothex': [5, { n: 'bad' }],
    [`b:${Y}`]: [5, 2],
    'a:["all","fly"]': [5, true],
    'a:["all","read"]': [5, 'maybe'],
    'a:["all","send"]': [5, { until: 99 }],
    '#c': [5, 1],
    [`g:${X}`]: [5, { n: 'one member' }],
  });
  assert.deepEqual(Object.keys(got), [`c:${X}`, 'a:["all","send"]']);
});

test('a large ledger is split into envelopes that each fit', () => {
  // Japanese names are 3 bytes a character: the limit counts bytes, and each part really wraps.
  const contacts = Array.from({ length: 2000 }, (_, i) => ({ pubkey: i.toString(16).padStart(64, '0'), name: `とてもながいなまえのともだち${i}`.padEnd(40, 'あ') }));
  const l = all(null, lists({ contacts }), 1);
  const parts = S.syncParts(l);
  assert(parts.length > 1, `parts: ${parts.length}`);
  const sk = generateSecretKey();
  const me = getPublicKey(sk);
  for (const p of parts) {
    assert(new TextEncoder().encode(p).length <= S.SYNC_PART_BYTES + 400, `part of ${p.length}`);
    const rumor = nip59.createRumor({ kind: S.ACCOUNT_SYNC_KIND, content: p, tags: [['p', me]], created_at: 1 }, sk);
    const wrap = wrapQuiet(rumor, sk, me);
    assert(JSON.stringify(wrap).length < 128 * 1024, 'envelope over the relay limit');
    assert.equal(nip59.unwrapEvent(wrap, sk).content, p);
  }
  const back = {};
  for (const p of parts) Object.assign(back, S.readSyncPart(p));
  assert.equal(Object.keys(back).length, 2000);
});

test('a bundle carries the ledger and the history files; too big, the ledger goes first after the stamps', () => {
  const ref = { url: 'https://relay.tegami.chat/' + 'd'.repeat(64), type: 'application/gzip', key: '1'.repeat(64), nonce: '2'.repeat(24), sha256: 'd'.repeat(64) };
  const raw = { v: 1, secretHex: '3'.repeat(64), myName: 'えー', contacts: [], groups: [], sync: { [`c:${X}`]: [9, { n: 'えっくす' }] }, history: [ref, { url: 'x' }] };
  const b = T.cleanBundle(raw);
  assert.deepEqual(b.sync, { [`c:${X}`]: [9, { n: 'えっくす' }] });
  assert.equal(b.history.length, 1);
  const big = { ...b, sync: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`b:${i.toString(16).padStart(64, '0')}`, [1, 1]])) };
  const fit = T.fitBundle(big, 46_000);
  assert.equal(fit.sync, undefined);
  assert(JSON.stringify(fit).length <= 46_000);
});

test('history: newest messages first, the oldest are left out when the files are full', () => {
  const msgs = Array.from({ length: 100 }, (_, i) => ({ id: `${i}`.padStart(64, '0'), from: X, peer: X, text: 'あ'.repeat(40), at: 1000 + i }));
  msgs.push({ id: 'local:1', from: Y, peer: X, text: 'まだ', at: 5000 });
  msgs.push({ id: 'e'.repeat(64), from: Y, peer: X, text: '送信中', at: 5001, pending: 'unsent' });
  const { parts, left } = H.historyParts({ messages: msgs, cleared: { [X]: 10 }, deleted: ['q'] }, 2000, 2);
  assert.equal(parts.length, 2);
  const got = parts.flatMap((p) => H.readHistoryPart(p).messages);
  assert.equal(got.length + left, 100);
  assert(got.every((m) => m.at >= 1000 + left), 'the oldest were not the ones left out');
  assert(!got.some((m) => m.id === 'local:1' || m.pending), 'unsent messages went along');
  assert.deepEqual(H.readHistoryPart(parts[0]).cleared, { [X]: 10 });
  const all1 = H.historyParts({ messages: msgs, cleared: {}, deleted: [] });
  assert.equal(all1.left, 0);
  assert.equal(all1.parts.length, 1);
});

test('history: broken messages are dropped', () => {
  const part = JSON.stringify({
    v: 1,
    messages: [
      { id: 'f'.repeat(64), from: X, peer: `${X},${Y}`, text: 'ok', at: 1, call: { video: true, result: 'done', seconds: 3 }, pending: 'unsent' },
      { id: 'x', from: 'me', peer: X, text: 'bad', at: 1 },
      { id: 'y', from: X, peer: X, text: 'bad file', at: 1, file: { url: 'javascript:1' } },
    ],
  });
  const h = H.readHistoryPart(part);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].pending, undefined);
  assert.deepEqual(h.messages[0].call, { video: true, result: 'done', seconds: 3 });
});

test('a Tegami group (g-<gid>) is not in the ledger: its state comes only from signed group changes', () => {
  const g = { id: `g-${'1'.repeat(32)}`, gid: '1'.repeat(32), name: '家族', members: [X, Y], mode: 'admin', admins: [X], v: 5, vid: 'f'.repeat(64) };
  const a = S.stamp(all(null, lists(), 1), 'g', lists({ groups: [g] }), 1000).ledger;
  assert(!Object.keys(a).some((key) => key.startsWith('g:g-')), 'a Tegami group went into the ledger');
  // A device that has the group keeps it as it is, whatever the other device's ledger says.
  const old = [X, Z].sort().join(',');
  let other = S.stamp(all(null, lists(), 1), 'g', lists({ groups: [{ id: old, name: '古い', members: old.split(',') }] }), 1500).ledger;
  const atB = deliver(other, null, lists({ groups: [g] }), 2000);
  assert.deepEqual(atB.lists.groups.find((x) => x.id === g.id), g);
  assert(atB.lists.groups.some((x) => x.id === old));
  // An entry for a g- group from outside is dropped.
  assert.deepEqual(S.cleanEntries({ [`g:${g.id}`]: [9, { n: 'にせもの' }] }), {});
});

test('history: messages of a Tegami group, group lines and AI-written messages make the move', () => {
  const room = `g-${'2'.repeat(32)}`;
  const part = JSON.stringify({
    v: 1,
    messages: [
      { id: 'e'.repeat(64), from: X, peer: room, text: 'グループで', at: 1 },
      { id: 'd'.repeat(64), from: X, peer: room, text: 'えーがグループを作成しました。', at: 2, notice: true },
      { id: 'c'.repeat(64), from: X, peer: Y, text: 'AIが書いた', at: 3, ai: { pubkey: Z, model: 'Anthropic Claude', name: 'クロード' } },
      { id: 'b'.repeat(64), from: X, peer: 'g-xyz', text: 'bad room', at: 4 },
    ],
    cleared: { [room]: 1 },
  });
  const h = H.readHistoryPart(part);
  assert.equal(h.messages.length, 3);
  assert.equal(h.messages[1].notice, true);
  assert.deepEqual(h.messages[2].ai, { pubkey: Z, model: 'Anthropic Claude', name: 'クロード' });
  assert.equal(h.cleared[room], 1);
});

console.log(`${n} passed`);
