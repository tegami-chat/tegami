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
import { MAX_FILE_BYTES, encryptAndUpload, fileFromRumor, fileTags, forgetFile, isStampRumor, keepSent, keptFile, openFile, shrinkAvatar, shrinkImage, shrinkStamp, validFileName, validFileRef, type FileRef } from './files';
import { backoff, loadOutbox, publishOne, saveOutbox, type Outgoing } from './outbox';
import { k, load, remove, save } from './storage';
import { bundleSecret, sendTransfer, type Bundle } from './transfer';
import { disablePush, enablePush, refreshPush, type PushState } from './push';
import { SIGNAL_KIND, freshSignal, wrapQuiet, wrapSignal } from './signal';
import { BackupGoneError, type BackupRef, clearLocal, deleteBackup, deriveKeys, loadLocal, makeCode, putBackup, recoveryOnHere, saveLocal, takeRestoredKeys } from './recovery';
import { createVault, unlockVault, type Vault } from './vault';
import { TURNSTILE_SITEKEY, askRelay, forgetInviteCode, keptInviteCode, type Registration } from './register';
import { signedFetch } from './relay-http';

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
  /** True when file is a stamp (kind 15 with a ["t", "stamp"] tag). */
  stamp?: true;
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

/** Rumor kind for a private profile card (Tegami's own, not a standard NIP). */
export const PROFILE_KIND = 10100;

/** model: for an AI friend, which company's which model (always shown, philosophy #93). */
export type Contact = { pubkey: string; name: string; model?: string; avatar?: FileRef };

/** A stamp in my list (`k('stamps')`): an uploaded file and when it was uploaded (unix seconds). */
export type Stamp = FileRef & { uploadedAt?: number };

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

/**
 * Whether this account's key is registered with the relay (lib/register.ts).
 * checking: not known yet (or the relay cannot be reached and nothing is remembered).
 * needed: not registered; the web app shows the Turnstile check. blocked: the key was stopped.
 */
export type RegistrationState = 'checking' | 'needed' | 'ok' | 'blocked';

/** Why someone is reported to the relay's operator (POST /report). */
export type ReportReason = 'spam' | 'scam' | 'impersonation' | 'harassment' | 'other';

/** Recent messages attached to a report: at most this many, each cut to this length. */
const REPORT_MESSAGES = 20;
const REPORT_TEXT = 2000;
/** Deleted message ids kept per account so the relay's 30-day replay does not bring them back. */
const MAX_DELETED_IDS = 500;

/** The messages from `pubkey` that a report will attach (around `messageId` when given, else the latest 20). */
export function reportMessagesFor(all: Message[], pubkey: string, messageId?: string): Message[] {
  // Only what they wrote in the chat being reported: the 1:1 chat, or the chat of the chosen
  // message (a group). Other chats the person is in are not the reporter's to hand over.
  const target = messageId ? all.find((m) => m.id === messageId) : undefined;
  const room = target?.peer ?? pubkey;
  const theirTexts = all.filter((m) => m.peer === room && m.from === pubkey && !m.file && !m.call && m.text);
  if (!target) return theirTexts.slice(-REPORT_MESSAGES);
  const idx = theirTexts.findIndex((m) => m.id === messageId);
  if (idx >= 0) return theirTexts.slice(Math.max(0, idx - 9), idx + 10);
  // The chosen message itself is not text (a photo): the texts around it in time.
  const before = theirTexts.filter((m) => m.at <= target.at).slice(-9);
  const after = theirTexts.filter((m) => m.at > target.at).slice(0, 9);
  return [...before, ...after];
}

