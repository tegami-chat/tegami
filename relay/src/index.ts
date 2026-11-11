// Tegami relay: a small Nostr relay on a Cloudflare Durable Object.
//
// Rules
// - Every connection must log in first (NIP-42 AUTH) with its Nostr key.
// - Only gift-wrapped private messages (kind 1059) are accepted.
// - You can only read envelopes addressed to yourself (#p = your key), so nobody can
//   list who receives messages from whom.
// - Envelopes are deleted after 30 days. Messages live on people's devices.
//
// - Limits: each network address and each key can send only so fast, each address can
//   hold only so many connections, and each mailbox holds at most MAX_MAILBOX envelopes.
//   Keys cost nothing to make, so the address limit is the one that stops floods.
//
// TODO: accept writes only from registered Tegami accounts.

import { DurableObject } from 'cloudflare:workers';
import { verifyEvent, type NostrEvent } from 'nostr-tools/pure';

type Filter = { kinds?: number[]; '#p'?: string[]; since?: number; until?: number; limit?: number; ids?: string[] };
type Attachment = { challenge: string; ip: string; pubkey?: string; subs: Record<string, Filter[]> };

type Env = { RELAY: DurableObjectNamespace<Relay> };

const ALLOWED_KINDS = new Set([1059]);
const MAX_EVENT_BYTES = 128 * 1024;
const MAX_SUBS = 20;
const RETENTION_SECONDS = 30 * 24 * 60 * 60;
const AUTH_WINDOW_SECONDS = 10 * 60;
// One message is two envelopes (one for the recipient, one for the sender's other devices).
const RATE = { ip: { burst: 120, perSecond: 2 }, key: { burst: 60, perSecond: 1 } };
const MAX_CONNECTIONS_PER_IP = 50;
const MAX_MAILBOX = 10_000;

/** Token bucket: `burst` sends at once, refilling at `perSecond`. */
class Buckets {
  private b = new Map<string, { tokens: number; at: number }>();
  constructor(private burst: number, private perSecond: number) {}
  take(key: string): boolean {
    const t = Date.now() / 1000;
    const cur = this.b.get(key) ?? { tokens: this.burst, at: t };
    cur.tokens = Math.min(this.burst, cur.tokens + (t - cur.at) * this.perSecond);
    cur.at = t;
    if (this.b.size > 50_000) this.b.clear(); // memory guard; buckets only ever err towards allowing
    this.b.set(key, cur);
    if (cur.tokens < 1) return false;
    cur.tokens -= 1;
    return true;
  }
}

const INFO = {
  name: 'Tegami relay',
  description: 'Relay for the Tegami messenger. Speak freely.',
  software: 'https://github.com/tegami-chat/tegami',
  supported_nips: [1, 11, 17, 42, 59],
  limitation: {
    auth_required: true,
    restricted_writes: true,
    max_message_length: MAX_EVENT_BYTES,
    max_subscriptions: MAX_SUBS,
  },
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
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

function matches(f: Filter, ev: NostrEvent) {
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, kind INTEGER, created_at INTEGER, received_at INTEGER, p TEXT, raw TEXT)`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS events_p ON events (p, created_at)');
  }

  async fetch(req: Request): Promise<Response> {
    const ip = req.headers.get('X-Tegami-IP') ?? 'unknown';
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
