import * as nip17 from 'nostr-tools/nip17';
import * as nip19 from 'nostr-tools/nip19';
import * as nip59 from 'nostr-tools/nip59';
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { describeAccount } from './accounts';
import { clearNewMark } from './sw-store';
import { createDeviceVault, deviceVaultAvailable, openDeviceVault, type DeviceVault } from './device-vault';
import { setCrashReports } from './crash';
import { encryptAndUpload, fileFromRumor, fileTags, forgetFile, keepSent, keptFile, shrinkImage, type FileRef } from './files';
import { backoff, loadOutbox, publishOne, saveOutbox, type Outgoing } from './outbox';
import { k, load, remove, save } from './storage';
import { bundleSecret, sendTransfer, type Bundle } from './transfer';
import { disablePush, enablePush, refreshPush, type PushState } from './push';
import { SIGNAL_KIND, freshSignal, wrapSignal } from './signal';
import { BackupGoneError, type BackupRef, clearLocal, deleteBackup, deriveKeys, loadLocal, makeCode, putBackup, recoveryOnHere, saveLocal, takeRestoredKeys } from './recovery';
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
  /** When this device received it (ms). Only for messages from others. */
  got?: number;
  /** My message not yet accepted by the relay: being sent now, or waiting for the connection. */
  pending?: 'sending' | 'unsent';
  /** The id of the message this one replies to (NIP-17 `e` tag). It may not be on this device. */
  replyTo?: string;
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

/** Failed backup refreshes in a row (across app starts) before settings says so. */
const RECOVERY_FAILURES_SHOWN = 3;

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
  /** Sends a text message, as a reply to the message with id replyTo when given. */
  send: (peer: string, text: string, replyTo?: string) => Promise<void>;
  /** Whether crash reports are sent (off unless the person turns it on). */
  crashReports: boolean;
  setCrashReportsOn: (on: boolean) => void;
  /** Everything on this device except the key, as JSON (philosophy #88). */
  exportChats: () => string;
  /** Makes the photo smaller, encrypts it on this device, uploads it and sends it. */
  sendPhoto: (peer: string, photo: Blob, replyTo?: string) => Promise<void>;
  /** Turns notifications for this device on or off. Returns the new state. */
  setNotifications: (on: boolean) => Promise<PushState>;
  /** Sends a call signal to one person, and to my other devices when alsoMe. */
  sendSignal: (to: string, data: Record<string, unknown>, alsoMe?: boolean) => Promise<void>;
  /** Listens for fresh call signals. Returns the function that stops listening. */
  onSignal: (fn: (s: Signal) => void) => () => void;
  /** Adds a call record to a chat on this device. */
  recordCall: (peer: string, from: string, record: CallRecord, id: string) => void;
  /** Whether this device keeps a recovery backup on the relay up to date. */
  recoveryOn: boolean;
  /** Makes a new recovery code and uploads the backup; an earlier code stops working. Returns the code (shown once). */
  makeRecoveryCode: () => Promise<string>;
  /** Deletes the backup from the relay and turns recovery off. */
  turnOffRecovery: () => Promise<void>;
  /** The backup has not been refreshed for several tries in a row (offline, relay refused). */
  recoveryBehind: boolean;
  /** Unread messages per chat id (only chats with some). Empty when counts are hidden. */
  unread: Record<string, number>;
  /** Whether unread counts are shown (philosophy #112: the person's choice, on by default). */
  showUnread: boolean;
  setShowUnread: (on: boolean) => void;
  /** Marks a chat as read up to now. Stays on this device; nothing is sent (philosophy #17). */
  markRead: (peer: string) => void;
  /** Stops sending a message that is still waiting, and removes it from this device. */
  cancelSend: (id: string) => void;
  /** Tries to send what is waiting now, without waiting for the next automatic try. */
  retrySend: () => void;
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

/**
 * Unread messages per chat: from someone else, received after the chat was last read.
 * My own messages (also from my other devices) never count; of call records only missed calls.
 * Messages written before this device's account was set up (brought back from the relay
 * after moving to a new device) count as read. readAt and got are ms, setupAt is unix seconds.
 */
