import * as nip17 from 'nostr-tools/nip17';
import * as nip19 from 'nostr-tools/nip19';
import * as nip59 from 'nostr-tools/nip59';
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { createDeviceVault, deviceVaultAvailable, openDeviceVault, type DeviceVault } from './device-vault';
import { load, save } from './storage';
import { createVault, unlockVault, type Vault } from './vault';

// Tegami relays. In development: the relay in app/relay started with `npm run dev`.
const RELAYS = (process.env.EXPO_PUBLIC_TEGAMI_RELAYS ?? 'wss://relay.tegami.chat').split(',');

export type Message = {
  id: string;
  from: string; // hex pubkey of the author
  peer: string; // hex pubkey of the other person in this 1:1 chat
  text: string;
  at: number; // unix seconds
};

/** model: for an AI friend, which company's which model (always shown, philosophy #93). */
export type Contact = { pubkey: string; name: string; model?: string };

// Legacy, unprotected account. Moved into a device vault on first load;
// still used only when this browser has no IndexedDB or Web Crypto.
type PlainAccount = { secretHex: string };

export type Status = 'loading' | 'new' | 'locked' | 'open';

type TegamiState = {
  status: Status;
  me: string | null; // hex pubkey
  protectedByPasskey: boolean;
  npub: string | null;
  contacts: Contact[];
  messages: Message[];
  /** My own name, shared through my invite link. Stays on this device otherwise. */
  myName: string;
  setMyName: (name: string) => void;
  /** Creates a key protected by a new passkey. Throws PasskeyUnsupportedError when not possible. */
  start: () => Promise<void>;
  /** Creates a key kept on this device only (no passkey can protect it). */
  startWithoutPasskey: () => Promise<void>;
  /** Asks for the passkey and opens the account. */
  unlock: () => Promise<void>;
  addContact: (pubkey: string, name: string, model?: string) => void;
  send: (peer: string, text: string) => Promise<void>;
};

const Ctx = createContext<TegamiState | null>(null);

export function useTegami() {
  const value = useContext(Ctx);
  if (!value) throw new Error('useTegami must be used inside TegamiProvider');
  return value;
}

// Invite links: https://app.tegami.chat/i#<npub>&n=<name>
// Everything sits after '#', so the key and the name never reach any server.
export const APP_ORIGIN = 'https://app.tegami.chat';

export function inviteLink(npub: string, name: string) {
  const n = name.trim();
  return `${APP_ORIGIN}/i#${npub}${n ? `&n=${encodeURIComponent(n)}` : ''}`;
}

// An invite opened through /i, waiting for the add screen. Kept in memory only.
let pendingInvite = '';
export function setPendingInvite(text: string) {
  pendingInvite = text;
}
export function takePendingInvite() {
  const text = pendingInvite;
  pendingInvite = '';
  return text;
}

function inviteParam(input: string, key: string): string {
  const m = input.match(new RegExp(`[#&]${key}=([^&\\s]*)`));
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]).slice(0, 60);
  } catch {
    return '';
  }
}

/** Reads the name carried by an invite link, if any. */
export function inviteName(input: string): string {
  return inviteParam(input, 'n').slice(0, 40);
}

/** Reads the AI model carried by an AI friend's invite link, if any. */
export function inviteModel(input: string): string {
  return inviteParam(input, 'm');
}

/** A short, stable label for someone who is not in my contacts. */
export function shortId(pubkey: string) {
  const npub = nip19.npubEncode(pubkey);
  return `${npub.slice(0, 9)}…${npub.slice(-4)}`;
}

/** People who wrote to me but are not in my contacts, newest first. */
export function strangers(contacts: Contact[], messages: Message[]) {
  const known = new Set(contacts.map((c) => c.pubkey));
  const last = new Map<string, Message>();
  for (const m of messages) if (!known.has(m.peer)) last.set(m.peer, m);
  return [...last.entries()].map(([peer, m]) => ({ peer, last: m })).sort((a, b) => b.last.at - a.last.at);
}

