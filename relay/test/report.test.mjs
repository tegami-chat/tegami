// Reports: a member tells the operator about a key; only the operator can read them.
// Usage (fresh relay: wrangler dev with .dev.vars): RELAY=ws://127.0.0.1:8787 node test/report.test.mjs
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

import { HTTP, admin, signedPost, trust } from './join.mjs';

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures++;
};
const report = (sk, body) => signedPost('/report', sk, body);
const accepted = (r) => r.status === 200 || r.status === 204;

const reporter = generateSecretKey();
const reporterPub = getPublicKey(reporter);
const scammer = getPublicKey(generateSecretKey());
await trust(reporter);
const now = Math.floor(Date.now() / 1000);
const messages = [
  { text: 'この投資で必ず儲かります', at: now - 120 },
  { text: 'https://example.com', at: now - 60 },
];

// ---------- who may report ----------
const unsigned = await fetch(`${HTTP}/report`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pubkey: scammer, reason: 'spam' }),
});
check('an unsigned report is refused', unsigned.status === 401);
check('a report signed for another address is refused', (await signedPost('/report', reporter, { pubkey: scammer, reason: 'spam' }, { url: 'https://example.com/report' })).status === 401);
check('a key that did not register cannot report', (await report(generateSecretKey(), { pubkey: scammer, reason: 'spam' })).status === 403);
const stopped = generateSecretKey();
await trust(stopped);
await admin('ban', getPublicKey(stopped));
check('a stopped key cannot report', (await report(stopped, { pubkey: scammer, reason: 'spam' })).status === 403);

// ---------- what a report may say ----------
const other = getPublicKey(generateSecretKey());
check('an unknown reason is refused', (await report(reporter, { pubkey: other, reason: 'boring' })).status === 400);
check('a key that is not hex is refused', (await report(reporter, { pubkey: 'npub1xyz', reason: 'spam' })).status === 400);
check('reporting yourself is refused', (await report(reporter, { pubkey: reporterPub, reason: 'spam' })).status === 400);
const many = Array.from({ length: 21 }, (_, i) => ({ text: `m${i}`, at: now }));
check('more than 20 messages are refused', (await report(reporter, { pubkey: other, reason: 'spam', messages: many })).status === 400);
check('a message over 2000 characters is refused', (await report(reporter, { pubkey: other, reason: 'spam', messages: [{ text: 'x'.repeat(2001), at: now }] })).status === 400);
check('a message without a time is refused', (await report(reporter, { pubkey: other, reason: 'spam', messages: [{ text: 'hi' }] })).status === 400);

// ---------- reporting ----------
check('a member reports a key, with the messages they chose to attach', accepted(await report(reporter, { pubkey: scammer, reason: 'scam', messages })));
check('the same key again within a day is refused', (await report(reporter, { pubkey: scammer, reason: 'spam' })).status === 429);
check('another key can still be reported (refused ones did not count), without messages', accepted(await report(reporter, { pubkey: other, reason: 'other' })));
const second = generateSecretKey();
await trust(second);
check('someone else reports the same key', accepted(await report(second, { pubkey: scammer, reason: 'harassment' })));

// ---------- the operator ----------
const list = await admin('reports');
const mine = list.json?.reports?.find((r) => r.reporter === reporterPub && r.reported === scammer);
check('the operator lists reports and sees the reason', list.status === 200 && mine?.reason === 'scam');
check('…and the attached messages', JSON.stringify(mine?.messages) === JSON.stringify(messages));
check('…newest first', list.json?.reports?.[0]?.reported === scammer && list.json.reports[0].reason === 'harassment');
check('…and how many people reported each key', list.json?.counts?.[scammer] === 2 && list.json.counts[other] === 1);
const plain = list.json?.reports?.find((r) => r.reporter === reporterPub && r.reported === other);
check('a report without attached messages keeps none', plain?.reason === 'other' && plain.messages === null);
const about = await admin('reports', scammer);
check('the operator lists the reports about one key', about.status === 200 && about.json?.reports?.length === 2 && about.json.reporters === 2);
check('someone else cannot list reports', (await signedPost('/admin', reporter, { action: 'reports' })).status === 403);
check('…nor the reports about one key', (await signedPost('/admin', reporter, { action: 'reports', pubkey: scammer })).status === 403);

check('impersonation is a reason', accepted(await report(second, { pubkey: other, reason: 'impersonation' })));
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
