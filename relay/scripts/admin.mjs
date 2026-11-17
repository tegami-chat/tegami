#!/usr/bin/env node
// The operator's tool for the Tegami relay: read reports, stop a key, and undo it.
//
//   node scripts/admin.mjs init                     make the operator key (once per computer)
//   node scripts/admin.mjs whoami                   show the operator's public key
//   node scripts/admin.mjs reports [key]            latest reports, or the reports about one key
//   node scripts/admin.mjs ban <key> [--invitees]   stop a key (and everyone it invited)
//   node scripts/admin.mjs unban <key> [--invitees]
//   node scripts/admin.mjs stop-invites <key>       the key can no longer invite
//   node scripts/admin.mjs allow-invites <key>
//   node scripts/admin.mjs set-limit <key> <n>      invites per day for that key
//   node scripts/admin.mjs trust <key>              treat the key as invited (official accounts, tests)
//   node scripts/admin.mjs members                  how many keys registered, by how (numbers only)
//   node scripts/admin.mjs stats                    the exact daily totals (the public /stats is weekly and rounded)
//   node scripts/admin.mjs ais [owner]              owners of AI keys and how many each has, or one owner's AI keys
//   node scripts/admin.mjs ai-limit <owner> <n>     envelopes a day all of one owner's AI keys may send
//
// <key> is an npub or 64 hex characters. The operator key lives in ~/.tegami/admin/key.json,
// outside the repository. Its public key must be listed in the relay's ADMIN_PUBKEYS
// (wrangler.jsonc, "vars"). Lost the file? Run init again and replace the public key there.
// TEGAMI_RELAY_URL=http://localhost:8787 points the tool at a local relay.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

const DIR = join(homedir(), '.tegami', 'admin');
const FILE = join(DIR, 'key.json');
const BASE = (process.env.TEGAMI_RELAY_URL ?? 'https://relay.tegami.chat').replace(/\/$/, '');
const hex = (b) => Buffer.from(b).toString('hex');

function loadSecret() {
  if (!existsSync(FILE)) throw new Error(`no operator key: run "node scripts/admin.mjs init" first`);
  return Uint8Array.from(Buffer.from(JSON.parse(readFileSync(FILE, 'utf8')).secret, 'hex'));
}

function toHex(key) {
  if (/^[0-9a-f]{64}$/.test(key ?? '')) return key;
  try {
    const d = nip19.decode(key);
    if (d.type === 'npub') return d.data;
  } catch {}
  throw new Error(`not a public key: ${key}`);
}

async function admin(body) {
  const url = `${BASE}/admin`;
  const text = JSON.stringify(body);
  const auth = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      content: '',
      tags: [['u', url], ['method', 'POST'], ['payload', createHash('sha256').update(text).digest('hex')]],
    },
    loadSecret(),
  );
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString('base64')}` },
    body: text,
  });
  const out = await res.text();
  if (res.status === 403) throw new Error('the relay does not know this operator key: add it to ADMIN_PUBKEYS and deploy');
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${out}`);
  return JSON.parse(out);
}

const [cmd, ...rest] = process.argv.slice(2);
const flag = (f) => rest.includes(f);
const args = rest.filter((a) => !a.startsWith('--'));

try {
  switch (cmd) {
    case 'init': {
      if (existsSync(FILE)) throw new Error(`${FILE} already exists`);
      mkdirSync(DIR, { recursive: true });
      const sk = generateSecretKey();
      writeFileSync(FILE, JSON.stringify({ secret: hex(sk), created_at: new Date().toISOString() }), { mode: 0o600 });
      const pk = getPublicKey(sk);
      console.log(`operator key saved to ${FILE}`);
      console.log(`public key (put this in ADMIN_PUBKEYS): ${pk}`);
      break;
    }
    case 'whoami': {
      const pk = getPublicKey(loadSecret());
      console.log(pk);
      console.log(nip19.npubEncode(pk));
      break;
    }
    case 'members':
    case 'stats':
      console.log(JSON.stringify(await admin({ action: cmd }), null, 2));
      break;
    case 'reports':
      console.log(JSON.stringify(await admin(args[0] ? { action: 'reports', pubkey: toHex(args[0]) } : { action: 'reports' }), null, 2));
      break;
    case 'ban':
    case 'unban':
    case 'stop-invites':
    case 'allow-invites':
    case 'trust':
      console.log(JSON.stringify(await admin({ action: cmd, pubkey: toHex(args[0]), invitees: flag('--invitees') }), null, 2));
      break;
    case 'ais':
      console.log(JSON.stringify(await admin(args[0] ? { action: 'ais', pubkey: toHex(args[0]) } : { action: 'ais' }), null, 2));
      break;
    case 'ai-limit':
      console.log(JSON.stringify(await admin({ action: 'ai-limit', pubkey: toHex(args[0]), per_day: Number(args[1]) }), null, 2));
      break;
    case 'set-limit':
      console.log(JSON.stringify(await admin({ action: 'set-limit', pubkey: toHex(args[0]), per_day: Number(args[1]) }), null, 2));
      break;
    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 18).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
      process.exitCode = cmd ? 1 : 0;
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
