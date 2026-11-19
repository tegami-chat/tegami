// Unit tests for what the app keeps encrypted on the device (src/lib/at-rest.ts, storage.ts).
// Run:  node test/at-rest.test.mjs   (Node 24 strips the TypeScript types)
// Node has no IndexedDB, so the records go to the localStorage fallback the apps use
// ("tegami-store:<name>"); the browser's IndexedDB is covered by test/web.test.mjs.

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

const A = await import('../src/lib/at-rest.ts');
const S = await import('../src/lib/storage.ts');
const { k, load, save, remove } = S;

const SECRET = new Uint8Array(32).fill(7);
const OTHER = new Uint8Array(32).fill(8);
const WORDS = 'ひみつのてがみ-7f3a';
const raw = (name) => store.get(`tegami-store:${name}`);
const everything = () => JSON.stringify([...store.entries()]);

let n = 0;
let chain = Promise.resolve();
function test(name, fn) {
  chain = chain.then(async () => {
    await fn();
    n++;
    console.log(`ok ${n} ${name}`);
  });
}

test('which names are kept encrypted', () => {
  for (const name of ['messages', 'contacts', 'groups', 'outbox', 'blocked', 'deleted', 'readAt', 'cleared', 'sync', 'ai.log', 'stamps', 'stampsUsed', 'avatar']) {
    assert.ok(A.isSealedKey(`tegami.${name}`), name);
    assert.ok(A.isSealedKey(`tegami@ab12cd34.${name}`), name);
  }
  for (const name of ['vault', 'device', 'account', 'myName', 'setupAt', 'showUnread', 'registration', 'push', 'avatarAt', 'stampsAt', 'ai.permissions']) {
    assert.ok(!A.isSealedKey(`tegami.${name}`), name);
  }
  assert.ok(!A.isSealedKey('tegami.accounts') && !A.isSealedKey('tegami.theme'));
});

test('before an account is open nothing reads and a save is dropped', async () => {
  save(k('messages'), [{ id: '1', text: WORDS }]);
  assert.deepEqual(load(k('messages'), []), []);
  await A.openAtRest('main', SECRET);
  assert.deepEqual(load(k('messages'), []), [], 'the dropped save did not come back');
  await A.flushAtRest();
  assert.equal(raw('tegami.messages'), undefined);
  A.closeAtRest();
});

test('a saved value reads back, and only ciphertext is written', async () => {
  await A.openAtRest('main', SECRET);
  save(k('messages'), [{ id: '1', text: WORDS }]);
  assert.deepEqual(load(k('messages'), []), [{ id: '1', text: WORDS }]);
  await A.flushAtRest();
  assert.ok(raw('tegami.messages'), 'written');
  assert.ok(!everything().includes(WORDS), 'no plain text anywhere');
  assert.ok(!store.has('tegami.messages'), 'nothing under the old plain name');
});

test('the next time the account opens, the value is there', async () => {
  A.closeAtRest();
  assert.deepEqual(load(k('messages'), []), [], 'closed: nothing');
  await A.openAtRest('main', SECRET);
  assert.deepEqual(load(k('messages'), []), [{ id: '1', text: WORDS }]);
});

test('names that are not sealed stay in localStorage', () => {
  save(k('myName'), 'あず');
  assert.equal(store.get('tegami.myName'), '"あず"');
  assert.equal(load(k('myName'), ''), 'あず');
});

test('saving again and again writes the last value', async () => {
  for (let i = 0; i < 20; i++) save(k('contacts'), [{ pubkey: 'p', name: `n${i}` }]);
  await A.flushAtRest();
  A.closeAtRest();
  await A.openAtRest('main', SECRET);
  assert.deepEqual(load(k('contacts'), []), [{ pubkey: 'p', name: 'n19' }]);
});

test('a changed value is noticed through rawOf', () => {
  const before = S.rawOf(k('blocked'));
  save(k('blocked'), ['x']);
  assert.notEqual(S.rawOf(k('blocked')), before);
});

test('remove forgets the value, here and in the records', async () => {
  save(k('blocked'), ['x']);
  await A.flushAtRest();
  assert.ok(raw('tegami.blocked'));
  remove(k('blocked'));
  assert.deepEqual(load(k('blocked'), []), []);
  await A.flushAtRest();
  assert.equal(raw('tegami.blocked'), undefined);
});

test('another secret key cannot read the records: they count as not there, nothing breaks', async () => {
  A.closeAtRest();
  await A.openAtRest('main', OTHER);
  assert.deepEqual(load(k('messages'), []), []);
  assert.deepEqual(load(k('contacts'), []), []);
  A.closeAtRest();
});

