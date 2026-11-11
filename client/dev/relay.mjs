// A tiny Nostr relay for local development only.
// Keeps events in memory. Run: npm run relay  (listens on ws://localhost:7447)
import { WebSocketServer } from 'ws';
import { verifyEvent } from 'nostr-tools/pure';

const PORT = Number(process.env.PORT || 7447);
const events = [];
const subs = new Map(); // ws -> Map(subId -> filters[])

function matches(filter, ev) {
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

const wss = new WebSocketServer({ port: PORT });
wss.on('connection', (ws) => {
  subs.set(ws, new Map());
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const [type] = msg;
    if (type === 'EVENT') {
      const ev = msg[1];
      if (!ev || !verifyEvent(ev)) {
        ws.send(JSON.stringify(['OK', ev?.id ?? '', false, 'invalid: bad signature']));
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
