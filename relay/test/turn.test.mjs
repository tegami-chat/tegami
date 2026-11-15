// TURN credentials for calls (POST /turn), against `wrangler dev` with .dev.vars and a local
// stand-in for the Cloudflare Realtime API (this test starts it on TURN_FAKE_PORT).
// Usage (fresh relay):
//   npx wrangler@4 dev --port 8795 --persist-to <empty dir> --var TURN_KEY_ID:test-key \
//     --var TURN_KEY_API_TOKEN:test-token --var TURN_API:http://127.0.0.1:8796 --var DEV_LOCAL:1
//   RELAY=ws://127.0.0.1:8795 HTTP=http://127.0.0.1:8795 TURN_FAKE_PORT=8796 node test/turn.test.mjs
// With TURN_OFF=1 (a relay started without the TURN variables) it checks only that /turn says 503.
import { createServer } from 'node:http';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

import { HTTP, admin, signedPost, trust } from './join.mjs';

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures++;
};
const turn = (sk, body = {}) => signedPost('/turn', sk, body);

if (process.env.TURN_OFF === '1') {
  const sk = generateSecretKey();
  await trust(sk);
  const r = await turn(sk);
  check('without the TURN key the relay says it is not set up (503)', r.status === 503 && r.json?.error === 'turn-not-configured');
  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
}

// ---------- a stand-in for https://rtc.live.cloudflare.com ----------
const seen = [];
let mode = 'ok';
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    if (mode === 'error') {
      res.writeHead(500).end('{}');
      return;
    }
    res.writeHead(201, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        iceServers: [
          { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
          {
            urls: [
              'turn:turn.cloudflare.com:3478?transport=udp',
              'turn:turn.cloudflare.com:53?transport=udp',
              'turn:turn.cloudflare.com:3478?transport=tcp',
              'turns:turn.cloudflare.com:5349?transport=tcp',
              'turns:turn.cloudflare.com:443?transport=tcp',
              'http://evil.example/',
            ],
            username: 'u-' + seen.length,
            credential: 'c-' + seen.length,
          },
        ],
      }),
    );
  });
});
await new Promise((ok) => fake.listen(Number(process.env.TURN_FAKE_PORT ?? 8796), '127.0.0.1', ok));

// ---------- who may ask ----------
const unsigned = await fetch(`${HTTP}/turn`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
check('an unsigned request is refused', unsigned.status === 401);
const member = generateSecretKey();
await trust(member);
check('a request signed for another address is refused', (await signedPost('/turn', member, {}, { url: 'https://example.com/turn' })).status === 401);
check('a key that did not register gets nothing', (await turn(generateSecretKey())).status === 403);
const stopped = generateSecretKey();
await trust(stopped);
await admin('ban', getPublicKey(stopped));
check('a stopped key gets nothing', (await turn(stopped)).status === 403);
check('Cloudflare was not asked for any of them', seen.length === 0);

// ---------- a member ----------
const r = await turn(member);
check('a member gets credentials (200)', r.status === 200);
const turnEntry = r.json?.iceServers?.find((s) => s.username);
check('…a TURN entry with a username and a credential', turnEntry?.username === 'u-1' && turnEntry.credential === 'c-1');
const urls = (r.json?.iceServers ?? []).flatMap((s) => s.urls);
check('…with turn: and turns: addresses', urls.some((u) => u.startsWith('turn:')) && urls.some((u) => u.startsWith('turns:')));
check('…without port 53 (browsers block it)', urls.length > 0 && !urls.some((u) => /:53(\?|$)/.test(u)));
check('…and nothing that is not stun:, turn: or turns:', urls.every((u) => /^(stun|turns?):/.test(u)));
check('…and how long they last (6 hours)', r.json?.ttl === 21600);
const call = seen[0];
check('the relay asked Cloudflare with its key id and token', call?.method === 'POST' && call.url === '/v1/turn/keys/test-key/credentials/generate-ice-servers' && call.auth === 'Bearer test-token');
check('…for credentials that last 6 hours', JSON.parse(call?.body ?? '{}').ttl === 21600);
check('…and did not send who asked', !call?.body.includes(getPublicKey(member)));

// ---------- limits ----------
let ok = 1;
let last = 0;
for (let i = 0; i < 12; i++) {
  last = (await turn(member)).status;
  if (last === 200) ok++;
  else break;
}
check('one key gets 10 at once, then is refused (429)', ok === 10 && last === 429);
const other = generateSecretKey();
await trust(other);
check('another key is not held back by it', (await turn(other)).status === 200);

// ---------- Cloudflare fails ----------
mode = 'error';
const third = generateSecretKey();
await trust(third);
const broken = await turn(third);
check('when Cloudflare fails the relay says so (502) and the app calls with STUN only', broken.status === 502 && broken.json?.error === 'turn-unavailable');

fake.close();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
