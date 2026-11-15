// Where calls look for a path between the two browsers (ICE servers).
//
// STUN (stun.cloudflare.com) tells each browser its public address, which is enough on most
// networks. When both sides sit behind strict NATs, a TURN server has to relay the media.
// The Tegami relay hands a registered key short-lived Cloudflare TURN credentials
// (POST /turn, NIP-98 signed, relay/src/turn.ts). The media stays encrypted end to end
// (DTLS-SRTP): TURN only forwards packets it cannot read.
//
// Credentials last hours (ttl), so one set is kept in memory per account and reused for
// calls until less than an hour is left. When the relay has no TURN set up (503), cannot be
// reached, or is slow, calls go on with STUN only.

import { signedFetch } from './relay-http';

export const STUN: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

/** Credentials are fetched again when less than this is left. */
const KEEP_MARGIN_MS = 60 * 60 * 1000;
/** After a 503 (no TURN on this relay) or an error, do not ask again for this long. */
const RETRY_MS = 10 * 60 * 1000;

type Kept = { pubkey: string; servers: RTCIceServer[] | null; until: number };
let kept: Kept | null = null;
let asking: { pubkey: string; promise: Promise<RTCIceServer[]> } | null = null;

const isUrl = (u: unknown): u is string => typeof u === 'string' && /^(stun|turns?):/.test(u);

/** The ICE servers for a call: STUN plus TURN when the relay hands out credentials. Never throws. */
export function iceServers(secret: Uint8Array, pubkey: string): Promise<RTCIceServer[]> {
  const now = Date.now();
  if (kept && kept.pubkey === pubkey && kept.until > now) return Promise.resolve(kept.servers ?? STUN);
  if (asking && asking.pubkey === pubkey) return asking.promise;
  const promise = (async () => {
    try {
      const res = await signedFetch('POST', '/turn', '{}', secret);
      if (!res.ok) throw new Error(`turn: ${res.status}`);
      const json = (await res.json()) as { iceServers?: unknown; ttl?: unknown };
      const servers = (Array.isArray(json.iceServers) ? json.iceServers : [])
        .map((s): RTCIceServer | null => {
          const e = s as { urls?: unknown; username?: unknown; credential?: unknown };
          const urls = (Array.isArray(e?.urls) ? e.urls : [e?.urls]).filter(isUrl);
          if (!urls.length) return null;
          return typeof e.username === 'string' && typeof e.credential === 'string'
            ? { urls, username: e.username, credential: e.credential }
            : { urls };
        })
        .filter((s): s is RTCIceServer => !!s);
      if (!servers.some((s) => s.username)) throw new Error('turn: no credentials');
      const ttl = typeof json.ttl === 'number' && json.ttl > 0 ? json.ttl * 1000 : 0;
      kept = { pubkey, servers, until: Date.now() + Math.max(0, ttl - KEEP_MARGIN_MS) };
      return servers;
    } catch {
      kept = { pubkey, servers: null, until: Date.now() + RETRY_MS };
      return STUN;
    } finally {
      asking = null;
    }
  })();
  asking = { pubkey, promise };
  return promise;
}

/** Resolves with `p`, or with `fallback` after `ms` (a slow relay must not hold up a call). */
export function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((done) => {
    const timer = setTimeout(() => done(fallback), ms);
    p.then((v) => {
      clearTimeout(timer);
      done(v);
    });
  });
}
