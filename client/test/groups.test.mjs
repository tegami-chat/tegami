// Unit tests for Tegami groups (src/lib/groups.ts): who may change a group, and which messages belong.
// Run:  node test/groups.test.mjs   (Node 24 strips the TypeScript types)

import assert from 'node:assert/strict';

const G = await import('../src/lib/groups.ts');
const { applyGroupState, acceptsMessage, parseGroupState, changeText, canManage, groupRoom, gidOf, groupTagOf } = G;

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);
const GID = '0123456789abcdef0123456789abcdef';
const friends = new Set([A, B, C]);
const isFriend = (k) => friends.has(k);

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}
const state = (o) => ({ gid: GID, name: '家族', avatar: null, members: [A, B, C], admins: [], mode: 'open', op: 'create', ...o });

test('room id and tag round trip', () => {
  assert.equal(gidOf(groupRoom(GID)), GID);
  assert.equal(gidOf(`${A},${B}`), null);
  assert.equal(groupTagOf([['p', A], ['tegami-group', GID]]), GID);
  assert.equal(groupTagOf([['tegami-group', 'zz']]), null);
});

test('parse rejects malformed states', () => {
  const ok = parseGroupState(JSON.stringify(state()), () => null);
  assert.equal(ok.members.length, 3);
  assert.equal(parseGroupState('{', () => null), null);
  assert.equal(parseGroupState(JSON.stringify(state({ mode: 'x' })), () => null), null);
  assert.equal(parseGroupState(JSON.stringify(state({ members: ['nope'] })), () => null), null);
  assert.equal(parseGroupState(JSON.stringify(state({ op: 'steal' })), () => null), null);
  // Admins who are not members are dropped.
  assert.deepEqual(parseGroupState(JSON.stringify(state({ admins: [A, D] })), () => null).admins, [A]);
});

test('a new group from a friend is taken; from a stranger it is not', () => {
  const r = applyGroupState(undefined, state(), A, 100, 'x1', B, isFriend);
  assert.deepEqual(r.group.members.sort(), [A, C]);
  assert.equal(r.group.since, 100);
  assert.equal(applyGroupState(undefined, state({ members: [D, B] }), D, 100, 'x1', B, isFriend), null);
  // Not including me: not mine.
  assert.equal(applyGroupState(undefined, state({ members: [A, C] }), A, 100, 'x1', B, isFriend), null);
});

test('neutral group: any member adds and removes; outsiders and old states cannot', () => {
  const g = applyGroupState(undefined, state(), A, 100, 'x1', B, isFriend).group;
  const added = applyGroupState(g, state({ members: [A, B, C, D], op: 'add' }), C, 101, 'x2', B, isFriend);
  assert.ok(added, 'a member could not add');
  assert.deepEqual(added.change.added, [D]);
  assert.equal(applyGroupState(g, state({ members: [A, B], op: 'remove' }), D, 101, 'x2', B, isFriend), null, 'an outsider changed it');
  assert.equal(applyGroupState(g, state({ members: [A, B], op: 'remove' }), C, 99, 'x0', B, isFriend), null, 'an older state won');
  const removed = applyGroupState(g, state({ members: [A, B], op: 'remove' }), A, 102, 'x3', B, isFriend);
  assert.deepEqual(removed.change.removed, [C]);
  assert.deepEqual(removed.group.past, [C]);
});

test('group with admins: only admins change it; anyone may leave; the last admin is replaced', () => {
  const s0 = state({ mode: 'admin', admins: [A] });
  const g = applyGroupState(undefined, s0, A, 100, 'x1', B, isFriend).group;
  assert.equal(canManage(g, B), false);
  assert.equal(canManage({ ...g, members: [B, C] }, A), true);
  assert.equal(applyGroupState(g, { ...s0, members: [A, B, C, D], op: 'add' }, C, 101, 'x2', B, isFriend), null, 'a non-admin added someone');
  assert.equal(applyGroupState(g, { ...s0, admins: [A, C], op: 'admin' }, C, 101, 'x2', B, isFriend), null, 'a non-admin made themselves admin');
  // A new device cannot be fooled by a state whose author is not one of its admins.
  assert.equal(applyGroupState(undefined, { ...s0, admins: [A] }, C, 100, 'x1', B, isFriend), null);
  // Mode cannot be flipped by a later state.
  const open = applyGroupState(g, { ...s0, mode: 'open', admins: [], op: 'rename', name: '新' }, A, 101, 'x2', B, isFriend);
  assert.equal(open.group.mode, 'admin');
  assert.deepEqual(open.group.admins, [A]);
  // C leaves: only C goes, whatever the state says.
  const left = applyGroupState(g, { ...s0, members: [C], op: 'leave' }, C, 102, 'x3', B, isFriend);
  assert.deepEqual(left.group.members, [A]);
  // The only admin leaves: someone else takes over.
  const noAdmin = applyGroupState(g, { ...s0, op: 'leave' }, A, 102, 'x3', B, isFriend);
  assert.deepEqual(noAdmin.group.admins, [B]);
});

