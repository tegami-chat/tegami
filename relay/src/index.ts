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
//
// - Limits: each network address and each key can send only so fast, each address can
//   hold only so many connections, and each mailbox holds at most MAX_MAILBOX envelopes.
//   Keys cost nothing to make, so the address limit is the one that stops floods.
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
// TODO: accept writes only from registered Tegami accounts.

import { DurableObject } from 'cloudflare:workers';
import { verifyEvent, type NostrEvent } from 'nostr-tools/pure';

import { MAX_DEVICES, Vapid, allowedEndpoint, nip98 } from './push';
import { STATS_DESCRIPTION, Stats } from './stats';

type Filter = { kinds?: number[]; '#p'?: string[]; since?: number; until?: number; limit?: number; ids?: string[] };
type Attachment = { challenge: string; ip: string; pubkey?: string; subs: Record<string, Filter[]> };

// VAPID_JWK: the relay's Web Push key (Worker secret). DEV_PUSH=1 lets tests push to localhost
// (and sign requests for localhost). DEV_LOCAL=1 only lets tests sign requests for localhost.
type Env = { RELAY: DurableObjectNamespace<Relay>; FILES: R2Bucket; VAPID_JWK?: string; DEV_PUSH?: string; DEV_LOCAL?: string };

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
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BACKUP_BYTES = 64 * 1024;
// Backups per signing key. The app derives one signing key and one id from each recovery
// code, so a key never needs more than one; this stops one key from filling many ids.
const MAX_BACKUPS_PER_KEY = 1;
const BACKUP_PATH = /^\/backup\/([0-9a-f]{64})$/;
// Bytes: an address may upload 100 MB at once, then 100 KB per second; a key 50 MB, then 50 KB/s.
const FILE_RATE = { ip: { burst: 100e6, perSecond: 100e3 }, key: { burst: 50e6, perSecond: 50e3 } };
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-SHA-256, If-Match',
  'Access-Control-Max-Age': '86400',
};

/** Token bucket: `burst` sends at once, refilling at `perSecond`. */
class Buckets {
  private b = new Map<string, { tokens: number; at: number }>();
  constructor(private burst: number, private perSecond: number) {}
  take(key: string, cost = 1): boolean {
    const t = Date.now() / 1000;
    const cur = this.b.get(key) ?? { tokens: this.burst, at: t };
    cur.tokens = Math.min(this.burst, cur.tokens + (t - cur.at) * this.perSecond);
    cur.at = t;
    if (this.b.size > 50_000) this.b.clear(); // memory guard; buckets only ever err towards allowing
    this.b.set(key, cur);
    if (cur.tokens < cost) return false;
    cur.tokens -= cost;
    return true;
  }
}

