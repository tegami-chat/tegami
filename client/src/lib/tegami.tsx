import * as nip17 from 'nostr-tools/nip17';
import * as nip19 from 'nostr-tools/nip19';
import * as nip59 from 'nostr-tools/nip59';
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { createDeviceVault, deviceVaultAvailable, openDeviceVault, type DeviceVault } from './device-vault';
import { setCrashReports } from './crash';
import { encryptAndUpload, fileFromRumor, fileTags, keepSent, shrinkImage, type FileRef } from './files';
import { load, save } from './storage';
import { bundleSecret, sendTransfer, type Bundle } from './transfer';
import { disablePush, enablePush, type PushState } from './push';
import { SIGNAL_KIND, freshSignal, wrapSignal } from './signal';
import { createVault, unlockVault, type Vault } from './vault';

// Tegami relays. In development: the relay in app/relay started with `npm run dev`.
export const RELAYS = (process.env.EXPO_PUBLIC_TEGAMI_RELAYS ?? 'wss://relay.tegami.chat').split(',');

export type Message = {
  id: string;
  from: string; // hex pubkey of the author
  // The chat this message belongs to: the other participants' hex pubkeys, sorted and
  // joined with ','. For a 1:1 chat that is just the other person's pubkey.
  peer: string;
  text: string;
  at: number; // unix seconds
  /** A photo or file (NIP-17 kind 15). text is empty then. */
  file?: FileRef;
  /** A call, recorded on this device only (never sent). text holds what the chat shows. */
  call?: CallRecord;
};

/** done: we talked. missed: they called, I did not answer. unanswered: I called, no answer. */
export type CallRecord = { video: boolean; result: 'done' | 'missed' | 'unanswered'; seconds?: number };

/** A call signal from someone (or from my other device: from === me). See lib/signal.ts. */
export type Signal = { id: string; from: string; to: string; at: number; data: Record<string, unknown> };

/** model: for an AI friend, which company's which model (always shown, philosophy #93). */
export type Contact = { pubkey: string; name: string; model?: string };

/** A group chat (NIP-17): a fixed set of people. A different set is a different chat. */
export type Group = { id: string; name: string; members: string[] };

/** The chat id for a set of other participants. */
export function roomOf(members: string[]) {
  return [...new Set(members)].sort().join(',');
}
export function isGroup(room: string) {
  return room.includes(',');
}

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
  groups: Group[];
  messages: Message[];
  /** Makes a group with these contacts and returns its chat id. */
  createGroup: (name: string, members: string[]) => string;
  /** My own name, shared through my invite link. Stays on this device otherwise. */
  myName: string;
  setMyName: (name: string) => void;
  /**
   * Creates a key protected by a new passkey. Throws PasskeyUnsupportedError when not possible.
   * With a bundle (an account moved from another device), uses that key, name and contacts.
   */
  start: (moved?: Bundle) => Promise<void>;
  /** Creates a key kept on this device only (no passkey can protect it). */
  startWithoutPasskey: (moved?: Bundle) => Promise<void>;
  /** Sends this account to another device. Returns a 10-minute link to open there. */
  makeTransferLink: () => Promise<{ link: string; expiresAt: number }>;
  /** Asks for the passkey and opens the account. */
  unlock: () => Promise<void>;
  addContact: (pubkey: string, name: string, model?: string) => void;
  send: (peer: string, text: string) => Promise<void>;
  /** Whether crash reports are sent (off unless the person turns it on). */
  crashReports: boolean;
  setCrashReportsOn: (on: boolean) => void;
  /** Everything on this device except the key, as JSON (philosophy #88). */
  exportChats: () => string;
  /** Makes the photo smaller, encrypts it on this device, uploads it and sends it. */
  sendPhoto: (peer: string, photo: Blob) => Promise<void>;
  /** Turns notifications for this device on or off. Returns the new state. */
  setNotifications: (on: boolean) => Promise<PushState>;
  /** Sends a call signal to one person, and to my other devices when alsoMe. */
  sendSignal: (to: string, data: Record<string, unknown>, alsoMe?: boolean) => Promise<void>;
  /** Listens for fresh call signals. Returns the function that stops listening. */
  onSignal: (fn: (s: Signal) => void) => () => void;
  /** Adds a call record to a chat on this device. */
  recordCall: (peer: string, from: string, record: CallRecord, id: string) => void;
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