test('removed: I am marked as no longer in it', () => {
  const g = applyGroupState(undefined, state(), A, 100, 'x1', B, isFriend).group;
  const r = applyGroupState(g, state({ members: [A, C], op: 'remove' }), A, 101, 'x2', B, isFriend);
  assert.equal(r.group.left, true);
  assert.equal(canManage(r.group, B), false);
});

test('messages: members only, nothing from before I joined, a removed member only before removal', () => {
  const g0 = applyGroupState(undefined, state({ members: [A, B] }), A, 100, 'x1', A, isFriend).group;
  const g1 = applyGroupState(g0, state({ members: [A, B, C], op: 'add' }), A, 110, 'x2', C, isFriend);
  assert.equal(g1, null, 'C does not have the group yet, so it is new to C');
  const forC = applyGroupState(undefined, state({ members: [A, B, C], op: 'add' }), A, 110, 'x2', C, isFriend).group;
  assert.equal(acceptsMessage(forC, A, 105, C), false, 'C reads a message from before C was added');
  assert.equal(acceptsMessage(forC, A, 111, C), true);
  assert.equal(acceptsMessage(forC, D, 111, C), false, 'an outsider writes in it');
  const g2 = applyGroupState(g0, state({ members: [A], op: 'remove' }), A, 120, 'x3', A, isFriend).group;
  assert.equal(acceptsMessage(g2, B, 119, A), true, 'a message B wrote before removal');
  assert.equal(acceptsMessage(g2, B, 121, A), false, 'a message B wrote after removal');
});

test('someone just added sees "added me"; a late older state moves the join time back', () => {
  const forD = applyGroupState(undefined, state({ members: [A, B, C, D], op: 'add' }), A, 110, 'x2', D, isFriend);
  assert.deepEqual(forD.change.added, [D]);
  const renamed = applyGroupState(forD.group, state({ members: [A, B, C, D], op: 'rename' }), B, 120, 'x3', D, isFriend).group;
  assert.equal(renamed.since, 110);
  // D first got the rename (120), then the add (110): D joined at 110.
  const firstRename = applyGroupState(undefined, state({ members: [A, B, C, D], op: 'rename' }), A, 120, 'x3', D, isFriend).group;
  assert.equal(G.earlierJoin(firstRename, state({ members: [A, B, C, D], op: 'add' }), A, 110, D), 110);
  assert.equal(G.earlierJoin(firstRename, state({ members: [A, B, C, D], op: 'add' }), 'e'.repeat(64), 110, D), null, 'an outsider moved it');
});

test('the lines the chat shows', () => {
  const name = (k) => ({ [A]: 'あきら', [B]: 'ぶんた', [C]: 'ちえ' })[k];
  assert.equal(changeText({ op: 'add', by: A, added: [B, C], removed: [], admins: [], name: '' }, name), 'あきらがぶんた、ちえをグループに追加しました。');
  assert.equal(changeText({ op: 'remove', by: A, added: [], removed: [C], admins: [], name: '' }, name), 'あきらがちえをグループから削除しました。');
  assert.equal(changeText({ op: 'leave', by: B, added: [], removed: [B], admins: [], name: '' }, name), 'ぶんたが退会しました。');
  assert.equal(changeText({ op: 'rename', by: A, added: [], removed: [], admins: [], name: '親戚' }, name), 'あきらがグループ名を「親戚」に変更しました。');
});

console.log(`${passed} passed`);
