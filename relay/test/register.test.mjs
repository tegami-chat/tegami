// Registration: who may write, invite codes, keys registered without an invite, the operator.
// Usage (fresh relay: wrangler dev with .dev.vars): RELAY=ws://127.0.0.1:8787 node test/register.test.mjs
import { createHash } from 'node:crypto';
import * as nip42 from 'nostr-tools/nip42';
import * as nip59 from 'nostr-tools/nip59';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import WebSocket from 'ws';

import { HTTP, admin, register, signedPost, trust } from './join.mjs';

const RELAY = process.env.RELAY ?? 'ws://localhost:8787';
let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(sk) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY);
    const inbox = [];
    ws.on('error', reject);
    ws.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));
    const next = async (pred, ms = 5000) => {
      for (let i = 0; i < ms / 25; i++) {
        const hit = inbox.find(pred);
        if (hit) return hit;
        await wait(25);
      }
      throw new Error('timeout');
    };
    ws.on('open', async () => {
      const [, ch] = await next((m) => m[0] === 'AUTH');
      const auth = finalizeEvent(nip42.makeAuthEvent(RELAY, ch), sk);
      ws.send(JSON.stringify(['AUTH', auth]));
      await next((m) => m[0] === 'OK' && m[1] === auth.id);
      resolve({
        ws,
        inbox,
        next,
        send: async (wrap) => {
          ws.send(JSON.stringify(['EVENT', wrap]));
          return (await next((m) => m[0] === 'OK' && m[1] === wrap.id)).slice(2);
        },
      });
    });
  });
}
const wrapTo = (from, to, text) => nip59.createWrap(nip59.createSeal(nip59.createRumor({ kind: 14, content: text, tags: [['p', to]] }, from), from, to), to);

// ---------- not registered ----------
const stranger = generateSecretKey();
const target = generateSecretKey();
const targetPub = getPublicKey(target);
await trust(target);
check('asking about an unknown key: not a member', (await register(stranger)).json?.member === false);
const s = await connect(stranger);
const [ok0, why0] = await s.send(wrapTo(stranger, targetPub, 'hello'));
check('a key that did not register cannot write', ok0 === false && String(why0).startsWith('restricted'));
const file = Buffer.from(`file ${Math.random()}`);
const hash = createHash('sha256').update(file).digest('hex');
const upAuth = finalizeEvent(
  { kind: 24242, created_at: Math.floor(Date.now() / 1000), content: 'Upload', tags: [['t', 'upload'], ['x', hash], ['expiration', String(Math.floor(Date.now() / 1000) + 300)]] },
  stranger,
);
const up = await fetch(`${HTTP}/upload`, { method: 'PUT', body: file, headers: { Authorization: 'Nostr ' + Buffer.from(JSON.stringify(upAuth)).toString('base64') } });
check('…nor upload a file', up.status === 403);
check('an unsigned registration is refused', (await fetch(`${HTTP}/register`, { method: 'POST', body: '{}' })).status === 401);
check('a registration signed for another address is refused', (await signedPost('/register', stranger, {}, { url: 'https://example.com/register' })).status === 401);

// ---------- without an invite (Turnstile) ----------
check('a failed Turnstile check does not register', (await register(stranger, { turnstile: 'not-a-person' })).status === 403);
const open = await register(stranger, { turnstile: 'dev-pass' });
check('registering without an invite: an open member', open.status === 200 && open.json.member && open.json.via === 'open' && open.json.trusted === false);
check('…which has no invite code to give', open.json.code === null);
const [ok1] = await s.send(wrapTo(stranger, targetPub, 'hello again'));
check('an open key can write', ok1 === true);
const t = await connect(target);
t.ws.send(JSON.stringify(['REQ', 'mine', { kinds: [1059], '#p': [targetPub] }]));
await t.next((m) => m[0] === 'EOSE' && m[1] === 'mine');
const stored = t.inbox.find((m) => m[0] === 'EVENT' && m[1] === 'mine');
check('its envelope is marked as from an open key when handed out', stored?.[2]?.tegami_open === 1);
check('…and still opens (the mark is outside the signed part)', nip59.unwrapEvent(stored[2], target).content === 'hello again');
const liveWrap = wrapTo(stranger, targetPub, 'live');
await s.send(liveWrap);
const live = await t.next((m) => m[0] === 'EVENT' && m[1] === 'mine' && m[2].id === liveWrap.id);
check('…and when it arrives live', live[2].tegami_open === 1);

