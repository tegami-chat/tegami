// Unit tests for keeping words away from AIs (src/lib/ai-optout.ts).
// Run:  node test/ai-optout.test.mjs   (Node 24 strips the TypeScript types)

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

const O = await import('../src/lib/ai-optout.ts');

const ME = 'a'.repeat(64);
const F = 'b'.repeat(64);
const G = 'c'.repeat(64);
const msg = (from, text, extra = {}) => ({ from, text, ...extra });

let n = 0;
const test = (name, fn) => {
  fn();
  n++;
  console.log(`  ok    ${name}`);
};

test('the noai mark and a "does not stay" mark keep a message away from AIs', () => {
  assert.equal(O.keptFromAi([['p', F], ['noai']]), true);
  assert.equal(O.keptFromAi([['p', F], ['expiration', '1900000000']]), true);
  assert.equal(O.keptFromAi([['p', F], ['e', 'x', '', 'reply']]), false);
  assert.deepEqual(O.withNoAi([['p', F]]), [['p', F], ['noai']]);
  assert.deepEqual(O.withNoAi([['noai']]), [['noai']]);
});

test('a friend who said no: none of their messages, my own still', () => {
  const list = [msg(F, 'やあ'), msg(ME, 'こんにちは'), msg(G, 'ども')];
  const got = O.aiReadable(list, [{ pubkey: F, noai: true }, { pubkey: G }], ME);
  assert.deepEqual(got.map((m) => m.text), ['こんにちは', 'ども']);
});

test('a marked message is left out, mine too', () => {
  const list = [msg(F, '秘密', { noai: true }), msg(F, 'ふつう'), msg(ME, '私の秘密', { noai: true })];
  assert.deepEqual(O.aiReadable(list, [{ pubkey: F }], ME).map((m) => m.text), ['ふつう']);
});

test('why a draft cannot be asked for', () => {
  assert.equal(O.nothingToRead([msg(F, 'やあ')], { pubkey: F, noai: true }, ME), 'optout');
  assert.equal(O.nothingToRead([msg(F, 'やあ', { noai: true })], { pubkey: F }, ME), 'marked');
  assert.equal(O.nothingToRead([msg(ME, '私だけ')], { pubkey: F }, ME), 'empty');
  assert.equal(O.nothingToRead([msg(F, 'やあ', { noai: true }), msg(F, 'ふつう')], { pubkey: F }, ME), null);
  assert.match(O.nothingToReadText('optout', 'テストB'), /テストBさんは自分のメッセージを相手のAIに読ませない設定/);
});

test('a profile card from before says nothing about noai', () => {
  assert.equal(O.profileNoAi({ avatar: null }), undefined);
  assert.equal(O.profileNoAi({ avatar: null, noai: true }), true);
  assert.equal(O.profileNoAi({ avatar: null, noai: false }), false);
});

console.log(`${n} passed`);
