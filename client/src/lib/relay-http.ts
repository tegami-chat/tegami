// HTTP requests to the Tegami relay, signed with the person's Nostr key (NIP-98).
// Used for notifications (/push) and the recovery backup (/backup/<id>).

import { finalizeEvent } from 'nostr-tools/pure';

import { RELAYS } from './tegami';

/** The relay's HTTP address (wss://relay.tegami.chat → https://relay.tegami.chat). A function: tegami.tsx imports this file. */
export const relayHttp = () => RELAYS[0].replace(/^ws/, 'http');

export async function sha256hex(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Sends `body` to `path` on the relay with a NIP-98 Authorization header signed by `secret`. */
export async function signedFetch(method: 'POST' | 'PUT' | 'DELETE', path: string, body: string, secret: Uint8Array, headers: Record<string, string> = {}) {
  const url = `${relayHttp()}${path}`;
  const ev = finalizeEvent(
    { kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['u', url], ['method', method], ['payload', await sha256hex(body)]] },
    secret,
  );
  return fetch(url, { method, headers: { ...headers, 'Content-Type': 'application/json', Authorization: `Nostr ${btoa(JSON.stringify(ev))}` }, body });
}