// ---------- invites ----------
const inviter = generateSecretKey();
await trust(inviter);
const me = await register(inviter);
const code = me.json?.code;
check('a trusted key has an invite code', me.json?.trusted === true && /^[a-z2-9]{12}$/.test(code ?? ''));
check('asking again gives the same code', (await register(inviter)).json?.code === code);
const friend = generateSecretKey();
const joined = await register(friend, { invite: code });
check('registering with an invite: trusted, and has a code of its own', joined.json?.via === 'invite' && joined.json.trusted && joined.json.code && joined.json.code !== code);
const fc = await connect(friend);
const fromFriend = wrapTo(friend, targetPub, 'from a friend of a friend');
check('an invited key can write', (await fc.send(fromFriend))[0] === true);
const got = await t.next((m) => m[0] === 'EVENT' && m[1] === 'mine' && m[2].id === fromFriend.id);
check('its envelopes carry no mark', got[2].tegami_open === undefined);
check('an unknown code is refused', (await register(generateSecretKey(), { invite: 'zzzzzzzzzzzz' })).json?.error === 'invite-invalid');
const fallback = await register(generateSecretKey(), { invite: 'zzzzzzzzzzzz', turnstile: 'dev-pass' });
check('an unknown code with a Turnstile token: open member, and says the code did not work', fallback.json?.via === 'open' && fallback.json.inviteError === 'invite-invalid');
check('an open key cannot invite: its code is refused', (await register(generateSecretKey(), { invite: open.json.code ?? 'aaaaaaaaaaaa' })).status === 400);
const upgraded = await register(stranger, { invite: code });
check('an open key that uses an invite becomes an invite key', upgraded.json?.via === 'invite' && upgraded.json.trusted === true);

// 20 a day (here: the operator lowers it to 3 for one code; 2 already used).
check('the operator sets a lower limit', (await admin('set-limit', getPublicKey(inviter), { per_day: 3 })).status === 200);
check('the third key today registers', (await register(generateSecretKey(), { invite: code })).json?.via === 'invite');
check('the fourth is told the code is used up for today', (await register(generateSecretKey(), { invite: code })).json?.error === 'invite-used-up');

// ---------- the operator ----------
check('someone else cannot use the operator route', (await signedPost('/admin', stranger, { action: 'ban', pubkey: getPublicKey(friend) })).status === 403);
const stopped = await admin('ban', getPublicKey(inviter), { invitees: true });
check('stopping a key and everyone it invited', stopped.status === 200 && stopped.json.changed >= 4);
const ic = await connect(inviter);
check('the stopped key cannot write', String((await ic.send(wrapTo(inviter, targetPub, 'x')))[1]).startsWith('blocked'));
check('…nor can a key it invited', String((await fc.send(wrapTo(friend, targetPub, 'y')))[1]).startsWith('blocked'));
check('…and its code no longer works', (await register(generateSecretKey(), { invite: code })).json?.error === 'invite-invalid');
check('a stopped key cannot register again', (await register(friend, { turnstile: 'dev-pass' })).status === 403);
check('the operator can undo it', (await admin('unban', getPublicKey(friend))).json?.member?.banned === false);

// ---------- a stranger cannot fill someone's mailbox ----------
const victim = getPublicKey(generateSecretKey());
let accepted = 0;
let refused = 0;
for (let k = 0; k < 2; k++) {
  const spammer = generateSecretKey();
  await register(spammer, { turnstile: 'dev-pass' });
  const c = await connect(spammer);
  const wraps = Array.from({ length: 105 }, (_, i) => wrapTo(spammer, victim, `spam ${i}`));
  for (const w of wraps) c.ws.send(JSON.stringify(['EVENT', w]));
  const answers = await Promise.all(wraps.map((w) => c.next((m) => m[0] === 'OK' && m[1] === w.id, 15000)));
  accepted += answers.filter((m) => m[2] === true).length;
  refused += answers.filter((m) => m[2] === false && String(m[3]).includes('too many waiting')).length;
  c.ws.close();
}
check(`open keys can leave at most 200 envelopes for one person (${accepted} accepted, ${refused} refused)`, accepted === 200 && refused === 10);

for (const c of [s, t, fc, ic]) c.ws.close();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
