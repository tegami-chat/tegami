// Tegami relay: a small Nostr relay on a Cloudflare Durable Object.
//
// Rules
// - Every connection must log in first (NIP-42 AUTH) with its Nostr key.
// - Only gift-wrapped private messages (kind 1059) are accepted.
// - You can only read envelopes addressed to yourself (#p = your key), so nobody can
//   list who receives messages from whom.
// - Envelopes are deleted after 30 days. Messages live on people's devices.
// - An envelope with an expiration tag (NIP-40) is refused once expired and never handed
//   out after that time (used to move an account to another device: a 10-minute envelope).
//   It is deleted when the next envelope arrives or at the daily clean-up, whichever is first.
//
// - Limits: each network address and each key can send only so fast, each address can
//   hold only so many connections, and each mailbox holds at most MAX_MAILBOX envelopes.
//   Keys cost nothing to make, so the address limit is the one that stops floods. An IPv6 address counts
//   by its /64, and also toward larger blocks (/48, /32) with looser limits, so a rented block does not
//   get a fresh allowance for every /64.
// - One answer to a REQ holds at most MAX_REQ_ROWS envelopes and MAX_REQ_BYTES bytes, newest first; the
//   app asks again with `until` to read the rest. Each key and each address has a budget of rows it can
//   read (REQ_ROWS), so asking for the same large mailbox over and over is refused.
// - Each envelope is marked when the recipient had not written to its sender that day (one bit, not who
//   the sender is); at most MAX_STRANGER_BOX such envelopes wait for one person, so people the person
//   does not know cannot take the whole mailbox. Bytes saved per sending key and per invite tree are
//   counted per day (memory only).
//
// Files (Blossom, BUD-01/02): PUT /upload stores an already-encrypted file, GET /<sha256>
// returns it. Uploads need a signed kind 24242 event; files are deleted after 30 days.
//
// Recovery backups: PUT /backup/<id> stores an account backup that was encrypted on the
// person's device with a key from their recovery code; GET /backup/<id> returns it (no
// login: the id comes from the code and cannot be guessed); DELETE /backup/<id> removes
// it. Writing and deleting need a NIP-98 signature, and only the key that first stored a
// backup can replace or delete it. The app signs with a key derived from the recovery
// code, not with the account's key, so the relay cannot tell whose backup it is. The
// relay keeps the id, the ciphertext, that signing key and the time of the last upload,
// until the person deletes it (no 30-day limit). It cannot read the backup or find one
// without the code.
//
// Registration (members.ts): only registered keys may write or upload (and make a new recovery backup). POST /register
// (NIP-98) registers a key with an invite code or a Cloudflare Turnstile token, or just
// reports its state, and returns its own invite code when it may invite. Envelopes from keys
// registered without an invite are marked (tegami_open) and ring no notifications.
// POST /admin lets the operator (ADMIN_PUBKEYS) stop a key and everyone below it in the invite tree.
// An AI key may also send {ai_card} (its owner card): from then on it is an AI key, and the
// envelopes it publishes are counted against AI limits per key and per owner (ai.ts).
//
// Reports (reports.ts): POST /report (NIP-98) lets a registered key tell the operator about
// another key, with recent messages only if the reporter chose to attach them. Nothing is
// sent to the reported key and nothing happens automatically; the operator reads them with
// POST /admin {action: 'reports'}. Deleted after 90 days.
//
// Deleting an account: DELETE /account (NIP-98, body {"delete":"account"}) removes everything
// the relay keeps under that key: envelopes waiting for it, its stamps (and their files when no
// other key keeps them), its notification addresses and its registration. The key is kept in
// deleted_keys so it cannot register again; envelopes sent to it afterwards are dropped.
// Kept as before: reports (90 days) and who it invited (on the invitees' rows, 90 days).
// Not reachable from the key: recovery backups (signed with a key from the recovery code; the
// app deletes its own first) and photos (no key is stored with them; gone after 30 days).

import { DurableObject } from 'cloudflare:workers';
import { verifyEvent, type NostrEvent } from 'nostr-tools/pure';

import { AI_PER_MINUTE, AiKeys, HELD_OWNER_BANNED, HELD_OWNER_DELETED, checkAiCard } from './ai';
import { Members, turnstileOk, type Member } from './members';
import { MAX_DEVICES, Vapid, allowedEndpoint, nip98, nip98Header, validKeys, type PushKeys } from './push';
import { Reports, parseReport } from './reports';
import { STATS_DESCRIPTION, Stats } from './stats';
import { TURN_RATE, TURN_TTL_SECONDS as TURN_TTL, makeTurnCredentials, turnConfigured, type TurnEnv } from './turn';

type Filter = { kinds?: number[]; '#p'?: string[]; since?: number; until?: number; limit?: number; ids?: string[] };
type TestOpts = {
  rows?: number; // rows in one answer to a REQ
  bytes?: number; // bytes in one answer to a REQ
  budget?: number; // a key's row budget (burst)
  strangerBox?: number; // MAX_STRANGER_BOX
  senderBytes?: number; // ENVELOPE_BYTES_PER_KEY_PER_DAY
  treeBytes?: number; // ENVELOPE_BYTES_PER_TREE_PER_DAY
  dbSize?: number; // DB_NEARLY_FULL_BYTES
  newKeySeconds?: number; // NEW_KEY_SECONDS
  friendPair?: number; // FRIEND_PUSH_PER_PAIR burst
  friendHour?: number; // FRIEND_PUSH_PER_HOUR burst
};
type Attachment = { challenge: string; ip: string; pubkey?: string; subs: Record<string, Filter[]>; authTries?: number; testLimit?: number; testPushCap?: number; t?: TestOpts };

// VAPID_JWK: the relay's Web Push key (Worker secret). DEV_PUSH=1 lets tests push to localhost
// (and sign requests for localhost). DEV_LOCAL=1 only lets tests sign requests for localhost.
// TURNSTILE_SECRET: checks the web app's proof of a person when registering without an invite.
// ADMIN_PUBKEYS: the operator's keys (comma separated, hex), allowed to use POST /admin.
// COMMIT: the Git commit being deployed (scripts/deploy.mjs sets it), shown in /stats and NIP-11.
// TURN_KEY_ID, TURN_KEY_API_TOKEN: the Cloudflare Realtime TURN key (Worker secrets) for POST /turn (turn.ts).
// TURN_API: tests only (with DEV_LOCAL=1), a local stand-in for the Cloudflare API.
type Env = TurnEnv & {
  RELAY: DurableObjectNamespace<Relay>;
  FILES: R2Bucket;
  STAMPS: R2Bucket;
  VAPID_JWK?: string;
  DEV_PUSH?: string;
  DEV_LOCAL?: string;
  TURNSTILE_SECRET?: string;
  ADMIN_PUBKEYS?: string;
  COMMIT?: string;
};

const ALLOWED_KINDS = new Set([1059]);
const MAX_EVENT_BYTES = 128 * 1024;
const MAX_SUBS = 20;
const RETENTION_SECONDS = 30 * 24 * 60 * 60;
const AUTH_WINDOW_SECONDS = 10 * 60;
// One message is one envelope per member plus one for the sender's other devices,
// so a message to a group of five is six envelopes.
const RATE = { ip: { burst: 300, perSecond: 5 }, key: { burst: 120, perSecond: 3 } };
const MAX_CONNECTIONS_PER_IP = 50;
const MAX_MAILBOX = 10_000;
// One REQ may carry at most this many filters: each filter runs its own query of up to 500 rows.
const MAX_FILTERS_PER_REQ = 10;
// One answer to a REQ: at most this many envelopes in all (every filter together) and this many bytes. When
// it is cut short the relay still ends with EOSE; the app asks again with `until` (client lib/catch-up.ts).
const MAX_REQ_ROWS = 1000;
const MAX_REQ_BYTES = 4 * 1024 * 1024;
// Envelopes a key (and an address) may read: a budget of rows, refilled over time. The key's burst is one
// whole full mailbox, so reading everything once always works; after that about 100 rows a second.
const REQ_ROWS = { key: { burst: 10_000, perSecond: 100 }, ip: { burst: 20_000, perSecond: 200 } };
// REQs per address and per key (burst, then per second): a client asks a few times when it opens, not constantly.
const REQ_RATE = { ip: { burst: 120, perSecond: 2 }, key: { burst: 40, perSecond: 1 } };
// AUTH events one connection may send before it is closed: each one costs a signature check.
const MAX_AUTH_ATTEMPTS = 10;
// Envelopes one key may send to one recipient in a day (memory only, so the sender's key is never written down):
// without it one invited key could fill a person's mailbox in about an hour. Copies to oneself are exempt.
const PAIR_PER_DAY = 500;
// A recipient that is not registered can only get short-lived envelopes (moving an account sends one to a
// one-time key), at most this long, this many waiting, and this many a day from one key.
const STRANGER_MAX_TTL_SECONDS = 15 * 60;
const MAX_STRANGER_MAILBOX = 3;
// Envelopes waiting for one person from keys the person had not written to that day (the relay marks them with
// one bit): the rest of the mailbox stays for people they have. Keys cost nothing, so without this a handful
// of invited keys can fill a mailbox and lock out a person's friends.
const MAX_STRANGER_BOX = 1000;
// Bytes of envelopes one key may save in a day, and all the keys of one invite tree together (memory only).
// A tree is the same people: invites made by hand can give a person hundreds of keys.
const ENVELOPE_BYTES_PER_KEY_PER_DAY = 50e6;
const ENVELOPE_BYTES_PER_TREE_PER_DAY = 500e6;
// When the Durable Object holds more than this (its limit is 10 GB), envelopes from keys made in the last
// NEW_KEY_SECONDS are refused until the 30-day clean-up makes room.
const DB_NEARLY_FULL_BYTES = 8e9;
const NEW_KEY_SECONDS = 7 * 24 * 60 * 60;
const STRANGER_PER_DAY = 50;
// New recovery backups per address per day: the signing key comes from the recovery code, so it cannot be
// tied to a registered account, and keys cost nothing; only the address can slow someone who makes ids in bulk.
const NEW_BACKUPS_PER_IP_PER_DAY = 10;
// New recovery backups for the whole relay per UTC day, and backups held in total. Addresses are free to
// rotate (rented blocks, proxies), so the per-address limit alone cannot stop bulk creation; these bound the
// worst case: a day of abuse costs at most this many rows of up to 64 KB, and storage stays well under the
// Durable Object's 10 GB. Refreshing or deleting an existing backup is never blocked by either.
const NEW_BACKUPS_PER_DAY = 5000;
// New backups per invite tree per day. A backup is signed with a key from the recovery code, so the relay
// asks for a second signature by the account's own key (X-Tegami-Member), checks that it is registered, counts
// it for the tree, and keeps nothing: the backup row has no account key, only the one from the code.
const NEW_BACKUPS_PER_TREE_PER_DAY = 50;
const MAX_BACKUPS_TOTAL = 100_000;
// Notifications from a key the recipient has not written to (the relay cannot read envelopes, so it cannot
// know who is a friend; "the recipient wrote to this key today" is the only sign it has). Such a sender rings
// a recipient at most once per pair, kind and 10 minutes, and all strangers together at most 20 times an hour.
// The envelope is still stored and delivered; only the push is skipped. Memory only, like PAIR_PER_DAY.
const STRANGER_PUSH_PAIR_SECONDS = 10 * 60;
const STRANGER_PUSH_PER_HOUR = 20;
// Notifications from a key the recipient did write to today: no longer unlimited (the recipient can be made to
// write one line to anyone). Per sender and recipient 10 in a minute, and per recipient 300 an hour from all
// friends together. The message is still delivered; only the ring is skipped. Memory only.
const FRIEND_PUSH_PER_PAIR: Rate = { burst: 10, perSecond: 10 / 60 };
const FRIEND_PUSH_PER_HOUR: Rate = { burst: 300, perSecond: 300 / 3600 };
// Most keys tracked in memory by a limiter before the oldest are dropped (a bounded Map, never a full reset).
const LIMITER_MAX_KEYS = 50_000;
// Bytes one key may upload in a day (memory only), on top of the burst limit above: stops slow, steady filling of storage.
const FILE_BYTES_PER_KEY_PER_DAY = 200e6;
// Envelopes from keys registered without an invite, waiting for one person. Their app
// shows them only from friends, so a stranger cannot fill someone's mailbox with them.
const MAX_OPEN_MAILBOX = 200;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BACKUP_BYTES = 64 * 1024;
// Backups per signing key. The app derives one signing key and one id from each recovery
// code, so a key never needs more than one; this stops one key from filling many ids.
const MAX_BACKUPS_PER_KEY = 1;
const BACKUP_PATH = /^\/backup\/([0-9a-f]{64})$/;
// Stamps: kept until the person removes them (not deleted after 30 days like photos).
const STAMP_PATH = /^\/stamp\/([0-9a-f]{64})$/;
const MAX_STAMP_BYTES = 512 * 1024;
const MAX_STAMPS_PER_KEY = 200;
// Bytes: an address may upload 100 MB at once, then 100 KB per second; a key 50 MB, then 50 KB/s.
const FILE_RATE = { ip: { burst: 100e6, perSecond: 100e3 }, key: { burst: 50e6, perSecond: 50e3 } };
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-SHA-256, If-Match',
  'Access-Control-Max-Age': '86400',
};

