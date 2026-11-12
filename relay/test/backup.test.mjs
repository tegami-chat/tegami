// Recovery backups against a running relay: `wrangler dev` with DEV_LOCAL=1 (or DEV_PUSH=1)
// in .dev.vars, so requests signed for localhost are accepted.
// Usage: npm run dev (in another window), then  node test/backup.test.mjs
//        HTTP=http://localhost:8807 node test/backup.test.mjs   for another port
import { randomBytes } from 'node:crypto';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';

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

/** method on /backup/<id>, signed by sk (NIP-98) unless sign is false. Returns the response. */
async function call(method, id, { sk, body = '', sign = true, headers = {}, signedUrl } = {}) {
  const url = `${HTTP}/backup/${id}`;
  const h = { 'Content-Type': 'application/json', ...headers };
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

// One key holds at most 3 backups (the current one and old ones while a new code replaces them).
const more = [newId(), newId()];
for (const x of more) await call('PUT', x, { sk: alice, body: blob });
check('a fourth backup for the same key is refused', (await call('PUT', newId(), { sk: alice, body: blob })).status === 429);

check('alice deletes it', (await call('DELETE', id, { sk: alice })).status === 204);
check('after deleting, GET is 404', (await call('GET', id)).status === 404);
check('deleting again is 404', (await call('DELETE', id, { sk: alice })).status === 404);
for (const x of more) await call('DELETE', x, { sk: alice });
check('ids that are not 64 hex characters are not backups', !(await (await fetch(`${HTTP}/backup/xyz`)).text()).startsWith('{'));

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