export function countUnread(messages: Message[], me: string | null, readAt: Record<string, number>, setupAt: number) {
  const out: Record<string, number> = {};
  for (const m of messages) {
    if (m.from === me || m.at < setupAt) continue;
    if (m.call && m.call.result !== 'missed') continue;
    if ((m.got ?? m.at * 1000) <= (readAt[m.peer] ?? 0)) continue;
    out[m.peer] = (out[m.peer] ?? 0) + 1;
  }
  return out;
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
  const [recoveryOn, setRecoveryOn] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [readAt, setReadAt] = useState<Record<string, number>>({});
  const [setupAt, setSetupAt] = useState(0);
  const [showUnread, setShowUnreadState] = useState(true);
  const pool = useRef<SimplePool | null>(null);
  const authRef = useRef<((t: EventTemplate) => Promise<ReturnType<typeof finalizeEvent>>) | null>(null);
  const outbox = useRef<Outgoing[]>([]);
  const flushRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let alive = true;
    (async () => {
      const v = load<Vault | null>(k('vault'), null);
      const device = load<DeviceVault | null>(k('device'), null);
      const plain = load<PlainAccount | null>(k('account'), null);
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
            save(k('device'), await createDeviceVault(sk as Uint8Array<ArrayBuffer>));
            remove(k('account'));
          } catch {
            // Keep the legacy record; try again next time.
          }
        }
      }
      if (!alive) return;
      setVault(v);
      if (sk) setSecret(sk);
      setContacts(load<Contact[]>(k('contacts'), []));
      setGroups(load<Group[]>(k('groups'), []));
      // Messages waiting to be sent: the outbox is what counts. A message still marked as
      // being sent when the app closed is now waiting; a mark without an outbox entry is stale.
      const box = loadOutbox();
      const stored = load<Message[]>(k('messages'), []);
      const ids = new Set(stored.map((m) => m.id));
      outbox.current = box.filter((o) => ids.has(o.id));
      if (outbox.current.length !== box.length) saveOutbox(outbox.current);
      const waiting = new Set(outbox.current.map((o) => o.id));
      setMessages(
        stored.map((m) => {
          if (waiting.has(m.id)) return m.pending === 'unsent' ? m : { ...m, pending: 'unsent' };
          if (!m.pending) return m;
          const { pending: _, ...rest } = m;
          return rest;
        }),
      );
      setReadAt(load<Record<string, number>>(k('readAt'), {}));
      setShowUnreadState(load<boolean>(k('showUnread'), true));
      // Accounts made before unread counts existed: what is already here counts as read.
      let setup = load<number>(k('setupAt'), 0);
      if (!setup && (v || device || plain)) save(k('setupAt'), (setup = Math.floor(Date.now() / 1000)));
      setSetupAt(setup);
      setMyNameState(load<string>(k('myName'), ''));
      // A choice for the whole device, not for one account.
      const crash = load<boolean>('tegami.crashReports', false);
      setCrashReportsState(crash);
      setCrashReports(crash);
      setRecoveryOn(recoveryOnHere());
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const status: Status = !loaded ? 'loading' : secret ? 'open' : vault ? 'locked' : 'new';
  const me = useMemo(() => (secret ? getPublicKey(secret) : null), [secret]);
  // The account list (lib/accounts.ts) shows each account's name without opening it.
  useEffect(() => {
    if (me) describeAccount(me, myName);
  }, [me, myName]);
  // The open account has nothing new waiting in the account list: its chats are on screen.
  useEffect(() => {
    if (!me) return;
    void clearNewMark(me);
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.tegami === 'new' && e.data.p === me) void clearNewMark(me);
    };
    sw?.addEventListener('message', onMessage);
    return () => {
      sw?.removeEventListener('message', onMessage);
      void clearNewMark(me);
    };
  }, [me]);

  const saveGroups = useCallback((update: (prev: Group[]) => Group[]) => {
    setGroups((prev) => {
      const next = update(prev);
      if (next !== prev) save(k('groups'), next);
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
      save(k('messages'), next);
      return next;
    });
  }, []);

  /** Changes or removes messages already in the list (update returns null to remove). */
  const editMessages = useCallback((ids: string[], update: (m: Message) => Message | null) => {
    setMessages((prev) => {
      let changed = false;
      const next: Message[] = [];
      for (const m of prev) {
        if (!ids.includes(m.id)) {
          next.push(m);
          continue;
        }
        const u = update(m);
        if (u !== m) changed = true;
        if (u) next.push(u);
      }
      if (!changed) return prev;
      save(k('messages'), next);
      return next;
    });
  }, []);
  const setPending = useCallback(
    (ids: string[], pending: Message['pending']) =>
      editMessages(ids, (m) => {
        if (m.pending === pending) return m;
        if (pending) return { ...m, pending };
        const { pending: _, ...rest } = m;
        return rest;
      }),
    [editMessages],
  );

  // ---------- unread counts ----------
  const unread = useMemo(
    () => (showUnread ? countUnread(messages, me, readAt, setupAt) : {}),
    [showUnread, messages, me, readAt, setupAt],
  );
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  const markRead = useCallback((room: string) => {
    let latest = 0;
    for (const m of messagesRef.current) if (m.peer === room) latest = Math.max(latest, m.got ?? m.at * 1000);
    setReadAt((prev) => {
      if ((prev[room] ?? 0) >= latest) return prev;
      const next = { ...prev, [room]: Math.max(latest, Date.now()) };
      save(k('readAt'), next);
      return next;
    });
  }, []);
  const setShowUnread = useCallback((on: boolean) => {
    save(k('showUnread'), on);
    setShowUnreadState(on);
  }, []);
  // The browser tab shows the total, like "(3) Tegami".
  const totalUnread = Object.values(unread).reduce((a, b) => a + b, 0);
  useEffect(() => {
    const doc = globalThis.document;
    if (!doc) return;
    const base = doc.title.replace(/^\(\d+\+?\) /, '') || 'Tegami';
    doc.title = totalUnread ? `(${totalUnread > 99 ? '99+' : totalUnread}) ${base}` : base;
  }, [totalUnread]);

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
          const replyTo = replyOf(rumor.tags);
          if (isGroup(peer)) {
            const subject = rumor.tags.find((t) => t[0] === 'subject')?.[1]?.slice(0, 60);
            rememberGroup(peer, subject, rumor.pubkey);
          }
          const m: Message = {
            id: rumor.id,
            from: rumor.pubkey,
            peer,
            text: file ? '' : rumor.content,
            at: rumor.created_at,
            ...(file ? { file } : {}),
            ...(replyTo ? { replyTo } : {}),
          };
          if (rumor.pubkey !== me) m.got = Date.now();
          addMessage(m);
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
        // Connected (again): send what is waiting.
        oneose: () => void flushRef.current(),
        onclose: () => {
          if (disposed || sub !== s) return;
          retry = setTimeout(open, 2000);
        },
      });
      sub = s;
    };
    open();
    const onVisible = () => {
      if (globalThis.document?.visibilityState === 'visible') {
        open();
        void flushRef.current();
      }
    };
    const onOnline = () => {
      open();
      void flushRef.current();
    };
    globalThis.document?.addEventListener?.('visibilitychange', onVisible);
    globalThis.addEventListener?.('online', onOnline);
    return () => {
      disposed = true;
      clearTimeout(retry);
      globalThis.document?.removeEventListener?.('visibilitychange', onVisible);
      globalThis.removeEventListener?.('online', onOnline);
      sub?.close();
      p.destroy();
      pool.current = null;
    };
  }, [secret, me, addMessage, rememberGroup]);

  // An account moved from another device brings its name, contacts and groups.
  // A new account: nothing from an earlier account on this browser applies.
  const forgetRecovery = useCallback(() => {
    clearLocal();
    setRecoveryOn(false);
  }, []);

  // An account restored with a recovery code keeps recovery on with the same code.
  const adopt = useCallback(async (moved: Bundle, sk: Uint8Array) => {
    save(k('myName'), moved.myName);
    save(k('contacts'), moved.contacts);
    save(k('groups'), moved.groups);
    setMyNameState(moved.myName);
    setContacts(moved.contacts);
    setGroups(moved.groups);
    const keys = takeRestoredKeys();
    if (keys) {
      await saveLocal(sk, { keys, stale: [] });
      setRecoveryOn(true);
    } else {
      // An account moved by link starts without recovery on this device.
      clearLocal();
      setRecoveryOn(false);
    }
  }, []);

  // From now on, messages count as unread. Older ones (brought back from the relay on a
  // new device) are read. Envelopes still waiting from an earlier account here are dropped.
  const beginAccount = useCallback(() => {
    const now = Math.floor(Date.now() / 1000);
    save(k('setupAt'), now);
    setSetupAt(now);
    setPending(outbox.current.map((o) => o.id), undefined);
    outbox.current = [];
    saveOutbox([]);
  }, [setPending]);

  const start = useCallback(
    async (moved?: Bundle) => {
      const sk = moved ? bundleSecret(moved) : generateSecretKey();
      const v = await createVault(sk as Uint8Array<ArrayBuffer>);
      if (moved) await adopt(moved, sk);
      else forgetRecovery();
      beginAccount();
      save(k('vault'), v);
      setVault(v);
      setSecret(sk);
    },
    [adopt, forgetRecovery, beginAccount],
  );

  const startWithoutPasskey = useCallback(
    async (moved?: Bundle) => {
      const sk = moved ? bundleSecret(moved) : generateSecretKey();
      if (deviceVaultAvailable()) save(k('device'), await createDeviceVault(sk as Uint8Array<ArrayBuffer>));
      else save(k('account'), { secretHex: bytesToHex(sk) });
      if (moved) await adopt(moved, sk);
      else forgetRecovery();
      beginAccount();
      setSecret(sk);
    },
    [adopt, forgetRecovery, beginAccount],
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
    save(k('myName'), n);
    setMyNameState(n);
  }, []);

  const addContact = useCallback((pubkey: string, name: string, model?: string) => {
    setContacts((prev) => {
      const old = prev.find((c) => c.pubkey === pubkey);
      const rest = prev.filter((c) => c.pubkey !== pubkey);
      const m = model ?? old?.model;
      const next = [...rest, m ? { pubkey, name, model: m } : { pubkey, name }];
      save(k('contacts'), next);
      return next;
    });
  }, []);

  /**
   * Seals and wraps one rumor for everyone in the chat, once: the other people first, my own
   * devices last. The envelopes are kept as they are until the relay takes them (lib/outbox.ts).
   */
  const build = useCallback(
    (peer: string, kind: 14 | 15, content: string, extra: string[][] = [], at = Math.floor(Date.now() / 1000)) => {
      if (!secret || !me) throw new Error('not open');
      // One rumor with a p tag for everyone in the chat, sealed and wrapped once
      // per person and once for myself, so my other devices see it too.
      // (nip17.wrapManyEvents gives the self copy a different rumor without the p tags.)
      const members = peer.split(',');
      const tags = members.map((m) => ['p', m]);
      const subject = groupsRef.current.find((g) => g.id === peer)?.name;
      if (isGroup(peer) && subject) tags.push(['subject', subject]);
      tags.push(...extra);
      const rumor = nip59.createRumor({ kind, content, tags, created_at: at }, secret);
      const wraps = [...members, me].map((to) => nip59.createWrap(nip59.createSeal(rumor, secret, to), to));
      return { rumor, wraps };
    },
    [secret, me],
  );

  // ---------- outbox ----------
  const saveBox = useCallback((list: Outgoing[]) => {
    outbox.current = list;
    saveOutbox(list);
  }, []);
  const failures = useRef(0);
  const flushing = useRef(false);
  const flushAgain = useRef(false);
  const outboxTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** One try at one waiting message. True when everything in it was accepted. */
  const attempt = useCallback(
    async (item: Outgoing): Promise<boolean> => {
      if (!secret || !pool.current) return false;
      let cur = item;
      if (cur.photo && !cur.wraps.length) {
        // The upload failed earlier: upload again, then build the message once.
        const kept = await keptFile(cur.id);
        if (!kept) return false;
        const bytes = new Uint8Array(await kept.arrayBuffer());
        let file: FileRef;
        try {
          file = await encryptAndUpload(bytes, cur.photo.type, secret, cur.photo.dim);
        } catch {
          return false;
        }
        if (!outbox.current.some((o) => o.id === item.id)) return false; // given up meanwhile
        const { rumor, wraps } = build(cur.peer, 15, file.url, [...fileTags(file), ...(cur.photo.replyTo ? replyTag(15, cur.photo.replyTo) : [])], cur.at);
        await keepSent(rumor.id, bytes, cur.photo.type);
        const localId = cur.id;
        cur = { id: rumor.id, peer: cur.peer, at: cur.at, wraps, done: [] };
        const next = cur;
        saveBox(outbox.current.map((o) => (o.id === localId ? next : o)));
        editMessages([localId], (m) => ({ ...m, id: rumor.id, file }));
        void forgetFile(localId);
      }
      for (const wrap of cur.wraps) {
        if (cur.done.includes(wrap.id)) continue;
        if (!(await publishOne(pool.current, RELAYS, wrap, authRef.current ?? undefined))) return false;
        cur = { ...cur, done: [...cur.done, wrap.id] };
        const next = cur;
        // Given up while sending: the rest stays unsent.
        if (!outbox.current.some((o) => o.id === next.id)) return false;
        saveBox(outbox.current.map((o) => (o.id === next.id ? next : o)));
      }
      const doneId = cur.id;
      saveBox(outbox.current.filter((o) => o.id !== doneId));
      setPending([doneId], undefined);
      return true;
    },
    [secret, build, saveBox, editMessages, setPending],
  );

  /** Sends what is waiting, oldest first. Stops at the first failure and tries again later. */
  const flush = useCallback(async () => {
    if (flushing.current) {
      flushAgain.current = true;
      return;
    }
    if (!pool.current || !outbox.current.length) return;
    flushing.current = true;
    clearTimeout(outboxTimer.current);
    let ok = true;
    try {
      do {
        flushAgain.current = false;
        for (const item of [...outbox.current]) {
          const fresh = outbox.current.find((o) => o.id === item.id);
          if (!fresh) continue;
          ok = await attempt(fresh);
          if (!ok) break;
        }
      } while (ok && flushAgain.current && outbox.current.length);
    } finally {
      flushing.current = false;
    }
    if (!outbox.current.length) {
      failures.current = 0;
      return;
    }
    if (ok) {
      // Something was added while the last one was being sent.
      outboxTimer.current = setTimeout(() => void flushRef.current(), 0);
      return;
    }
    failures.current += 1;
    setPending(outbox.current.map((o) => o.id), 'unsent');
    outboxTimer.current = setTimeout(() => void flushRef.current(), backoff(failures.current));
  }, [attempt, setPending]);
  flushRef.current = flush;
  useEffect(() => () => clearTimeout(outboxTimer.current), []);
  // Opening the app with messages waiting: try once the connection is up (the subscription's
  // first EOSE also triggers this), and keep trying with the backoff.
  useEffect(() => {
    if (secret && me) void flushRef.current();
  }, [secret, me]);

  const send = useCallback(
    async (peer: string, text: string, replyTo?: string) => {
      const { rumor, wraps } = build(peer, 14, text, replyTo ? replyTag(14, replyTo) : []);
      saveBox([...outbox.current, { id: rumor.id, peer, at: rumor.created_at, wraps, done: [] }]);
      addMessage({ id: rumor.id, from: me!, peer, text, at: rumor.created_at, pending: 'sending', ...(replyTo ? { replyTo } : {}) });
      void flush();
    },
    [build, saveBox, addMessage, me, flush],
  );

  const sendPhoto = useCallback(
    async (peer: string, photo: Blob, replyTo?: string) => {
      if (!secret || !me) throw new Error('not open');
      const reply = replyTo ? replyTag(15, replyTo) : [];
      const small = await shrinkImage(photo);
      const dim = `${small.width}x${small.height}`;
      const at = Math.floor(Date.now() / 1000);
      let file: FileRef | null = null;
      try {
        file = await encryptAndUpload(small.bytes, small.type, secret, dim);
      } catch {
        // Offline or the file server refused: keep the photo here and upload it later.
      }
      if (file) {
        const { rumor, wraps } = build(peer, 15, file.url, [...fileTags(file), ...reply], at);
        await keepSent(rumor.id, small.bytes, small.type);
        saveBox([...outbox.current, { id: rumor.id, peer, at, wraps, done: [] }]);
        addMessage({ id: rumor.id, from: me, peer, text: '', at, file, pending: 'sending', ...(replyTo ? { replyTo } : {}) });
      } else {
        const id = `local:${bytesToHex(crypto.getRandomValues(new Uint8Array(16)))}`;
        await keepSent(id, small.bytes, small.type);
        // Without a place to keep it (no IndexedDB), the photo cannot wait: say it was not sent.
        if (!(await keptFile(id))) throw new Error('could not keep the photo');
        const info = { type: small.type, dim, size: small.bytes.byteLength };
        saveBox([...outbox.current, { id, peer, at, wraps: [], done: [], photo: replyTo ? { ...info, replyTo } : info }]);
        // Shown from this device until it is uploaded; the file fields are filled in then.
        addMessage({
          id,
          from: me,
          peer,
          text: '',
          at,
          file: { url: '', type: info.type, key: '', nonce: '', sha256: '', size: info.size, dim },
          pending: 'unsent',
          ...(replyTo ? { replyTo } : {}),
        });
      }
      void flush();
    },
    [secret, me, build, saveBox, addMessage, flush],
  );

  const retrySend = useCallback(() => {
    failures.current = 0;
    clearTimeout(outboxTimer.current);
    void flushRef.current();
  }, []);

  const cancelSend = useCallback(
    (id: string) => {
      if (!outbox.current.some((o) => o.id === id)) return;
      saveBox(outbox.current.filter((o) => o.id !== id));
      editMessages([id], () => null);
      if (id.startsWith('local:')) void forgetFile(id);
    },
    [saveBox, editMessages],
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
      // Only the ringing offer to the other person is marked as a call (not my own copy).
      const wraps = (alsoMe ? [to, me] : [to]).map((k) => wrapSignal(rumor, secret, k, data.t === 'offer' && k === to));
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

  // Opening the app with notifications on: register this device again (keys, new address).
  useEffect(() => {
    if (secret) void refreshPush(secret);
  }, [secret]);

  const setNotifications = useCallback(
    async (on: boolean) => {
      if (!secret) throw new Error('not open');
      return on ? enablePush(secret) : disablePush(secret);
    },
    [secret],
  );

  // ---------- recovery code ----------
  // Every relay call for recovery runs one after another, so turning it off cannot be
  // overtaken by a refresh that is still uploading.
  const recoveryQueue = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    const run = recoveryQueue.current.then(job, job);
    recoveryQueue.current = run.catch(() => undefined);
    return run;
  }, []);
  const lastUploaded = useRef('');
  const [recoveryRetry, setRecoveryRetry] = useState(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Refreshes that failed in a row, counted across app starts. After RECOVERY_FAILURES_SHOWN
  // the settings screen says the backup is out of date; the next success clears it.
  const [recoveryFailures, setRecoveryFailures] = useState(() => load<number>(k('recovery.failures'), 0));
  const refreshed = useCallback((ok: boolean) => {
    setRecoveryFailures((n) => {
      const next = ok ? 0 : n + 1;
      if (next !== n) save(k('recovery.failures'), next);
      return next;
    });
  }, []);
  const currentBundle = useCallback(
    (sk: Uint8Array): Bundle => ({ v: 1, secretHex: bytesToHex(sk), myName, contacts, groups }),
    [myName, contacts, groups],
  );

  const makeRecoveryCode = useCallback(async () => {
    if (!secret) throw new Error('not open');
    const code = makeCode();
    const keys = await deriveKeys(code);
    const bundle = currentBundle(secret);
    await enqueue(async () => {
      const old = await loadLocal(secret);
      await putBackup(keys, bundle);
      lastUploaded.current = JSON.stringify(bundle);
      const stale = [...(old?.stale ?? []), ...(old ? [old.keys] : [])].map(({ id, signer }) => ({ id, signer }));
      await saveLocal(secret, { keys, stale });
      setRecoveryOn(true);
      refreshed(true);
      // The old code stops working. If the relay cannot be reached now, the next refresh tries again.
      const left: BackupRef[] = [];
      for (const ref of stale) await deleteBackup(ref).catch(() => left.push(ref));
      if (left.length !== stale.length) await saveLocal(secret, { keys, stale: left });
    });
    return code;
  }, [secret, currentBundle, enqueue, refreshed]);

  const turnOffRecovery = useCallback(async () => {
    if (!secret) throw new Error('not open');
    await enqueue(async () => {
      const rec = await loadLocal(secret);
      if (rec) for (const ref of [rec.keys, ...rec.stale]) await deleteBackup(ref);
      clearLocal();
      refreshed(true);
      lastUploaded.current = '';
      setRecoveryOn(false);
    });
  }, [secret, enqueue, refreshed]);

  // Keep the backup up to date when my name, contacts or groups change (after a pause).
  useEffect(() => {
    if (!secret || !recoveryOn) return;
    const bundle = currentBundle(secret);
    const json = JSON.stringify(bundle);
    // Back to what the relay already has: the backup is up to date again.
    if (json === lastUploaded.current) return refreshed(true);
    const t = setTimeout(() => {
      void enqueue(async () => {
        const rec = await loadLocal(secret);
        if (!rec) return; // turned off meanwhile
        try {
          await putBackup(rec.keys, bundle, true);
        } catch (e) {
          if (!(e instanceof BackupGoneError)) throw e;
          // Turned off, or a new code was made, on another device.
          clearLocal();
          setRecoveryOn(false);
          refreshed(true);
          return;
        }
        lastUploaded.current = json;
        refreshed(true);
        if (rec.stale.length) {
          const left: BackupRef[] = [];
          for (const ref of rec.stale) await deleteBackup(ref).catch(() => left.push(ref));
          await saveLocal(secret, { keys: rec.keys, stale: left });
        }
      }).catch(() => {
        // Offline or the relay refused: try again in a minute, and at the next change or start.
        refreshed(false);
        clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => setRecoveryRetry((n) => n + 1), 60_000);
      });
    }, 1500);
    return () => clearTimeout(t);
  }, [secret, recoveryOn, currentBundle, enqueue, refreshed, recoveryRetry]);
  useEffect(() => () => clearTimeout(retryTimer.current), []);

  const value: TegamiState = {
    unread,
    showUnread,
    setShowUnread,
    markRead,
    cancelSend,
    retrySend,
    recoveryOn,
    recoveryBehind: recoveryOn && recoveryFailures >= RECOVERY_FAILURES_SHOWN,
    makeRecoveryCode,
    turnOffRecovery,
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

/**
 * The reply tag, as NIP-17 writes it: ["e", <id>, <relay>] on a chat message (kind 14) and
 * ["e", <id>, <relay>, "reply"] on a file message (kind 15).
 */
export function replyTag(kind: 14 | 15, id: string): string[][] {
  return [kind === 14 ? ['e', id, RELAYS[0]] : ['e', id, RELAYS[0], 'reply']];
}

/** The message a rumor replies to: the e tag marked "reply", else the only or first e tag. */
export function replyOf(tags: string[][]): string | undefined {
  const es = tags.filter((t) => t[0] === 'e' && /^[0-9a-f]{64}$/.test(t[1] ?? ''));
  return (es.find((t) => t[3] === 'reply') ?? es[0])?.[1];
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