type TegamiState = {
  status: Status;
  me: string | null; // hex pubkey
  protectedByPasskey: boolean;
  npub: string | null;
  contacts: Contact[];
  groups: Group[];
  blocked: string[];
  block: (pubkey: string) => void;
  unblock: (pubkey: string) => void;
  /**
   * Reports a person to the relay's operator. With attach, the selected message and up to 9
   * messages before and after it (or the last 20 text messages they wrote) go along.
   * Nothing is sent to them. Throws when it did not go through.
   */
  report: (pubkey: string, reason: ReportReason, attach: boolean, messageId?: string) => Promise<void>;
  messages: Message[];
  /** Deletes one message on this device only and remembers its id so the relay replay skips it. */
  deleteMessage: (id: string) => void;
  /** Makes a group with these contacts and returns its chat id. */
  createGroup: (name: string, members: string[]) => string;
  /** My own name, shared through my invite link. Stays on this device otherwise. */
  myName: string;
  setMyName: (name: string) => void;
  /** My own profile picture, shared privately with contacts only. */
  myAvatar: FileRef | null;
  setMyAvatar: (photo: Blob | null) => Promise<void>;
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
  removeContact: (pubkey: string) => void;
  /** Removes every message of this chat (and the group entry for a group) from this device. */
  deleteChat: (room: string) => void;
  /** Sends a text message, as a reply to the message with id replyTo when given. */
  send: (peer: string, text: string, replyTo?: string) => Promise<void>;
  /** Whether crash reports are sent (off unless the person turns it on). */
  crashReports: boolean;
  setCrashReportsOn: (on: boolean) => void;
  /** Everything on this device except the key, as JSON (philosophy #88). */
  exportChats: () => string;
  /** Makes a photo smaller (or keeps a video as-is), encrypts, uploads and sends it. */
  sendPhoto: (peer: string, photo: Blob, replyTo?: string) => Promise<void>;
  /** Encrypts a general file on this device, uploads it with its original name, and sends it. */
  sendFile: (peer: string, file: Blob, name: string, replyTo?: string) => Promise<void>;
  /** Encrypts a recorded voice message on this device, uploads it with its duration, and sends it. */
  sendVoice: (peer: string, audio: Blob, duration: number, replyTo?: string) => Promise<void>;
  /** Sends an already-uploaded photo or file to another chat without uploading again. */
  forwardFile: (peer: string, file: FileRef, stamp?: boolean) => Promise<void>;
  /** My stamps, kept per account on this device. */
  stamps: Stamp[];
  /** Shrinks an image, encrypts and uploads it, and adds it to my stamps. */
  makeStamp: (image: Blob) => Promise<Stamp>;
  /** Adds someone else's stamp to my stamps, fetching and keeping the image now. */
  addStamp: (file: FileRef, uploadedAt?: number) => Promise<void>;
  /** Removes a stamp from my stamps only. */
  removeStamp: (sha256: string) => void;
  /** Sends a stamp, uploading it again first if its upload is older than 20 days. */
  sendStamp: (peer: string, stamp: Stamp, replyTo?: string) => Promise<void>;
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
  registration: RegistrationState;
  /** Registered with an invite (or before registration existed): my messages reach strangers. */
  trusted: boolean;
  /** My invite code, put into my invite link. Null while unknown or when I may not invite. */
  inviteCode: string | null;
  /** Registers with a Turnstile token (web) or, with invite, upgrades with a friend's code. Returns whether it worked. */
  registerWith: (body: { turnstile?: string; invite?: string }) => Promise<boolean>;
};

const Ctx = createContext<TegamiState | null>(null);

export function useTegami() {
  const value = useContext(Ctx);
  if (!value) throw new Error('useTegami must be used inside TegamiProvider');
  return value;
}

// Invite links: https://app.tegami.chat/i#<npub>&n=<name>&c=<invite code>
// Everything sits after '#', so the key, the name and the code never reach any server.
// The code lets the person who opens the link register as invited (lib/register.ts).
export const APP_ORIGIN = 'https://app.tegami.chat';

export function inviteLink(npub: string, name: string, code?: string | null) {
  const n = name.trim();
  return `${APP_ORIGIN}/i#${npub}${n ? `&n=${encodeURIComponent(n)}` : ''}${code ? `&c=${code}` : ''}`;
}

