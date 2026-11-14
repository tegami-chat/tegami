// A tiny Nostr relay for local development only.
// Keeps events and uploaded files in memory. Run: npm run relay  (listens on ws://localhost:7447)
// Files: PUT /upload and GET /<sha256> on the same port, like relay.tegami.chat (Blossom).
// Recovery backups: GET, PUT and DELETE /backup/<id>, like relay.tegami.chat (NIP-98 signed writes).
// Registration: POST /register like relay.tegami.chat (an invite code, or the Turnstile token
// 'dev-pass'). Only registered keys write; envelopes from open keys are marked tegami_open.
// Tests: POST /_trust {pubkey} registers a key as if invited, GET /_members lists them.
// Unlike the real relay, 'dev-pass' registers a key as invited (so tests of other features
// see what invited people see), until POST /_open {on: true} makes it register open keys.
// Reports: POST /report like relay.tegami.chat (NIP-98, registered keys); GET /_reports lists them for tests.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { verifyEvent } from 'nostr-tools/pure';

const PORT = Number(process.env.PORT || 7447);
const events = [];
const subs = new Map(); // ws -> Map(subId -> filters[])

// NIP-40, like the real relay: expired envelopes are refused and not handed out.
const expired = (ev) => {
  const exp = ev.tags?.find((t) => t[0] === 'expiration')?.[1];
  return exp !== undefined && Number(exp) <= Math.floor(Date.now() / 1000);
};

function matches(filter, ev) {
  if (expired(ev)) return false;
  if (filter.ids && !filter.ids.includes(ev.id)) return false;
  if (filter.kinds && !filter.kinds.includes(ev.kind)) return false;
  if (filter.authors && !filter.authors.includes(ev.pubkey)) return false;
  if (filter.since && ev.created_at < filter.since) return false;
  if (filter.until && ev.created_at > filter.until) return false;
  for (const key of Object.keys(filter)) {
    if (key[0] !== '#') continue;
    const name = key.slice(1);
    const values = filter[key];
    if (!ev.tags.some((t) => t[0] === name && values.includes(t[1]))) return false;
  }
  return true;
}

