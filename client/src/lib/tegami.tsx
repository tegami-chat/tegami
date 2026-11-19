import * as nip17 from 'nostr-tools/nip17';
import * as nip19 from 'nostr-tools/nip19';
import * as nip59 from 'nostr-tools/nip59';
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { accounts, describeAccount, readyAccounts, removeAccountHere } from './accounts';
import { FEEDBACK_NAME, FEEDBACK_PUBKEY } from './feedback';
import { AI_DRAFT_ASK_KIND, AI_DRAFT_KIND, draftAsk, parseDraft, wrapExpiring } from './ai-draft';
import { pairWrap } from './ai-pair';
import { OWNER_CARD_KIND, OWNER_CARD_RENEW, aiSelfOf, ownerCardTemplate, ownerOfMessage, type AiSelf, type OwnerMark } from './ai-owner';
import { aiReadable, chatNoAi, keptFromAi, myNoAi, nothingToRead, profileNoAi, saveMyNoAi, withNoAi, type NothingToRead } from './ai-optout';
import {
  aiStageAllows,
  aiWidened,
  askAi,
  checkAi,
  decideAi,
  gateAi,
  getAiPermissions,
  loadAiSent,
  logAiStop,
  overAiLimit,
  recordAiSent,
  endAiGrants,
  removePeerAi,
  stopAllAi,
  type GrantEnd,
} from './ai-permissions';
import {
  AI_ACTION_KINDS,
  AI_CONTACTS_ASK_KIND,
  AI_CONTACTS_KIND,
  AI_GROUP_KIND,
  AI_PEER_ASK_KIND,
  AI_PEER_RESULT_KIND,
  AI_SEND_ASK_KIND,
  AI_SEND_RESULT_KIND,
  PEER_AI_DAILY_LIMIT,
  AI_STOP_KIND,
  aiOf,
  aiTag,
  applyAiGroup,
  approvedAis,
  everyoneIn,
  freshAsk,
  groupOfAiMessage,
  handledAsk,
  loadAiGroups,
  loadProposals,
  markHandled,
  myAiMayRead,
  parseAiGroup,
  parsePeerAsk,
  parseSendAsk,
  rememberPeerAi,
  saveProposals,
  type AiGroups,
  type AiProposal,
} from './ai-actions';
import { clearNewMark } from './sw-store';
import { createDeviceVault, deviceVaultAvailable, openDeviceVault, type DeviceVault } from './device-vault';
import { setCrashReports } from './crash';
import { MAX_FILE_BYTES, deleteStampFile, encryptAndUpload, fileFromRumor, fileTags, forgetFile, isKeptStamp, isStampRumor, keepSent, keptFile, openFile, sealLegacyFiles, shrinkAvatar, shrinkImage, shrinkStamp, uploadStamp, validFileName, validFileRef, type FileRef } from './files';
import { backoff, loadOutbox, publishOne, saveOutbox, type Outgoing } from './outbox';
import { k, keyFor, load, remove, save, storageAccount } from './storage';
import { openAtRest } from './at-rest';
import { replaceAiPermissions, useAiPermissions } from './ai-permissions';
import { downloadHistory, uploadHistory } from './history';
import {
  ACCOUNT_SYNC_KIND,
  SYNC_RESEND_SECONDS,
  cleanEntries,
  ledgerForBundle,
  materialize,
  merge,
  readSyncPart,
  stamp,
  stampAll,
  syncParts,
  type AccountLists,
  type Ledger,
  type Section,
} from './own-sync';
import { bundleSecret, cleanStamps, sendTransfer, type Bundle } from './transfer';
import { disablePush, enablePush, refreshPush, replaceSubscription, type PushState } from './push';
import { SIGNAL_KIND, freshSignal, wrapQuiet, wrapSignal } from './signal';
import { BackupGoneError, type BackupRef, clearLocal, deleteBackup, deriveKeys, loadLocal, makeCode, putBackup, recoveryOnHere, saveLocal, takeRestoredKeys } from './recovery';
import { createVault, unlockVault, type Vault } from './vault';
import { TURNSTILE_SITEKEY, askRelay, forgetInviteCode, keptInviteCode, type Registration } from './register';
import { signedFetch } from './relay-http';
import { STUN, iceServers } from './turn';
import { GROUP_KIND, GROUP_TAG, acceptsMessage, applyGroupState, canManage, changeText, earlierJoin, everyone, gidOf, groupRoom, groupTagOf, newGid, parseGroupState, stateOf, type GroupMode, type GroupOp } from './groups';

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
  /** A line about a change to the group (someone added, the name changed). text holds it. */
  notice?: true;
  /** Written by an AI in the sender's name (lib/ai-actions.ts): shown as「AIが書いた」. */
  ai?: { pubkey: string; model?: string; name?: string };
  /** Never given to an AI: marked「AIに読ませない」or meant not to stay (lib/ai-optout.ts). */
  noai?: true;
};

/** done: we talked. missed: they called, I did not answer. unanswered: I called, no answer. */
export type CallRecord = { video: boolean; result: 'done' | 'missed' | 'unanswered'; seconds?: number };

/** A reply draft from an AI friend, answering my ask `re` (lib/ai-draft.ts). Never a message. */
export type AiDraft = { ai: string; re: string; text: string };

/** Thrown when the AI gate does not let this AI read this friend's chat. */
export class AiNotAllowedError extends Error {}
/** Thrown when the AI gate wants the person to confirm this one ask first (askAiDraft with confirmed). */
export class AiConfirmNeededError extends Error {}
/** Thrown when nothing in the chat may be given to the AI (lib/ai-optout.ts): reason says why. */
export class AiNothingToReadError extends Error {
  constructor(public reason: NothingToRead) {
    super(reason);
  }
}

/** A call signal from someone (or from my other device: from === me). See lib/signal.ts. */
export type Signal = { id: string; from: string; to: string; at: number; data: Record<string, unknown> };

/** Rumor kind for a private profile card (Tegami's own, not a standard NIP). */
export const PROFILE_KIND = 10100;

/**
 * model: for an AI friend, which company's which model as its invite link said (always shown,
 * philosophy #93, but only what the AI says of itself). mine: my own AI. Set only when I paired
 * with it by its QR code or chose it in its screen, and synced to my other devices. Only an AI
 * with this mark may ask this app for anything (lib/ai-actions.ts); a model name never counts.
 *
 * noai: this friend keeps their words away from my AI (from their profile card, lib/ai-optout.ts).
 *
 * owner: for an AI friend, who signed this AI's key as theirs (lib/ai-owner.ts), from the card on
 * the AI's own newest message. Checked with the owner's key; kept on this device only. An empty
 * pubkey means the AI's newest message said "no owner" (at is that message's time).
 *
 * self: for an AI friend, what its newest own message says of it: the name its maker gave it and
 * the model that wrote its last reply. Its own word. Kept on this device only.
 */
export type Contact = { pubkey: string; name: string; model?: string; avatar?: FileRef; mine?: true; noai?: true; owner?: OwnerMark; self?: AiSelf };

/** My own AI (the mark I set), not someone who only says they are an AI. */
export const isMyAi = (c: Contact) => c.mine === true;
/** A person: not an AI by its own word, and not my AI. */
export const isPerson = (c: Contact) => !c.model && !c.mine;

/** A stamp in my list (`k('stamps')`): an uploaded file and when it was uploaded (unix seconds). */
// uploadedAt: only stamps from before the stamp storage (2026-11-15) have it; they are moved
// into the stamp storage when the app opens (see keepStamps).
export type Stamp = FileRef & { uploadedAt?: number };
/** My stamp list, sent quietly to my own key so my other devices show the same list (Tegami's own kind). */
export const STAMPS_KIND = 10101;
/** How many recently used stamps the stamp panel shows first. */
export const RECENT_STAMPS = 8;

/**
 * A group chat. members: the other people in it (not me). Without gid it is a NIP-17 group: a
 * fixed set of people (id = their keys), and a different set is a different chat. With gid it is
 * a Tegami group (id = `g-<gid>`) that stays the same chat when members change (lib/groups.ts).
 */
export type Group = {
  id: string;
  name: string;
  members: string[];
  gid?: string;
  /** admin: only admins change it. open: any member does (philosophy #86). */
  mode?: GroupMode;
  admins?: string[];
  avatar?: FileRef;
  /** The time and rumor id of the state I have (the newest wins). */
  v?: number;
  vid?: string;
  /** When I was added: earlier messages are not shown. */
  since?: number;
  /** People who were in it and are not any more. */
  past?: string[];
  /** I am no longer in it (removed by someone). */
  left?: true;
  /** The line the chat shows for the state I have (to show it again if it was lost). */
  note?: string;
};