/** Reads the invite code carried by an invite link, if any. */
export function inviteCodeOf(input: string): string {
  const code = inviteParam(input, 'c');
  return /^[a-z2-9]{6,32}$/.test(code) ? code : '';
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
export function strangers(contacts: Contact[], messages: Message[], groups: Group[] = [], blocked: string[] = []) {
  const known = new Set([...contacts.map((c) => c.pubkey), ...groups.map((g) => g.id), ...blocked]);
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
export function countUnread(
  messages: Message[],
  me: string | null,
  readAt: Record<string, number>,
  setupAt: number,
  blocked: string[] = [],
) {
  const skip = new Set(blocked);
  const out: Record<string, number> = {};
  for (const m of messages) {
    if (m.from === me || m.at < setupAt || skip.has(m.peer)) continue;
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

/** Checks whether scanned QR text is a Tegami invite link and returns it, or null. */
export function inviteFromQr(text: string): string | null {
  const trimmed = text.trim();
  if (!/^https:\/\/(?:app\.)?tegami\.chat\/i#\S+$/.test(trimmed)) return null;
  return parsePubkey(trimmed) ? trimmed : null;
}

export function TegamiProvider({ children }: { children: React.ReactNode }) {
  const [secret, setSecret] = useState<Uint8Array | null>(null);
  const [vault, setVault] = useState<Vault | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [myName, setMyNameState] = useState('');
  const [myAvatar, setMyAvatarState] = useState<FileRef | null>(null);
  const myAvatarRef = useRef<FileRef | null>(null);
  myAvatarRef.current = myAvatar;
  const [stamps, setStamps] = useState<Stamp[]>([]);
  const profileAt = useRef(new Map<string, number>());
  const lastProfileAt = useRef(0);
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
      const loadedContacts = load<Contact[]>(k('contacts'), []);
      contactsRef.current = loadedContacts;
      setContacts(loadedContacts);
      setGroups(load<Group[]>(k('groups'), []));
      const loadedAvatar = load<FileRef | null>(k('avatar'), null);
      myAvatarRef.current = loadedAvatar;
      setMyAvatarState(loadedAvatar);
      setStamps(load<Stamp[]>(k('stamps'), []));
      const loadedBlocked = load<string[]>(k('blocked'), []);
      blockedRef.current = loadedBlocked;
      setBlocked(loadedBlocked);
      // Messages waiting to be sent: the outbox is what counts. A message still marked as
      // being sent when the app closed is now waiting; a mark without an outbox entry is stale.
      const deletedSet = new Set(load<string[]>(k('deleted'), []));
      deletedRef.current = deletedSet;
      const box = loadOutbox();
      const stored = load<Message[]>(k('messages'), []).filter((m) => !deletedSet.has(m.id));
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
      clearedRef.current = load<Record<string, number>>(k('cleared'), {});
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
      if (next !== prev) {
        groupsRef.current = next;
        save(k('groups'), next);
      }
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
  const blockedRef = useRef<string[]>([]);
  // Chats deleted on this device: room -> the time up to which their messages stay deleted.
  const clearedRef = useRef<Record<string, number>>({});
  // Individual messages deleted on this device, kept small so relay replays skip them.
  const deletedRef = useRef<Set<string>>(new Set());
  blockedRef.current = blocked;
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
    () => (showUnread ? countUnread(messages, me, readAt, setupAt, blocked) : {}),
    [showUnread, messages, me, readAt, setupAt, blocked],
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
          if (rumor.pubkey !== me && blockedRef.current.includes(rumor.pubkey)) return;
          // Written by a key registered without an invite: only from friends and groups I know.
          // Keys made in bulk cannot reach strangers this way (relay/src/members.ts).
          if ((wrap as { tegami_open?: number }).tegami_open === 1 && rumor.pubkey !== me) {
            const known = contactsRef.current.some((c) => c.pubkey === rumor.pubkey);
            const room = roomOf([rumor.pubkey, ...rumor.tags.filter((t) => t[0] === 'p').map((t) => t[1])].filter((x) => x !== me));
            if (!known && !(isGroup(room) && groupsRef.current.some((g) => g.id === room))) return;
          }
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
          if (rumor.kind === PROFILE_KIND) {
            if (!contactsRef.current.some((c) => c.pubkey === rumor.pubkey)) return;
            if (rumor.created_at < (profileAt.current.get(rumor.pubkey) ?? 0)) return;
            const data = JSON.parse(rumor.content) as { avatar?: unknown };
            if (!data || typeof data !== 'object') return;
            const avatar = data.avatar === null ? null : validFileRef(data.avatar);
            if (data.avatar !== null && !avatar) return;
            profileAt.current.set(rumor.pubkey, rumor.created_at);
            // Fetch it now: the file server deletes files after 30 days.
            if (avatar) void openFile(`avatar:${avatar.sha256}`, avatar).catch(() => {});
            setContacts((prev) => {
              if (!prev.some((c) => c.pubkey === rumor.pubkey)) return prev;
              const next = prev.map((c) => {
                if (c.pubkey !== rumor.pubkey) return c;
                if (avatar) return { ...c, avatar };
                const { avatar: _, ...rest } = c;
                return rest;
              });
              contactsRef.current = next;
              save(k('contacts'), next);
              return next;
            });
            return;
          }
          if (rumor.kind !== 14 && rumor.kind !== 15) return;
          const file = rumor.kind === 15 ? fileFromRumor(rumor.content, rumor.tags) : undefined;
          if (file === null) return;
          const stamp = file && isStampRumor(rumor.tags) ? true : undefined;
          // Everyone in the chat except me: the author and every p tag.
          const others = [rumor.pubkey, ...rumor.tags.filter((t) => t[0] === 'p').map((t) => t[1])].filter(
            (k) => /^[0-9a-f]{64}$/.test(k) && k !== me,
          );
          if (!others.length) return;
          const peer = roomOf(others);
          // A deleted chat or message: the relay still holds its envelopes for 30 days and hands
          // them out again on the next start. Messages up to the moment of deleting stay gone.
          if (rumor.created_at <= (clearedRef.current[peer] ?? 0) || deletedRef.current.has(rumor.id)) return;
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
            ...(stamp ? { stamp: true } : {}),
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

  // ---------- registration with the relay ----------
  const [registration, setRegistration] = useState<RegistrationState>('checking');
  const [trusted, setTrusted] = useState(false);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const applyRegistration = useCallback((r: Registration) => {
    if (r.banned) {
      setRegistration('blocked');
      return;
    }
    if (!r.member) {
      setRegistration('needed');
      return;
    }
    const known = { trusted: !!r.trusted, code: r.code ?? null };
    save(k('registration'), known);
    setTrusted(known.trusted);
    setInviteCode(known.code);
    setRegistration('ok');
  }, []);
  const registerWith = useCallback(
    async (body: { turnstile?: string; invite?: string }) => {
      if (!secret) return false;
      try {
        const r = await askRelay(secret, body);
        if (r.member && body.invite && !r.inviteError) forgetInviteCode();
        if (r.member || r.banned) applyRegistration(r);
        return r.member;
      } catch {
        return false;
      }
    },
    [secret, applyRegistration],
  );
  useEffect(() => {
    if (!secret) return;
    let alive = true;
    // What the relay said last time: the app works offline meanwhile.
    const known = load<{ trusted: boolean; code: string | null } | null>(k('registration'), null);
    if (known) {
      setTrusted(known.trusted);
      setInviteCode(known.code);
      setRegistration('ok');
    }
    (async () => {
      // A code from an invite link opened here registers this key as invited (or upgrades
      // a key registered without one). Without a Turnstile site key (tests), 'dev-pass'.
      const code = keptInviteCode();
      for (let attempt = 0; alive; attempt++) {
        try {
          let r = await askRelay(secret, code ? { invite: code } : {});
          if (!r.member && !r.banned && !TURNSTILE_SITEKEY) r = await askRelay(secret, { turnstile: 'dev-pass' });
          if (!alive) return;
          if (code && (r.member || r.error === 'invite-invalid')) forgetInviteCode();
          applyRegistration(r);
          return;
        } catch {
          // The relay cannot be reached: try again, less and less often.
          await new Promise((res) => setTimeout(res, Math.min(60_000, 2000 * 2 ** attempt)));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [secret, applyRegistration]);

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
    save(k('blocked'), moved.blocked ?? []);
    setMyNameState(moved.myName);
    setContacts(moved.contacts);
    setGroups(moved.groups);
    blockedRef.current = moved.blocked ?? [];
    setBlocked(moved.blocked ?? []);
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
    const bundle: Bundle = { v: 1, secretHex: bytesToHex(secret), myName, contacts, groups, blocked };
    return sendTransfer(pool.current, RELAYS, authRef.current, bundle, globalThis.location?.origin ?? APP_ORIGIN);
  }, [secret, myName, contacts, groups, blocked]);

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

  /** Sends a private profile card to each given contact (never to strangers or groups). */
  const sendProfileTo = useCallback(
    async (recipients: string[], avatar: FileRef | null) => {
      if (!secret || !pool.current) return;
      const targets = recipients.filter((p) => !blockedRef.current.includes(p));
      if (!targets.length) return;
      const at = Math.max(Math.floor(Date.now() / 1000), lastProfileAt.current + 1);
      lastProfileAt.current = at;
      const content = JSON.stringify({ avatar });
      await Promise.all(
        targets.map((to) => {
          const rumor = nip59.createRumor({ kind: PROFILE_KIND, content, tags: [['p', to]], created_at: at }, secret);
          // Quiet: changing a picture must not ring "a new message" on every friend's phone.
          const wrap = wrapQuiet(rumor, secret, to);
          return publishOne(pool.current!, RELAYS, wrap, authRef.current ?? undefined);
        }),
      );
    },
    [secret],
  );

  const setMyAvatar = useCallback(
    async (photo: Blob | null) => {
      if (!secret) throw new Error('not open');
      if (!photo) {
        const prev = myAvatarRef.current;
        remove(k('avatar'));
        myAvatarRef.current = null;
        setMyAvatarState(null);
        if (prev?.sha256) void forgetFile(`avatar:${prev.sha256}`);
        await sendProfileTo(
          contactsRef.current.map((c) => c.pubkey),
          null,
        );
        return;
      }
      const small = await shrinkAvatar(photo);
      const dim = `${small.width}x${small.height}`;
      const ref = await encryptAndUpload(small.bytes, small.type, secret, dim);
      await keepSent(`avatar:${ref.sha256}`, small.bytes, small.type);
      save(k('avatar'), ref);
      save(k('avatarAt'), Math.floor(Date.now() / 1000));
      myAvatarRef.current = ref;
      setMyAvatarState(ref);
      await sendProfileTo(
        contactsRef.current.map((c) => c.pubkey),
        ref,
      );
    },
    [secret, sendProfileTo],
  );

  // The file server deletes files after 30 days. Upload my picture again when it is 20 days
  // old, so a friend added later (or one who was away) still gets a picture that loads.
  useEffect(() => {
    if (!secret || !pool.current) return;
    const ref = myAvatarRef.current;
    const at = load<number>(k('avatarAt'), 0);
    if (!ref || Date.now() / 1000 - at < 20 * 24 * 60 * 60) return;
    void (async () => {
      const blob = await keptFile(`avatar:${ref.sha256}`).catch(() => undefined);
      if (blob) await setMyAvatar(blob).catch(() => {});
    })();
  }, [secret, me, setMyAvatar]);

  const addContact = useCallback(
    (pubkey: string, name: string, model?: string) => {
      setContacts((prev) => {
        const old = prev.find((c) => c.pubkey === pubkey);
        const rest = prev.filter((c) => c.pubkey !== pubkey);
        const m = model ?? old?.model;
        const avatar = old?.avatar;
        const next = [...rest, { pubkey, name, ...(m ? { model: m } : {}), ...(avatar ? { avatar } : {}) }];
        contactsRef.current = next;
        save(k('contacts'), next);
        return next;
      });
      if (myAvatarRef.current) void sendProfileTo([pubkey], myAvatarRef.current);
    },
    [sendProfileTo],
  );

  const removeContact = useCallback((pubkey: string) => {
    profileAt.current.delete(pubkey);
    setContacts((prev) => {
      const old = prev.find((c) => c.pubkey === pubkey);
      if (!old) return prev;
      if (old.avatar?.sha256) void forgetFile(`avatar:${old.avatar.sha256}`);
      const next = prev.filter((c) => c.pubkey !== pubkey);
      contactsRef.current = next;
      save(k('contacts'), next);
      return next;
    });
  }, []);

  const block = useCallback((pubkey: string) => {
    setBlocked((prev) => {
      if (prev.includes(pubkey)) return prev;
      const next = [...prev, pubkey];
      blockedRef.current = next;
      save(k('blocked'), next);
      return next;
    });
  }, []);

  const unblock = useCallback((pubkey: string) => {
    setBlocked((prev) => {
      if (!prev.includes(pubkey)) return prev;
      const next = prev.filter((p) => p !== pubkey);
      blockedRef.current = next;
      save(k('blocked'), next);
      return next;
    });
  }, []);

  // Only the relay's operator sees a report. The relay cannot read chats, so messages go
  // along only when the person chose to attach them, and only what the other person wrote.
  const report = useCallback(
    async (pubkey: string, reason: ReportReason, attach: boolean, messageId?: string) => {
      if (!secret) throw new Error('not open');
      const messages = attach
        ? reportMessagesFor(messagesRef.current, pubkey, messageId).map((m) => ({
            text: m.text.slice(0, REPORT_TEXT),
            at: Math.floor(m.at),
          }))
        : [];
      const body = JSON.stringify(messages.length ? { pubkey, reason, messages } : { pubkey, reason });
      const res = await signedFetch('POST', '/report', body, secret);
      if (!res.ok) throw new Error(`report: ${res.status}`);
    },
    [secret],
  );

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
          file = await encryptAndUpload(bytes, cur.photo.type, secret, cur.photo.dim, {
            name: cur.photo.name,
            duration: cur.photo.duration,
          });
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
      if (!isGroup(peer) && blockedRef.current.includes(peer)) return;
      const { rumor, wraps } = build(peer, 14, text, replyTo ? replyTag(14, replyTo) : []);
      saveBox([...outbox.current, { id: rumor.id, peer, at: rumor.created_at, wraps, done: [] }]);
      addMessage({ id: rumor.id, from: me!, peer, text, at: rumor.created_at, pending: 'sending', ...(replyTo ? { replyTo } : {}) });
      void flush();
    },
    [build, saveBox, addMessage, me, flush],
  );

  const uploadAndSend = useCallback(
    async (
      peer: string,
      bytes: Uint8Array<ArrayBuffer>,
      type: string,
      opts: { dim?: string; name?: string; duration?: number; replyTo?: string } = {},
    ) => {
      if (!secret || !me) throw new Error('not open');
      if (!isGroup(peer) && blockedRef.current.includes(peer)) return;
      const { dim, name, duration, replyTo } = opts;
      const reply = replyTo ? replyTag(15, replyTo) : [];
      const at = Math.floor(Date.now() / 1000);
      let file: FileRef | null = null;
      try {
        file = await encryptAndUpload(bytes, type, secret, dim, { name, duration });
      } catch {
        // Offline or the file server refused: keep the file here and upload it later.
      }
      if (file) {
        const { rumor, wraps } = build(peer, 15, file.url, [...fileTags(file), ...reply], at);
        await keepSent(rumor.id, bytes, type);
        saveBox([...outbox.current, { id: rumor.id, peer, at, wraps, done: [] }]);
        addMessage({ id: rumor.id, from: me, peer, text: '', at, file, pending: 'sending', ...(replyTo ? { replyTo } : {}) });
      } else {
        const id = `local:${bytesToHex(crypto.getRandomValues(new Uint8Array(16)))}`;
        await keepSent(id, bytes, type);
        // Without a place to keep it (no IndexedDB), the file cannot wait: say it was not sent.
        if (!(await keptFile(id))) throw new Error('could not keep the file');
        const info = {
          type,
          size: bytes.byteLength,
          ...(dim ? { dim } : {}),
          ...(name ? { name } : {}),
          ...(duration !== undefined ? { duration } : {}),
          ...(replyTo ? { replyTo } : {}),
        };
        saveBox([...outbox.current, { id, peer, at, wraps: [], done: [], photo: info }]);
        // Shown from this device until it is uploaded; the file fields are filled in then.
        addMessage({
          id,
          from: me,
          peer,
          text: '',
          at,
          file: {
            url: '',
            type,
            key: '',
            nonce: '',
            sha256: '',
            size: info.size,
            ...(dim ? { dim } : {}),
            ...(name ? { name } : {}),
            ...(duration !== undefined ? { duration } : {}),
          },
          pending: 'unsent',
          ...(replyTo ? { replyTo } : {}),
        });
      }
      void flush();
    },
    [secret, me, build, saveBox, addMessage, flush],
  );

  const sendPhoto = useCallback(
    async (peer: string, photo: Blob, replyTo?: string) => {
      if (!secret || !me) throw new Error('not open');
      if (photo.type.startsWith('video/')) {
        if (photo.size > MAX_FILE_BYTES) throw new Error('video too large');
        const bytes = new Uint8Array(await photo.arrayBuffer());
        await uploadAndSend(peer, bytes, photo.type, { replyTo });
        return;
      }
      const small = await shrinkImage(photo);
      await uploadAndSend(peer, small.bytes, small.type, { dim: `${small.width}x${small.height}`, replyTo });
    },
    [secret, me, uploadAndSend],
  );

  const sendFile = useCallback(
    async (peer: string, file: Blob, name: string, replyTo?: string) => {
      if (!secret || !me) throw new Error('not open');
      if (file.size > MAX_FILE_BYTES) throw new Error('file too large');
      const base = name.split(/[/\\]/).pop()?.slice(0, 200) ?? '';
      const cleanName = validFileName(base) ?? 'file';
      const bytes = new Uint8Array(await file.arrayBuffer());
      await uploadAndSend(peer, bytes, file.type || 'application/octet-stream', { name: cleanName, replyTo });
    },
    [secret, me, uploadAndSend],
  );

  const sendVoice = useCallback(
    async (peer: string, audio: Blob, duration: number, replyTo?: string) => {
      if (!secret || !me) throw new Error('not open');
      if (audio.size > MAX_FILE_BYTES) throw new Error('voice too large');
      const bytes = new Uint8Array(await audio.arrayBuffer());
      await uploadAndSend(peer, bytes, audio.type || 'audio/webm', {
        duration: Math.max(0, Math.round(duration)),
        replyTo,
      });
    },
    [secret, me, uploadAndSend],
  );

  const forwardFile = useCallback(
    async (peer: string, file: FileRef, stamp?: boolean) => {
      if (!secret || !me) throw new Error('not open');
      if (!isGroup(peer) && blockedRef.current.includes(peer)) return;
      const { rumor, wraps } = build(peer, 15, file.url, fileTags(file, stamp));
      saveBox([...outbox.current, { id: rumor.id, peer, at: rumor.created_at, wraps, done: [] }]);
      addMessage({
        id: rumor.id,
        from: me,
        peer,
        text: '',
        at: rumor.created_at,
        file,
        ...(stamp ? { stamp: true } : {}),
        pending: 'sending',
      });
      void flush();
    },
    [secret, me, build, saveBox, addMessage, flush],
  );

  const makeStamp = useCallback(
    async (image: Blob): Promise<Stamp> => {
      if (!secret) throw new Error('not open');
      const small = await shrinkStamp(image);
      const dim = `${small.width}x${small.height}`;
      const ref = await encryptAndUpload(small.bytes, small.type, secret, dim);
      await keepSent(`stamp:${ref.sha256}`, small.bytes, small.type);
      const entry: Stamp = { ...ref, uploadedAt: Math.floor(Date.now() / 1000) };
      setStamps((prev) => {
        const next = [...prev.filter((s) => s.sha256 !== entry.sha256), entry];
        save(k('stamps'), next);
        return next;
      });
      return entry;
    },
    [secret],
  );

  const addStamp = useCallback(
    // Someone else uploaded it, maybe weeks ago (files are deleted after 30 days): 0 means
    // "unknown", so the first time I send it, it is uploaded again as my own copy.
    async (file: FileRef, uploadedAt = 0) => {
      const { uploadedAt: _, ...clean } = file as Stamp;
      const entry: Stamp = { ...clean, uploadedAt };
      setStamps((prev) => {
        if (prev.some((s) => s.sha256 === clean.sha256)) return prev;
        const next = [...prev, entry];
        save(k('stamps'), next);
        return next;
      });
      const blob = await openFile(`stamp:${clean.sha256}`, clean);
      await keepSent(`stamp:${clean.sha256}`, new Uint8Array(await blob.arrayBuffer()), clean.type);
    },
    [],
  );

  const removeStamp = useCallback((sha256: string) => {
    setStamps((prev) => {
      if (!prev.some((s) => s.sha256 === sha256)) return prev;
      const next = prev.filter((s) => s.sha256 !== sha256);
      save(k('stamps'), next);
      return next;
    });
  }, []);

  const sendStamp = useCallback(
    async (peer: string, stamp: Stamp, replyTo?: string) => {
      if (!secret || !me) throw new Error('not open');
      if (!isGroup(peer) && blockedRef.current.includes(peer)) return;
      const now = Math.floor(Date.now() / 1000);
      const uploadedSec =
        stamp.uploadedAt === undefined
          ? 0
          : stamp.uploadedAt > 1e11
            ? Math.floor(stamp.uploadedAt / 1000)
            : stamp.uploadedAt;
      let file: FileRef;
      if (now - uploadedSec >= 20 * 24 * 60 * 60) {
        const blob = (await keptFile(`stamp:${stamp.sha256}`)) ?? (await openFile(`stamp:${stamp.sha256}`, stamp));
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const fresh = await encryptAndUpload(bytes, stamp.type, secret, stamp.dim);
        await keepSent(`stamp:${fresh.sha256}`, bytes, fresh.type);
        const updated: Stamp = { ...fresh, uploadedAt: now };
        setStamps((prev) => {
          const next = prev.map((s) => (s.sha256 === stamp.sha256 ? updated : s));
          save(k('stamps'), next);
          return next;
        });
        file = fresh;
      } else {
        const { uploadedAt: _, ...clean } = stamp;
        file = clean;
      }
      const reply = replyTo ? replyTag(15, replyTo) : [];
      const { rumor, wraps } = build(peer, 15, file.url, [...fileTags(file, true), ...reply], now);
      const kept = await keptFile(`stamp:${file.sha256}`);
      if (kept) await keepSent(rumor.id, new Uint8Array(await kept.arrayBuffer()), file.type);
      saveBox([...outbox.current, { id: rumor.id, peer, at: now, wraps, done: [] }]);
      addMessage({
        id: rumor.id,
        from: me,
        peer,
        text: '',
        at: now,
        file,
        stamp: true,
        pending: 'sending',
        ...(replyTo ? { replyTo } : {}),
      });
      void flush();
    },
    [secret, me, build, saveBox, addMessage, flush],
  );

  const deleteChat = useCallback(
    (room: string) => {
      let upTo = Math.floor(Date.now() / 1000);
      for (const m of messagesRef.current) if (m.peer === room) upTo = Math.max(upTo, m.at);
      clearedRef.current = { ...clearedRef.current, [room]: upTo };
      save(k('cleared'), clearedRef.current);
      const waiting = outbox.current.filter((o) => o.peer === room);
      if (waiting.length) {
        saveBox(outbox.current.filter((o) => o.peer !== room));
        for (const o of waiting) if (o.id.startsWith('local:')) void forgetFile(o.id);
      }
      for (const m of messagesRef.current) {
        if (m.peer === room && m.file) void forgetFile(m.id);
      }
      setMessages((prev) => {
        const next = prev.filter((m) => m.peer !== room);
        if (next.length !== prev.length) {
          messagesRef.current = next;
          save(k('messages'), next);
        }
        return next;
      });
      setReadAt((prev) => {
        if (!(room in prev)) return prev;
        const { [room]: _, ...next } = prev;
        save(k('readAt'), next);
        return next;
      });
      if (isGroup(room)) {
        saveGroups((prev) => (prev.some((g) => g.id === room) ? prev.filter((g) => g.id !== room) : prev));
      }
    },
    [saveBox, saveGroups],
  );

  const deleteMessage = useCallback(
    (id: string) => {
      deletedRef.current.add(id);
      const kept = [...deletedRef.current].slice(-MAX_DELETED_IDS);
      deletedRef.current = new Set(kept);
      save(k('deleted'), kept);
      if (outbox.current.some((o) => o.id === id)) {
        saveBox(outbox.current.filter((o) => o.id !== id));
        if (id.startsWith('local:')) void forgetFile(id);
      }
      const target = messagesRef.current.find((m) => m.id === id);
      if (target?.file) void forgetFile(id);
      setMessages((prev) => {
        const next = prev.filter((m) => m.id !== id);
        if (next.length !== prev.length) {
          messagesRef.current = next;
          save(k('messages'), next);
        }
        return next;
      });
    },
    [saveBox],
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
    (sk: Uint8Array): Bundle => ({ v: 1, secretHex: bytesToHex(sk), myName, contacts, groups, blocked }),
    [myName, contacts, groups, blocked],
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
    registration,
    trusted,
    inviteCode,
    registerWith,
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
    blocked,
    block,
    unblock,
    report,
    createGroup,
    messages,
    deleteMessage,
    start,
    startWithoutPasskey,
    makeTransferLink,
    unlock,
    addContact,
    removeContact,
    deleteChat,
    myName,
    setMyName,
    myAvatar,
    setMyAvatar,
    send,
    sendPhoto,
    sendFile,
    sendVoice,
    forwardFile,
    stamps,
    makeStamp,
    addStamp,
    removeStamp,
    sendStamp,
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
