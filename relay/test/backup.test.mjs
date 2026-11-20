// Recovery backups against a running relay: `wrangler dev` with DEV_LOCAL=1 (or DEV_PUSH=1)
// in .dev.vars, so requests signed for localhost are accepted.
// Usage: npm run dev (in another window), then  node test/backup.test.mjs
//        HTTP=http://localhost:8807 node test/backup.test.mjs   for another port
import { randomBytes } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { admin, register, trust } from './join.mjs';

const HTTP = process.env.HTTP ?? 'http://localhost:8787';
let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures++;
};

async function sha256hex(text) {
  return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex');
}
const newId = () => randomBytes(32).toString('hex');

// A new backup needs a registered account: a second signature of the same request by the account's key
// (X-Tegami-Member). This key is registered (as if invited) and makes the invite tree used below.
const member = generateSecretKey();
await trust(member);

/** A NIP-98 header value for `method` on `url`, signed by `sk`. */
async function nip98(sk, method, url, body) {
  const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['u', url], ['method', method], ['payload', await sha256hex(body)]] }, sk);
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64');
}

/**
 * method on /backup/<id>, signed by sk (NIP-98) unless sign is false. A PUT that is not a refresh also carries the
 * member proof, signed by `account` (the registered key above unless given; null sends none). Returns the response.
 */
async function call(method, id, { sk, body = '', sign = true, headers = {}, signedUrl, account = member } = {}) {
  const url = `${HTTP}/backup/${id}`;
  const h = { 'Content-Type': 'application/json', ...headers };
  if (method === 'PUT' && account && !headers['If-Match'] && !headers['X-Tegami-Member']) h['X-Tegami-Member'] = await nip98(account, 'PUT', url, body);
  if (sign && sk) {
    const ev = finalizeEvent(
      { kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['u', signedUrl ?? url], ['method', method], ['payload', await sha256hex(body)]] },
      sk,
    );
    h.Authorization = 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64');
  }
  return fetch(url, { method, headers: h, body: method === 'GET' ? undefined : body });
}

const alice = generateSecretKey();
const mallory = generateSecretKey();
const id = newId();
const blob = JSON.stringify({ v: 1, iv: 'aaaa', ct: 'b'.repeat(2000) });