/** Accepts an npub, a hex pubkey or an invite link that contains an npub. */
export function parsePubkey(input: string): string | null {
  const text = input.trim();
  const npub = text.match(/npub1[02-9ac-hj-np-z]+/)?.[0];
  if (npub) {
    try {
      const decoded = nip19.decode(npub);
      return decoded.type === 'npub' ? decoded.data : null;
    } catch {
      return null;
    }
  }
  return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

export function TegamiProvider({ children }: { children: React.ReactNode }) {
  const [secret, setSecret] = useState<Uint8Array | null>(null);
  const [vault, setVault] = useState<Vault | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [myName, setMyNameState] = useState('');
  const [loaded, setLoaded] = useState(false);
  const pool = useRef<SimplePool | null>(null);
  const authRef = useRef<((t: EventTemplate) => Promise<ReturnType<typeof finalizeEvent>>) | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const v = load<Vault | null>('tegami.vault', null);
      const device = load<DeviceVault | null>('tegami.device', null);
      const plain = load<PlainAccount | null>('tegami.account', null);
      let sk: Uint8Array | null = null;
      if (!v && device) {
        try {
          sk = await openDeviceVault(device);
        } catch {
          // The device key is gone (site data partly cleared). Nothing can open this account.
          sk = null;
        }
      } else if (!v && plain) {
        sk = hexToBytes(plain.secretHex);
        if (deviceVaultAvailable()) {
          try {
            save('tegami.device', await createDeviceVault(sk as Uint8Array<ArrayBuffer>));
            globalThis.localStorage?.removeItem('tegami.account');
          } catch {
            // Keep the legacy record; try again next time.
          }
        }
      }
      if (!alive) return;
      setVault(v);
      if (sk) setSecret(sk);
      setContacts(load<Contact[]>('tegami.contacts', []));
      setMessages(load<Message[]>('tegami.messages', []));
      setMyNameState(load<string>('tegami.myName', ''));
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const status: Status = !loaded ? 'loading' : secret ? 'open' : vault ? 'locked' : 'new';
  const me = useMemo(() => (secret ? getPublicKey(secret) : null), [secret]);

  const addMessage = useCallback((m: Message) => {
    setMessages((prev) => {
      if (prev.some((p) => p.id === m.id)) return prev;
      const next = [...prev, m].sort((a, b) => a.at - b.at);
      save('tegami.messages', next);
      return next;
    });
  }, []);

  // Receive gift-wrapped messages addressed to me.
  useEffect(() => {
    if (!secret || !me) return;
    // The Tegami relay asks every connection to log in (NIP-42) with its key.
    const onauth = async (t: EventTemplate) => finalizeEvent(t, secret);
    authRef.current = onauth;
    const p = new SimplePool({ enableReconnect: true });
    p.automaticallyAuth = () => onauth;
    pool.current = p;
    const sub = p.subscribe(RELAYS, { kinds: [1059], '#p': [me] }, {
      onauth,
      onevent(wrap) {
        try {
          const rumor = nip17.unwrapEvent(wrap, secret);
          if (rumor.kind !== 14) return;
          // The rumor's p tags can include the sender, so skip my own key.
          const to = rumor.tags.find((t) => t[0] === 'p' && t[1] !== me)?.[1];
          const peer = rumor.pubkey === me ? to : rumor.pubkey;
          if (!peer) return;
          addMessage({ id: rumor.id, from: rumor.pubkey, peer, text: rumor.content, at: rumor.created_at });
        } catch {
          // Not for us or malformed. Ignore.
        }
      },
    });
    return () => {
      sub.close();
      p.destroy();
      pool.current = null;
    };
  }, [secret, me, addMessage]);

  const start = useCallback(async () => {
    const sk = generateSecretKey();
    const v = await createVault(sk as Uint8Array<ArrayBuffer>);
    save('tegami.vault', v);
    setVault(v);
    setSecret(sk);
  }, []);

  const startWithoutPasskey = useCallback(async () => {
    const sk = generateSecretKey();
    if (deviceVaultAvailable()) save('tegami.device', await createDeviceVault(sk as Uint8Array<ArrayBuffer>));
    else save('tegami.account', { secretHex: bytesToHex(sk) });
    setSecret(sk);
  }, []);

  const unlock = useCallback(async () => {
    if (!vault) return;
    setSecret(await unlockVault(vault));
  }, [vault]);

  const setMyName = useCallback((name: string) => {
    const n = name.slice(0, 40);
    save('tegami.myName', n);
    setMyNameState(n);
  }, []);

  const addContact = useCallback((pubkey: string, name: string, model?: string) => {
    setContacts((prev) => {
      const old = prev.find((c) => c.pubkey === pubkey);
      const rest = prev.filter((c) => c.pubkey !== pubkey);
      const m = model ?? old?.model;
      const next = [...rest, m ? { pubkey, name, model: m } : { pubkey, name }];
      save('tegami.contacts', next);
      return next;
    });
  }, []);

  const send = useCallback(
    async (peer: string, text: string) => {
      if (!secret || !me || !pool.current) return;
      // One rumor (kind 14) addressed to the peer, sealed and wrapped twice:
      // once for the peer and once for myself, so my other devices see it too.
      // (nip17.wrapManyEvents gives the self copy a different rumor without the peer's p tag.)
      const rumor = nip59.createRumor(
        { kind: 14, content: text, tags: [['p', peer]], created_at: Math.floor(Date.now() / 1000) },
        secret,
      );
      const wraps = [peer, me].map((to) => nip59.createWrap(nip59.createSeal(rumor, secret, to), to));
      await Promise.any(wraps.flatMap((w) => pool.current!.publish(RELAYS, w, { onauth: authRef.current ?? undefined })));
      addMessage({ id: rumor.id, from: me, peer, text, at: rumor.created_at });
    },
    [secret, me, addMessage],
  );

  const value: TegamiState = {
    status,
    me,
    protectedByPasskey: !!vault,
    npub: me ? nip19.npubEncode(me) : null,
    contacts,
    messages,
    start,
    startWithoutPasskey,
    unlock,
    addContact,
    myName,
    setMyName,
    send,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
