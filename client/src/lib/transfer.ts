// Moves an account to another device (philosophy #77: phone and computer at the same time).
//
// The old device makes a one-time key T and sends one envelope to T through the Tegami
// relay. The envelope holds the account (Nostr key, my name, contacts, groups), encrypted
// with NIP-44 so only T can open it, and carries a NIP-40 expiration: after 10 minutes
// the relay refuses to hand it out. T's secret travels only inside the link
// (https://app.tegami.chat/link#k=...), after '#', so it never reaches a server.
// The new device logs in to the relay as T, opens the envelope and protects the key
// with its own passkey. Messages of the last 30 days come from the relay as usual.
//
// Anyone who opens the link within those 10 minutes gets the account, so the screen
// that shows it says so.

import * as nip44 from 'nostr-tools/nip44';
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate, type NostrEvent, type VerifiedEvent } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';

import type { Contact, Group } from './tegami';
import { fromB64u, toB64u } from './vault';

export const TRANSFER_SECONDS = 10 * 60;

// Set when this device has just taken over an account through a link, so the /link
// screen sends the person to their chats instead of saying an account is already here.
export const arrival = { moved: false };

// The one-time key from a link (https://app.tegami.chat/link#k=...). Taken out of the
// address bar as soon as the app loads, before the router reads the address, so a
// reload, the history or a shared screen does not keep it.
let linkKey: Uint8Array | null = null;
export function captureLinkKey() {
  if (typeof window === 'undefined' || window.location.pathname !== '/link' || !window.location.hash) return;
  linkKey = transferKey(window.location.hash.slice(1));
  // The router remembered the address when it loaded and writes it back once it has
  // drawn the first screen, so take the key out again after that.
  const strip = () => {
    if (/[#&]k=/.test(window.location.hash)) window.history.replaceState(window.history.state, '', window.location.pathname);
  };
  strip();
  for (const ms of [0, 50, 200, 500, 1000, 2000]) setTimeout(strip, ms);
}
/** Hands the captured key over once. */
export function takeLinkKey() {
  const k = linkKey;
  linkKey = null;
  return k;
}

export type Bundle = { v: 1; secretHex: string; myName: string; contacts: Contact[]; groups: Group[] };

type Auth = (t: EventTemplate) => Promise<VerifiedEvent>;

/** Seals the account for a new one-time key. Returns the envelope and the link part after '#'. */
export function sealTransfer(bundle: Bundle, now = Math.floor(Date.now() / 1000)) {
  const t = generateSecretKey();
  const tPub = getPublicKey(t);
  const sender = generateSecretKey();
  const content = nip44.encrypt(JSON.stringify(bundle), nip44.getConversationKey(sender, tPub));
  const envelope = finalizeEvent(
    { kind: 1059, created_at: now, tags: [['p', tPub], ['expiration', String(now + TRANSFER_SECONDS)]], content },
    sender,
  );
  return { envelope, fragment: `k=${toB64u(t)}`, expiresAt: now + TRANSFER_SECONDS };
}

/** Reads the one-time key from a link or its part after '#'. */
export function transferKey(input: string): Uint8Array | null {
  const m = input.match(/(?:^|[#&])k=([A-Za-z0-9_-]{43})(?:&|$)/);
  if (!m) return null;
  try {
    const k = fromB64u(m[1]);
    return k.length === 32 ? k : null;
  } catch {
    return null;
  }
}

/** Sends the account through the relay. Returns the link to open on the other device. */
export async function sendTransfer(pool: SimplePool, relays: string[], auth: Auth, bundle: Bundle, origin: string) {
  const { envelope, fragment, expiresAt } = sealTransfer(bundle);
  await Promise.any(pool.publish(relays, envelope, { onauth: auth }));
  return { link: `${origin}/link#${fragment}`, expiresAt };
}

export class TransferError extends Error {}

/** On the new device: logs in as the one-time key and opens the account. */
export async function receiveTransfer(relays: string[], key: Uint8Array, waitMs = 8000): Promise<Bundle> {
  const tPub = getPublicKey(key);
  const onauth: Auth = async (t) => finalizeEvent(t, key);
  const pool = new SimplePool();
  pool.automaticallyAuth = () => onauth;
  try {
    const found = await new Promise<NostrEvent | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), waitMs);
      const sub = pool.subscribe(relays, { kinds: [1059], '#p': [tPub] }, {
        onauth,
        onevent(ev) {
          clearTimeout(timer);
          sub.close();
          resolve(ev);
        },
      });
    });
    if (!found) throw new TransferError('not found or expired');
    const exp = Number(found.tags.find((t) => t[0] === 'expiration')?.[1] ?? 0);
    if (exp <= Math.floor(Date.now() / 1000)) throw new TransferError('expired');
    const bundle = cleanBundle(JSON.parse(nip44.decrypt(found.content, nip44.getConversationKey(key, found.pubkey))));
    if (!bundle) throw new TransferError('unknown format');
    return bundle;
  } catch (e) {
    if (e instanceof TransferError) throw e;
    throw new TransferError(String((e as Error)?.message ?? e));
  } finally {
    pool.destroy();
  }
}

/** Checks a bundle that came from outside (a link or a recovery backup). Null when it is not one. */
export function cleanBundle(raw: unknown): Bundle | null {
  const bundle = raw as Bundle;
  if (bundle?.v !== 1 || typeof bundle.secretHex !== 'string' || !/^[0-9a-f]{64}$/.test(bundle.secretHex)) return null;
  try {
    // Make sure the key really is a key before anything is saved.
    getPublicKey(hexToBytes(bundle.secretHex));
  } catch {
    return null;
  }
  return {
    v: 1,
    secretHex: bundle.secretHex,
    myName: String(bundle.myName ?? '').slice(0, 40),
    contacts: Array.isArray(bundle.contacts) ? bundle.contacts : [],
    groups: Array.isArray(bundle.groups) ? bundle.groups : [],
  };
}

export function bundleSecret(bundle: Bundle) {
  return hexToBytes(bundle.secretHex) as Uint8Array<ArrayBuffer>;
}

