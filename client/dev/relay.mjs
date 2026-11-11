// A tiny Nostr relay for local development only.
// Keeps events and uploaded files in memory. Run: npm run relay  (listens on ws://localhost:7447)
// Files: PUT /upload and GET /<sha256> on the same port, like relay.tegami.chat (Blossom).
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
const crashes = [];
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-SHA-256',
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
  if (req.url === '/_crashes' && req.method === 'GET') return send(200, JSON.stringify(crashes), 'application/json');
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
      if (!events.some((e) => e.id === ev.id)) {
        events.push(ev);
        for (const [client, clientSubs] of subs) {
          for (const [subId, filters] of clientSubs) {
            if (filters.some((f) => matches(f, ev))) client.send(JSON.stringify(['EVENT', subId, ev]));
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
          ws.send(JSON.stringify(['EVENT', subId, e]));
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