// Most keys tracked in memory by a limiter. Tests (DEV_LOCAL) may lower it with X-Test-Table-Max.
let limiterMax = LIMITER_MAX_KEYS;

/**
 * Makes room once a Map holds more than limiterMax entries (down to 90%). Entries that limit nothing right now
 * (`idle`: a bucket that is full again, a count from an earlier day) go first; only when there are not enough of
 * them, the oldest records that are not refusing anything (`limiting`: a used-up bucket) go next, and the records that
 * are refusing something right now go last. Someone who makes a record for every address they can reach cannot
 * push out the records of addresses that are used up.
 */
function trimOldest<V>(m: Map<string, V>, idle?: (v: V) => boolean, limiting?: (v: V) => boolean) {
  if (m.size <= limiterMax) return;
  let drop = m.size - (limiterMax - Math.ceil(limiterMax / 10));
  const pass = (pick: (v: V) => boolean) => {
    for (const [k, v] of m) {
      if (drop <= 0) return;
      if (pick(v)) {
        m.delete(k);
        drop--;
      }
    }
  };
  if (idle) pass(idle);
  if (limiting) pass((v) => !limiting(v));
  pass(() => true);
}

type Rate = { burst: number; perSecond: number };

/** Token bucket: `burst` sends at once, refilling at `perSecond`. `over` replaces both (tests, per-call limits). */
class Buckets {
  private b = new Map<string, { tokens: number; at: number }>();
  constructor(private burst: number, private perSecond: number) {}
  private level(key: string, over?: Rate) {
    const burst = over?.burst ?? this.burst;
    const per = over?.perSecond ?? this.perSecond;
    const t = Date.now() / 1000;
    const cur = this.b.get(key) ?? { tokens: burst, at: t };
    cur.tokens = Math.min(burst, cur.tokens + (t - cur.at) * per);
    cur.at = t;
    return { cur, burst, per };
  }
  private store(key: string, cur: { tokens: number; at: number }, burst: number, per: number) {
    this.b.delete(key); // re-insert so the least recently used keys are the ones dropped
    this.b.set(key, cur);
    // A full bucket limits nothing, so it is the first to go when the table is full.
    const now = () => Date.now() / 1000;
    trimOldest(
      this.b,
      (v) => v.tokens + (now() - v.at) * per >= burst,
      (v) => v.tokens + (now() - v.at) * per < 1,
    );
  }
  /** Whether `cost` could be taken now. Takes nothing. */
  can(key: string, cost = 1, over?: Rate): boolean {
    const { cur, burst, per } = this.level(key, over);
    this.store(key, cur, burst, per);
    return cur.tokens >= cost;
  }
  take(key: string, cost = 1, over?: Rate): boolean {
    const { cur, burst, per } = this.level(key, over);
    this.store(key, cur, burst, per); // memory guard; a dropped bucket only errs towards allowing, and only for idle keys
    if (cur.tokens < cost) return false;
    cur.tokens -= cost;
    return true;
  }
  /** For a budget that may run into debt: takes `n` even if that leaves less than nothing (down to -burst). */
  charge(key: string, n: number, over?: Rate) {
    const { cur, burst, per } = this.level(key, over);
    cur.tokens = Math.max(-burst, cur.tokens - n);
    this.store(key, cur, burst, per);
  }
  /** Whether anything is left (above zero). Takes nothing. */
  hasSome(key: string, over?: Rate): boolean {
    const { cur, burst, per } = this.level(key, over);
    this.store(key, cur, burst, per);
    return cur.tokens > 0;
  }
}

/** The address blocks a limit counts: the address (its /64 for IPv6), and for IPv6 also its /48 and /32. */
function ipLevels(ip: string): string[] {
  if (!ip.includes(':')) return [ip];
  const g = ip.split(':');
  return [ip, g.slice(0, 3).join(':'), g.slice(0, 2).join(':')];
}
/** How much looser each level is than the /64 (or the IPv4 address). */
const IP_LEVEL_SCALE = [1, 4, 16];
const scaled = (r: Rate, i: number): Rate => ({ burst: r.burst * IP_LEVEL_SCALE[i], perSecond: r.perSecond * IP_LEVEL_SCALE[i] });

/** A limit per network address: the /64 level plus, for IPv6, a 4 times looser /48 and 16 times looser /32. Any one used up refuses. */
class IpBuckets {
  private b: Buckets[];
  constructor(burst: number, perSecond: number) {
    this.b = IP_LEVEL_SCALE.map((k) => new Buckets(burst * k, perSecond * k));
  }
  take(ip: string, cost = 1): boolean {
    const keys = ipLevels(ip);
    if (!keys.every((k, i) => this.b[i].can(k, cost))) return false;
    keys.forEach((k, i) => this.b[i].take(k, cost));
    return true;
  }
  /** A budget run into debt (see Buckets.charge): is anything left, and take `n`. `over` is the /64 level's limit. */
  hasSome(ip: string, over: Rate): boolean {
    return ipLevels(ip).every((k, i) => this.b[i].hasSome(k, scaled(over, i)));
  }
  charge(ip: string, n: number, over: Rate) {
    ipLevels(ip).forEach((k, i) => this.b[i].charge(k, n, scaled(over, i)));
  }
}

/** Counts per key for the current UTC day, in memory only. `take` adds `n` unless that would pass `limit`. */
class DayCounter {
  private m = new Map<string, { day: number; n: number }>();
  take(key: string, limit: number, n = 1): boolean {
    const day = Math.floor(Date.now() / 86_400_000);
    let cur = this.m.get(key);
    if (!cur || cur.day !== day) cur = { day, n: 0 };
    this.m.delete(key);
    this.m.set(key, cur);
    // A count from an earlier day limits nothing: it goes first when the table is full.
    trimOldest(this.m, (v) => v.day !== Math.floor(Date.now() / 86_400_000));
    if (cur.n + n > limit) return false;
    cur.n += n;
    return true;
  }
  /** The count for this key today, without adding anything. */
  peek(key: string): number {
    const cur = this.m.get(key);
    return cur && cur.day === Math.floor(Date.now() / 86_400_000) ? cur.n : 0;
  }
}

/** A daily count per network address, with the same looser /48 and /32 levels as IpBuckets. */
class IpDayCounter {
  private d = IP_LEVEL_SCALE.map(() => new DayCounter());
  take(ip: string, limit: number): boolean {
    const keys = ipLevels(ip);
    if (!keys.every((k, i) => this.d[i].peek(k) + 1 <= limit * IP_LEVEL_SCALE[i])) return false;
    keys.forEach((k, i) => this.d[i].take(k, limit * IP_LEVEL_SCALE[i]));
    return true;
  }
}

/** The address a request came from. Tests (DEV_LOCAL) may pose as another address with X-Test-Ip. */
function clientIp(req: Request, env: Env): string {
  const test = env.DEV_LOCAL === '1' || env.DEV_PUSH === '1' ? req.headers.get('X-Test-Ip') : null;
  return test ?? req.headers.get('CF-Connecting-IP') ?? 'unknown';
}

/**
 * Limits count an IPv6 address by its /64, the block one subscriber gets, so a rented block is one address.
 * IpBuckets and IpDayCounter also count its /48 and /32 (looser), so a block cannot get a new allowance for each /64.
 */
export function ipGroup(ip: string): string {
  if (!ip.includes(':')) return ip;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  const [head, tail] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return groups.slice(0, 4).join(':');
}