const files = new Map(); // sha256 -> Buffer
const pushDevices = []; // { endpoint, pubkey }
const crashes = [];
const backups = new Map(); // id -> { pubkey, data }
const MAX_BACKUP_BYTES = 64 * 1024;
const members = new Map(); // pubkey -> { via, invitedBy, code, banned }
const codes = new Map(); // code -> pubkey
const openIds = new Set(); // envelopes written by open keys
const reports = []; // { reporter, reported, reason, messages, at }
const REPORT_REASONS = ['spam', 'scam', 'impersonation', 'harassment', 'other'];
// Like relay/src/reports.ts: null when the body is a valid report, else why not.
const reportError = (r) => {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'invalid: not an object';
  if (typeof r.pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(r.pubkey)) return 'invalid: pubkey';
  if (!REPORT_REASONS.includes(r.reason)) return 'invalid: reason';
  if (r.messages === undefined) return null;
  if (!Array.isArray(r.messages) || r.messages.length > 20) return 'invalid: messages';
  for (const m of r.messages) {
    if (typeof m?.text !== 'string' || m.text.length > 2000) return 'invalid: message text';
    if (!Number.isInteger(m.at) || m.at < 0) return 'invalid: message time';
  }
  return null;
};
let devPassOpen = false;
const trusted = (m) => !!m && !m.banned && m.via !== 'open';
const codeOf = (pubkey) => {
  const m = members.get(pubkey);
  if (!trusted(m)) return null;
  if (!m.code) {
    m.code = randomBytes(12).toString('hex').replace(/[^a-z2-9]/g, 'a').slice(0, 12).replace(/[01lo]/g, 'a');
    codes.set(m.code, pubkey);
  }
  return m.code;
};
const describe = (pubkey, extra = {}) => {
  const m = members.get(pubkey);
  if (!m) return { member: false };
  return { member: true, via: m.via, trusted: trusted(m), banned: !!m.banned, code: codeOf(pubkey), ...extra };
};
const deliver = (ev) => (openIds.has(ev.id) ? { ...ev, tegami_open: 1 } : ev);
const nip98 = (req, body, path) => {
  try {
    const ev = JSON.parse(Buffer.from((req.headers.authorization ?? '').replace(/^Nostr /, ''), 'base64').toString());
    const tag = (n) => ev.tags.find((t) => t[0] === n)?.[1];
    const hash = createHash('sha256').update(body).digest('hex');
    const ok = ev.kind === 27235 && verifyEvent(ev) && tag('u') === `http://localhost:${PORT}${path}` && tag('method') === req.method && tag('payload') === hash;
    return ok ? ev.pubkey : null;
  } catch {
    return null;
  }
};
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-SHA-256, If-Match',
};
const http = createServer((req, res) => {
  const send = (status, body = '', type = 'text/plain') => {
    res.writeHead(status, { ...CORS, 'Content-Type': type });
    res.end(body);
  };
  if (req.method === 'OPTIONS') return send(204);
  const blob = req.url.match(/^\/([0-9a-f]{64})$/);
  if (blob && req.method === 'GET') {
    const f = files.get(blob[1]);
    return f ? send(200, f, 'application/octet-stream') : send(404, 'Not found');
  }
  // Crash reports: kept in memory so tests can read them at GET /_crashes.
  if (req.url === '/crash' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        crashes.push(JSON.parse(body));
      } catch {}
      send(204);
    });
    return;
  }
  if (req.url === '/register' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (status, obj) => send(status, JSON.stringify(obj), 'application/json');
      const pubkey = nip98(req, body, '/register');
      if (!pubkey) return json(401, { error: 'auth-required' });
      let ask = {};
      try {
        ask = JSON.parse(body || '{}') ?? {};
      } catch {
        return json(400, { error: 'invalid json' });
      }
      let m = members.get(pubkey);
      if (m?.banned) return json(403, { error: 'blocked' });
      let inviteError = '';
      if (typeof ask.invite === 'string' && ask.invite && (!m || m.via === 'open')) {
        const inviter = codes.get(ask.invite);
        if (!inviter || inviter === pubkey || !trusted(members.get(inviter))) inviteError = 'invite-invalid';
        else members.set(pubkey, { via: 'invite', invitedBy: inviter });
      }
      m = members.get(pubkey);
      if (!m && typeof ask.turnstile === 'string' && ask.turnstile) {
        if (ask.turnstile !== 'dev-pass') return json(403, { error: 'turnstile-failed' });
        members.set(pubkey, { via: devPassOpen ? 'open' : 'invite' });
      }
      if (!members.has(pubkey) && inviteError) return json(400, { error: inviteError });
      json(200, describe(pubkey, inviteError ? { inviteError } : {}));
    });
    return;
  }
  if (req.url === '/_trust' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { pubkey } = JSON.parse(body);
        const m = members.get(pubkey);
        if (!m || m.via === 'open') members.set(pubkey, { ...(m ?? {}), via: 'invite' });
        send(204);
      } catch {
        send(400, 'invalid');
      }
    });
    return;
  }
  if (req.url === '/_open' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        devPassOpen = JSON.parse(body).on === true;
        send(204);
      } catch {
        send(400, 'invalid');
      }
    });
    return;
  }
  if (req.url === '/_members' && req.method === 'GET') {
    return send(200, JSON.stringify([...members].map(([pubkey, m]) => ({ pubkey, ...m }))), 'application/json');
  }
  if (req.url === '/report' && req.method === 'POST') {
    let body = '';
    req.setEncoding('utf8'); // attached messages can be long Japanese text, split across chunks
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (status, obj) => send(status, JSON.stringify(obj), 'application/json');
      const reporter = nip98(req, body, '/report');
      if (!reporter) return json(401, { error: 'auth-required' });
      let r;
      try {
        r = JSON.parse(body);
      } catch {
        return json(400, { error: 'invalid json' });
      }
      const m = members.get(reporter);
      if (!m) return json(403, { error: 'restricted: register first (POST /register)' });
      if (m.banned) return json(403, { error: 'blocked' });
      const why = reportError(r);
      if (why) return json(400, { error: why });
      if (r.pubkey === reporter) return json(400, { error: 'invalid: cannot report yourself' });
      // 20 a day per reporter, one a day about the same key.
      const today = reports.filter((x) => x.reporter === reporter && x.at > Date.now() / 1000 - 86400);
      if (today.length >= 20 || today.some((x) => x.reported === r.pubkey)) return json(429, { error: 'rate-limited: too many reports' });
      const messages = r.messages?.length ? r.messages.map(({ text, at }) => ({ text, at })) : null;
      reports.push({ reporter, reported: r.pubkey, reason: r.reason, messages, at: Math.floor(Date.now() / 1000) });
      send(204);
    });
    return;
  }
  if (req.url === '/_reports' && req.method === 'GET') return send(200, JSON.stringify(reports), 'application/json');
  if (req.url === '/_crashes' && req.method === 'GET') return send(200, JSON.stringify(crashes), 'application/json');
  // Web Push, like relay.tegami.chat: a public key, and registrations signed with NIP-98.
  // Registered devices are listed at GET /_push for tests (no push is sent).
  if (req.url === '/push/key' && req.method === 'GET') {
    return send(200, JSON.stringify({ key: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url') }), 'application/json');
  }
  if (req.url === '/_push' && req.method === 'GET') return send(200, JSON.stringify(pushDevices), 'application/json');
  if (req.url === '/push' && (req.method === 'POST' || req.method === 'DELETE')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const ev = JSON.parse(Buffer.from((req.headers.authorization ?? '').replace(/^Nostr /, ''), 'base64').toString());
        const tag = (n) => ev.tags.find((t) => t[0] === n)?.[1];
        const hash = createHash('sha256').update(body).digest('hex');
        const ok = ev.kind === 27235 && verifyEvent(ev) && tag('u') === `http://localhost:${PORT}/push` && tag('method') === req.method && tag('payload') === hash;
        if (!ok) return send(401, 'auth-required');
        const { endpoint, keys } = JSON.parse(body);
        const rest = pushDevices.filter((d) => d.endpoint !== endpoint || d.pubkey !== ev.pubkey); // one row per address and key, like the real relay
        pushDevices.length = 0;
        pushDevices.push(...rest);
        if (req.method === 'POST') pushDevices.push({ endpoint, pubkey: ev.pubkey, keys });
        send(204);
      } catch {
        send(400, 'invalid');
      }
    });
    return;
  }
  // Recovery backups. GET /_backups lists them for tests.
  if (req.url === '/_backups' && req.method === 'GET') {
    return send(200, JSON.stringify([...backups].map(([id, b]) => ({ id, ...b }))), 'application/json');
  }
  const backup = req.url.match(/^\/backup\/([0-9a-f]{64})$/);
  if (backup && req.method === 'GET') {
    const b = backups.get(backup[1]);
    return b ? send(200, b.data, 'application/json') : send(404, 'not found');
  }
  if (backup && (req.method === 'PUT' || req.method === 'DELETE')) {
    const id = backup[1];
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (Buffer.byteLength(body) > MAX_BACKUP_BYTES) return send(413, 'too large');
      let ev;
      try {
        ev = JSON.parse(Buffer.from((req.headers.authorization ?? '').replace(/^Nostr /, ''), 'base64').toString());
      } catch {
        return send(401, 'auth-required');
      }
      const tag = (n) => ev?.tags?.find((t) => t[0] === n)?.[1];
      const hash = createHash('sha256').update(body).digest('hex');
      const ok = ev?.kind === 27235 && verifyEvent(ev) && tag('u') === `http://localhost:${PORT}/backup/${id}` && tag('method') === req.method && tag('payload') === hash;
      if (!ok) return send(401, 'auth-required');
      const old = backups.get(id);
      if (old && old.pubkey !== ev.pubkey) return send(403, 'restricted');
      if (req.method === 'DELETE') {
        if (!old) return send(404, 'not found');
        backups.delete(id);
        return send(204);
      }
      if (!body) return send(400, 'invalid');
      if (!old && req.headers['if-match'] === '*') return send(412, 'gone');
      backups.set(id, { pubkey: ev.pubkey, data: body });
      send(204);
    });
    return;
  }
  // Tests: drop every connection, like a phone that puts the browser in the background.
  if (req.url === '/_drop' && req.method === 'POST') {
    for (const c of wss.clients) c.terminate();
    return send(204);
  }
  if (req.url === '/upload' && req.method === 'PUT') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      let auth;
      try {
        auth = JSON.parse(Buffer.from((req.headers.authorization ?? '').replace(/^Nostr /, ''), 'base64').toString());
      } catch {
        return send(401, 'auth-required');
      }
      const hash = createHash('sha256').update(body).digest('hex');
      const ok = auth?.kind === 24242 && verifyEvent(auth) && auth.tags.some((t) => t[0] === 'x' && t[1] === hash);
      if (!ok) return send(401, 'auth-required');
      if (!members.has(auth.pubkey) || members.get(auth.pubkey).banned) return send(403, 'restricted: register first');
      files.set(hash, body);
      send(200, JSON.stringify({ url: `http://localhost:${PORT}/${hash}`, sha256: hash, size: body.length }), 'application/json');
    });
    return;
  }
  send(200, 'dev relay');
});
http.listen(PORT);
const wss = new WebSocketServer({ server: http });
wss.on('connection', (ws) => {
  subs.set(ws, new Map());
  // Like relay.tegami.chat: log in first (NIP-42), or reading and writing are refused.
  const challenge = randomBytes(16).toString('hex');
  let pubkey = null;
  ws.send(JSON.stringify(['AUTH', challenge]));
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const [type] = msg;
    if (type === 'AUTH') {
      const ev = msg[1];
      const ok = ev?.kind === 22242 && verifyEvent(ev) && ev.tags.some((t) => t[0] === 'challenge' && t[1] === challenge);
      if (ok) pubkey = ev.pubkey;
      ws.send(JSON.stringify(['OK', ev?.id ?? '', ok, ok ? '' : 'auth-required: invalid auth event']));
      return;
    }
    if (!pubkey) {
      if (type === 'EVENT') ws.send(JSON.stringify(['OK', msg[1]?.id ?? '', false, 'auth-required: log in first']));
      if (type === 'REQ') ws.send(JSON.stringify(['CLOSED', msg[1], 'auth-required: log in first']));
      return;
    }
    if (type === 'EVENT') {
      const ev = msg[1];
      if (!ev || !verifyEvent(ev)) {
        ws.send(JSON.stringify(['OK', ev?.id ?? '', false, 'invalid: bad signature']));
        return;
      }
      if (expired(ev)) {
        ws.send(JSON.stringify(['OK', ev.id, false, 'invalid: expired']));
        return;
      }
      const writer = members.get(pubkey);
      if (!writer) {
        ws.send(JSON.stringify(['OK', ev.id, false, 'restricted: register first (POST /register)']));
        return;
      }
      if (writer.banned) {
        ws.send(JSON.stringify(['OK', ev.id, false, 'blocked: this key is stopped']));
        return;
      }
      if (!events.some((e) => e.id === ev.id)) {
        events.push(ev);
        if (writer.via === 'open') openIds.add(ev.id);
        for (const [client, clientSubs] of subs) {
          for (const [subId, filters] of clientSubs) {
            if (filters.some((f) => matches(f, ev))) client.send(JSON.stringify(['EVENT', subId, deliver(ev)]));
          }
        }
      }
      ws.send(JSON.stringify(['OK', ev.id, true, '']));
    } else if (type === 'REQ') {
      const [, subId, ...filters] = msg;
      subs.get(ws).set(subId, filters);
      const seen = new Set();
      for (const f of filters) {
        let found = events.filter((e) => matches(f, e)).sort((a, b) => b.created_at - a.created_at);
        if (f.limit) found = found.slice(0, f.limit);
        for (const e of found) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          ws.send(JSON.stringify(['EVENT', subId, deliver(e)]));
        }
      }
      ws.send(JSON.stringify(['EOSE', subId]));
    } else if (type === 'CLOSE') {
      subs.get(ws).delete(msg[1]);
    }
  });
  ws.on('close', () => subs.delete(ws));
});

console.log(`dev relay listening on ws://localhost:${PORT}`);