test('a record moved to another name cannot be read (the name is part of the encryption)', async () => {
  const swap = raw('tegami.messages');
  store.set('tegami-store:tegami.groups', swap);
  await A.openAtRest('main', SECRET);
  assert.deepEqual(load(k('groups'), []), [], 'a messages record under the name groups');
  assert.deepEqual(load(k('messages'), []), [{ id: '1', text: WORDS }], 'the real one still reads');
  store.delete('tegami-store:tegami.groups');
  A.closeAtRest();
});

test('a record of another account cannot be read under this account', async () => {
  store.set('tegami-store:tegami@ab12cd34.messages', raw('tegami.messages'));
  await A.openAtRest('ab12cd34', SECRET);
  assert.deepEqual(load('tegami@ab12cd34.messages', []), []);
  A.closeAtRest();
});

test('a damaged record counts as not there', async () => {
  store.set('tegami-store:tegami.stamps', '{"v":1,"iv":"AAAA","ct":"AAAA"}');
  await A.openAtRest('main', SECRET);
  assert.deepEqual(load(k('stamps'), []), []);
  save(k('stamps'), [{ sha256: 'a' }]);
  await A.flushAtRest();
  A.closeAtRest();
  await A.openAtRest('main', SECRET);
  assert.deepEqual(load(k('stamps'), []), [{ sha256: 'a' }], 'a new save replaces it');
  A.closeAtRest();
});

test('plain data from before is encrypted, and the plain copy goes', async () => {
  store.set('tegami.outbox', JSON.stringify([{ id: 'o1', text: WORDS }]));
  store.set('tegami.readAt', JSON.stringify({ p: 5 }));
  await A.openAtRest('main', SECRET);
  assert.deepEqual(load(k('outbox'), []), [{ id: 'o1', text: WORDS }]);
  assert.ok(!store.has('tegami.outbox') && !store.has('tegami.readAt'), 'plain copies removed');
  assert.ok(raw('tegami.outbox') && !raw('tegami.outbox').includes(WORDS));
  assert.ok(!everything().includes(WORDS));
  A.closeAtRest();
  await A.openAtRest('main', SECRET);
  assert.deepEqual(load(k('readAt'), {}), { p: 5 }, 'readable again after the move');
  A.closeAtRest();
});

test('when an encrypted record and a plain copy both exist, the encrypted one counts and the plain one goes', async () => {
  store.set('tegami.outbox', JSON.stringify([{ id: 'old' }]));
  await A.openAtRest('main', SECRET);
  assert.deepEqual(load(k('outbox'), []), [{ id: 'o1', text: WORDS }]);
  assert.ok(!store.has('tegami.outbox'));
  A.closeAtRest();
});

test('a move that cannot be written keeps the plain copy', async () => {
  const set = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = (key, v) => {
    if (key.startsWith('tegami-store:')) throw new Error('full');
    set(key, v);
  };
  store.set('tegami.cleared', JSON.stringify({ p: 1 }));
  await A.openAtRest('main', new Uint8Array(32).fill(9));
  assert.deepEqual(load(k('cleared'), {}), { p: 1 }, 'still shows');
  assert.ok(store.has('tegami.cleared'), 'the plain copy was kept');
  A.closeAtRest(true);
  globalThis.localStorage.setItem = set;
});

test('bytes for other stores are bound to their place', async () => {
  await A.openAtRest('main', SECRET);
  const data = new Uint8Array([1, 2, 3, 4]);
  const rec = await A.sealBytes('file:main|x', data);
  assert.deepEqual([...(await A.openBytes('file:main|x', rec))], [1, 2, 3, 4]);
  assert.equal(await A.openBytes('file:main|y', rec), null, 'another place');
  A.closeAtRest();
  assert.equal(await A.openBytes('file:main|x', rec), null, 'closed: no key');
  assert.equal(await A.sealBytes('file:main|x', data), null);
});

test('removing an account removes its records without its key', async () => {
  await A.openAtRest('ab12cd34', SECRET);
  save('tegami@ab12cd34.contacts', [{ pubkey: 'p' }]);
  await A.flushAtRest();
  A.closeAtRest();
  assert.ok(raw('tegami@ab12cd34.contacts'));
  await A.forgetAccountRecords('ab12cd34');
  assert.equal(raw('tegami@ab12cd34.contacts'), undefined);
  assert.ok(raw('tegami.messages'), 'another account is not touched');
});

test('opening another account closes the open one and writes its last changes', async () => {
  await A.openAtRest('main', SECRET);
  save(k('deleted'), ['d1']);
  await A.openAtRest('ab12cd34', SECRET);
  assert.deepEqual(load(k('deleted'), []), [], 'the first account is not readable now');
  await new Promise((r) => setTimeout(r, 10));
  A.closeAtRest();
  await A.openAtRest('main', SECRET);
  assert.deepEqual(load(k('deleted'), []), ['d1']);
  A.closeAtRest();
});

await chain;
console.log(`${n} passed`);