/** The chat id for a set of other participants. */
export function roomOf(members: string[]) {
  return [...new Set(members)].sort().join(',');
}
export function isGroup(room: string) {
  return room.includes(',') || gidOf(room) !== null;
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
export type RegistrationState = 'checking' | 'needed' | 'ok' | 'blocked' | 'deleted';

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
  const theirTexts = all.filter((m) => m.peer === room && m.from === pubkey && !m.file && !m.call && !m.notice && m.text);
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
  /**
   * Makes a group with these contacts and returns its chat id. With admin, only admins (me at
   * first) may change who is in it; otherwise anyone in it may (philosophy #86).
   */
  createGroup: (name: string, members: string[], admin?: boolean) => string;
  /** Adds people to a group (lib/groups.ts). They do not get the messages from before. */
  addGroupMembers: (room: string, pubkeys: string[]) => void;
  /** Takes someone out of a group. */
  removeGroupMember: (room: string, pubkey: string) => void;
  /** Makes someone in a group with admins an admin too. */
  makeGroupAdmin: (room: string, pubkey: string) => void;
  /** Changes a group's name. */
  renameGroup: (room: string, name: string) => void;
  /** Changes (or with null removes) a group's picture. */
  setGroupAvatar: (room: string, photo: Blob | null) => Promise<void>;
  /** Leaves a group: the others are told, and the chat is removed from this device. */
  leaveGroup: (room: string) => void;
  /** My own name, shared through my invite link. Stays on this device otherwise. */
  myName: string;
  setMyName: (name: string) => void;
  /** My「自分の文を相手のAIに読ませない」(lib/ai-optout.ts). Told to friends, synced to my devices. */
  myNoAi: boolean;
  setMyNoAi: (on: boolean) => Promise<void>;
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
  /** My stamps, in my order. Kept per account, and the same on all my devices. */
  stamps: Stamp[];
  /** My stamps I sent most recently on this device, newest first. */
  recentStamps: Stamp[];
  /** Moves a stamp to the front of my stamps. */
  moveStampToFront: (sha256: string) => void;
  /** Shrinks an image, encrypts and uploads it, and adds it to my stamps. */
  makeStamp: (image: Blob) => Promise<Stamp>;
  /** Adds someone else's stamp to my stamps: the image is fetched and kept again as my own. */
  addStamp: (file: FileRef) => Promise<void>;
  /** Removes a stamp from my stamps (and from the stamp storage). */
  removeStamp: (sha256: string) => void;
  /** Sends a stamp (one from before the stamp storage is moved there first). */
  sendStamp: (peer: string, stamp: Stamp, replyTo?: string) => Promise<void>;
  /** Turns notifications for this device on or off. Returns the new state. */
  setNotifications: (on: boolean) => Promise<PushState>;
  /** Sends a call signal to one person, and to my other devices when alsoMe. */
  sendSignal: (to: string, data: Record<string, unknown>, alsoMe?: boolean) => Promise<void>;
  /** Where a call looks for a path (STUN, plus TURN when the relay hands out credentials). Never throws. */
  callIceServers: () => Promise<RTCIceServer[]>;
  /**
   * Asks an AI friend for a reply draft in a 1:1 chat with a friend. The gate must allow both
   * reading and drafting (each logged); else throws AiNotAllowedError. When the gate wants the
   * person asked first, throws AiConfirmNeededError until called again with confirmed.
   * Returns the ask's id.
   */
  askAiDraft: (ai: string, friend: string, confirmed?: boolean) => Promise<string>;
  /** Answers the one-time code in an AI's invite link (lib/ai-pair.ts): the AI then replies to me. */
  pairAi: (ai: string, code: string, myInvite: string) => Promise<void>;
  /** Listens for drafts coming back from AI friends. Returns the function that stops listening. */
  onAiDraft: (fn: (d: AiDraft) => void) => () => void;
  /** Messages my AI friends wrote for a friend, waiting for me to press 送る (lib/ai-actions.ts). */
  aiProposals: AiProposal[];
  /** Sends a waiting AI message in my name (the gate is asked again). False when the gate stops it. */
  acceptAiProposal: (id: string) => Promise<boolean>;
  declineAiProposal: (id: string) => void;
  /** AIs invited to my groups, and every member's answer (philosophy #72). */
  aiGroups: AiGroups;
  /** The people an AI in this chat is agreed with: everyone but me (for a g-<gid> group, its members now). */
  aiMembersOf: (room: string) => string;
  /** Invites one of my AI friends into a group chat. Every member must say yes. */
  inviteAiToGroup: (room: string, ai: string) => Promise<void>;
  /** Says yes or no (or takes a yes back) to an AI in a group chat. */
  answerAiInGroup: (room: string, ai: string, yes: boolean) => Promise<void>;
  /** Takes back my AI's permission to talk to another person's AI, and tells my AI. */
  revokePeerAi: (ai: string, peer: string) => Promise<void>;
  /** Marks a friend as my own AI (only my AIs may ask this app for anything), or takes the mark away. */
  setMyAi: (pubkey: string, on: boolean) => void;
  /** すべてオフにする: every AI switch off, other AIs' permissions taken back, and my AIs told to stop. */
  stopAi: () => Promise<void>;
  /** When my other device last let AIs do more; 0 once I have seen it. */
  aiWidenedAt: number;
  seenAiWidened: () => void;
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
  /**
   * Removes an account (the open one when no id is given) from this device only: it stays on
   * other devices and on the relay. Removing the open one opens another, or the first screen.
   */
  removeFromDevice: (id?: string) => Promise<void>;
  /**
   * Deletes the open account everywhere: the recovery backup, everything the relay keeps under
   * the key (DELETE /account), then this device's copy. Throws when the relay did not confirm.
   */
  deleteAccount: () => Promise<void>;
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
  return contacts.find((c) => c.pubkey === pubkey)?.name ?? (pubkey === FEEDBACK_PUBKEY ? FEEDBACK_NAME : shortId(pubkey));
}

/** What to call a chat: the contact, the group's name, or its members' names. */
export function chatName(room: string, contacts: Contact[], groups: Group[]) {
  if (!isGroup(room)) return personName(room, contacts);
  const g = groups.find((x) => x.id === room);
  return g?.name || (g ? g.members : room.split(',')).map((k) => personName(k, contacts)).join('、');
}