const INFO = {
  name: 'Tegami relay',
  description: 'Relay for the Tegami messenger. Speak freely.',
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
    envelopes: 'Gift-wrapped messages (kind 1059), deleted 30 days after they arrive.',
    files: 'Encrypted photos and files, deleted after 30 days. Nothing about the uploader.',
    push: 'For notifications: a device push address and the key it belongs to, until turned off.',
    backups:
      'Recovery backups: an id derived from the recovery code, the ciphertext, a signing key also derived from the code (not the account key) and when it was last uploaded. Kept until the person deletes it.',
  },
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/crash' && req.method === 'POST') {
      const headers = new Headers(req.headers);
      headers.set('X-Tegami-IP', req.headers.get('CF-Connecting-IP') ?? 'unknown');
      return env.RELAY.get(env.RELAY.idFromName('main')).fetch(new Request(req, { headers }));
    }
    if (url.pathname === '/stats' && req.method === 'GET') {
      return env.RELAY.get(env.RELAY.idFromName('main')).fetch(req);
    }
    if (url.pathname === '/push/key' && req.method === 'GET') {
      if (!env.VAPID_JWK) return new Response('Push is not set up', { status: 503, headers: CORS });
      return Response.json({ key: new Vapid(env.VAPID_JWK).publicKey }, { headers: { ...CORS, 'Cache-Control': 'public, max-age=3600' } });
    }
    if (url.pathname === '/push' && (req.method === 'POST' || req.method === 'DELETE')) {
      const headers = new Headers(req.headers);
      headers.set('X-Tegami-IP', req.headers.get('CF-Connecting-IP') ?? 'unknown');
      return env.RELAY.get(env.RELAY.idFromName('main')).fetch(new Request(req, { headers }));
    }
    if (BACKUP_PATH.test(url.pathname) && ['GET', 'PUT', 'DELETE'].includes(req.method)) {
      const headers = new Headers(req.headers);
      headers.set('X-Tegami-IP', req.headers.get('CF-Connecting-IP') ?? 'unknown');
      return env.RELAY.get(env.RELAY.idFromName('main')).fetch(new Request(req, { headers }));
    }
    if (url.pathname === '/upload' && req.method === 'PUT') {
      const headers = new Headers(req.headers);
      headers.set('X-Tegami-IP', req.headers.get('CF-Connecting-IP') ?? 'unknown');
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
      headers.set('X-Tegami-IP', req.headers.get('CF-Connecting-IP') ?? 'unknown');
      return env.RELAY.get(env.RELAY.idFromName('main')).fetch(new Request(req, { headers }));
    }
    if (req.headers.get('Accept')?.includes('application/nostr+json')) {
      return Response.json(INFO, {
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/nostr+json' },
      });
    }
    return new Response('Tegami relay. Speak freely.\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
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
  ipRate = new Buckets(RATE.ip.burst, RATE.ip.perSecond);
  keyRate = new Buckets(RATE.key.burst, RATE.key.perSecond);
  stats: Stats;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, kind INTEGER, created_at INTEGER, received_at INTEGER, p TEXT, raw TEXT)`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS events_p ON events (p, created_at)');
    // Web Push: which devices to tell when an envelope for this key arrives.
    this.sql.exec('CREATE TABLE IF NOT EXISTS push (endpoint TEXT PRIMARY KEY, pubkey TEXT, created_at INTEGER)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS push_pubkey ON push (pubkey)');
    // Recovery backups (encrypted on the device). Not touched by the 30-day clean-up.
    this.sql.exec('CREATE TABLE IF NOT EXISTS backups (id TEXT PRIMARY KEY, pubkey TEXT, data TEXT, updated_at INTEGER)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS backups_pubkey ON backups (pubkey)');
    this.vapid = env.VAPID_JWK ? new Vapid(env.VAPID_JWK) : null;
    this.devPush = env.DEV_PUSH === '1';
    this.devLocal = this.devPush || env.DEV_LOCAL === '1';
    this.stats = new Stats(this.sql);
  }

  async fetch(req: Request): Promise<Response> {
    const ip = req.headers.get('X-Tegami-IP') ?? 'unknown';
    const path = new URL(req.url).pathname;
    if (path === '/upload') return this.upload(req, ip);
    if (path === '/push') return this.pushRoute(req, ip);
    const backup = path.match(BACKUP_PATH);
    if (backup) return this.backupRoute(req, ip, backup[1]);
    if (path === '/crash') return this.crash(req, ip);
    if (path === '/stats') {
      return Response.json({ ...STATS_DESCRIPTION, days: this.stats.recent() }, { headers: { ...CORS, 'Cache-Control': 'public, max-age=300' } });
    }
    const open = this.ctx.getWebSockets().filter((w) => (w.deserializeAttachment() as Attachment)?.ip === ip).length;
    if (open >= MAX_CONNECTIONS_PER_IP) return new Response('Too many connections', { status: 429 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const att: Attachment = { challenge: randomHex(16), ip, subs: {} };
    server.serializeAttachment(att);
    server.send(JSON.stringify(['AUTH', att.challenge]));
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    return new Response(null, { status: 101, webSocket: client });
  }

  ipBytes = new Buckets(FILE_RATE.ip.burst, FILE_RATE.ip.perSecond);
  keyBytes = new Buckets(FILE_RATE.key.burst, FILE_RATE.key.perSecond);

  crashRate = new Buckets(20, 0.05); // per address: 20 at once, then one every 20 seconds

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
    const size = Number(req.headers.get('Content-Length') ?? 0);
    if (!size || size > MAX_FILE_BYTES) return fail(413, 'too large: files up to 10 MB');
    if (!this.ipBytes.take(ip, size) || !this.keyBytes.take(auth.pubkey, size)) {
      return fail(429, 'rate-limited: slow down');
    }
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

  vapid: Vapid | null;
  devPush: boolean;
  devLocal: boolean;
  backupWriteRate = new Buckets(60, 0.1); // per address: 60 at once, then one every 10 seconds
  backupReadRate = new Buckets(30, 0.2); // per address: 30 at once, then one every 5 seconds

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
    }
    this.sql.exec('INSERT OR REPLACE INTO backups (id, pubkey, data, updated_at) VALUES (?, ?, ?, ?)', id, pubkey, body, now());
    return new Response(null, { status: 204, headers: CORS });
  }
  pushRate = new Buckets(30, 0.1); // registering: per address, 30 at once, then one every 10 seconds
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
    try {
      endpoint = JSON.parse(body)?.endpoint;
    } catch {
      return fail(400, 'invalid json');
    }
    if (!allowedEndpoint(endpoint, this.devPush)) return fail(400, 'invalid: not a push service address');
    if (req.method === 'DELETE') {
      this.sql.exec('DELETE FROM push WHERE endpoint = ? AND pubkey = ?', endpoint, pubkey);
      return new Response(null, { status: 204, headers: CORS });
    }
    this.sql.exec('INSERT OR REPLACE INTO push (endpoint, pubkey, created_at) VALUES (?, ?, ?)', endpoint, pubkey, now());
    // Keep the newest MAX_DEVICES for this key.
    this.sql.exec(
      'DELETE FROM push WHERE pubkey = ? AND endpoint NOT IN (SELECT endpoint FROM push WHERE pubkey = ? ORDER BY created_at DESC LIMIT ?)',
      pubkey,
      pubkey,
      MAX_DEVICES,
    );
    return new Response(null, { status: 204, headers: CORS });
  }

  /** Tells this key's devices that something arrived. At most once every 3 seconds per key. */
  async notify(pubkey: string) {
    if (!this.vapid) return;
    const t = Date.now();
    if (t - (this.lastPush.get(pubkey) ?? 0) < 3000) return;
    this.lastPush.set(pubkey, t);
    if (this.lastPush.size > 50_000) this.lastPush.clear();
    const rows = this.sql.exec('SELECT endpoint FROM push WHERE pubkey = ?', pubkey).toArray();
    await Promise.all(
      rows.map(async (r) => {
        const endpoint = r.endpoint as string;
        try {
          const status = await this.vapid!.send(endpoint);
          if (status === 404 || status === 410) this.sql.exec('DELETE FROM push WHERE endpoint = ?', endpoint);
        } catch {
          // The push service is unreachable; try again with the next message.
        }
      }),
    );
  }

  async alarm() {
    // received_at, not created_at: NIP-59 wraps carry a randomized past created_at.
    this.sql.exec('DELETE FROM events WHERE received_at < ?', now() - RETENTION_SECONDS);
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
    if (!this.ipRate.take(att.ip) || !this.keyRate.take(att.pubkey)) {
      return reply(false, 'rate-limited: slow down');
    }
    if (!verifyEvent(ev)) return reply(false, 'invalid: bad signature');
    if (expired(ev)) return reply(false, 'invalid: expired');

    const p = ps[0][1];
    const held = this.sql.exec('SELECT COUNT(*) AS n FROM events WHERE p = ?', p).one().n as number;
    if (held >= MAX_MAILBOX) return reply(false, 'rate-limited: the recipient has too many waiting messages');
    const res = this.sql.exec(
      'INSERT OR IGNORE INTO events (id, kind, created_at, received_at, p, raw) VALUES (?, ?, ?, ?, ?, ?)',
      ev.id,
      ev.kind,
      ev.created_at,
      now(),
      p,
      JSON.stringify(ev),
    );
    reply(true, res.rowsWritten === 0 ? 'duplicate: already have this event' : '');
    if (res.rowsWritten === 0) return;
    this.stats.add('envelopes');
    // Not for the sender's own copy: the sending connection is logged in as the sender.
    if (p !== att.pubkey) this.ctx.waitUntil(this.notify(p));

    for (const other of this.ctx.getWebSockets()) {
      const o = other.deserializeAttachment() as Attachment;
      if (o.pubkey !== p) continue;
      for (const [subId, filters] of Object.entries(o.subs)) {
        if (filters.some((f) => matches(f, ev))) other.send(JSON.stringify(['EVENT', subId, ev]));
      }
    }
  }

  onReq(ws: WebSocket, att: Attachment, subId: string, filters: Filter[]) {
    const closed = (why: string) => ws.send(JSON.stringify(['CLOSED', subId, why]));
    if (!att.pubkey) return closed('auth-required: log in first');
    if (Object.keys(att.subs).length >= MAX_SUBS && !att.subs[subId]) return closed('error: too many subscriptions');
    for (const f of filters) {
      const onlyMine = f['#p']?.length === 1 && f['#p'][0] === att.pubkey;
      const onlyWraps = !f.kinds || f.kinds.every((k) => ALLOWED_KINDS.has(k));
      if (!onlyMine || !onlyWraps) return closed('restricted: you can only read messages addressed to you');
    }
    att.subs[subId] = filters;
    ws.serializeAttachment(att);

    const seen = new Set<string>();
    for (const f of filters) {
      const limit = Math.min(f.limit ?? 500, 500);
      const rows = this.sql
        .exec(
          'SELECT raw FROM events WHERE p = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at DESC LIMIT ?',
          att.pubkey,
          f.since ?? 0,
          f.until ?? 2 ** 40,
          limit,
        )
        .toArray();
      for (const row of rows) {
        const ev = JSON.parse(row.raw as string) as NostrEvent;
        if (seen.has(ev.id) || !matches(f, ev)) continue;
        seen.add(ev.id);
        ws.send(JSON.stringify(['EVENT', subId, ev]));
      }
    }
    ws.send(JSON.stringify(['EOSE', subId]));
  }
}
