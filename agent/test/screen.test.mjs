// AIの検査: the watcher's fixed checks (agent/screen.mjs) and the app's (client/src/lib/ai-screen.ts)
// answer the same for the same texts. Run: node test/screen.test.mjs (no relay needed).
import { register } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import * as agent from '../screen.mjs';

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
const app = await import(pathToFileURL(join(resolve(import.meta.dirname, '../..'), 'client/src/lib/ai-screen.ts')).href);

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures++;
};

const ZW = '​';
const secrets = {
  nostrKey: ['nsec1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jq', `nsec${ZW}1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs`, 'ｎｓｅｃ１ｑｑｑｓｙｑｃｙｑ５ｒｑｗｚｑｆｐｇ９ｓｃｒｇｗｐｕｇｐｚｙ', 'ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p'],
  hexKey: [`鍵は ${'ab'.repeat(32)} です`],
  recoveryCode: ['K7QM-3XRA-ABCD-EFGH-JKLM-NPQR-STUV', 'k7qm 3xra abcd efgh jklm npqr stuv', 'K7QM3XRAABCDEFGHJKLMNPQRSTUV'],
  transferLink: ['https://app.tegami.chat/link#k=abc123'],
  apiKey: ['sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx', 'AIzaSyA1234567890abcdefghijklmnopqrstuv', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  cardNumber: ['4242 4242 4242 4242', '4242-4242-4242-4242', '５５５５５５５５５５５５４４４４'],
};
for (const [kind, texts] of Object.entries(secrets))
  for (const t of texts) check(`${kind}: ${t.slice(0, 24)}…`, agent.findSecret(t) === kind && app.findSecret(t) === kind);

const everyday = [
  '明日の10時でどう？',
  '電話は 090-1234-5678 です',
  '2026年11月17日 10:30 に',
  '会員番号 12345678',
  '郵便番号 150-0043',
  'npub1zptpqkxhr98glpt4rqv9945f3hd3q82wghaqth4gwqtmzmtjutsse5a98k',
  'ISBN 978-4-10-101001-6',
  'sk-ってなに？',
  'LINEってくそじゃない？',
  '1234 5678 9012 3456',
];
for (const t of everyday) check(`not a secret: ${t}`, agent.findSecret(t) === null && app.findSecret(t) === null);

// What an AI may read: hidden characters out, one variation selector kept (emoji and names use it).
const hidden = `こん${ZW}にちは‮abc\u{e0041}\u{e0042}`;
check('hidden characters are taken out', agent.cleanForAi(hidden) === 'こんにちはabc' && app.cleanForAi(hidden) === 'こんにちはabc');
check('a heart with its variation selector stays', agent.cleanForAi('❤️') === '❤️');
const smuggled = `a${'︀︁︂︃'.repeat(5)}`;
check('a long run of variation selectors is cut to one', agent.cleanForAi(smuggled) === 'a︀' && app.cleanForAi(smuggled) === 'a︀');
check('ordinary Japanese is unchanged', agent.cleanForAi('明日、駅で待ってるね。') === '明日、駅で待ってるね。');
check('a long text is cut for the AI', agent.cleanForAi('あ'.repeat(30000)).length === agent.AI_TEXT_MAX);

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