/** Chats that are neither a contact nor a group I know, newest first. */
export function strangers(contacts: Contact[], messages: Message[], groups: Group[] = [], blocked: string[] = []) {
  // The chat with Tegami's official account ("Tegamiへの意見") is never a stranger's.
  const known = new Set([...contacts.map((c) => c.pubkey), ...groups.map((g) => g.id), ...blocked, FEEDBACK_PUBKEY]);
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
    if (m.notice) continue;
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
  // What AI friends may do: moves with the account, and a change rewrites the recovery backup.
  const aiPermissions = useAiPermissions();
  const [messages, setMessages] = useState<Message[]>([]);
  const [myName, setMyNameState] = useState('');
  const myNameRef = useRef('');
  myNameRef.current = myName;
  const [myAvatar, setMyAvatarState] = useState<FileRef | null>(null);
  const myAvatarRef = useRef<FileRef | null>(null);
  myAvatarRef.current = myAvatar;
  // My「自分の文を相手のAIに読ませない」(lib/ai-optout.ts): in my profile card and my ledger.
  const [myNoAiState, setMyNoAiState] = useState(false);
  const myNoAiRef = useRef(false);
  myNoAiRef.current = myNoAiState;
  const [stamps, setStamps] = useState<Stamp[]>([]);
  const stampsRef = useRef<Stamp[]>([]);
  stampsRef.current = stamps;
  const [stampsUsed, setStampsUsed] = useState<Record<string, number>>({});
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
  // When each friend, group, block and AI switch last changed on any of my devices (lib/own-sync.ts).
  const ledgerRef = useRef<Ledger | null>(null);
  // A ledger from my other device: applied by the code below the receiving effect.
  const applySyncRef = useRef<(remote: Ledger) => void>(() => {});
  // My「AIに読ませない」as my other device changed it (set by the code after setMyNoAi).
  const takeMyNoAiRef = useRef<(on: boolean) => void>(() => {});

  // What the account keeps on this device (messages, friends, groups …) is encrypted with a key
  // made from its secret key (lib/at-rest.ts). So it can be read only once the secret key is
  // here: this opens the encrypted records and puts what they hold on the screen. Everything
  // that sets the secret key calls it first, and sets the secret key only after it finishes, so
  // nothing can be saved from a screen that has not loaded yet.
  const loadPrivate = useCallback(async (sk: Uint8Array) => {
    await openAtRest(storageAccount(), sk);
    const loadedContacts = load<Contact[]>(k('contacts'), []);
    contactsRef.current = loadedContacts;
    setContacts(loadedContacts);
    const loadedGroups = load<Group[]>(k('groups'), []);
    setGroups(loadedGroups);
    const loadedAvatar = load<FileRef | null>(k('avatar'), null);
    myAvatarRef.current = loadedAvatar;
    setMyAvatarState(loadedAvatar);
    const loadedStamps = load<Stamp[]>(k('stamps'), []);
    setStamps(loadedStamps);
    setStampsUsed(load<Record<string, number>>(k('stampsUsed'), {}));
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
    // Leaving a group has no message left on this device (lib/groups.ts), but must still go.
    outbox.current = box.filter((o) => ids.has(o.id) || o.peer.endsWith('#leave'));
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
    ledgerRef.current = load<Ledger | null>(k('sync'), null);
    clearedRef.current = load<Record<string, number>>(k('cleared'), {});
    // What my AI friends asked for and the AIs in groups (lib/ai-actions.ts) are encrypted too.
    setAiGroups(loadAiGroups());
    setAiProposals(loadProposals());
    // Photos kept before they were encrypted are encrypted now (lib/files.ts).
    const fileIds: string[] = [];
    for (const m of stored) if (m.file) fileIds.push(m.id);
    for (const o of box) if (o.photo) fileIds.push(o.id);
    for (const st of loadedStamps) if (st.sha256) fileIds.push(`stamp:${st.sha256}`);
    for (const c of loadedContacts) if (c.avatar?.sha256) fileIds.push(`avatar:${c.avatar.sha256}`);
    for (const g of loadedGroups) if (g.avatar?.sha256) fileIds.push(`avatar:${g.avatar.sha256}`);
    if (loadedAvatar?.sha256) fileIds.push(`avatar:${loadedAvatar.sha256}`);
    void sealLegacyFiles(
      fileIds,
      readyAccounts().map((a) => a.id),
    );
  }, []);

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
      // The secret key is here (no passkey, or the device key): load what it protects first.
      // With a passkey it is not here yet, and unlock() does this once the passkey is used.
      if (sk) await loadPrivate(sk);
      if (!alive) return;
      setVault(v);
      if (sk) setSecret(sk);
      myNoAiRef.current = myNoAi();
      setMyNoAiState(myNoAiRef.current);
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
  }, [loadPrivate]);

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

  // Group states (lib/groups.ts), handled further down; the receiver calls it through this ref.
  const takeGroupStateRef = useRef<(rumor: { id: string; pubkey: string; created_at: number; content: string }) => string | null>(() => null);
  // Messages of a group I do not know yet wait here for its state (envelopes come in any order).
  const waitingForGroup = useRef(new Map<string, Parameters<typeof nip17.unwrapEvent>[0][]>());
  const deleteChatRef = useRef<(room: string) => void>(() => {});

  // Call signals go to whoever listens (lib/calls.tsx). Each is handled once.
  const signalListeners = useRef(new Set<(s: Signal) => void>());
  const seenSignals = useRef(new Set<string>());
  const onSignal = useCallback((fn: (s: Signal) => void) => {
    signalListeners.current.add(fn);
    return () => {
      signalListeners.current.delete(fn);
    };
  }, []);

  // Drafts from AI friends go to whoever listens (the chat screen that asked).
  const draftListeners = useRef(new Set<(d: AiDraft) => void>());
  const onAiDraft = useCallback((fn: (d: AiDraft) => void) => {
    draftListeners.current.add(fn);
    return () => {
      draftListeners.current.delete(fn);
    };
  }, []);

  // ---------- what AI friends ask this app to do (lib/ai-actions.ts) ----------
  const [aiGroups, setAiGroups] = useState<AiGroups>({});
  const aiGroupsRef = useRef<AiGroups>(aiGroups);
  aiGroupsRef.current = aiGroups;
  const [aiProposals, setAiProposals] = useState<AiProposal[]>([]);
  const aiProposalsRef = useRef<AiProposal[]>(aiProposals);
  // When my other device last let AIs do more (lib/ai-permissions.ts aiWidened); 0 when seen.
  const [aiWidenedAt, setAiWidenedAt] = useState(() => load<number>(k('ai.widened'), 0));
  aiProposalsRef.current = aiProposals;
  // Set below, once the functions it needs exist: handles an AI ask or a group answer.
  const aiRumorRef = useRef<(rumor: ReturnType<typeof nip59.createRumor>) => void>(() => {});
  /**
   * The AIs a group message also goes to: every member said yes (as far as this device knows).
   * One of my own AI friends also needs my switches to let it read at all.
   */
  /**
   * AIs in a group are keyed by the people in it (lib/ai-actions.ts): everyone but me, sorted and
   * joined with ','. For a Tegami group (g-<gid>) that is its members now, so when someone is
   * added or removed, every member has to say yes again before the AI gets anything more.
   */
  const aiMembersOf = useCallback(
    (room: string) => {
      if (!gidOf(room)) return room;
      const g = groupsRef.current.find((x) => x.id === room);
      if (!g || g.left || !me) return '';
      return [...new Set(g.members)].filter((m) => m !== me).sort().join(',');
    },
    [me],
  );
  /** The Tegami group (g-<gid>) I am in whose members, but me, are exactly these people. */
  const tegamiGroupOfMembers = useCallback(
    (members: string) => groupsRef.current.find((g) => g.gid && !g.left && aiMembersOf(g.id) === members)?.id ?? null,
    [aiMembersOf],
  );
  const groupAiCopies = useCallback(
    (room: string) => {
      if (!me) return [];
      const key = aiMembersOf(room);
      if (!key) return [];
      // AI in a group is a later stage (lib/ai-permissions.ts AI_STAGE): no copies at all.
      if (!aiStageAllows('group')) return [];
      const p = getAiPermissions();
      return approvedAis(aiGroupsRef.current, key, me).filter((ai) => {
        const mine = contactsRef.current.find((c) => c.pubkey === ai && isMyAi(c));
        return !mine || myAiMayRead(p, mine);
      });
    },
    [me, aiMembersOf],
  );

  // Ids of my messages built with the noai tag, so the chat shows the mark at once.
  const noAiSent = useRef(new Set<string>());
  const addMessage = useCallback((m0: Message) => {
    const m: Message = !m0.noai && noAiSent.current.has(m0.id) ? { ...m0, noai: true } : m0;
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
            const gidHere = groupTagOf(rumor.tags);
            const inGroup = gidHere ? groupsRef.current.some((g) => g.gid === gidHere) : isGroup(room) && groupsRef.current.some((g) => g.id === room);
            if (!known && !inGroup && rumor.kind !== GROUP_KIND) return;
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
          if (AI_ACTION_KINDS.includes(rumor.kind)) {
            aiRumorRef.current(rumor);
            return;
          }
          if (rumor.kind === AI_DRAFT_KIND) {
            // Only from an AI friend; the chat screen matches it to the ask it made.
            if (!contactsRef.current.some((c) => c.pubkey === rumor.pubkey && isMyAi(c))) return;
            const d = parseDraft(rumor.content);
            if (d) for (const fn of draftListeners.current) fn({ ai: rumor.pubkey, ...d });
            return;
          }
          if (rumor.kind === STAMPS_KIND) {
            // My list from my other device. The newest list wins.
            if (rumor.pubkey !== me) return;
            if (rumor.created_at <= load<number>(k('stampsAt'), 0)) return;
            const list = cleanStamps((JSON.parse(rumor.content) as { stamps?: unknown })?.stamps);
            save(k('stampsAt'), rumor.created_at);
            save(k('stamps'), list);
            stampsRef.current = list;
            setStamps(list);
            for (const st of list) void openFile(`stamp:${st.sha256}`, st).catch(() => {});
            return;
          }
          if (rumor.kind === ACCOUNT_SYNC_KIND) {
            // My friends, groups, blocks and AI switches from my other device: merged entry by entry.
            if (rumor.pubkey !== me) return;
            const remote = readSyncPart(rumor.content);
            if (remote) applySyncRef.current(remote);
            return;
          }
          if (rumor.kind === PROFILE_KIND) {
            if (!contactsRef.current.some((c) => c.pubkey === rumor.pubkey)) return;
            if (rumor.created_at < (profileAt.current.get(rumor.pubkey) ?? 0)) return;
            const data = JSON.parse(rumor.content) as { avatar?: unknown; noai?: unknown };
            if (!data || typeof data !== 'object') return;
            const avatar = data.avatar === null ? null : validFileRef(data.avatar);
            if (data.avatar !== null && !avatar) return;
            // A card from before「AIに読ませない」says nothing: the friend's choice stays as it was.
            const noai = profileNoAi(data);
            profileAt.current.set(rumor.pubkey, rumor.created_at);
            // Fetch it now: the file server deletes files after 30 days.
            if (avatar) void openFile(`avatar:${avatar.sha256}`, avatar).catch(() => {});
            setContacts((prev) => {
              if (!prev.some((c) => c.pubkey === rumor.pubkey)) return prev;
              const next = prev.map((c) => {
                if (c.pubkey !== rumor.pubkey) return c;
                const { avatar: _, noai: was, ...rest } = c;
                const off = noai ?? was === true;
                return { ...rest, ...(avatar ? { avatar } : {}), ...(off ? { noai: true as const } : {}) };
              });
              contactsRef.current = next;
              save(k('contacts'), next);
              return next;
            });
            return;
          }
          if (rumor.kind === GROUP_KIND) {
            const room = takeGroupStateRef.current(rumor);
            // Messages of this group that came before its state.
            const gid = room ? gidOf(room) : null;
            const waiting = gid ? waitingForGroup.current.get(gid) : undefined;
            if (gid && waiting) {
              waitingForGroup.current.delete(gid);
              for (const w of waiting) onevent(w);
            }
            return;
          }
          if (rumor.kind !== 14 && rumor.kind !== 15) return;
          const gid = groupTagOf(rumor.tags);
          let aiInGid = false;
          if (gid) {
            const g = groupsRef.current.find((x) => x.gid === gid);
            if (!g) {
              const list = waitingForGroup.current.get(gid) ?? [];
              if (list.length < 200) waitingForGroup.current.set(gid, [...list, wrap]);
              return;
            }
            if (!acceptsMessage(g, rumor.pubkey, rumor.created_at, me)) {
              // An AI every member said yes to (lib/ai-actions.ts) is not a member, but may write here.
              if (g.left || !approvedAis(aiGroupsRef.current, aiMembersOf(g.id), me).includes(rumor.pubkey)) return;
              aiInGid = true;
            }
          }
          const file = rumor.kind === 15 ? fileFromRumor(rumor.content, rumor.tags) : undefined;
          if (file === null) return;
          const stamp = file && isStampRumor(rumor.tags) ? true : undefined;
          // Everyone in the chat except me: the author and every p tag.
          const others = [rumor.pubkey, ...rumor.tags.filter((t) => t[0] === 'p').map((t) => t[1])].filter(
            (k) => /^[0-9a-f]{64}$/.test(k) && k !== me,
          );
          if (!others.length) return;
          let peer = gid ? groupRoom(gid) : roomOf(others);
          // Written by an AI in a group (lib/ai-actions.ts): it belongs to the group of the people
          // it was written for, and only while every member has said yes. The AI writes to the
          // members (p tags) without the group's tag, so a Tegami group (g-<gid>) whose members
          // are those people now takes it.
          if (rumor.pubkey !== me && !aiInGid) {
            const g = groupOfAiMessage(aiGroupsRef.current, rumor.pubkey, others.filter((x) => x !== rumor.pubkey), me);
            if (g === 'drop') return;
            if (g) peer = tegamiGroupOfMembers(g) ?? g;
          }
          // A deleted chat or message: the relay still holds its envelopes for 30 days and hands
          // them out again on the next start. Messages up to the moment of deleting stay gone.
          if (rumor.created_at <= (clearedRef.current[peer] ?? 0) || deletedRef.current.has(rumor.id)) return;
          const replyTo = replyOf(rumor.tags);
          // Written by an AI in the sender's name (not an AI writing as itself).
          const byAi = rumor.kind === 14 ? aiOf(rumor.tags) : undefined;
          const writtenByAi = byAi && byAi.pubkey !== rumor.pubkey ? byAi : undefined;
          // An AI friend writing as itself: its owner's card, or none (concern 4).
          if (byAi && byAi.pubkey === rumor.pubkey && rumor.pubkey !== me) takeOwnerRef.current(rumor.pubkey, rumor.tags, rumor.created_at);
          if (isGroup(peer) && !gidOf(peer)) {
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
            ...(writtenByAi ? { ai: writtenByAi } : {}),
            ...(keptFromAi(rumor.tags) ? { noai: true as const } : {}),
          };
          if (rumor.pubkey !== me) m.got = Date.now();
          // My other device already sent what my AI asked: the same waiting message here goes.
          if (rumor.pubkey === me && writtenByAi && aiProposalsRef.current.length) {
            const left = aiProposalsRef.current.filter((x) => !(x.ai === writtenByAi.pubkey && x.to === peer && x.text === rumor.content));
            if (left.length !== aiProposalsRef.current.length) {
              aiProposalsRef.current = left;
              saveProposals(left);
              setAiProposals(left);
            }
          }
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
    if (r.deleted) {
      setRegistration('deleted');
      return;
    }
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
        if (r.member || r.banned || r.deleted) applyRegistration(r);
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
    // Nothing of an earlier account on this browser is synced either.
    ledgerRef.current = null;
    remove(k('sync'));
    remove(k('syncSent'));
    remove(k('historyPending'));
  }, []);

  // An account restored with a recovery code keeps recovery on with the same code.
  const adopt = useCallback(async (moved: Bundle, sk: Uint8Array) => {
    save(k('myName'), moved.myName);
    save(k('contacts'), moved.contacts);
    save(k('groups'), moved.groups);
    save(k('blocked'), moved.blocked ?? []);
    save(k('stamps'), moved.stamps ?? []);
    // Lists my other devices sent before this move are older than the one it brought.
    save(k('stampsAt'), Math.floor(Date.now() / 1000));
    stampsRef.current = moved.stamps ?? [];
    setStamps(moved.stamps ?? []);
    // Keep the images on this device now, while the file server still has them. One that is
    // gone shows as expired in the stamp list and can be removed there.
    for (const st of moved.stamps ?? []) {
      void openFile(`stamp:${st.sha256}`, st).catch(() => {});
    }
    setMyNameState(moved.myName);
    setContacts(moved.contacts);
    setGroups(moved.groups);
    blockedRef.current = moved.blocked ?? [];
    setBlocked(moved.blocked ?? []);
    replaceAiPermissions(moved.ai);
    // When each item last changed, so later changes on my other devices merge in correctly.
    // Without it (an older version), what came along counts as the oldest state.
    ledgerRef.current = moved.sync ? cleanEntries(moved.sync) : null;
    // My「自分の文を相手のAIに読ませない」comes along in the ledger (lib/ai-optout.ts).
    const movedNoAi = ledgerRef.current?.['p:noai']?.v === 1;
    saveMyNoAi(movedNoAi);
    myNoAiRef.current = movedNoAi;
    setMyNoAiState(movedNoAi);
    if (ledgerRef.current) save(k('sync'), ledgerRef.current);
    else remove(k('sync'));
    remove(k('syncSent'));
    // Every message of the old device, fetched once the account is open (lib/history.ts).
    if (moved.history?.length) save(k('historyPending'), moved.history);
    else remove(k('historyPending'));
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
      // Open the encrypted records first: adopt() and the code after it save into them.
      await openAtRest(storageAccount(), sk);
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
      await openAtRest(storageAccount(), sk);
      if (moved) await adopt(moved, sk);
      else forgetRecovery();
      beginAccount();
      setSecret(sk);
    },
    [adopt, forgetRecovery, beginAccount],
  );

  const makeTransferLink = useCallback(async () => {
    if (!secret || !pool.current || !authRef.current) throw new Error('not open');
    // Stamps from before the stamp storage are moved there first, so the new device can fetch them.
    const fresh = await keepStampsRef.current();
    // Every message here, not only the relay's last 30 days. When the upload fails, the account still moves.
    const history = await uploadHistory(
      { messages: messagesRef.current, cleared: clearedRef.current, deleted: [...deletedRef.current] },
      secret,
    ).catch(() => []);
    const bundle: Bundle = {
      v: 1,
      secretHex: bytesToHex(secret),
      myName,
      contacts,
      groups,
      blocked,
      ai: aiPermissions,
      stamps: fresh,
      sync: ledgerForBundle(ledgerRef.current),
      ...(history.length ? { history } : {}),
    };
    return sendTransfer(pool.current, RELAYS, authRef.current, bundle, globalThis.location?.origin ?? APP_ORIGIN);
  }, [secret, myName, contacts, groups, blocked, aiPermissions]);

  const unlock = useCallback(async () => {
    if (!vault) return;
    const sk = await unlockVault(vault);
    // What the passkey protects is read now, before anything can save (see loadPrivate).
    await loadPrivate(sk);
    setSecret(sk);
  }, [vault, loadPrivate]);

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
      // noai: my「自分の文を相手のAIに読ませない」(lib/ai-optout.ts), always said, on or off.
      const content = JSON.stringify({ avatar, noai: myNoAiRef.current });
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

  /**
   * My「自分の文を相手のAIに読ませない」(lib/ai-optout.ts): kept here, written into my ledger for
   * my other devices (the effect below stampSection), and told to every friend in my profile card.
   */
  const setMyNoAi = useCallback(
    async (on: boolean) => {
      saveMyNoAi(on);
      myNoAiRef.current = on;
      setMyNoAiState(on);
      await sendProfileTo(
        contactsRef.current.filter((c) => !c.model).map((c) => c.pubkey),
        myAvatarRef.current,
      );
    },
    [sendProfileTo],
  );
  takeMyNoAiRef.current = (on: boolean) => {
    saveMyNoAi(on);
    myNoAiRef.current = on;
    setMyNoAiState(on);
  };

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
        const next = [...rest, { pubkey, name, ...(m ? { model: m } : {}), ...(avatar ? { avatar } : {}), ...(old?.mine ? { mine: true as const } : {}), ...(old?.owner ? { owner: old.owner } : {}), ...(old?.self ? { self: old.self } : {}) }];
        contactsRef.current = next;
        save(k('contacts'), next);
        return next;
      });
      if (myAvatarRef.current || myNoAiRef.current) void sendProfileTo([pubkey], myAvatarRef.current);
    },
    [sendProfileTo],
  );

  /** Marks a friend as my own AI, or takes the mark away (synced to my other devices). */
  const setMyAi = useCallback((pubkey: string, on: boolean) => {
    setContacts((prev) => {
      const old = prev.find((c) => c.pubkey === pubkey);
      if (!old || !!old.mine === on) return prev;
      const { mine: _, ...rest } = old;
      const next = prev.map((c) => (c.pubkey === pubkey ? (on ? { ...rest, mine: true as const } : rest) : c));
      contactsRef.current = next;
      save(k('contacts'), next);
      return next;
    });
  }, []);

  /**
   * Ends the permissions one AI was given for a while (lib/ai-permissions.ts endAiGrants) and tells
   * the AI which other AIs it may no longer talk to. Set below, once tellAi exists.
   */
  const endGrantsRef = useRef<(ai: string, why: GrantEnd) => void>(() => {});

  // A permission given for a while holds only while the AI stays my AI and my friend. Watching the
  // list (not only setMyAi and removeContact) also catches a change synced from my other devices.
  // Kept per account: switching accounts or closing one is not removing friends.
  const grantsSeenRef = useRef<{ me: string; contacts: Contact[] } | null>(null);
  useEffect(() => {
    const before = grantsSeenRef.current;
    grantsSeenRef.current = me ? { me, contacts } : null;
    if (!me || !before || before.me !== me) return;
    for (const old of before.contacts) {
      const now = contacts.find((c) => c.pubkey === old.pubkey);
      if (!now) endGrantsRef.current(old.pubkey, 'removed');
      else if (isMyAi(old) && !isMyAi(now)) endGrantsRef.current(old.pubkey, 'unmarked');
    }
  }, [me, contacts]);

  /**
   * The owner a message from AI friend `ai` shows (lib/ai-owner.ts). Only a message newer than the
   * card kept here changes it, so the relay handing out older messages again changes nothing.
   */
  const takeOwnerRef = useRef<(ai: string, tags: string[][], at: number) => void>(() => {});
  takeOwnerRef.current = (ai, tags, at) => {
    const c = contactsRef.current.find((x) => x.pubkey === ai);
    if (!c) return;
    const self = aiSelfOf(tags, ai, at);
    // The AI now says it runs another model: what was allowed for a while was allowed to the old one.
    if (self?.running && c.self?.running && at > c.self.at && self.running !== c.self.running) endGrantsRef.current(ai, 'model');
    if (self && at > (c.self?.at ?? 0) && (self.name !== c.self?.name || self.running !== c.self?.running)) {
      const next = contactsRef.current.map((x) => (x.pubkey === ai ? { ...x, self } : x));
      contactsRef.current = next;
      save(k('contacts'), next);
      setContacts(next);
    }
    const cur = contactsRef.current.find((x) => x.pubkey === ai)!;
    const said = ownerOfMessage(tags, ai);
    if (said === undefined) return;
    if (said === 'none' ? at <= (cur.owner?.at ?? 0) : said.at <= (cur.owner?.at ?? 0)) return;
    // "No owner" is kept as a mark with no owner and the message's time: the relay hands out the
    // older message with the card again on the next start, and that card must not come back.
    if (said === 'none' && (!cur.owner || !cur.owner.pubkey)) return;
    if (said !== 'none' && cur.owner?.pubkey === said.pubkey && cur.owner.until === said.until) return;
    const owner: OwnerMark = said === 'none' ? { pubkey: '', at, until: 0 } : said;
    // The AI no longer says I am its owner: what I allowed it for a while ends here.
    if (me && cur.owner?.pubkey === me && owner.pubkey !== me) endGrantsRef.current(ai, 'owner');
    const next = contactsRef.current.map((x) => (x.pubkey === ai ? { ...x, owner } : x));
    contactsRef.current = next;
    save(k('contacts'), next);
    setContacts(next);
  };

  // My signature on each of my AIs' keys (lib/ai-owner.ts): a new card when the mark「自分のAI」is
  // set or the last card is old, and "no card" when the mark is taken away. Which card went to
  // which AI and when is kept per account; each of my devices may send its own, which is fine.
  useEffect(() => {
    if (!secret || !pool.current || !me) return;
    const sent = load<Record<string, number>>(k('ai.ownerCards'), {});
    const now = Math.floor(Date.now() / 1000);
    const mine = new Set(contacts.filter(isMyAi).map((c) => c.pubkey));
    const tell = (ai: string, card: unknown) => {
      const rumor = nip59.createRumor({ kind: OWNER_CARD_KIND, content: JSON.stringify({ v: 1, card }), tags: [['p', ai]], created_at: now }, secret);
      return publishOne(pool.current!, RELAYS, wrapQuiet(rumor, secret, ai), authRef.current ?? undefined).catch(() => false);
    };
    // Written down only once the relay took it, so a card that did not go out is tried again.
    const note = (ai: string, at: number | null) => {
      const cur = load<Record<string, number>>(k('ai.ownerCards'), {});
      if (at === null) delete cur[ai];
      else cur[ai] = at;
      save(k('ai.ownerCards'), cur);
    };
    for (const ai of mine) {
      if (now - (sent[ai] ?? 0) < OWNER_CARD_RENEW) continue;
      void tell(ai, finalizeEvent(ownerCardTemplate(ai, now), secret)).then((ok) => ok && note(ai, now));
    }
    for (const ai of Object.keys(sent)) {
      if (!mine.has(ai)) void tell(ai, null).then((ok) => ok && note(ai, null));
    }
  }, [secret, me, contacts]);

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
      const group = groupsRef.current.find((g) => g.id === peer);
      if (gidOf(peer) && (!group?.gid || group.left)) throw new Error('not in this group');
      const members = group?.gid ? group.members : peer.split(',');
      const tags = members.map((m) => ['p', m]);
      const subject = group?.name;
      if (isGroup(peer) && subject) tags.push(['subject', subject]);
      if (group?.gid) tags.push([GROUP_TAG, group.gid]);
      // 「AIに読ませない」(lib/ai-optout.ts): my setting, this chat's switch, or the caller's mark.
      // Never in a chat with only my AI friends: those messages are written for the AI.
      const toAiOnly = members.every((m) => contactsRef.current.some((c) => c.pubkey === m && c.model));
      const noai = !toAiOnly && (myNoAiRef.current || chatNoAi(peer) || extra.some((t) => t[0] === 'noai'));
      tags.push(...(noai ? withNoAi(extra) : extra.filter((t) => t[0] !== 'noai')));
      const rumor = nip59.createRumor({ kind, content, tags, created_at: at }, secret);
      if (noai) noAiSent.current.add(rumor.id);
      // AIs every member of this chat has said yes to get a copy too (not in the p tags),
      // unless the message is kept away from AIs.
      const ais = noai ? [] : groupAiCopies(peer);
      const wraps = [...members, ...ais, me].map((to) => nip59.createWrap(nip59.createSeal(rumor, secret, to), to));
      return { rumor, wraps };
    },
    [secret, me, groupAiCopies],
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
        const { rumor, wraps } = build(
          cur.peer,
          15,
          file.url,
          [...fileTags(file), ...(cur.photo.replyTo ? replyTag(15, cur.photo.replyTo) : []), ...(cur.photo.noai ? [['noai']] : [])],
          cur.at,
        );
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

  /** Puts one group in my list now (the ref too, so what follows sees it at once). */
  const putGroup = useCallback(
    (g: Group) => {
      const next = [...groupsRef.current.filter((x) => x.id !== g.id), g];
      groupsRef.current = next;
      saveGroups(() => next);
    },
    [saveGroups],
  );
  const groupNameOf = useCallback(
    (pubkey: string) => (pubkey === me ? myNameRef.current || '自分' : personName(pubkey, contactsRef.current)),
    [me],
  );
  /** Applies a group state rumor (from anyone, me included). Returns the group's chat id when taken. */
  const takeGroupState = useCallback(
    (rumor: { id: string; pubkey: string; created_at: number; content: string }, pending?: true): string | null => {
      if (!me) return null;
      const st = parseGroupState(rumor.content, validFileRef);
      if (!st) return null;
      const room = groupRoom(st.gid);
      if (rumor.created_at <= (clearedRef.current[room] ?? 0)) return null;
      const prev = groupsRef.current.find((g) => g.id === room);
      const isFriend = (pk: string) => contactsRef.current.some((c) => c.pubkey === pk);
      const done = applyGroupState(prev, st, rumor.pubkey, rumor.created_at, rumor.id, me, isFriend);
      const notice = (text: string): Message => ({
        id: rumor.id,
        from: rumor.pubkey,
        peer: room,
        text,
        at: rumor.created_at,
        notice: true,
        ...(pending ? { pending: 'sending' as const } : {}),
      });
      if (!done) {
        const since = earlierJoin(prev, st, rumor.pubkey, rumor.created_at, me);
        if (prev && since !== null) putGroup({ ...prev, since });
        // The group was saved but its line was not (the page closed in between): the relay's
        // replay brings the same state again, so the line comes back.
        if (prev?.vid === rumor.id && prev.note && !deletedRef.current.has(rumor.id) && !messagesRef.current.some((m) => m.id === rumor.id)) {
          addMessage(notice(prev.note));
        }
        return null;
      }
      const text = changeText(done.change, groupNameOf);
      putGroup({ ...done.group, note: text });
      if (done.group.avatar) void openFile(`avatar:${done.group.avatar.sha256}`, done.group.avatar).catch(() => {});
      addMessage(notice(text));
      return room;
    },
    [me, putGroup, addMessage, groupNameOf],
  );
  takeGroupStateRef.current = (rumor) => {
    // My other device left this group: leave here too.
    const st = rumor.pubkey === me ? parseGroupState(rumor.content, validFileRef) : null;
    if (st?.op === 'leave') {
      const g = groupsRef.current.find((x) => x.gid === st.gid);
      if (g && rumor.created_at > (g.v ?? 0)) {
        deleteChatRef.current(g.id);
        groupsRef.current = groupsRef.current.filter((x) => x.id !== g.id);
        saveGroups((prev) => prev.filter((x) => x.id !== g.id));
      }
      return null;
    }
    return takeGroupState(rumor);
  };

  /**
   * Seals one change of a group for everyone in it before and after (and my devices), applies
   * it here and sends it through the outbox. `change` returns the group as it is after.
   */
  const sendGroupChange = useCallback(
    (room: string, op: GroupOp, change: (g: Group) => Group) => {
      if (!secret || !me) throw new Error('not open');
      const g = groupsRef.current.find((x) => x.id === room);
      if (!g?.gid || g.left) throw new Error('not in this group');
      if (op !== 'leave' && !canManage(g, me)) throw new Error('not an admin');
      const after = change(g);
      const at = Math.max(Math.floor(Date.now() / 1000), (g.v ?? 0) + 1);
      const st = stateOf(after, me, op);
      const rumor = nip59.createRumor({ kind: GROUP_KIND, content: JSON.stringify(st), tags: [[GROUP_TAG, g.gid]], created_at: at }, secret);
      const to = [...new Set([...everyone(g, me), ...st.members])].filter((p) => p !== me);
      // Quiet: a change is not "a new message" on everyone's phone.
      const wraps = [...to, me].map((p) => wrapQuiet(rumor, secret, p));
      if (op === 'leave') {
        // My copy goes too, so my other devices leave as well. The chat is gone here at once.
        saveBox([...outbox.current, { id: rumor.id, peer: `${room}#leave`, at, wraps, done: [] }]);
        deleteChatRef.current(room);
        groupsRef.current = groupsRef.current.filter((x) => x.id !== room);
        saveGroups((prev) => prev.filter((x) => x.id !== room));
      } else {
        if (!takeGroupState(rumor, true)) throw new Error('change not allowed');
        saveBox([...outbox.current, { id: rumor.id, peer: room, at, wraps, done: [] }]);
      }
      void flushRef.current();
    },
    [secret, me, takeGroupState, saveBox, saveGroups],
  );

  const createGroup = useCallback(
    (name: string, members: string[], admin = false) => {
      if (!secret || !me) throw new Error('not open');
      const gid = newGid();
      const id = groupRoom(gid);
      const others = [...new Set(members)].filter((p) => p !== me);
      const mode: GroupMode = admin ? 'admin' : 'open';
      const at = Math.floor(Date.now() / 1000);
      const g: Group = { id, gid, name: name.trim().slice(0, 60), members: others, mode, admins: admin ? [me] : [] };
      const st = stateOf(g, me, 'create');
      const rumor = nip59.createRumor({ kind: GROUP_KIND, content: JSON.stringify(st), tags: [[GROUP_TAG, gid]], created_at: at }, secret);
      takeGroupState(rumor, true);
      const wraps = [...others, me].map((p) => wrapQuiet(rumor, secret, p));
      saveBox([...outbox.current, { id: rumor.id, peer: id, at, wraps, done: [] }]);
      void flushRef.current();
      return id;
    },
    [secret, me, takeGroupState, saveBox],
  );

  const addGroupMembers = useCallback(
    (room: string, pubkeys: string[]) =>
      sendGroupChange(room, 'add', (g) => ({ ...g, members: [...new Set([...g.members, ...pubkeys])].filter((p) => p !== me) })),
    [sendGroupChange, me],
  );
  const removeGroupMember = useCallback(
    (room: string, pubkey: string) =>
      sendGroupChange(room, 'remove', (g) => ({ ...g, members: g.members.filter((p) => p !== pubkey), admins: (g.admins ?? []).filter((a) => a !== pubkey) })),
    [sendGroupChange],
  );
  const makeGroupAdmin = useCallback(
    (room: string, pubkey: string) => sendGroupChange(room, 'admin', (g) => ({ ...g, admins: [...new Set([...(g.admins ?? []), pubkey])] })),
    [sendGroupChange],
  );
  const renameGroup = useCallback(
    (room: string, name: string) => sendGroupChange(room, 'rename', (g) => ({ ...g, name: name.trim().slice(0, 60) })),
    [sendGroupChange],
  );
  const leaveGroup = useCallback((room: string) => sendGroupChange(room, 'leave', (g) => g), [sendGroupChange]);
  const setGroupAvatar = useCallback(
    async (room: string, photo: Blob | null) => {
      if (!secret) throw new Error('not open');
      let ref: FileRef | null = null;
      if (photo) {
        const small = await shrinkAvatar(photo);
        ref = await encryptAndUpload(small.bytes, small.type, secret, `${small.width}x${small.height}`);
        await keepSent(`avatar:${ref.sha256}`, small.bytes, small.type);
      }
      sendGroupChange(room, 'icon', (g) => {
        const { avatar: _, ...rest } = g;
        return ref ? { ...rest, avatar: ref } : rest;
      });
    },
    [secret, sendGroupChange],
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
      // Decided now, while the chat's switch is as the person sees it (lib/ai-optout.ts).
      const noaiNow = chatNoAi(peer);
      const reply = replyTo ? replyTag(15, replyTo) : [];
      const at = Math.floor(Date.now() / 1000);
      let file: FileRef | null = null;
      try {
        file = await encryptAndUpload(bytes, type, secret, dim, { name, duration });
      } catch {
        // Offline or the file server refused: keep the file here and upload it later.
      }
      if (file) {
        const { rumor, wraps } = build(peer, 15, file.url, [...fileTags(file), ...reply, ...(noaiNow ? [['noai']] : [])], at);
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
          ...(noaiNow ? { noai: true as const } : {}),
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
          ...(noaiNow || (myNoAiRef.current && !contactsRef.current.some((c) => c.pubkey === peer && c.model)) ? { noai: true as const } : {}),
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

  /** Sends my stamp list quietly to my own key; my other devices take it if it is newer. */
  const sendStampsToMe = useCallback(
    async (list: Stamp[], at: number) => {
      if (!secret || !me || !pool.current) return;
      const content = JSON.stringify({ stamps: list.map(({ uploadedAt: _, ...ref }) => ref) });
      const rumor = nip59.createRumor({ kind: STAMPS_KIND, content, tags: [['p', me]], created_at: at }, secret);
      await publishOne(pool.current, RELAYS, wrapQuiet(rumor, secret, me), authRef.current ?? undefined);
      save(k('stampsSent'), { at, time: Math.floor(Date.now() / 1000) });
    },
    [secret, me],
  );

  /** Saves my new stamp list and sends it to my other devices. */
  const commitStamps = useCallback(
    (next: Stamp[]) => {
      stampsRef.current = next;
      setStamps(next);
      save(k('stamps'), next);
      const at = Math.max(Math.floor(Date.now() / 1000), load<number>(k('stampsAt'), 0) + 1);
      save(k('stampsAt'), at);
      void sendStampsToMe(next, at).catch(() => {});
    },
    [sendStampsToMe],
  );

  const makeStamp = useCallback(
    async (image: Blob): Promise<Stamp> => {
      if (!secret) throw new Error('not open');
      const small = await shrinkStamp(image);
      const dim = `${small.width}x${small.height}`;
      const entry: Stamp = await uploadStamp(small.bytes, small.type, secret, dim);
      await keepSent(`stamp:${entry.sha256}`, small.bytes, small.type);
      commitStamps([...stampsRef.current.filter((s) => s.sha256 !== entry.sha256), entry]);
      return entry;
    },
    [secret, commitStamps],
  );

  const addStamp = useCallback(
    // Someone else's copy can disappear when they remove it, so it is kept again as my own
    // (encrypted for my account, in the stamp storage).
    async (file: FileRef) => {
      if (!secret) throw new Error('not open');
      const { uploadedAt: _, ...theirs } = file as Stamp;
      const blob = await openFile(`stamp:${theirs.sha256}`, theirs);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const entry: Stamp = await uploadStamp(bytes, theirs.type, secret, theirs.dim);
      await keepSent(`stamp:${entry.sha256}`, bytes, entry.type);
      if (stampsRef.current.some((s) => s.sha256 === entry.sha256)) return;
      commitStamps([...stampsRef.current, entry]);
    },
    [secret, commitStamps],
  );

  const removeStamp = useCallback(
    (sha256: string) => {
      const gone = stampsRef.current.find((s) => s.sha256 === sha256);
      if (!gone) return;
      commitStamps(stampsRef.current.filter((s) => s.sha256 !== sha256));
      if (secret && isKeptStamp(gone)) void deleteStampFile(sha256, secret).catch(() => {});
    },
    [secret, commitStamps],
  );

  const moveStampToFront = useCallback(
    (sha256: string) => {
      const st = stampsRef.current.find((s) => s.sha256 === sha256);
      if (!st || stampsRef.current[0]?.sha256 === sha256) return;
      commitStamps([st, ...stampsRef.current.filter((s) => s.sha256 !== sha256)]);
    },
    [commitStamps],
  );

  // A stamp from before the stamp storage lives on the 30-day file server: it is moved into
  // the stamp storage from this device's copy, and my list points to the new place. A stamp
  // whose image is gone everywhere stays as it is (the list shows it as expired).
  const keepStamp = useCallback(
    async (stamp: Stamp): Promise<Stamp> => {
      if (!secret) throw new Error('not open');
      if (isKeptStamp(stamp)) return stamp;
      const blob = (await keptFile(`stamp:${stamp.sha256}`)) ?? (await openFile(`stamp:${stamp.sha256}`, stamp));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const kept: Stamp = await uploadStamp(bytes, stamp.type, secret, stamp.dim);
      await keepSent(`stamp:${kept.sha256}`, bytes, kept.type);
      commitStamps(stampsRef.current.map((s) => (s.sha256 === stamp.sha256 ? kept : s)));
      return kept;
    },
    [secret, commitStamps],
  );

  /** Moves every stamp from before the stamp storage into it. Returns my list. */
  const keepStamps = useCallback(async (): Promise<Stamp[]> => {
    const out: Stamp[] = [];
    for (const st of stampsRef.current) out.push(await keepStamp(st).catch(() => st));
    return out;
  }, [keepStamp]);
  const keepStampsRef = useRef(keepStamps);
  keepStampsRef.current = keepStamps;

  // When the app opens: move old stamps into the stamp storage, and send my list to my other
  // devices again if it has not gone out yet, or if it went out 20 days ago or more (the
  // relay keeps envelopes 30 days, so a device that was away still finds it).
  useEffect(() => {
    if (!secret || !me) return;
    void (async () => {
      await keepStampsRef.current();
      const at = load<number>(k('stampsAt'), 0);
      const sent = load<{ at: number; time: number } | null>(k('stampsSent'), null);
      const stale = !sent || sent.at !== at || Date.now() / 1000 - sent.time >= 20 * 24 * 60 * 60;
      if (at && stale) await sendStampsToMe(stampsRef.current, at).catch(() => {});
    })();
  }, [secret, me, sendStampsToMe]);

  const recentStamps = useMemo(
    () =>
      stamps
        .filter((s) => stampsUsed[s.sha256])
        .sort((a, b) => stampsUsed[b.sha256] - stampsUsed[a.sha256])
        .slice(0, RECENT_STAMPS),
    [stamps, stampsUsed],
  );

  const sendStamp = useCallback(
    async (peer: string, stamp: Stamp, replyTo?: string) => {
      if (!secret || !me) throw new Error('not open');
      if (!isGroup(peer) && blockedRef.current.includes(peer)) return;
      const now = Math.floor(Date.now() / 1000);
      const { uploadedAt: _, ...file }: Stamp = await keepStamp(stamp);
      setStampsUsed((prev) => {
        const next = { ...prev, [file.sha256]: Date.now() };
        save(k('stampsUsed'), next);
        return next;
      });
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
    [secret, me, build, saveBox, addMessage, flush, keepStamp],
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
      // A Tegami group I am still in stays (deleting the chat is not leaving it).
      if (isGroup(room) && !groupsRef.current.some((g) => g.id === room && g.gid && !g.left)) {
        groupsRef.current = groupsRef.current.filter((g) => g.id !== room);
        saveGroups((prev) => (prev.some((g) => g.id === room) ? prev.filter((g) => g.id !== room) : prev));
      }
    },
    [saveBox, saveGroups],
  );
  deleteChatRef.current = deleteChat;

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

  const callIceServers = useCallback(
    () => (secret && me ? iceServers(secret, me) : Promise.resolve(STUN)),
    [secret, me],
  );

  const askAiDraft = useCallback(
    async (ai: string, friend: string, confirmed = false) => {
      if (!secret || !me || !pool.current) throw new Error('not open');
      const people = contactsRef.current;
      const aiContact = people.find((c) => c.pubkey === ai && isMyAi(c));
      const friendContact = people.find((c) => c.pubkey === friend && isPerson(c));
      // Only a friend (a person, not another AI) in a 1:1 chat, not blocked. Never a stranger.
      const isFriend = (pk: string) => people.some((c) => c.pubkey === pk && isPerson(c)) && !blockedRef.current.includes(pk);
      if (!aiContact || !friendContact || isGroup(friend)) throw new AiNotAllowedError('not an AI friend and a friend');
      // Only what may be read (lib/ai-optout.ts): not marked, not from a friend who said no.
      const chat = messagesRef.current.filter((m) => m.peer === friend);
      const why = nothingToRead(chat, friendContact, me);
      if (why) throw new AiNothingToReadError(why);
      const { ask, range } = draftAsk(aiReadable(chat, people, me), friend, me, { friend: friendContact.name, me: myName || '自分' });
      const r = { ai, model: aiContact.model, friend };
      // The gate answers allow, refuse, or (with per-ask permissions) "ask the person first".
      const pass = (answer: unknown, what: string) => {
        if (answer === true) return;
        if (answer === 'ask') {
          if (confirmed) return;
          throw new AiConfirmNeededError(what);
        }
        throw new AiNotAllowedError(what);
      };
      pass(gateAi({ ...r, action: 'read', range }, isFriend), 'read');
      pass(gateAi({ ...r, action: 'draft' }, isFriend), 'draft');
      const rumor = nip59.createRumor(
        { kind: AI_DRAFT_ASK_KIND, content: JSON.stringify(ask), tags: [['p', ai]], created_at: Math.floor(Date.now() / 1000) },
        secret,
      );
      // For the AI only: no copy for my other devices, and it expires (lib/ai-draft.ts).
      const wrap = wrapExpiring(rumor, secret, ai);
      if (!(await publishOne(pool.current, RELAYS, wrap, authRef.current ?? undefined))) throw new Error('not sent');
      return rumor.id;
    },
    [secret, me, myName],
  );

  // ---------- AI friends acting in my name (lib/ai-actions.ts) ----------

  /** A short answer to my AI: for it only, and gone from the relay in 10 minutes. */
  const tellAi = useCallback(
    async (ai: string, kind: number, data: Record<string, unknown>) => {
      if (!secret || !pool.current) return;
      const rumor = nip59.createRumor({ kind, content: JSON.stringify(data), tags: [['p', ai]], created_at: Math.floor(Date.now() / 1000) }, secret);
      await publishOne(pool.current, RELAYS, wrapExpiring(rumor, secret, ai), authRef.current ?? undefined).catch(() => false);
    },
    [secret],
  );
  endGrantsRef.current = (ai, why) => {
    for (const peer of endAiGrants(ai, why)) void tellAi(ai, AI_PEER_RESULT_KIND, { peer, until: 0, limit: 0 });
  };

  /** Answers an AI's one-time pairing code (lib/ai-pair.ts): the code and my invite link, for the AI only. */
  const pairAi = useCallback(
    async (ai: string, code: string, myInvite: string) => {
      if (!secret || !pool.current) throw new Error('not open');
      // Pairing with the code on my own computer is the one way, with the switch in the AI's
      // screen, that a friend becomes my AI (the add screen asks before it calls this).
      setMyAi(ai, true);
      if (!(await publishOne(pool.current, RELAYS, pairWrap(secret, ai, code, myInvite), authRef.current ?? undefined))) throw new Error('not sent');
    },
    [secret, setMyAi],
  );

  /** Only a friend who is a person (not another AI), not blocked. Never a stranger. */
  const isPersonFriend = useCallback(
    (pk: string) => contactsRef.current.some((c) => c.pubkey === pk && isPerson(c)) && !blockedRef.current.includes(pk),
    [],
  );

  /**
   * Sends a text in my name with the "written by an AI" tag. Only after the gate said yes.
   * `at` is the time of the AI's ask: two of my devices that both handle the same ask build the
   * very same message (same words, tags and time, so the same id), and the friend's app keeps
   * one of them (懸念の6番: the AI's asks reach every one of my devices).
   */
  const sendFromAi = useCallback(
    (peer: string, text: string, ai: Contact, at?: number) => {
      const by = { pubkey: ai.pubkey, ...(ai.model ? { model: ai.model } : {}), ...(ai.name ? { name: ai.name } : {}) };
      const { rumor, wraps } = build(peer, 14, text, [aiTag(by)], at);
      if (messagesRef.current.some((m) => m.id === rumor.id) || outbox.current.some((o) => o.id === rumor.id)) return;
      recordAiSent(peer);
      saveBox([...outbox.current, { id: rumor.id, peer, at: rumor.created_at, wraps, done: [] }]);
      addMessage({ id: rumor.id, from: me!, peer, text, at: rumor.created_at, pending: 'sending', ai: by });
      void flush();
    },
    [build, saveBox, addMessage, me, flush],
  );

  const putProposals = useCallback((next: AiProposal[]) => {
    aiProposalsRef.current = next;
    saveProposals(next);
    setAiProposals(next);
  }, []);

  const acceptAiProposal = useCallback(
    async (id: string) => {
      const prop = aiProposalsRef.current.find((x) => x.id === id);
      if (!prop) return false;
      putProposals(aiProposalsRef.current.filter((x) => x.id !== id));
      const ai = contactsRef.current.find((c) => c.pubkey === prop.ai && isMyAi(c));
      // Asked again now: a switch may have been turned off since the AI wrote it.
      const ok =
        !!ai &&
        gateAi({ ai: prop.ai, model: ai.model, action: 'send', friend: prop.to, content: { kind: 'text', text: prop.text } }, isPersonFriend);
      if (ok && ai) sendFromAi(prop.to, prop.text, ai, prop.askAt);
      void tellAi(prop.ai, AI_SEND_RESULT_KIND, { re: prop.id, status: ok ? 'sent' : 'stopped' });
      return ok;
    },
    [putProposals, isPersonFriend, sendFromAi, tellAi],
  );

  const declineAiProposal = useCallback(
    (id: string) => {
      const prop = aiProposalsRef.current.find((x) => x.id === id);
      if (!prop) return;
      putProposals(aiProposalsRef.current.filter((x) => x.id !== id));
      void tellAi(prop.ai, AI_SEND_RESULT_KIND, { re: prop.id, status: 'declined' });
    },
    [putProposals, tellAi],
  );

  /** How many messages at the end of this chat an AI wrote in my name, with nobody writing after them. */
  const aiInARow = useCallback(
    (peer: string) => {
      let n = 0;
      const list = messagesRef.current;
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (m.peer !== peer || m.notice || m.call) continue;
        if (m.from !== me || !m.ai) break;
        n++;
      }
      return n;
    },
    [me],
  );

  /** My AI asks to send a message for me. The gate decides; nothing is sent around it. */
  const handleSendAsk = useCallback(
    async (rumor: ReturnType<typeof nip59.createRumor>, ai: Contact) => {
      const ask = parseSendAsk(rumor.content);
      if (!ask) return void tellAi(ai.pubkey, AI_SEND_RESULT_KIND, { re: rumor.id, status: 'invalid' });
      const r = { ai: ai.pubkey, model: ai.model, friend: ask.to, content: { kind: 'text' as const, text: ask.text }, readOthers: ask.readOthers };
      // Without asking: the gate may let it go, or show the confirm window (photos, links, money, "ask each time").
      let auto = decideAi(getAiPermissions(), { ...r, action: 'autosend' }, isPersonFriend);
      // Over a limit on sending (AiLimits): never at once; it waits for 送る below instead.
      if (auto.verdict !== 'deny' && overAiLimit(getAiPermissions(), loadAiSent(), aiInARow(ask.to))) {
        logAiStop({ ...r, action: 'autosend' }, 'limit');
        auto = { verdict: 'deny', by: 'limit' };
      }
      if (auto.verdict !== 'deny') {
        if (await askAi({ ...r, action: 'autosend' }, isPersonFriend)) {
          sendFromAi(ask.to, ask.text, ai, rumor.created_at);
          return void tellAi(ai.pubkey, AI_SEND_RESULT_KIND, { re: rumor.id, status: 'sent' });
        }
        if (auto.verdict === 'ask') return void tellAi(ai.pubkey, AI_SEND_RESULT_KIND, { re: rumor.id, status: 'declined' });
      }
      // After checking: it waits on this device until I press 送る (asked again then, and logged).
      if (checkAi(getAiPermissions(), { ...r, action: 'send' }, isPersonFriend) !== null) {
        gateAi({ ...r, action: 'send' }, isPersonFriend); // logs why it stopped
        return void tellAi(ai.pubkey, AI_SEND_RESULT_KIND, { re: rumor.id, status: 'stopped' });
      }
      if (aiProposalsRef.current.some((x) => x.id === rumor.id)) return;
      putProposals([
        ...aiProposalsRef.current,
        { id: rumor.id, ai: ai.pubkey, to: ask.to, text: ask.text, at: Math.floor(Date.now() / 1000), askAt: rumor.created_at },
      ]);
      void tellAi(ai.pubkey, AI_SEND_RESULT_KIND, { re: rumor.id, status: 'waiting', ...(auto.by === 'limit' ? { reason: 'limit' } : {}) });
    },
    [isPersonFriend, sendFromAi, tellAi, putProposals, aiInARow],
  );

  /** My AI asks for my friend list (people only). */
  const handleContactsAsk = useCallback(
    async (rumor: ReturnType<typeof nip59.createRumor>, ai: Contact) => {
      const ok = await askAi({ ai: ai.pubkey, model: ai.model, action: 'contacts' }, isPersonFriend);
      const friends = ok
        ? contactsRef.current.filter((c) => isPerson(c) && !blockedRef.current.includes(c.pubkey)).map((c) => ({ pubkey: c.pubkey, name: c.name }))
        : undefined;
      void tellAi(ai.pubkey, AI_CONTACTS_KIND, friends ? { re: rumor.id, friends } : { re: rumor.id, stopped: true });
    },
    [isPersonFriend, tellAi],
  );

  /** My AI asks to talk to another person's AI: asked in the confirm window the first time. */
  const handlePeerAsk = useCallback(
    async (rumor: ReturnType<typeof nip59.createRumor>, ai: Contact) => {
      const peer = parsePeerAsk(rumor.content);
      if (!peer) return;
      rememberPeerAi(peer.pubkey, { name: peer.name, model: peer.model });
      const ok = await askAi({ ai: ai.pubkey, model: ai.model, action: 'otherAi', peer }, isPersonFriend);
      // 今回だけ keeps nothing: the AI may talk for the next 10 minutes only.
      const until = ok ? (getAiPermissions().peerAis[`${ai.pubkey}>${peer.pubkey}`]?.until ?? Math.floor(Date.now() / 1000) + 600) : 0;
      void tellAi(ai.pubkey, AI_PEER_RESULT_KIND, { re: rumor.id, peer: peer.pubkey, until, limit: PEER_AI_DAILY_LIMIT });
    },
    [isPersonFriend, tellAi],
  );

  const revokePeerAi = useCallback(
    async (ai: string, peer: string) => {
      removePeerAi(ai, peer);
      await tellAi(ai, AI_PEER_RESULT_KIND, { peer, until: 0, limit: 0 });
    },
    [tellAi],
  );

  /**
   * Tells every one of my AIs to stop (true) or that it may go on (false): AI_STOP_KIND, for
   * that AI only, kept by the relay like messages (not expiring) so an AI whose computer was
   * off hears it when it comes back. The newest `at` wins on the AI's side.
   */
  const tellMyAis = useCallback(
    async (stop: boolean) => {
      if (!secret || !pool.current) return;
      const at = Math.floor(Date.now() / 1000);
      save(k('ai.stopped'), stop);
      const mine = contactsRef.current.filter(isMyAi);
      await Promise.all(
        mine.map((c) => {
          const rumor = nip59.createRumor(
            { kind: AI_STOP_KIND, content: JSON.stringify({ v: 1, stop, at }), tags: [['p', c.pubkey]], created_at: at },
            secret,
          );
          return publishOne(pool.current!, RELAYS, wrapQuiet(rumor, secret, c.pubkey), authRef.current ?? undefined).catch(() => false);
        }),
      );
    },
    [secret],
  );

  /**
   * すべてオフにする: every "AI の使用" switch off, every permission to talk to another person's
   * AI taken back and each AI told (until 0), and every one of my AIs told to stop at once:
   * replies on its own, its MCP tools and its talks with other AIs do not pass this app's gate.
   */
  const stopAi = useCallback(async () => {
    const taken = stopAllAi();
    await Promise.all([
      ...taken.map(([ai, peer]) => tellAi(ai, AI_PEER_RESULT_KIND, { peer, until: 0, limit: 0 })),
      tellMyAis(true),
    ]);
  }, [tellAi, tellMyAis]);

  const seenAiWidened = useCallback(() => {
    save(k('ai.widened'), 0);
    setAiWidenedAt(0);
  }, []);

  // After すべてオフにする, the first "AI の使用" switch turned on again tells my AIs they may go on.
  useEffect(() => {
    if (!secret || !load<boolean>(k('ai.stopped'), false)) return;
    if (Object.values(aiPermissions.all).some((v) => v !== false && v !== undefined)) void tellMyAis(false);
  }, [aiPermissions, secret, tellMyAis]);

  const putAiGroups = useCallback((update: (prev: AiGroups) => AiGroups) => {
    setAiGroups((prev) => {
      const next = update(prev);
      if (next === prev) return prev;
      aiGroupsRef.current = next;
      save(k('ai.groups'), next);
      return next;
    });
  }, []);

  /** An invitation or an answer: to every member, to the AI (so it knows when it is in), and to my other devices. */
  const sendAiGroup = useCallback(
    async (chat: string, data: Record<string, unknown>) => {
      if (!secret || !me || !pool.current) throw new Error('not open');
      // A Tegami group (g-<gid>): the people in it now (see aiMembersOf).
      const room = aiMembersOf(chat);
      if (!room) throw new Error('not in this group');
      const everyone = everyoneIn(room, me).split(',');
      const ai = String(data.ai);
      const content = JSON.stringify({ ...data, members: everyone });
      const at = Math.floor(Date.now() / 1000);
      const rumor = nip59.createRumor({ kind: AI_GROUP_KIND, content, tags: [...room.split(','), ai].map((x) => ['p', x]), created_at: at }, secret);
      const parsed = parseAiGroup(content);
      if (parsed) {
        // Applied here at once (a "no" stops my copies to the AI before anything is sent).
        const next = applyAiGroup(aiGroupsRef.current, parsed, me, at);
        aiGroupsRef.current = next;
        putAiGroups(() => next);
      }
      const wraps = [...room.split(','), ai, me].map((to) => wrapQuiet(rumor, secret, to));
      await Promise.any(wraps.map((w) => publishOne(pool.current!, RELAYS, w, authRef.current ?? undefined)));
    },
    [secret, me, putAiGroups, aiMembersOf],
  );

  const inviteAiToGroup = useCallback(
    async (room: string, ai: string) => {
      const c = contactsRef.current.find((x) => x.pubkey === ai && isMyAi(x));
      // A group, or a 1:1 chat with a friend who is a person (philosophy #94).
      if (!c || (!isGroup(room) && !isPersonFriend(room)) || !myAiMayRead(getAiPermissions(), c)) throw new AiNotAllowedError('not my AI');
      // AI in a group is a later stage (lib/ai-permissions.ts AI_STAGE): refused and logged.
      if (!aiStageAllows('group')) {
        logAiStop({ ai, model: c.model, action: 'read', friend: isGroup(room) ? undefined : room }, 'stage');
        throw new AiNotAllowedError('not at this stage');
      }
      await sendAiGroup(room, { t: 'invite', ai, name: c.name, ...(c.model ? { model: c.model } : {}) });
    },
    [sendAiGroup, isPersonFriend],
  );

  const answerAiInGroup = useCallback(
    (room: string, ai: string, yes: boolean) => sendAiGroup(room, { t: 'answer', ai, yes }),
    [sendAiGroup],
  );

  // What arrives from AIs and from group members about AIs. An ask is handled once and only
  // while fresh, so the relay handing it out again cannot send a message twice.
  aiRumorRef.current = (rumor) => {
    if (!me) return;
    if (rumor.kind === AI_GROUP_KIND) {
      const r = parseAiGroup(rumor.content);
      if (!r || !r.members.includes(me)) return;
      putAiGroups((prev) => applyAiGroup(prev, r, rumor.pubkey, rumor.created_at));
      return;
    }
    // Only my own AI (the mark, never the model name it gives: NIP-46 says the same of names).
    const ai = contactsRef.current.find((c) => c.pubkey === rumor.pubkey && isMyAi(c));
    if (!ai || !freshAsk(rumor.created_at) || handledAsk(rumor.id)) return;
    if (rumor.kind !== AI_SEND_ASK_KIND && rumor.kind !== AI_CONTACTS_ASK_KIND && rumor.kind !== AI_PEER_ASK_KIND) return;
    markHandled(rumor.id);
    if (rumor.kind === AI_SEND_ASK_KIND) void handleSendAsk(rumor, ai);
    else if (rumor.kind === AI_CONTACTS_ASK_KIND) void handleContactsAsk(rumor, ai);
    else void handlePeerAsk(rumor, ai);
  };

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

  // ---------- my own devices in step (lib/own-sync.ts) ----------
  const aiPermissionsRef = useRef(aiPermissions);
  aiPermissionsRef.current = aiPermissions;
  const listsNow = useCallback(
    (): AccountLists => ({
      contacts: contactsRef.current,
      groups: groupsRef.current,
      blocked: blockedRef.current,
      ai: aiPermissionsRef.current,
      noai: myNoAiRef.current,
    }),
    [],
  );
  const syncTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** Sends my ledger to my own key, unless the same ledger went out less than 20 days ago. */
  const sendSync = useCallback(async () => {
    if (!secret || !me || !pool.current || !ledgerRef.current) return;
    const parts = syncParts(ledgerRef.current);
    const hash = parts.join('\n');
    const sent = load<{ hash: string; time: number } | null>(k('syncSent'), null);
    const now = Math.floor(Date.now() / 1000);
    if (sent?.hash === hash && now - sent.time < SYNC_RESEND_SECONDS) return;
    for (const content of parts) {
      const rumor = nip59.createRumor({ kind: ACCOUNT_SYNC_KIND, content, tags: [['p', me]], created_at: now }, secret);
      if (!(await publishOne(pool.current, RELAYS, wrapQuiet(rumor, secret, me), authRef.current ?? undefined))) return;
    }
    save(k('syncSent'), { hash, time: now });
  }, [secret, me]);
  const sendSyncRef = useRef(sendSync);
  sendSyncRef.current = sendSync;
  /** Sends a moment later, so several changes (or several envelopes merged at the start) go out once. */
  const scheduleSync = useCallback(() => {
    clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => void sendSyncRef.current().catch(() => {}), 1500);
  }, []);
  useEffect(() => () => clearTimeout(syncTimer.current), []);

  /** Writes a change made on this device in one section into the ledger. */
  const stampSection = useCallback(
    (section: Section, lists: AccountLists) => {
      if (!loaded || !secret) return;
      const r = stamp(ledgerRef.current, section, lists, Date.now());
      if (r.changed) {
        ledgerRef.current = r.ledger;
        save(k('sync'), r.ledger);
      }
      scheduleSync();
    },
    [loaded, secret, scheduleSync],
  );
  // One effect per section: a render that already has the other device's AI switches but not
  // yet its friends must not write the old friends back as a change made here.
  useEffect(() => stampSection('c', { ...listsNow(), contacts }), [contacts, stampSection, listsNow]);
  useEffect(() => stampSection('g', { ...listsNow(), groups }), [groups, stampSection, listsNow]);
  useEffect(() => stampSection('b', { ...listsNow(), blocked }), [blocked, stampSection, listsNow]);
  useEffect(() => stampSection('a', { ...listsNow(), ai: aiPermissions }), [aiPermissions, stampSection, listsNow]);
  useEffect(() => stampSection('p', { ...listsNow(), noai: myNoAiState }), [myNoAiState, stampSection, listsNow]);

  applySyncRef.current = (remote: Ledger) => {
    if (!loaded || !secret) return;
    const current = listsNow();
    // What is here first goes into the ledger, so nothing here is lost by the merge.
    const { ledger, changed } = merge(stampAll(ledgerRef.current, current, Date.now()), remote);
    ledgerRef.current = ledger;
    save(k('sync'), ledger);
    if (changed.size) {
      const next = materialize(ledger, current);
      if (changed.has('c')) {
        for (const c of current.contacts)
          if (c.avatar?.sha256 && !next.contacts.some((n) => n.pubkey === c.pubkey)) void forgetFile(`avatar:${c.avatar.sha256}`);
        contactsRef.current = next.contacts;
        save(k('contacts'), next.contacts);
        setContacts(next.contacts);
      }
      if (changed.has('g')) {
        groupsRef.current = next.groups;
        save(k('groups'), next.groups);
        setGroups(next.groups);
      }
      if (changed.has('b')) {
        blockedRef.current = next.blocked;
        save(k('blocked'), next.blocked);
        setBlocked(next.blocked);
      }
      if (changed.has('a')) replaceAiPermissions(next.ai);
      // My other device let AIs do more (a switch, a limit, or a new "my AI"): one line on the
      // list until I open the AI screen (懸念の6番).
      const newMine = next.contacts.some((c) => isMyAi(c) && !current.contacts.some((o) => o.pubkey === c.pubkey && isMyAi(o)));
      if ((changed.has('a') && aiWidened(current.ai, next.ai)) || (changed.has('c') && newMine)) {
        save(k('ai.widened'), Math.floor(Date.now() / 1000));
        setAiWidenedAt(Math.floor(Date.now() / 1000));
      }
      if (changed.has('p')) takeMyNoAiRef.current(next.noai === true);
    }
    scheduleSync();
  };

  // Every message of the old device, after moving here with a link (lib/history.ts).
  useEffect(() => {
    if (!secret || !me) return;
    const refs = load<FileRef[]>(k('historyPending'), []);
    if (!refs.length) return;
    let alive = true;
    void (async () => {
      const h = await downloadHistory(refs);      if (!alive) return;
      remove(k('historyPending'));
      for (const [room, at] of Object.entries(h.cleared)) clearedRef.current[room] = Math.max(clearedRef.current[room] ?? 0, at);
      save(k('cleared'), clearedRef.current);
      const deleted = [...new Set([...deletedRef.current, ...h.deleted])].slice(-MAX_DELETED_IDS);
      deletedRef.current = new Set(deleted);
      save(k('deleted'), deleted);
      const gone = (m: Message) => deletedRef.current.has(m.id) || m.at <= (clearedRef.current[m.peer] ?? 0);
      setMessages((prev) => {
        const have = new Set(prev.map((m) => m.id));
        const next = [...prev.filter((m) => m.pending || !gone(m)), ...h.messages.filter((m) => !have.has(m.id) && !gone(m))].sort((a, b) => a.at - b.at);
        messagesRef.current = next;
        save(k('messages'), next);
        return next;
      });
    })();
    return () => {
      alive = false;
    };
  }, [secret, me]);

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
    (sk: Uint8Array): Bundle => ({
      v: 1,
      secretHex: bytesToHex(sk),
      myName,
      contacts,
      groups,
      blocked,
      ai: aiPermissions,
      stamps,
      sync: ledgerForBundle(ledgerRef.current),
    }),
    [myName, contacts, groups, blocked, aiPermissions, stamps],
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

  // Keep the backup up to date when my name, contacts, groups, blocks or AI settings change (after a pause).
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

  // ---------- removing and deleting the account ----------
  const removeFromDevice = useCallback(
    async (id?: string) => {
      const target = id ?? accounts().current;
      if (target === accounts().current) {
        // Tell the relay to stop notifying this device for this account (best effort: the
        // relay also forgets addresses the push service reports as gone).
        if (secret && load<string | null>(k('push'), null)) await disablePush(secret).catch(() => undefined);
      } else if (load<string | null>(keyFor(target, 'push'), null)) {
        // Another account's key is not open here: replace this browser's push address instead.
        await replaceSubscription(secret).catch(() => undefined);
      }
      await removeAccountHere(target);
    },
    [secret],
  );

  const deleteAccount = useCallback(async () => {
    if (!secret) throw new Error('not open');
    // The backup is signed with a key from the recovery code, not the account's: delete it first.
    if (recoveryOnHere()) await turnOffRecovery();
    const res = await signedFetch('DELETE', '/account', JSON.stringify({ delete: 'account' }), secret);
    const out = res.ok ? ((await res.json().catch(() => ({}))) as { deleted?: boolean }) : {};
    if (!out.deleted) throw new Error(`relay said ${res.status}`);
    await removeFromDevice();
  }, [secret, turnOffRecovery, removeFromDevice]);

  const value: TegamiState = {
    removeFromDevice,
    deleteAccount,
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
    callIceServers,
    onSignal,
    askAiDraft,
    pairAi,
    onAiDraft,
    aiProposals,
    acceptAiProposal,
    declineAiProposal,
    aiGroups,
    aiMembersOf,
    inviteAiToGroup,
    answerAiInGroup,
    revokePeerAi,
    setMyAi,
    stopAi,
    aiWidenedAt,
    seenAiWidened,
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
    addGroupMembers,
    removeGroupMember,
    makeGroupAdmin,
    renameGroup,
    setGroupAvatar,
    leaveGroup,
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
    myNoAi: myNoAiState,
    setMyNoAi,
    myAvatar,
    setMyAvatar,
    send,
    sendPhoto,
    sendFile,
    sendVoice,
    forwardFile,
    stamps,
    recentStamps,
    moveStampToFront,
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