const INFO = {
  name: 'Tegami relay',
  description: 'Relay for the Tegami messenger. Your chats belong to you. Bring your own AI.',
  software: 'https://github.com/tegami-chat/tegami',
  supported_nips: [1, 11, 17, 42, 59, 98],
  limitation: {
    auth_required: true,
    restricted_writes: true,
    max_message_length: MAX_EVENT_BYTES,
    max_subscriptions: MAX_SUBS,
  },
  retention: [{ kinds: [1059], time: RETENTION_SECONDS }],
  // What this relay keeps. Recovery backups are encrypted on the person's device; the
  // relay cannot read them or find one without the recovery code.
  keeps: {
    envelopes:
      'Gift-wrapped messages (kind 1059), deleted 30 days after they arrive. Each has one mark: whether the recipient had written to its sender that day (not who the sender is).',
    files: 'Encrypted photos and files, deleted after 30 days. Nothing about the uploader.',
    members:
      'Registered keys: the key, whether it registered with an invite or without one, when, and whether it is stopped. Who invited whom is forgotten after 90 days; a mark that the key joined with an invite stays. Each inviting key has one invite code.',
    push: 'For notifications: a device push address and the key it belongs to, until turned off. In memory only: when a key that the person has not written to today last rang them, so a stranger cannot keep a phone ringing.',
    backups:
      'Recovery backups: an id derived from the recovery code, the ciphertext, a signing key also derived from the code (not the account key), when it was first and last uploaded. Kept until the person deletes it. A new backup also carries a second signature by the account key, checked when it is made and not kept.',
    limits:
      'In memory only, for at most a day: how many bytes of envelopes each key and each invite tree saved today, how many new backups each invite tree made today and how many times each network address (and its /48 and /32 block for IPv6) asked for something, how many envelopes each key and address read, and which keys the person wrote to today.',
    turn: 'Nothing. Short-lived call relay (TURN) credentials are made per request and not kept.',
    ai: "AI keys that registered as an AI: the AI's key, its owner's key (from the owner's signed card) and when, and how many envelopes each AI key and each owner sent per day (kept two days).",
    deleted:
      'Deleted accounts: the key and when it was deleted, so it cannot register again. Everything else under the key is deleted at once.',
    reports:
      "Reports about a key, for the operator: the reporter's key, the reported key, the reason, and recent messages only if the reporter chose to attach them. Deleted after 90 days.",
  },
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/crash' && req.method === 'POST') {
      const headers = new Headers(req.headers);
      headers.set('X-Tegami-IP', clientIp(req, env));
      return env.RELAY.get(env.RELAY.idFromName('main')).fetch(new Request(req, { headers }));
    }
    if (url.pathname === '/stats' && req.method === 'GET') {
      return env.RELAY.get(env.RELAY.idFromName('main')).fetch(req);
    }
    if (url.pathname === '/push/key' && req.method === 'GET') {
      if (!env.VAPID_JWK) return new Response('Push is not set up', { status: 503, headers: CORS });
      return Response.json({ key: new Vapid(env.VAPID_JWK).publicKey }, { headers: { ...CORS, 'Cache-Control': 'public, max-age=3600' } });
    }
    if (((url.pathname === '/register' || url.pathname === '/admin' || url.pathname === '/report' || url.pathname === '/turn') && req.method === 'POST') || (url.pathname === '/account' && req.method === 'DELETE')) {
      const headers = new Headers(req.headers);
      headers.set('X-Tegami-IP', clientIp(req, env));
      return env.RELAY.get(env.RELAY.idFromName('main')).fetch(new Request(req, { headers }));
    }
    if (url.pathname === '/push' && (req.method === 'POST' || req.method === 'DELETE')) {
      const headers = new Headers(req.headers);
      headers.set('X-Tegami-IP', clientIp(req, env));
      return env.RELAY.get(env.RELAY.idFromName('main')).fetch(new Request(req, { headers }));
    }
    if (BACKUP_PATH.test(url.pathname) && ['GET', 'PUT', 'DELETE'].includes(req.method)) {
      const headers = new Headers(req.headers);
      headers.set('X-Tegami-IP', clientIp(req, env));
      return env.RELAY.get(env.RELAY.idFromName('main')).fetch(new Request(req, { headers }));
    }
    const stampPath = url.pathname.match(STAMP_PATH);
    if (stampPath && (req.method === 'GET' || req.method === 'HEAD')) {
      const obj = await env.STAMPS.get(stampPath[1]);
      if (!obj) return new Response('Not found', { status: 404, headers: CORS });
      return new Response(req.method === 'HEAD' ? null : obj.body, {
        headers: {
          ...CORS,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(obj.size),
          // A stamp can be removed, so caches keep it a day, not a month.
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }
    if ((url.pathname === '/stamp' && req.method === 'PUT') || (stampPath && req.method === 'DELETE')) {
      const headers = new Headers(req.headers);
      headers.set('X-Tegami-IP', clientIp(req, env));
      return env.RELAY.get(env.RELAY.idFromName('main')).fetch(new Request(req, { headers }));
    }
    if (url.pathname === '/upload' && req.method === 'PUT') {
      const headers = new Headers(req.headers);
      headers.set('X-Tegami-IP', clientIp(req, env));
      return env.RELAY.get(env.RELAY.idFromName('main')).fetch(new Request(req, { headers }));
    }
    const blob = url.pathname.match(/^\/([0-9a-f]{64})(\.[a-z0-9]+)?$/);
    if (blob && (req.method === 'GET' || req.method === 'HEAD')) {
      const obj = await env.FILES.get(blob[1]);
      if (!obj) return new Response('Not found', { status: 404, headers: CORS });
      return new Response(req.method === 'HEAD' ? null : obj.body, {
        headers: {
          ...CORS,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(obj.size),
          'Cache-Control': 'public, max-age=2592000, immutable',
        },
      });
    }
    if (req.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      // Cloudflare sets CF-Connecting-IP; a client cannot forge it through the edge.
      const headers = new Headers(req.headers);
      headers.set('X-Tegami-IP', clientIp(req, env));
      return env.RELAY.get(env.RELAY.idFromName('main')).fetch(new Request(req, { headers }));
    }
    if (req.headers.get('Accept')?.includes('application/nostr+json')) {
      return Response.json({ ...INFO, version: env.COMMIT ?? 'unknown' }, {
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/nostr+json' },
      });
    }
    return new Response('Tegami relay. Your chats belong to you. Bring your own AI.\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  },
};

function now() {
  return Math.floor(Date.now() / 1000);
}

function randomHex(n: number) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function expired(ev: NostrEvent) {
  const exp = ev.tags.find((t) => t[0] === 'expiration')?.[1];
  return exp !== undefined && Number(exp) <= now();
}

function matches(f: Filter, ev: NostrEvent) {
  if (expired(ev)) return false;
  if (f.ids && !f.ids.includes(ev.id)) return false;
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f.since && ev.created_at < f.since) return false;
  if (f.until && ev.created_at > f.until) return false;
  if (f['#p'] && !ev.tags.some((t) => t[0] === 'p' && f['#p']!.includes(t[1]))) return false;
  return true;
}

export class Relay extends DurableObject<Env> {
  sql: SqlStorage;
  ipRate = new IpBuckets(RATE.ip.burst, RATE.ip.perSecond);
  keyRate = new Buckets(RATE.key.burst, RATE.key.perSecond);
  reqIp = new IpBuckets(REQ_RATE.ip.burst, REQ_RATE.ip.perSecond);
  reqKey = new Buckets(REQ_RATE.key.burst, REQ_RATE.key.perSecond);
  // Rows read per key and per address (a budget that can run into debt: see Buckets.charge).
  rowsKey = new Buckets(REQ_ROWS.key.burst, REQ_ROWS.key.perSecond);
  rowsIp = new IpBuckets(REQ_ROWS.ip.burst, REQ_ROWS.ip.perSecond);
  // Bytes of envelopes saved today, per sending key and per invite tree (its top key). Memory only.
  senderBytesDay = new DayCounter();
  treeBytesDay = new DayCounter();
  backupTreeDay = new DayCounter();
  // Pushes to a recipient from keys they wrote to today: per pair a minute, per recipient an hour.
  friendPair = new Buckets(FRIEND_PUSH_PER_PAIR.burst, FRIEND_PUSH_PER_PAIR.perSecond);
  friendHour = new Buckets(FRIEND_PUSH_PER_HOUR.burst, FRIEND_PUSH_PER_HOUR.perSecond);
  // Memory only on purpose: the site promises the relay does not keep who sent to whom.
  pairDay = new DayCounter();
  strangerDay = new DayCounter();
  backupNewDay = new IpDayCounter();
  uploadDay = new DayCounter();
  stats: Stats;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, kind INTEGER, created_at INTEGER, received_at INTEGER, p TEXT, raw TEXT)`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS events_p ON events (p, created_at)');
    // Web Push: which devices to tell when an envelope for this key arrives. One device (one
    // push address) can hold several Tegami accounts, so a row is an address and a key together.
    // keys: the device's push keys (to encrypt what kind of thing arrived); older rows have none.
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS push_devices (endpoint TEXT, pubkey TEXT, created_at INTEGER, keys TEXT, PRIMARY KEY (endpoint, pubkey))',
    );
    this.sql.exec('CREATE INDEX IF NOT EXISTS push_devices_pubkey ON push_devices (pubkey)');
    // Before 2026-11-12 the table was "push", one key per address. Move its rows over once.
    try {
      this.sql.exec('INSERT OR IGNORE INTO push_devices (endpoint, pubkey, created_at, keys) SELECT endpoint, pubkey, created_at, keys FROM push');
      this.sql.exec('DROP TABLE push');
    } catch {
      // No old table: nothing to move.
    }
    // Recovery backups (encrypted on the device). Not touched by the 30-day clean-up.
    this.sql.exec('CREATE TABLE IF NOT EXISTS backups (id TEXT PRIMARY KEY, pubkey TEXT, data TEXT, updated_at INTEGER)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS backups_pubkey ON backups (pubkey)');
    try {
      // Existing rows get NULL: they count as old, never as created today.
      this.sql.exec('ALTER TABLE backups ADD COLUMN created_at INTEGER');
    } catch {
      /* already there */
    }
    // Stamps (encrypted on the device): which key keeps which stamp, so a key's stamps can be
    // counted and the file deleted when nobody keeps it. Not touched by the 30-day clean-up.
    this.sql.exec('CREATE TABLE IF NOT EXISTS stamps (sha TEXT, pubkey TEXT, size INTEGER, created_at INTEGER, PRIMARY KEY (sha, pubkey))');
    this.sql.exec('CREATE INDEX IF NOT EXISTS stamps_pubkey ON stamps (pubkey)');
    // Envelopes written by a key registered without an invite (1).
    try {
      this.sql.exec('ALTER TABLE events ADD COLUMN open INTEGER DEFAULT 0');
    } catch {
      // Already there.
    }
    // When an envelope with an expiration tag (NIP-40) may be deleted: call signals, moving an
    // account, AI requests. The privacy policy promises these are gone after their time.
    try {
      this.sql.exec('ALTER TABLE events ADD COLUMN expires_at INTEGER');
    } catch {
      // Already there.
    }
    this.sql.exec('CREATE INDEX IF NOT EXISTS events_expires ON events (expires_at) WHERE expires_at IS NOT NULL');
    // 1 when the recipient had not written to the sender that day (the relay cannot know friends; this is its only sign).
    // One bit: the sender's key is not stored. It decides how many such envelopes may wait for one person.
    try {
      this.sql.exec('ALTER TABLE events ADD COLUMN stranger INTEGER DEFAULT 0');
    } catch {
      // Already there.
    }
    // Counting the waiting envelopes from strangers must not scan the whole mailbox for each new one.
    this.sql.exec('CREATE INDEX IF NOT EXISTS events_stranger ON events (p) WHERE stranger = 1');
    this.members = new Members(this.sql);
    this.ai = new AiKeys(this.sql);
    this.reports = new Reports(this.sql);
    this.vapid = env.VAPID_JWK ? new Vapid(env.VAPID_JWK) : null;
    this.devPush = env.DEV_PUSH === '1';
    this.devLocal = this.devPush || env.DEV_LOCAL === '1';
    this.stats = new Stats(this.sql);
  }

  async fetch(req: Request): Promise<Response> {
    const ip = ipGroup(req.headers.get('X-Tegami-IP') ?? 'unknown');
    const path = new URL(req.url).pathname;
    // Tests only (DEV_LOCAL): how many entries a limiter's table holds before it drops some. 0 puts it back.
    if (this.devLocal && req.headers.has('X-Test-Table-Max')) limiterMax = Number(req.headers.get('X-Test-Table-Max')) || LIMITER_MAX_KEYS;
    if (path === '/upload') return this.upload(req, ip);
    if (path === '/stamp') return this.stampPut(req, ip);
    const stamp = path.match(STAMP_PATH);
    if (stamp) return this.stampDelete(req, stamp[1]);
    if (path === '/push') return this.pushRoute(req, ip);
    if (path === '/register') return this.registerRoute(req, ip);
    if (path === '/admin') return this.adminRoute(req);
    if (path === '/report') return this.reportRoute(req, ip);
    if (path === '/turn') return this.turnRoute(req, ip);
    if (path === '/account') return this.accountRoute(req, ip);
    const backup = path.match(BACKUP_PATH);
    if (backup) return this.backupRoute(req, ip, backup[1]);
    if (path === '/crash') return this.crash(req, ip);
    if (path === '/stats') {
      return Response.json(
        { ...STATS_DESCRIPTION, commit: this.env.COMMIT ?? null, source: 'https://github.com/tegami-chat/tegami/blob/main/relay/src/stats.ts', weeks: this.stats.weekly() },
        { headers: { ...CORS, 'Cache-Control': 'public, max-age=3600' } },
      );
    }
    const open = this.ctx.getWebSockets().filter((w) => (w.deserializeAttachment() as Attachment)?.ip === ip).length;
    if (open >= MAX_CONNECTIONS_PER_IP) return new Response('Too many connections', { status: 429 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const att: Attachment = { challenge: randomHex(16), ip, subs: {} };
    // Tests only (DEV_LOCAL): a small daily limit for this connection, so a test need not send hundreds.
    const testLimit = Number(req.headers.get('X-Test-Limit'));
    if (this.devLocal && testLimit > 0) att.testLimit = testLimit;
    // Tests only (DEV_LOCAL): a small hourly cap on pushes from strangers, likewise.
    const testPushCap = Number(req.headers.get('X-Test-Push-Cap'));
    if (this.devLocal && testPushCap > 0) att.testPushCap = testPushCap;
    // Tests only (DEV_LOCAL): lower limits for this connection, as JSON (see TestOpts).
    const t = this.testOpts(req);
    if (t) att.t = t;
    server.serializeAttachment(att);
    server.send(JSON.stringify(['AUTH', att.challenge]));
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Tests only (DEV_LOCAL): X-Test-Opts, a JSON object of numbers (TestOpts). Nothing otherwise. */
  testOpts(req: Request): TestOpts | undefined {
    if (!this.devLocal) return undefined;
    try {
      const o = JSON.parse(req.headers.get('X-Test-Opts') ?? 'null');
      if (!o || typeof o !== 'object') return undefined;
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(o)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      return out as TestOpts;
    } catch {
      return undefined;
    }
  }

  members: Members;
  ai: AiKeys;
  // AI keys: envelopes a minute (memory only; the daily counts are in ai_counts).
  aiMinute = new Buckets(AI_PER_MINUTE, AI_PER_MINUTE / 60);
  // Registering: per address. Without an invite 10 at once, then one every 10 minutes;
  // with one (or just asking) 60 at once, then one a second.
  openJoinRate = new IpBuckets(10, 1 / 600);
  registerRate = new IpBuckets(60, 1);

  /** The signed URL for a route: the public address, or localhost in tests (wrangler dev rewrites the host). */
  signedFor(path: string) {
    const local = new RegExp(`^http://(localhost|127\\.0\\.0\\.1):\\d+${path}$`);
    return (u: string) => u === `https://relay.tegami.chat${path}` || (this.devLocal && local.test(u));
  }

  /**
   * POST /register, signed (NIP-98) by the key itself. Body: {} to ask, {invite} or
   * {turnstile} to register. An open key sending an invite becomes an invite key.
   * Answers {member, via, trusted, code}; code is this key's own invite code, if it may invite.
   * {ai_card}: the key is an AI and this is its owner card (kind 25070, signed by the owner, p =
   * this key, not run out; the owner a registered key that is not stopped). The key must already
   * be registered (or register in the same call). Then {ai: true}; a bad card answers 400.
   */
  async registerRoute(req: Request, ip: string): Promise<Response> {
    const fail = (status: number, error: string) => Response.json({ error }, { status, headers: CORS });
    if (!this.registerRate.take(ip)) return fail(429, 'rate-limited');
    const body = await req.text();
    if (body.length > 4096) return fail(413, 'too large');
    const pubkey = await nip98(req, body, this.signedFor('/register'));
    if (!pubkey) return fail(401, 'auth-required');
    let ask: { invite?: unknown; turnstile?: unknown; ai_card?: unknown };
    try {
      ask = JSON.parse(body || '{}') ?? {};
    } catch {
      return fail(400, 'invalid json');
    }
    if (this.members.deleted(pubkey)) return fail(403, 'deleted');
    let m = this.members.get(pubkey);
    if (m?.banned) return fail(403, 'blocked');
    let inviteError = '';
    if (typeof ask.invite === 'string' && ask.invite && (!m || m.via === 'open')) {
      const inviter = /^[a-z2-9]{6,32}$/.test(ask.invite) ? this.members.inviter(ask.invite) : null;
      if (inviter === 'used-up') inviteError = 'invite-used-up';
      else if (!inviter || inviter === pubkey) inviteError = 'invite-invalid';
      else {
        this.members.joinWithInvite(pubkey, inviter);
        m = this.members.get(pubkey);
      }
    }
    if (!m && typeof ask.turnstile === 'string' && ask.turnstile) {
      if (!this.openJoinRate.take(ip)) return fail(429, 'rate-limited');
      if (!(await turnstileOk(ask.turnstile, this.env.TURNSTILE_SECRET, ip, this.devLocal))) return fail(403, 'turnstile-failed');
      this.members.joinOpen(pubkey);
      m = this.members.get(pubkey);
    }
    if (!m && inviteError) return fail(400, inviteError);
    if (ask.ai_card !== undefined && ask.ai_card !== null) {
      if (!m) return fail(403, 'restricted: register first (POST /register)');
      const card = checkAiCard(ask.ai_card, pubkey);
      if ('error' in card) return fail(400, card.error);
      const owner = this.members.get(card.owner);
      if (!owner || owner.banned || this.members.deleted(card.owner)) return fail(400, 'ai-card-owner-not-member');
      if (!this.ai.declare(pubkey, card.owner)) return fail(409, 'ai-owner-differs');
    }
    return Response.json(this.describe(m, inviteError), { headers: CORS });
  }

  describe(m: Member | null, inviteError = '') {
    if (!m) return { member: false };
    return {
      member: true,
      via: m.via,
      trusted: this.members.trusted(m),
      banned: !!m.banned,
      code: this.members.code(m),
      ai: !!this.ai.owner(m.pubkey),
      ...(inviteError ? { inviteError } : {}),
    };
  }

  /**
   * POST /admin, signed (NIP-98) by an operator key. Body: {action, pubkey, invitees?, per_day?}.
   * {action: 'reports'} lists the latest reports; with pubkey, the reports about that key.
   * {action: 'stats'} the exact daily totals; {action: 'members'} how many keys registered, by how.
   * {action: 'ais'} owners of AI keys with how many each has; with pubkey (an owner), that owner's
   * AI keys. {action: 'ai-limit', pubkey: <owner>, per_day} changes one owner's daily AI total.
   */
  async adminRoute(req: Request): Promise<Response> {
    const body = await req.text();
    const signer = await nip98(req, body, this.signedFor('/admin'));
    const admins = (this.env.ADMIN_PUBKEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!signer || !admins.includes(signer)) return new Response('restricted', { status: 403, headers: CORS });
    let a: { action?: unknown; pubkey?: unknown; invitees?: unknown; per_day?: unknown };
    try {
      a = JSON.parse(body);
    } catch {
      return new Response('invalid json', { status: 400, headers: CORS });
    }
    if (a?.action === 'reports' && a.pubkey === undefined) return Response.json(this.reports.latest(), { headers: CORS });
    if (a?.action === 'stats') return Response.json(this.stats.recent(183), { headers: CORS });
    if (a?.action === 'members') return Response.json(this.members.counts(), { headers: CORS });
    if (a?.action === 'ais' && a.pubkey === undefined) return Response.json(this.ai.list(), { headers: CORS });
    if (typeof a?.action !== 'string' || typeof a.pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(a.pubkey)) {
      return new Response('invalid', { status: 400, headers: CORS });
    }
    if (a.action === 'reports') return Response.json(this.reports.about(a.pubkey), { headers: CORS });
    if (a.action === 'ais') return Response.json(this.ai.ofOwner(a.pubkey), { headers: CORS });
    if (a.action === 'ai-limit') {
      if (this.ai.setOwnerLimit(a.pubkey, a.per_day) === null) return new Response('invalid', { status: 400, headers: CORS });
      return Response.json({ changed: 1, per_day: this.ai.ownerLimit(a.pubkey) }, { headers: CORS });
    }
    // The keys this action stops or lets back by name (the key and, with invitees, everyone below it in the invite tree).
    const named = [a.pubkey];
    if (a.invitees === true) named.push(...this.members.inviteTree(a.pubkey));
    if (a.action === 'ban' || a.action === 'unban') for (const k of named) this.ai.clearHold(k);
    const changed = this.members.admin(a.action, a.pubkey, { invitees: a.invitees === true, per_day: a.per_day as number });
    if (changed === null) return new Response('invalid', { status: 400, headers: CORS });
    // An AI is part of its owner, not an invitee: stopping an owner stops their AI keys too.
    let ais = 0;
    if (a.action === 'ban') for (const k of named) ais += this.ai.holdAisOf(k, HELD_OWNER_BANNED);
    if (a.action === 'unban') for (const k of named) ais += this.ai.releaseAisOf(k);
    return Response.json({ changed, ais, member: this.describe(this.members.get(a.pubkey)) }, { headers: CORS });
  }

  reports: Reports;
  // Reporting: per address, 60 at once, then one every 10 seconds. The real limit is per
  // reporter (reports.ts); this only stops floods of bad requests.
  reportRate = new IpBuckets(60, 0.1);

  /**
   * POST /report, signed (NIP-98) by the reporter, a registered key that is not stopped.
   * Body: {pubkey, reason, messages?}. Nothing is sent to the reported key.
   */
  async reportRoute(req: Request, ip: string): Promise<Response> {
    const fail = (status: number, error: string) => Response.json({ error }, { status, headers: CORS });
    if (!this.reportRate.take(ip)) return fail(429, 'rate-limited');
    const body = await req.text();
    // 20 messages of 2000 characters, with room for JSON escapes.
    if (body.length > 128 * 1024) return fail(413, 'too large');
    const reporter = await nip98(req, body, this.signedFor('/report'));
    if (!reporter) return fail(401, 'auth-required');
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return fail(400, 'invalid json');
    }
    const m = this.members.get(reporter);
    if (!m) return fail(403, 'restricted: register first (POST /register)');
    if (m.banned) return fail(403, 'blocked');
    const r = parseReport(parsed);
    if (typeof r === 'string') return fail(400, r);
    if (r.pubkey === reporter) return fail(400, 'invalid: cannot report yourself');
    if (this.reports.limited(reporter, r.pubkey)) return fail(429, 'rate-limited: too many reports');
    this.reports.add(reporter, r.pubkey, r.reason, r.messages);
    return new Response(null, { status: 204, headers: CORS });
  }

  // TURN credentials: per key (turn.ts), and per address 60 at once, then one every 5 seconds.
  turnKeyRate = new Buckets(TURN_RATE.burst, TURN_RATE.perSecond);
  turnIpRate = new IpBuckets(60, 0.2);

  /**
   * POST /turn, signed (NIP-98) by a registered key that is not stopped. Answers
   * {iceServers, ttl} with short-lived TURN credentials, or 503 when TURN is not set up
   * (the app then calls with STUN only). Nothing about the request is kept.
   */
  async turnRoute(req: Request, ip: string): Promise<Response> {
    const fail = (status: number, error: string) => Response.json({ error }, { status, headers: CORS });
    if (!turnConfigured(this.env)) return fail(503, 'turn-not-configured');
    if (!this.turnIpRate.take(ip)) return fail(429, 'rate-limited');
    const body = await req.text();
    if (body.length > 1024) return fail(413, 'too large');
    const pubkey = await nip98(req, body, this.signedFor('/turn'));
    if (!pubkey) return fail(401, 'auth-required');
    const m = this.members.get(pubkey);
    if (!m) return fail(403, 'restricted: register first (POST /register)');
    if (m.banned) return fail(403, 'blocked');
    if (!this.turnKeyRate.take(pubkey)) return fail(429, 'rate-limited');
    const api = this.devLocal && this.env.TURN_API ? this.env.TURN_API : undefined;
    const servers = await makeTurnCredentials(this.env, api);
    if (!servers) return fail(502, 'turn-unavailable');
    return Response.json({ iceServers: servers, ttl: TURN_TTL }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
  }

  // Deleting: per address, 10 at once, then one a minute.
  deleteRate = new IpBuckets(10, 1 / 60);

  /**
   * DELETE /account, signed (NIP-98) by the key itself, body {"delete":"account"}. Removes what
   * the relay keeps under the key and closes its connections. Asking again answers the same.
   */
  async accountRoute(req: Request, ip: string): Promise<Response> {
    const fail = (status: number, error: string) => Response.json({ error }, { status, headers: CORS });
    if (req.method !== 'DELETE') return fail(405, 'method not allowed');
    if (!this.deleteRate.take(ip)) return fail(429, 'rate-limited');
    const body = await req.text();
    if (body.length > 1024) return fail(413, 'too large');
    const pubkey = await nip98(req, body, this.signedFor('/account'));
    if (!pubkey) return fail(401, 'auth-required');
    let ask: { delete?: unknown };
    try {
      ask = JSON.parse(body) ?? {};
    } catch {
      return fail(400, 'invalid json');
    }
    // The body says what is asked, so a signature made for something else cannot delete.
    if (ask?.delete !== 'account') return fail(400, 'invalid: body must be {"delete":"account"}');
    const already = this.members.deleted(pubkey);
    const envelopes = this.sql.exec('DELETE FROM events WHERE p = ?', pubkey).rowsWritten;
    const shas = this.sql.exec('SELECT sha FROM stamps WHERE pubkey = ?', pubkey).toArray().map((r) => r.sha as string);
    this.sql.exec('DELETE FROM stamps WHERE pubkey = ?', pubkey);
    for (const sha of shas) {
      if (!this.sql.exec('SELECT 1 FROM stamps WHERE sha = ?', sha).toArray().length) await this.env.STAMPS.delete(sha);
    }
    const push = this.sql.exec('DELETE FROM push_devices WHERE pubkey = ?', pubkey).rowsWritten;
    this.pendingMessages.delete(pubkey);
    this.members.markDeleted(pubkey);
    this.ai.forget(pubkey);
    // Its AI keys cannot go on sending without an owner: stopped for good.
    const ais = this.ai.holdAisOf(pubkey, HELD_OWNER_DELETED);
    for (const ws of this.ctx.getWebSockets()) {
      if ((ws.deserializeAttachment() as Attachment)?.pubkey !== pubkey) continue;
      try {
        ws.close(4001, 'account deleted');
      } catch {
        // Already closed.
      }
    }
    return Response.json({ deleted: true, already, envelopes, stamps: shas.length, push, ais }, { headers: CORS });
  }

  ipBytes = new IpBuckets(FILE_RATE.ip.burst, FILE_RATE.ip.perSecond);
  keyBytes = new Buckets(FILE_RATE.key.burst, FILE_RATE.key.perSecond);

  crashRate = new IpBuckets(20, 0.05); // per address: 20 at once, then one every 20 seconds

  /**
   * A crash report from an app whose user allowed it. Only written to Workers Logs
   * (kept a few days); nothing is stored by the relay. No key, no message text.
   */
  async crash(req: Request, ip: string): Promise<Response> {
    if (!this.crashRate.take(ip)) return new Response(null, { status: 429, headers: CORS });
    const text = await req.text();
    if (text.length > 8192) return new Response(null, { status: 413, headers: CORS });
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(text);
    } catch {
      return new Response(null, { status: 400, headers: CORS });
    }
    const str = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '');
    console.log(
      JSON.stringify({
        crash: true,
        message: str(r.message, 500),
        stack: str(r.stack, 4000),
        version: str(r.version, 80),
        platform: str(r.platform, 40),
      }),
    );
    return new Response(null, { status: 204, headers: CORS });
  }

  /** Blossom upload. The file is already encrypted on the sender's device. */
  async upload(req: Request, ip: string): Promise<Response> {
    const fail = (status: number, reason: string) =>
      new Response(reason, { status, headers: { ...CORS, 'X-Reason': reason } });
    let auth: NostrEvent;
    try {
      auth = JSON.parse(atob((req.headers.get('Authorization') ?? '').replace(/^Nostr /, '')));
    } catch {
      return fail(401, 'auth-required: missing upload authorization');
    }
    const tag = (name: string) => auth?.tags?.find((t) => t[0] === name)?.[1];
    const expiration = Number(tag('expiration') ?? 0);
    if (auth?.kind !== 24242 || tag('t') !== 'upload' || expiration < now() || !verifyEvent(auth)) {
      return fail(401, 'auth-required: invalid upload authorization');
    }
    const uploader = this.members.get(auth.pubkey);
    if (!uploader) return fail(403, 'restricted: register first (POST /register)');
    if (uploader.banned) return fail(403, 'blocked: this key is stopped');
    const size = Number(req.headers.get('Content-Length') ?? 0);
    if (!size || size > MAX_FILE_BYTES) return fail(413, 'too large: files up to 10 MB');
    if (!this.ipBytes.take(ip, size) || !this.keyBytes.take(auth.pubkey, size)) {
      return fail(429, 'rate-limited: slow down');
    }
    if (!this.uploadDay.take(auth.pubkey, (this.devLocal && Number(req.headers.get('X-Test-Limit'))) || FILE_BYTES_PER_KEY_PER_DAY, size)) return fail(429, 'rate-limited: too many files today');
    const body = await req.arrayBuffer();
    if (body.byteLength !== size || body.byteLength > MAX_FILE_BYTES) return fail(400, 'invalid: size mismatch');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    if (!auth.tags.some((t) => t[0] === 'x' && t[1] === hash)) return fail(401, 'auth-required: hash not authorized');
    // Nothing about the uploader is stored with the file.
    await this.env.FILES.put(hash, body);
    this.stats.add('files');
    this.stats.addBytes(size);
    const base = new URL(req.url).origin;
    return Response.json(
      { url: `${base}/${hash}`, sha256: hash, size, type: 'application/octet-stream', uploaded: now() },
      { headers: CORS },
    );
  }

  /** Checks a Blossom-style authorization (kind 24242) for `t`. Null when it is not valid. */
  fileAuth(req: Request, t: string): NostrEvent | null {
    let auth: NostrEvent;
    try {
      auth = JSON.parse(atob((req.headers.get('Authorization') ?? '').replace(/^Nostr /, '')));
    } catch {
      return null;
    }
    const tag = (name: string) => auth?.tags?.find((x) => x[0] === name)?.[1];
    if (auth?.kind !== 24242 || tag('t') !== t || Number(tag('expiration') ?? 0) < now() || !verifyEvent(auth)) return null;
    return auth;
  }

  /**
   * PUT /stamp: keeps an encrypted stamp until its keeper deletes it. The app encrypts each
   * stamp with a key made from the image and the account's own secret, so the same stamp from
   * the same account is the same file on every device, and stamps of different accounts never
   * match (the relay cannot see who has the same stamp as whom).
   */
  async stampPut(req: Request, ip: string): Promise<Response> {
    const fail = (status: number, reason: string) =>
      new Response(reason, { status, headers: { ...CORS, 'X-Reason': reason } });
    if (req.method !== 'PUT') return fail(405, 'method not allowed');
    const auth = this.fileAuth(req, 'stamp');
    if (!auth) return fail(401, 'auth-required: invalid stamp authorization');
    const keeper = this.members.get(auth.pubkey);
    if (!keeper) return fail(403, 'restricted: register first (POST /register)');
    if (keeper.banned) return fail(403, 'blocked: this key is stopped');
    const size = Number(req.headers.get('Content-Length') ?? 0);
    if (!size || size > MAX_STAMP_BYTES) return fail(413, 'too large: stamps up to 512 KB');
    if (!this.ipBytes.take(ip, size) || !this.keyBytes.take(auth.pubkey, size)) return fail(429, 'rate-limited: slow down');
    const body = await req.arrayBuffer();
    if (body.byteLength !== size) return fail(400, 'invalid: size mismatch');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (!auth.tags.some((x) => x[0] === 'x' && x[1] === hash)) return fail(401, 'auth-required: hash not authorized');
    const mine = this.sql.exec('SELECT 1 FROM stamps WHERE sha = ? AND pubkey = ?', hash, auth.pubkey).toArray().length > 0;
    if (!mine) {
      const held = Number(this.sql.exec('SELECT COUNT(*) AS n FROM stamps WHERE pubkey = ?', auth.pubkey).one().n);
      if (held >= MAX_STAMPS_PER_KEY) return fail(429, `rate-limited: up to ${MAX_STAMPS_PER_KEY} stamps per key`);
    }
    await this.env.STAMPS.put(hash, body);
    this.sql.exec('INSERT OR REPLACE INTO stamps (sha, pubkey, size, created_at) VALUES (?, ?, ?, ?)', hash, auth.pubkey, size, now());
    const base = new URL(req.url).origin;
    return Response.json({ url: `${base}/stamp/${hash}`, sha256: hash, size, type: 'application/octet-stream', uploaded: now() }, { headers: CORS });
  }

  /** DELETE /stamp/<sha256>: the key stops keeping it; the file goes when no key keeps it. */
  async stampDelete(req: Request, sha: string): Promise<Response> {
    const fail = (status: number, reason: string) =>
      new Response(reason, { status, headers: { ...CORS, 'X-Reason': reason } });
    if (req.method !== 'DELETE') return fail(405, 'method not allowed');
    const auth = this.fileAuth(req, 'delete');
    if (!auth || !auth.tags.some((x) => x[0] === 'x' && x[1] === sha)) return fail(401, 'auth-required: invalid delete authorization');
    this.sql.exec('DELETE FROM stamps WHERE sha = ? AND pubkey = ?', sha, auth.pubkey);
    const left = this.sql.exec('SELECT 1 FROM stamps WHERE sha = ?', sha).toArray().length;
    if (!left) await this.env.STAMPS.delete(sha);
    return new Response(null, { status: 204, headers: CORS });
  }

  vapid: Vapid | null;
  devPush: boolean;
  devLocal: boolean;
  backupWriteRate = new IpBuckets(60, 0.1); // per address: 60 at once, then one every 10 seconds
  backupReadRate = new IpBuckets(30, 0.2); // per address: 30 at once, then one every 5 seconds

  /** GET returns a backup to anyone with its id; PUT and DELETE need the owning key's signature (NIP-98). */
  async backupRoute(req: Request, ip: string, id: string): Promise<Response> {
    const fail = (status: number, why: string) => new Response(why, { status, headers: CORS });
    if (req.method === 'GET') {
      if (!this.backupReadRate.take(ip)) return fail(429, 'rate-limited');
      const row = this.sql.exec('SELECT data FROM backups WHERE id = ?', id).toArray()[0];
      if (!row) return fail(404, 'not found');
      return new Response(row.data as string, { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    if (!this.backupWriteRate.take(ip)) return fail(429, 'rate-limited');
    if (Number(req.headers.get('Content-Length') ?? 0) > MAX_BACKUP_BYTES) return fail(413, 'too large: backups up to 64 KB');
    const body = await req.text();
    if (new TextEncoder().encode(body).length > MAX_BACKUP_BYTES) return fail(413, 'too large: backups up to 64 KB');
    // The signed URL: the public address (wrangler dev rewrites the host, so tests sign localhost).
    const local = /^http:\/\/(localhost|127\.0\.0\.1):\d+\/backup\/([0-9a-f]{64})$/;
    const signedFor = (u: string) => u === `https://relay.tegami.chat/backup/${id}` || (this.devLocal && local.exec(u)?.[2] === id);
    const pubkey = await nip98(req, body, signedFor);
    if (!pubkey) return fail(401, 'auth-required: sign the request (NIP-98)');
    const owner = this.sql.exec('SELECT pubkey FROM backups WHERE id = ?', id).toArray()[0]?.pubkey as string | undefined;
    if (owner && owner !== pubkey) return fail(403, 'restricted: this backup belongs to another key');
    if (req.method === 'DELETE') {
      if (!owner) return fail(404, 'not found');
      this.sql.exec('DELETE FROM backups WHERE id = ?', id);
      return new Response(null, { status: 204, headers: CORS });
    }
    if (!body) return fail(400, 'invalid: empty backup');
    // A refresh (If-Match: *) only replaces a backup that is still there.
    if (!owner && req.headers.get('If-Match') === '*') return fail(412, 'gone: no backup with this id');
    if (!owner) {
      const held = this.sql.exec('SELECT COUNT(*) AS n FROM backups WHERE pubkey = ?', pubkey).one().n as number;
      if (held >= MAX_BACKUPS_PER_KEY) return fail(429, 'rate-limited: too many backups for this key');
      // Tests only (DEV_LOCAL): lower caps for this request, so a test need not make thousands of backups.
      const test = (name: string) => (this.devLocal ? Number(req.headers.get(name)) || 0 : 0);
      // A new backup needs a registered account: a second NIP-98 signature of the same request, by the account's
      // key (X-Tegami-Member). The relay checks it and keeps nothing of it; the tree it belongs to is counted today.
      const account = await nip98Header(req.headers.get('X-Tegami-Member') ?? '', 'PUT', body, signedFor);
      const member = account ? this.members.get(account) : null;
      if (!account || !member || member.banned || this.members.deleted(account)) return fail(403, 'restricted: register first (POST /register)');
      if (!this.backupTreeDay.take(this.members.root(account), test('X-Test-Backups-Per-Tree') || NEW_BACKUPS_PER_TREE_PER_DAY)) {
        return fail(429, 'rate-limited: too many new backups from this invite today');
      }
      if (!this.backupNewDay.take(ip, NEW_BACKUPS_PER_IP_PER_DAY)) return fail(429, 'rate-limited: too many new backups from this address today');
      // Relay-wide caps. The day's count comes from created_at, so it survives a restart and stores nothing new.
      const total = this.sql.exec('SELECT COUNT(*) AS n FROM backups').one().n as number;
      if (total >= (test('X-Test-Backups-Total') || MAX_BACKUPS_TOTAL)) return fail(507, 'full: this relay holds no more new backups');
      const midnight = Math.floor(now() / 86_400) * 86_400;
      const today = this.sql.exec('SELECT COUNT(*) AS n FROM backups WHERE created_at >= ?', midnight).one().n as number;
      if (today >= (test('X-Test-Backups-Per-Day') || NEW_BACKUPS_PER_DAY)) {
        return new Response('busy: new backups are paused until tomorrow', { status: 503, headers: { ...CORS, 'Retry-After': String(midnight + 86_400 - now()) } });
      }
    }
    // created_at is set once, when the backup first appears; a refresh keeps it.
    this.sql.exec(
      'INSERT INTO backups (id, pubkey, data, updated_at, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
      id,
      pubkey,
      body,
      now(),
      now(),
    );
    return new Response(null, { status: 204, headers: CORS });
  }
  pushRate = new IpBuckets(30, 0.1); // registering: per address, 30 at once, then one every 10 seconds
  lastPush = new Map<string, number>();

  /** POST /push registers this device for a key (NIP-98 signed); DELETE removes it. */
  async pushRoute(req: Request, ip: string): Promise<Response> {
    const fail = (status: number, why: string) => new Response(why, { status, headers: CORS });
    if (!this.pushRate.take(ip)) return fail(429, 'rate-limited');
    const body = await req.text();
    if (body.length > 4096) return fail(413, 'too large');
    // The signed URL: the public address (wrangler dev rewrites the host, so tests sign localhost).
    const pubkey = await nip98(req, body, (u) => u === 'https://relay.tegami.chat/push' || (this.devPush && /^http:\/\/(localhost|127\.0\.0\.1):\d+\/push$/.test(u)));
    if (!pubkey) return fail(401, 'auth-required: sign the request (NIP-98)');
    let endpoint: unknown;
    let keys: unknown;
    try {
      ({ endpoint, keys } = JSON.parse(body) ?? {});
    } catch {
      return fail(400, 'invalid json');
    }
    if (!allowedEndpoint(endpoint, this.devPush)) return fail(400, 'invalid: not a push service address');
    if (req.method === 'DELETE') {
      this.sql.exec('DELETE FROM push_devices WHERE endpoint = ? AND pubkey = ?', endpoint, pubkey);
      return new Response(null, { status: 204, headers: CORS });
    }
    if (this.members.deleted(pubkey)) return fail(403, 'deleted: this account was deleted');
    if (keys !== undefined && !validKeys(keys)) return fail(400, 'invalid: push keys');
    this.sql.exec(
      'INSERT OR REPLACE INTO push_devices (endpoint, pubkey, created_at, keys) VALUES (?, ?, ?, ?)',
      endpoint,
      pubkey,
      now(),
      keys ? JSON.stringify({ p256dh: (keys as PushKeys).p256dh, auth: (keys as PushKeys).auth }) : null,
    );
    // Keep the newest MAX_DEVICES for this key.
    this.sql.exec(
      'DELETE FROM push_devices WHERE pubkey = ? AND endpoint NOT IN (SELECT endpoint FROM push_devices WHERE pubkey = ? ORDER BY created_at DESC LIMIT ?)',
      pubkey,
      pubkey,
      MAX_DEVICES,
    );
    return new Response(null, { status: 204, headers: CORS });
  }

  /** Last push per sender, recipient and kind, and pushes per recipient this hour, from senders the recipient has not written to (memory only). */
  strangerPairPush = new Map<string, number>();
  strangerHourPush = new Map<string, { hour: number; n: number }>();
  strangerSwept = 0;

  /**
   * Whether this envelope may ring the recipient's devices. A sender the recipient wrote to today (the reverse
   * pair has a count) is a friend as far as the relay can tell: 10 rings a minute per pair and 300 an hour per
   * recipient (the recipient can be made to write one line to anyone). Anyone else rings at most once
   * per pair and kind every 10 minutes and `hourCap` times an hour across all such senders, so a stranger with a
   * free key cannot keep a phone ringing.
   */
  mayRing(sender: string, recipient: string, kind: 'message' | 'call', hourCap: number, t?: TestOpts): boolean {
    if (this.pairDay.peek(recipient + sender) > 0) {
      // A friend as far as the relay can tell: still limited, so one line to the right key cannot be turned into a flood.
      const pair: Rate = t?.friendPair ? { burst: t.friendPair, perSecond: FRIEND_PUSH_PER_PAIR.perSecond } : FRIEND_PUSH_PER_PAIR;
      const hour: Rate = t?.friendHour ? { burst: t.friendHour, perSecond: FRIEND_PUSH_PER_HOUR.perSecond } : FRIEND_PUSH_PER_HOUR;
      const pairKey = `${sender}:${recipient}`;
      if (!this.friendPair.can(pairKey, 1, pair) || !this.friendHour.can(recipient, 1, hour)) return false;
      this.friendPair.take(pairKey, 1, pair);
      this.friendHour.take(recipient, 1, hour);
      return true;
    }
    const t0 = Date.now();
    // Forget what no longer limits anything (older than an hour), so these times never outlive a day.
    if (t0 - this.strangerSwept > 10 * 60_000) {
      this.strangerSwept = t0;
      for (const [k, at] of this.strangerPairPush) if (t0 - at > 3_600_000) this.strangerPairPush.delete(k);
      const hr = Math.floor(t0 / 3_600_000);
      for (const [k, h] of this.strangerHourPush) if (h.hour !== hr) this.strangerHourPush.delete(k);
    }
    const pairKey = `${sender}:${recipient}:${kind}`;
    if (t0 - (this.strangerPairPush.get(pairKey) ?? 0) < STRANGER_PUSH_PAIR_SECONDS * 1000) return false;
    const hour = Math.floor(t0 / 3_600_000);
    const cur = this.strangerHourPush.get(recipient);
    const h = cur && cur.hour === hour ? cur : { hour, n: 0 };
    if (h.n >= hourCap) return false;
    h.n++;
    this.strangerHourPush.delete(recipient);
    this.strangerHourPush.set(recipient, h);
    trimOldest(this.strangerHourPush, (v) => v.hour !== Math.floor(Date.now() / 3_600_000));
    this.strangerPairPush.delete(pairKey);
    this.strangerPairPush.set(pairKey, t0);
    trimOldest(this.strangerPairPush, (at) => Date.now() - at > STRANGER_PUSH_PAIR_SECONDS * 1000);
    return true;
  }

  /** Messages for a key not yet told to its devices (counted while pushes wait out the 3 seconds). */
  pendingMessages = new Map<string, number>();
  /** Keys with a push waiting for the end of the 3 seconds. */
  trailing = new Set<string>();

  /**
   * Tells this key's devices that something arrived: a message, or a call ringing.
   * At most once every 3 seconds per key and kind. The kind is encrypted for each device.
   * Messages that arrive within those 3 seconds are counted, and one more push after the
   * wait carries their number, so a device can show how many arrived (n).
   */
  async notify(pubkey: string, kind: 'message' | 'call') {
    if (!this.vapid) return;
    if (kind === 'message') this.pendingMessages.set(pubkey, (this.pendingMessages.get(pubkey) ?? 0) + 1);
    const wait = 3000 - (Date.now() - (this.lastPush.get(`${pubkey}:${kind}`) ?? 0));
    if (wait <= 0) return this.push(pubkey, kind);
    if (kind !== 'message' || this.trailing.has(pubkey)) return;
    this.trailing.add(pubkey);
    await new Promise((r) => setTimeout(r, wait));
    this.trailing.delete(pubkey);
    // Another push may have gone out meanwhile and told these already.
    if (this.pendingMessages.get(pubkey)) await this.push(pubkey, 'message');
  }

  async push(pubkey: string, kind: 'message' | 'call') {
    this.lastPush.set(`${pubkey}:${kind}`, Date.now());
    if (this.lastPush.size > 50_000) this.lastPush.clear();
    if (this.pendingMessages.size > 50_000) this.pendingMessages.clear();
    const n = kind === 'message' ? (this.pendingMessages.get(pubkey) ?? 1) : 0;
    if (kind === 'message') this.pendingMessages.delete(pubkey);
    const rows = this.sql.exec('SELECT endpoint, keys FROM push_devices WHERE pubkey = ?', pubkey).toArray();
    // p: which account it is for, so a device with several accounts can say whose it is.
    // n: how many messages this push tells of.
    const payload = JSON.stringify(n ? { t: kind, p: pubkey, n } : { t: kind, p: pubkey });
    await Promise.all(
      rows.map(async (r) => {
        const endpoint = r.endpoint as string;
        try {
          const keys = r.keys ? (JSON.parse(r.keys as string) as PushKeys) : null;
          const status = await this.vapid!.send(endpoint, payload, keys);
          if (status === 404 || status === 410) this.sql.exec('DELETE FROM push_devices WHERE endpoint = ?', endpoint);
        } catch {
          // The push service is unreachable; try again with the next message.
        }
      }),
    );
  }

  deleteExpired() {
    this.sql.exec('DELETE FROM events WHERE expires_at IS NOT NULL AND expires_at <= ?', now());
  }

  async alarm() {
    // received_at, not created_at: NIP-59 wraps carry a randomized past created_at.
    this.sql.exec('DELETE FROM events WHERE received_at < ?', now() - RETENTION_SECONDS);
    this.deleteExpired();
    this.members.forgetOldInvites();
    this.reports.forgetOld();
    this.ai.forgetOld();
    await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    if (text.length > MAX_EVENT_BYTES) return this.notice(ws, 'error: message too large');
    let msg: unknown[];
    try {
      msg = JSON.parse(text);
    } catch {
      return this.notice(ws, 'error: invalid json');
    }
    if (!Array.isArray(msg)) return;
    const att = ws.deserializeAttachment() as Attachment;
    switch (msg[0]) {
      case 'AUTH':
        return this.onAuth(ws, att, msg[1] as NostrEvent);
      case 'EVENT':
        return this.onEvent(ws, att, msg[1] as NostrEvent);
      case 'REQ':
        return this.onReq(ws, att, String(msg[1]), msg.slice(2) as Filter[]);
      case 'CLOSE':
        delete att.subs[String(msg[1])];
        ws.serializeAttachment(att);
        return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code, 'closing');
    } catch {
      // already closed
    }
  }

  notice(ws: WebSocket, text: string) {
    ws.send(JSON.stringify(['NOTICE', text]));
  }

  onAuth(ws: WebSocket, att: Attachment, ev: NostrEvent) {
    const id = ev?.id ?? '';
    att.authTries = (att.authTries ?? 0) + 1;
    if (att.authTries > MAX_AUTH_ATTEMPTS) {
      ws.send(JSON.stringify(['OK', id, false, 'rate-limited: too many login attempts']));
      try {
        ws.close(4008, 'too many login attempts');
      } catch {
        // Already closed.
      }
      return;
    }
    ws.serializeAttachment(att);
    const tag = (name: string) => ev?.tags?.find((t) => t[0] === name)?.[1];
    const fresh = Math.abs(now() - (ev?.created_at ?? 0)) <= AUTH_WINDOW_SECONDS;
    if (!ev || ev.kind !== 22242 || tag('challenge') !== att.challenge || !fresh || !verifyEvent(ev)) {
      ws.send(JSON.stringify(['OK', id, false, 'auth-required: invalid auth event']));
      return;
    }
    att.pubkey = ev.pubkey;
    ws.serializeAttachment(att);
    ws.send(JSON.stringify(['OK', id, true, '']));
    this.stats.add('logins');
    void this.stats.addKey(ev.pubkey);
  }

  onEvent(ws: WebSocket, att: Attachment, ev: NostrEvent) {
    const id = ev?.id ?? '';
    const reply = (ok: boolean, why = '') => ws.send(JSON.stringify(['OK', id, ok, why]));
    if (!att.pubkey) return reply(false, 'auth-required: log in first');
    if (!ev || !ALLOWED_KINDS.has(ev.kind)) return reply(false, 'blocked: only private messages are accepted');
    const ps = ev.tags.filter((t) => t[0] === 'p');
    if (ps.length !== 1) return reply(false, 'invalid: exactly one recipient');
    const writer = this.members.get(att.pubkey);
    if (!writer) return reply(false, 'restricted: register first (POST /register)');
    if (writer.banned) return reply(false, 'blocked: this key is stopped');
    const open = writer.via === 'open';
    // Nearly out of room: only keys that have been here a while may add envelopes, until the 30-day clean-up frees some.
    if (this.sql.databaseSize > (att.t?.dbSize ?? DB_NEARLY_FULL_BYTES) && writer.created_at > now() - (att.t?.newKeySeconds ?? NEW_KEY_SECONDS)) {
      return reply(false, 'rate-limited: the relay is nearly full, new keys must wait');
    }
    if (!this.ipRate.take(att.ip) || !this.keyRate.take(att.pubkey)) {
      return reply(false, 'rate-limited: slow down');
    }
    if (!verifyEvent(ev)) return reply(false, 'invalid: bad signature');
    if (expired(ev)) return reply(false, 'invalid: expired');
    // An AI key (it registered as one, ai.ts): its own limits, per key and per owner, counted in
    // envelopes. Checked here, after the person limits, so only well-formed envelopes count.
    const aiOwner = this.ai.owner(att.pubkey);
    if (aiOwner) {
      const full = this.ai.dayFull(att.pubkey, aiOwner);
      if (full) return reply(false, full);
      if (!this.aiMinute.take(att.pubkey)) return reply(false, 'rate-limited: ai-minute: this AI sends too fast');
      this.ai.add(att.pubkey, aiOwner);
    }

    const p = ps[0][1];
    // Delete expired envelopes before counting the mailbox (cheap: the index holds only the few
    // envelopes that expire).
    this.deleteExpired();
    // The recipient deleted their account: say OK (the sender learns nothing, and its app does
    // not try again and again) but keep nothing.
    if (this.members.deleted(p)) return reply(true, '');
    const held = this.sql.exec('SELECT COUNT(*) AS n FROM events WHERE p = ?', p).one().n as number;
    if (held >= MAX_MAILBOX) return reply(false, 'rate-limited: the recipient has too many waiting messages');
    if (p !== att.pubkey) {
      if (!this.members.get(p)) {
        // Not registered: only short-lived envelopes (an account move goes to a one-time key), a few at a time.
        const until = Number(ev.tags.find((t) => t[0] === 'expiration')?.[1]);
        if (!Number.isFinite(until) || until - now() > STRANGER_MAX_TTL_SECONDS) return reply(false, 'restricted: the recipient is not registered');
        if (held >= MAX_STRANGER_MAILBOX) return reply(false, 'rate-limited: the recipient has too many waiting messages');
        if (!this.strangerDay.take(att.pubkey, STRANGER_PER_DAY)) return reply(false, 'rate-limited: too many messages to unregistered keys today');
      }
      if (!this.pairDay.take(att.pubkey + p, att.testLimit ?? PAIR_PER_DAY)) return reply(false, 'rate-limited: too many messages to this recipient today');
    }
    if (open && p !== att.pubkey) {
      const fromOpen = this.sql.exec('SELECT COUNT(*) AS n FROM events WHERE p = ? AND open = 1', p).one().n as number;
      if (fromOpen >= MAX_OPEN_MAILBOX) return reply(false, 'rate-limited: the recipient has too many waiting messages');
    }
    // Written to by no one the recipient wrote to today: such envelopes may take only part of the mailbox, so
    // keys made in bulk cannot lock out the recipient's friends. Only a bit is kept, never the sender.
    const stranger = p !== att.pubkey && this.pairDay.peek(p + att.pubkey) === 0;
    if (stranger) {
      const waiting = this.sql.exec('SELECT COUNT(*) AS n FROM events WHERE p = ? AND stranger = 1', p).one().n as number;
      if (waiting >= (att.t?.strangerBox ?? MAX_STRANGER_BOX)) return reply(false, 'rate-limited: the recipient has too many waiting messages from people they have not written to');
    }
    const raw = JSON.stringify(ev);
    // Bytes saved per key, and per invite tree (the top of its tree counts for all the keys below).
    if (!this.senderBytesDay.take(att.pubkey, att.t?.senderBytes ?? ENVELOPE_BYTES_PER_KEY_PER_DAY, raw.length)) return reply(false, 'rate-limited: too much saved today from this key');
    if (!this.treeBytesDay.take(this.members.root(att.pubkey), att.t?.treeBytes ?? ENVELOPE_BYTES_PER_TREE_PER_DAY, raw.length)) return reply(false, 'rate-limited: too much saved today from this invite');
    const exp = Number(ev.tags.find((t) => t[0] === 'expiration')?.[1]);
    const res = this.sql.exec(
      'INSERT OR IGNORE INTO events (id, kind, created_at, received_at, p, raw, open, expires_at, stranger) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ev.id,
      ev.kind,
      ev.created_at,
      now(),
      p,
      raw,
      open ? 1 : 0,
      Number.isFinite(exp) ? exp : null,
      stranger ? 1 : 0,
    );
    reply(true, res.rowsWritten === 0 ? 'duplicate: already have this event' : '');
    if (res.rowsWritten === 0) return;
    this.stats.add('envelopes');
    // Not for the sender's own copy: the sending connection is logged in as the sender.
    // Envelopes that expire soon are call signals (or moving an account). Only a ringing call,
    // marked t=call by the app, is worth a notification; the rest of a call's signals are not.
    // Nor for keys registered without an invite: their messages show only from friends, and
    // the relay cannot tell who is whose friend, so it never rings for them.
    if (p !== att.pubkey && !open) {
      const short = ev.tags.some((t) => t[0] === 'expiration');
      const call = ev.tags.some((t) => t[0] === 't' && t[1] === 'call');
      // t=quiet: something for the app that is not a message (a friend's new picture).
      const quiet = ev.tags.some((t) => t[0] === 't' && t[1] === 'quiet');
      const kind = !short && !quiet ? 'message' : call ? 'call' : null;
      if (kind && this.mayRing(att.pubkey, p, kind, att.testPushCap ?? STRANGER_PUSH_PER_HOUR, att.t)) this.ctx.waitUntil(this.notify(p, kind));
    }

    for (const other of this.ctx.getWebSockets()) {
      const o = other.deserializeAttachment() as Attachment;
      if (o.pubkey !== p) continue;
      for (const [subId, filters] of Object.entries(o.subs)) {
        if (filters.some((f) => matches(f, ev))) other.send(JSON.stringify(['EVENT', subId, open ? { ...ev, tegami_open: 1 } : ev]));
      }
    }
  }

  onReq(ws: WebSocket, att: Attachment, subId: string, filters: Filter[]) {
    const closed = (why: string) => ws.send(JSON.stringify(['CLOSED', subId, why]));
    if (!att.pubkey) return closed('auth-required: log in first');
    if (Object.keys(att.subs).length >= MAX_SUBS && !att.subs[subId]) return closed('error: too many subscriptions');
    if (!Array.isArray(filters) || filters.length > MAX_FILTERS_PER_REQ) return closed('error: too many filters');
    if (!this.reqIp.take(att.ip) || !this.reqKey.take(att.pubkey)) return closed('rate-limited: slow down');
    // Rows already read: a key and an address each have a budget (it may run into debt, so one whole answer is
    // always allowed while some is left; the next asks wait until it fills up again).
    const keyRows: Rate = att.t?.budget ? { burst: att.t.budget, perSecond: REQ_ROWS.key.perSecond } : REQ_ROWS.key;
    if (!this.rowsKey.hasSome(att.pubkey, keyRows) || !this.rowsIp.hasSome(att.ip, REQ_ROWS.ip)) {
      return closed('rate-limited: too many messages read, wait a little');
    }
    for (const f of filters) {
      if (!f || typeof f !== 'object' || (f.kinds !== undefined && !Array.isArray(f.kinds))) return closed('error: invalid filter');
      const onlyMine = f['#p']?.length === 1 && f['#p'][0] === att.pubkey;
      const onlyWraps = !f.kinds || f.kinds.every((k) => ALLOWED_KINDS.has(k));
      if (!onlyMine || !onlyWraps) return closed('restricted: you can only read messages addressed to you');
    }
    // The subscription stays so that new envelopes reach it. A connection keeps its subscriptions in an
    // attachment of at most 16 KB, so one that does not fit is refused (it used to throw).
    const before = att.subs[subId];
    att.subs[subId] = filters;
    try {
      ws.serializeAttachment(att);
    } catch {
      if (before) att.subs[subId] = before;
      else delete att.subs[subId];
      return closed('error: too many subscriptions');
    }

    const rowsCap = att.t?.rows ?? MAX_REQ_ROWS;
    const bytesCap = att.t?.bytes ?? MAX_REQ_BYTES;
    const t = now();
    const seen = new Set<string>();
    let rows = 0;
    let bytes = 0;
    for (const f of filters) {
      if (rows >= rowsCap || bytes >= bytesCap) break;
      // Every read has a LIMIT: a filter with no limit (or a negative one) gets 500, and the answer as a whole is cut at rowsCap.
      const asked = Number.isFinite(Number(f.limit)) ? Math.floor(Number(f.limit)) : 500;
      const limit = Math.max(0, Math.min(asked, 500, rowsCap - rows));
      if (!limit || (f.kinds && !f.kinds.includes(1059))) continue;
      const wanted = Array.isArray(f.ids) ? new Set(f.ids.filter((x) => typeof x === 'string')) : null;
      // First only the size of each row (length reads no more than the row's header), then the envelopes that
      // fit one by one: a mailbox of large envelopes is never read into memory whole.
      const found = this.sql
        .exec(
          'SELECT rowid AS r, id, length(raw) AS n, open FROM events WHERE p = ? AND created_at >= ? AND created_at <= ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT ?',
          att.pubkey,
          Number(f.since) || 0,
          Number.isFinite(Number(f.until)) && f.until !== undefined ? Number(f.until) : 2 ** 40,
          t,
          limit,
        )
        .toArray();
      for (const row of found) {
        const id = row.id as string;
        if (seen.has(id) || (wanted && !wanted.has(id))) continue;
        const n = row.n as number;
        if (rows >= rowsCap || (rows > 0 && bytes + n > bytesCap)) break;
        const raw = this.sql.exec('SELECT raw FROM events WHERE rowid = ?', row.r as number).toArray()[0]?.raw as string | undefined;
        if (!raw) continue;
        seen.add(id);
        rows++;
        bytes += n;
        // raw is the envelope's JSON as it was saved; a mark is added without parsing it.
        ws.send(`["EVENT",${JSON.stringify(subId)},${row.open ? `${raw.slice(0, -1)},"tegami_open":1}` : raw}]`);
      }
    }
    // Pay for what was read. Cut short or not, the answer ends with EOSE; the app asks again for older ones.
    this.rowsKey.charge(att.pubkey, Math.max(1, rows), keyRows);
    this.rowsIp.charge(att.ip, Math.max(1, rows), REQ_ROWS.ip);
    ws.send(JSON.stringify(['EOSE', subId]));
  }
}