{
  // A browser asks first (CORS preflight) whether it may send the account proof header; without it, a new backup cannot be made from the web app.
  const pre = await fetch(`${HTTP}/backup/${newId()}`, { method: 'OPTIONS', headers: { Origin: 'https://app.tegami.chat', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,content-type,x-tegami-member' } });
  check('a browser may send the account proof header (X-Tegami-Member)', (pre.headers.get('access-control-allow-headers') || '').toLowerCase().includes('x-tegami-member'));
}
check('GET of an unknown id is 404', (await call('GET', newId())).status === 404);
check('a PUT without a signature is refused', (await call('PUT', id, { body: blob, sign: false })).status === 401);
check('a PUT signed for another id is refused', (await call('PUT', id, { sk: alice, body: blob, signedUrl: `${HTTP}/backup/${newId()}` })).status === 401);
check('a PUT signed for another body is refused', (await (async () => {
  const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['u', `${HTTP}/backup/${id}`], ['method', 'PUT'], ['payload', await sha256hex('other')]] }, alice);
  return fetch(`${HTTP}/backup/${id}`, { method: 'PUT', headers: { Authorization: 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64') }, body: blob });
})()).status === 401);
check('a refresh (If-Match: *) of a backup that does not exist is refused with 412', (await call('PUT', id, { sk: alice, body: blob, headers: { 'If-Match': '*' } })).status === 412);
check('alice stores a backup', (await call('PUT', id, { sk: alice, body: blob })).status === 204);
const got = await call('GET', id);
check('anyone with the id gets it back unchanged, without logging in', got.status === 200 && (await got.text()) === blob);
check('alice refreshes it (If-Match: *)', (await call('PUT', id, { sk: alice, body: blob.replace('aaaa', 'cccc'), headers: { 'If-Match': '*' } })).status === 204);
check('…and the new content is returned', (await (await call('GET', id)).text()).includes('cccc'));
check('another key cannot overwrite it', (await call('PUT', id, { sk: mallory, body: blob })).status === 403);
check('another key cannot delete it', (await call('DELETE', id, { sk: mallory })).status === 403);
check('an unsigned DELETE is refused', (await call('DELETE', id, { sign: false })).status === 401);
check('…it is still there', (await call('GET', id)).status === 200);

const big = JSON.stringify({ v: 1, iv: 'aaaa', ct: 'b'.repeat(64 * 1024) });
check('a backup over 64 KB is refused', (await call('PUT', newId(), { sk: alice, body: big })).status === 413);

// The app derives one signing key per recovery code, so one key holds one backup.
const more = [];
check('a new backup without the account proof is refused (403)', (await call('PUT', newId(), { sk: generateSecretKey(), body: blob, account: null })).status === 403);
check('…also when the account is not registered', (await call('PUT', newId(), { sk: generateSecretKey(), body: blob, account: generateSecretKey() })).status === 403);
const stopped = generateSecretKey();
await trust(stopped);
await admin('ban', getPublicKey(stopped));
check('…also when the account is stopped', (await call('PUT', newId(), { sk: generateSecretKey(), body: blob, account: stopped })).status === 403);
{
  // A proof for another body or another id does not count.
  const sk = generateSecretKey();
  const i = newId();
  const wrongBody = await call('PUT', i, { sk, body: blob, headers: { 'X-Tegami-Member': await nip98(member, 'PUT', `${HTTP}/backup/${i}`, 'other') } });
  const wrongId = await call('PUT', i, { sk, body: blob, headers: { 'X-Tegami-Member': await nip98(member, 'PUT', `${HTTP}/backup/${newId()}`, blob) } });
  check('…a proof signed for another body or another id is refused too', wrongBody.status === 403 && wrongId.status === 403);
}
check('a second backup for the same key is refused', (await call('PUT', newId(), { sk: alice, body: blob })).status === 429);
const bobId = newId();
check('another key stores its own backup', (await call('PUT', bobId, { sk: mallory, body: blob })).status === 204);
check('…and deletes it', (await call('DELETE', bobId, { sk: mallory })).status === 204);

// Per invite tree: the registered key above and the keys it invites share a daily number of new backups (50; a test header lowers it).
{
  const root = generateSecretKey();
  await trust(root);
  const code = (await register(root)).json?.code;
  const kid = generateSecretKey();
  await register(kid, { invite: code });
  const cap = { 'X-Test-Backups-Per-Tree': '2', 'X-Test-Ip': '10.7.6.1' };
  const a = await call('PUT', newId(), { sk: generateSecretKey(), body: blob, headers: cap, account: root });
  const b = await call('PUT', newId(), { sk: generateSecretKey(), body: blob, headers: cap, account: kid });
  const c = await call('PUT', newId(), { sk: generateSecretKey(), body: blob, headers: cap, account: root });
  check(`two keys of one invite tree share the daily number of new backups (${a.status}, ${b.status}, then ${c.status})`, a.status === 204 && b.status === 204 && c.status === 429);
  const other = generateSecretKey();
  await trust(other);
  check('another tree is not affected', (await call('PUT', newId(), { sk: generateSecretKey(), body: blob, headers: cap, account: other })).status === 204);
}

// Relay-wide caps on new backups (test headers lower them, DEV_LOCAL only; the real caps are 5,000 a day and 100,000 in all).
const capId = newId();
const capKey = generateSecretKey();
const capIp = { 'X-Test-Ip': '10.7.7.7' };
check('a backup is stored (it counts towards today)', (await call('PUT', capId, { sk: capKey, body: blob, headers: capIp })).status === 204);
const dayCapped = await call('PUT', newId(), { sk: generateSecretKey(), body: blob, headers: { ...capIp, 'X-Test-Backups-Per-Day': '1' } });
const retry = Number(dayCapped.headers.get('Retry-After'));
check('over the day cap, a new backup gets 503 with a clear error', dayCapped.status === 503 && (await dayCapped.text()).startsWith('busy:'));
check('…and Retry-After says how many seconds until the next UTC midnight', retry > 0 && retry <= 86_400);
check('over the day cap, a refresh still works', (await call('PUT', capId, { sk: capKey, body: blob.replace('aaaa', 'dddd'), headers: { ...capIp, 'If-Match': '*', 'X-Test-Backups-Per-Day': '1' } })).status === 204);
check('…and the refresh was kept', (await (await call('GET', capId)).text()).includes('dddd'));
const totalCapped = await call('PUT', newId(), { sk: generateSecretKey(), body: blob, headers: { ...capIp, 'X-Test-Backups-Total': '1' } });
check('over the total cap, a new backup gets 507 with a clear error', totalCapped.status === 507 && (await totalCapped.text()).startsWith('full:'));
check('over the total cap, a refresh still works', (await call('PUT', capId, { sk: capKey, body: blob, headers: { ...capIp, 'If-Match': '*', 'X-Test-Backups-Total': '1' } })).status === 204);
check('over the cap, deleting still works', (await call('DELETE', capId, { sk: capKey, headers: { ...capIp, 'X-Test-Backups-Per-Day': '1' } })).status === 204);
check('a backup made without the test headers is not capped', (await (async () => {
  const k = generateSecretKey();
  const i = newId();
  const r = await call('PUT', i, { sk: k, body: blob, headers: { 'X-Test-Ip': '10.7.7.8' } });
  await call('DELETE', i, { sk: k });
  return r.status;
})()) === 204);

check('alice deletes it', (await call('DELETE', id, { sk: alice })).status === 204);
check('after deleting, GET is 404', (await call('GET', id)).status === 404);
check('deleting again is 404', (await call('DELETE', id, { sk: alice })).status === 404);
for (const x of more) await call('DELETE', x, { sk: alice });
check('ids that are not 64 hex characters are not backups', !(await (await fetch(`${HTTP}/backup/xyz`)).text()).startsWith('{'));

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
