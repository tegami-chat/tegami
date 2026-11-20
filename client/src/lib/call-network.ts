// How calls reach the other side (philosophy #27 freedom from the platform, #29 the user chooses).
//
// Two settings, per account, kept on this device only:
//
// - relayOnly: every call goes through a TURN server (RTCPeerConnection iceTransportPolicy
//   'relay'). The browser then gathers no host or STUN candidates, so the other side never
//   learns my IP address, only the relay's. When no TURN server is available, the call does
//   not fall back to a direct path: it ends, because falling back would show the address.
//
// - own: a TURN server the person runs or picked (coturn, a company's server). While it is
//   set, calls use only that server: the app asks neither the Tegami relay for Cloudflare
//   TURN credentials nor stun.cloudflare.com. The password stays on this device.
//
// The media is encrypted end to end either way (DTLS-SRTP); a TURN server forwards packets it
// cannot read, but it sees both IP addresses, when the call happened and how much went through.

import { useSyncExternalStore } from 'react';

import { onSealedChange } from './at-rest';
import { k, load, rawOf, save } from './storage';

export type OwnTurn = { url: string; username: string; credential: string };
export type CallNetwork = { relayOnly: boolean; own: OwnTurn | null };

const KEY = () => k('callNetwork');
const EMPTY: CallNetwork = { relayOnly: false, own: null };

let cache: { key: string; raw: string | null; value: CallNetwork } | null = null;
const listeners = new Set<() => void>();

function clean(v: unknown): CallNetwork {
  const o = (v ?? {}) as Partial<CallNetwork>;
  const own = o.own && typeof o.own === 'object' ? (o.own as Partial<OwnTurn>) : null;
  return {
    relayOnly: o.relayOnly === true,
    own:
      own && typeof own.url === 'string' && isTurnUrl(own.url)
        ? { url: own.url, username: String(own.username ?? ''), credential: String(own.credential ?? '') }
        : null,
  };
}

export function getCallNetwork(): CallNetwork {
  const key = KEY();
  // Kept encrypted (lib/at-rest.ts): read again when the stored text changed, e.g. once the account has opened.
  const raw = rawOf(key);
  if (!cache || cache.key !== key || cache.raw !== raw) cache = { key, raw, value: clean(load(key, EMPTY)) };
  return cache.value;
}

function put(value: CallNetwork) {
  const key = KEY();
  save(key, value);
  cache = { key, raw: rawOf(key), value };
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  // Another tab of the same browser changed it (sealed names do not raise the storage event).
  const offSealed = onSealedChange(() => {
    cache = null;
    l();
  });
  // Another tab of the same account changed it.
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY()) {
      cache = null;
      l();
    }
  };
  globalThis.addEventListener?.('storage', onStorage as EventListener);
  return () => {
    listeners.delete(l);
    offSealed();
    globalThis.removeEventListener?.('storage', onStorage as EventListener);
  };
}

export function useCallNetwork(): CallNetwork {
  return useSyncExternalStore(subscribe, getCallNetwork, getCallNetwork);
}

export function setRelayOnly(on: boolean) {
  put({ ...getCallNetwork(), relayOnly: on });
}

export function setOwnTurn(own: OwnTurn | null) {
  put({ ...getCallNetwork(), own });
}

/** turn: or turns: followed by a host (and maybe a port and ?transport=). */
export function isTurnUrl(url: string) {
  return /^turns?:[^\s/?#]+(\?transport=(udp|tcp))?$/i.test(url.trim());
}

/**
 * The ICE servers for my own TURN server. A turn: address also answers STUN on the same host
 * and port (coturn does), so a direct path can still be found without asking anyone else.
 */
export function ownServers(own: OwnTurn): RTCIceServer[] {
  const url = own.url.trim();
  const servers: RTCIceServer[] = [{ urls: [url], username: own.username, credential: own.credential }];
  const m = /^turn:([^?]+)/i.exec(url);
  if (m) servers.unshift({ urls: [`stun:${m[1]}`] });
  return servers;
}

/** Whether a list of ICE servers has a TURN server with credentials (relayOnly needs one). */
export function hasTurn(servers: RTCIceServer[]) {
  return servers.some((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some((u) => /^turns?:/i.test(u)) && typeof s.username === 'string';
  });
}

/**
 * Tries a TURN server: gathers candidates through it alone and waits for a relay candidate.
 * True when the server handed out a relay address within `ms`.
 */
export async function tryTurn(own: OwnTurn, ms = 8000): Promise<boolean> {
  if (typeof globalThis.RTCPeerConnection !== 'function' || !isTurnUrl(own.url)) return false;
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: [own.url.trim()], username: own.username, credential: own.credential }],
    iceTransportPolicy: 'relay',
  });
  try {
    pc.createDataChannel('try');
    const found = new Promise<boolean>((done) => {
      const timer = setTimeout(() => done(false), ms);
      pc.onicecandidate = (e) => {
        if (e.candidate && / typ relay /.test(` ${e.candidate.candidate} `)) {
          clearTimeout(timer);
          done(true);
        } else if (!e.candidate) {
          clearTimeout(timer);
          done(false);
        }
      };
    });
    await pc.setLocalDescription(await pc.createOffer());
    return await found;
  } catch {
    return false;
  } finally {
    pc.close();
  }
}