/** What to call a person: their contact name, or a short id. */
export function personName(pubkey: string, contacts: Contact[]) {
  return contacts.find((c) => c.pubkey === pubkey)?.name ?? shortId(pubkey);
}

/** What to call a chat: the contact, the group's name, or its members' names. */
export function chatName(room: string, contacts: Contact[], groups: Group[]) {
  if (!isGroup(room)) return personName(room, contacts);
  const g = groups.find((x) => x.id === room);
  return g?.name || room.split(',').map((k) => personName(k, contacts)).join('、');
}

/** Chats that are neither a contact nor a group I know, newest first. */
export function strangers(contacts: Contact[], messages: Message[], groups: Group[] = []) {
  const known = new Set([...contacts.map((c) => c.pubkey), ...groups.map((g) => g.id)]);
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
  const [groups, setGroups] = useState<Group[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [myName, setMyNameState] = useState('');
  const [crashReports, setCrashReportsState] = useState(false);
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
      setGroups(load<Group[]>('tegami.groups', []));
      setMessages(load<Message[]>('tegami.messages', []));
      setMyNameState(load<string>('tegami.myName', ''));
      const crash = load<boolean>('tegami.crashReports', false);
      setCrashReportsState(crash);
      setCrashReports(crash);
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const status: Status = !loaded ? 'loading' : secret ? 'open' : vault ? 'locked' : 'new';
  const me = useMemo(() => (secret ? getPublicKey(secret) : null), [secret]);

  const saveGroups = useCallback((update: (prev: Group[]) => Group[]) => {
    setGroups((prev) => {
      const next = update(prev);
      if (next !== prev) save('tegami.groups', next);
      return next;
    });
  }, []);

  // A group shows up in my list when someone I know writes in it (or I made it).
  // Its name follows the latest subject tag. Groups started by strangers stay in
  // the strangers box.
  const contactsRef = useRef<Contact[]>([]);
  contactsRef.current = contacts;
  const groupsRef = useRef<Group[]>([]);
  groupsRef.current = groups;
  const rememberGroup = useCallback(
    (id: string, subject: string | undefined, author: string) => {
      saveGroups((prev) => {
        const known = prev.find((g) => g.id === id);
        if (known) {
          if (!subject || subject === known.name) return prev;
          return prev.map((g) => (g.id === id ? { ...g, name: subject } : g));
        }
        if (author !== me && !contactsRef.current.some((c) => c.pubkey === author)) return prev;
        return [...prev, { id, name: subject ?? '', members: id.split(',') }];
      });
    },
    [me, saveGroups],
  );

  const createGroup = useCallback(
    (name: string, members: string[]) => {
      const id = roomOf(members);
      saveGroups((prev) => [...prev.filter((g) => g.id !== id), { id, name: name.trim().slice(0, 60), members: id.split(',') }]);
      return id;
    },
    [saveGroups],
  );

  // Call signals go to whoever listens (lib/calls.tsx). Each is handled once.
  const signalListeners = useRef(new Set<(s: Signal) => void>());
  const seenSignals = useRef(new Set<string>());
  const onSignal = useCallback((fn: (s: Signal) => void) => {
    signalListeners.current.add(fn);
    return () => {
      signalListeners.current.delete(fn);
    };
  }, []);

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
    const onevent = (wrap: Parameters<typeof nip17.unwrapEvent>[0]) => {
      {
        try {
          const rumor = nip17.unwrapEvent(wrap, secret);
          if (rumor.kind === SIGNAL_KIND) {
            // Late envelopes (delivered again after a reconnect) must not ring.
            if (!freshSignal(rumor.created_at) || seenSignals.current.has(rumor.id)) return;
            seenSignals.current.add(rumor.id);
            const to = rumor.tags.find((t) => t[0] === 'p')?.[1] ?? '';
            const data = JSON.parse(rumor.content);
            if (!data || typeof data !== 'object' || !/^[0-9a-f]{64}$/.test(to)) return;
            for (const fn of signalListeners.current) fn({ id: rumor.id, from: rumor.pubkey, to, at: rumor.created_at, data });
            return;
          }
          if (rumor.kind !== 14 && rumor.kind !== 15) return;
          const file = rumor.kind === 15 ? fileFromRumor(rumor.content, rumor.tags) : undefined;
          if (file === null) return;
          // Everyone in the chat except me: the author and every p tag.
          const others = [rumor.pubkey, ...rumor.tags.filter((t) => t[0] === 'p').map((t) => t[1])].filter(
            (k) => /^[0-9a-f]{64}$/.test(k) && k !== me,
          );
          if (!others.length) return;
          const peer = roomOf(others);
          if (isGroup(peer)) {
            const subject = rumor.tags.find((t) => t[0] === 'subject')?.[1]?.slice(0, 60);
            rememberGroup(peer, subject, rumor.pubkey);
          }
          addMessage(
            file
              ? { id: rumor.id, from: rumor.pubkey, peer, text: '', at: rumor.created_at, file }
              : { id: rumor.id, from: rumor.pubkey, peer, text: rumor.content, at: rumor.created_at },
          );
        } catch {
          // Not for us or malformed. Ignore.
        }
      }
    };

    // Keep receiving. When the connection drops (a phone puts the browser away), the
    // library reconnects and asks again before logging in, the relay refuses, and the
    // subscription ends for good. So whenever it ends, and whenever the app comes back
    // to the screen or the network returns, subscribe again (the pool logs in first).
    let sub: { close: () => void } | null = null;
    let disposed = false;
    let first = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      if (disposed) return;
      clearTimeout(retry);
      const old = sub;
      sub = null;
      old?.close();
      // After the first time, only what is new: envelopes carry a random time up to 2 days back.
      const filter = first ? { kinds: [1059], '#p': [me] } : { kinds: [1059], '#p': [me], since: Math.floor(Date.now() / 1000) - 3 * 86400 };
      first = false;
      const s = p.subscribe(RELAYS, filter, {
        onauth,
        onevent,
        onclose: () => {
          if (disposed || sub !== s) return;
          retry = setTimeout(open, 2000);
        },
      });
      sub = s;
    };
    open();
    const onVisible = () => {
      if (globalThis.document?.visibilityState === 'visible') open();
    };
    globalThis.document?.addEventListener?.('visibilitychange', onVisible);
    globalThis.addEventListener?.('online', open);
    return () => {
      disposed = true;
      clearTimeout(retry);
      globalThis.document?.removeEventListener?.('visibilitychange', onVisible);
      globalThis.removeEventListener?.('online', open);
      sub?.close();
      p.destroy();
      pool.current = null;
    };
  }, [secret, me, addMessage, rememberGroup]);

  // An account moved from another device brings its name, contacts and groups.
  const adopt = useCallback((moved: Bundle) => {
    save('tegami.myName', moved.myName);
    save('tegami.contacts', moved.contacts);
    save('tegami.groups', moved.groups);
    setMyNameState(moved.myName);
    setContacts(moved.contacts);
    setGroups(moved.groups);
  }, []);

  const start = useCallback(
    async (moved?: Bundle) => {
      const sk = moved ? bundleSecret(moved) : generateSecretKey();
      const v = await createVault(sk as Uint8Array<ArrayBuffer>);
      if (moved) adopt(moved);
      save('tegami.vault', v);
      setVault(v);
      setSecret(sk);
    },
    [adopt],
  );

  const startWithoutPasskey = useCallback(
    async (moved?: Bundle) => {
      const sk = moved ? bundleSecret(moved) : generateSecretKey();
      if (deviceVaultAvailable()) save('tegami.device', await createDeviceVault(sk as Uint8Array<ArrayBuffer>));
      else save('tegami.account', { secretHex: bytesToHex(sk) });
      if (moved) adopt(moved);
      setSecret(sk);
    },
    [adopt],
  );

  const makeTransferLink = useCallback(async () => {
    if (!secret || !pool.current || !authRef.current) throw new Error('not open');
    const bundle: Bundle = { v: 1, secretHex: bytesToHex(secret), myName, contacts, groups };
    return sendTransfer(pool.current, RELAYS, authRef.current, bundle, globalThis.location?.origin ?? APP_ORIGIN);
  }, [secret, myName, contacts, groups]);

  const unlock = useCallback(async () => {
    if (!vault) return;
    setSecret(await unlockVault(vault));
  }, [vault]);

  const setCrashReportsOn = useCallback((on: boolean) => {
    save('tegami.crashReports', on);
    setCrashReportsState(on);
    setCrashReports(on);
  }, []);

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

  /** Sends one rumor to everyone in the chat. Returns its id. */
  const deliver = useCallback(
    async (peer: string, kind: 14 | 15, content: string, extra: string[][] = []) => {
      if (!secret || !me || !pool.current) throw new Error('not open');
      // One rumor with a p tag for everyone in the chat, sealed and wrapped once
      // per person and once for myself, so my other devices see it too.
      // (nip17.wrapManyEvents gives the self copy a different rumor without the p tags.)
      const members = peer.split(',');
      const tags = members.map((m) => ['p', m]);
      const subject = groupsRef.current.find((g) => g.id === peer)?.name;
      if (isGroup(peer) && subject) tags.push(['subject', subject]);
      tags.push(...extra);
      const rumor = nip59.createRumor({ kind, content, tags, created_at: Math.floor(Date.now() / 1000) }, secret);
      const wraps = [...members, me].map((to) => nip59.createWrap(nip59.createSeal(rumor, secret, to), to));
      await Promise.any(wraps.flatMap((w) => pool.current!.publish(RELAYS, w, { onauth: authRef.current ?? undefined })));
      return rumor;
    },
    [secret, me],
  );

  const send = useCallback(
    async (peer: string, text: string) => {
      const rumor = await deliver(peer, 14, text);
      addMessage({ id: rumor.id, from: me!, peer, text, at: rumor.created_at });
    },
    [deliver, me, addMessage],
  );

  const sendPhoto = useCallback(
    async (peer: string, photo: Blob) => {
      if (!secret) throw new Error('not open');
      const small = await shrinkImage(photo);
      const file = await encryptAndUpload(small.bytes, small.type, secret, `${small.width}x${small.height}`);
      const rumor = await deliver(peer, 15, file.url, fileTags(file));
      await keepSent(rumor.id, small.bytes, small.type);
      addMessage({ id: rumor.id, from: me!, peer, text: '', at: rumor.created_at, file });
    },
    [secret, deliver, me, addMessage],
  );

  const sendSignal = useCallback(
    async (to: string, data: Record<string, unknown>, alsoMe = false) => {
      if (!secret || !me || !pool.current) throw new Error('not open');
      const rumor = nip59.createRumor(
        { kind: SIGNAL_KIND, content: JSON.stringify(data), tags: [['p', to]], created_at: Math.floor(Date.now() / 1000) },
        secret,
      );
      // My own signals coming back to this device are not for me.
      seenSignals.current.add(rumor.id);
      const wraps = (alsoMe ? [to, me] : [to]).map((k) => wrapSignal(rumor, secret, k));
      await Promise.any(wraps.flatMap((w) => pool.current!.publish(RELAYS, w, { onauth: authRef.current ?? undefined })));
    },
    [secret, me],
  );

  const recordCall = useCallback(
    (peer: string, from: string, record: CallRecord, id: string) => {
      addMessage({ id: `call:${id}`, from, peer, text: callText(record), at: Math.floor(Date.now() / 1000), call: record });
    },
    [addMessage],
  );

  const setNotifications = useCallback(
    async (on: boolean) => {
      if (!secret) throw new Error('not open');
      return on ? enablePush(secret) : disablePush(secret);
    },
    [secret],
  );

  const value: TegamiState = {
    setNotifications,
    sendSignal,
    onSignal,
    recordCall,
    status,
    me,
    protectedByPasskey: !!vault,
    npub: me ? nip19.npubEncode(me) : null,
    contacts,
    groups,
    createGroup,
    messages,
    start,
    startWithoutPasskey,
    makeTransferLink,
    unlock,
    addContact,
    myName,
    setMyName,
    send,
    sendPhoto,
    crashReports,
    setCrashReportsOn,
    exportChats: () =>
      JSON.stringify(
        {
          app: 'Tegami',
          format: 1,
          exported_at: new Date().toISOString(),
          me: me ? nip19.npubEncode(me) : null,
          my_name: myName,
          contacts,
          groups,
          messages,
        },
        null,
        2,
      ),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** What a call record says in the chat. */
export function callText(r: CallRecord) {
  if (r.result === 'missed') return '不在着信';
  if (r.result === 'unanswered') return '応答なし';
  return `${r.video ? 'ビデオ通話' : '音声通話'} ${clock(r.seconds ?? 0)}`;
}

/** 75 -> "1:15", 3725 -> "1:02:05" */
export function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
