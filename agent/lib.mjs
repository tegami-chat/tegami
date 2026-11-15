// Core of tegami-agent: one Nostr key for one AI friend, its contacts and messages.
//
// Everything lives in one folder on this computer (TEGAMI_AGENT_HOME, default
// ~/.tegami/agents/<name>). key.json holds the AI's secret key in plain text, like
// an SSH key: the agent has to run unattended, so there is no passkey to unlock it.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as nip17 from 'nostr-tools/nip17';
import * as nip19 from 'nostr-tools/nip19';
import * as nip44 from 'nostr-tools/nip44';
import * as nip59 from 'nostr-tools/nip59';
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import WebSocket from 'ws';

useWebSocketImplementation(WebSocket);

export const RELAYS = (process.env.TEGAMI_RELAYS ?? 'wss://relay.tegami.chat').split(',');
export const APP_ORIGIN = 'https://app.tegami.chat';

// Reply drafts (client/src/lib/ai-draft.ts): the owner's app hands over one friend's chat
// only when its AI permissions allow it; the AI answers with a draft for the owner to send.
export const DRAFT_ASK_KIND = 25060;
export const DRAFT_KIND = 25061;
/** Seconds an ask or a draft lives on the relay; older asks are not answered. */
export const DRAFT_TTL = 600;
const DRAFT_TEXT_MAX = 2000;

// Pairing by QR code (client/src/lib/tegami.tsx pairAi): `tegami-agent pair` shows the AI's
// invite link with a one-time code (&p=). The app that adds the AI from it sends back, sealed
// for the AI, that code and its own invite link; the AI then trusts that person and registers
// with the code in their link. The code works once, and only until it expires.
export const PAIR_KIND = 25062;
/** Seconds a pairing code works by default. */
export const PAIR_TTL = 600;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** A new one-time pairing code: 16 letters, 80 random bits. */
export function newPairCode() {
  const bytes = randomBytes(10);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

const hashCode = (code) => createHash('sha256').update(String(code)).digest();

/** Reads an ask's content, or null when it is not a well-formed ask. */
export function parseAsk(content) {
  try {
    const a = JSON.parse(content);
    if (a?.v !== 1 || typeof a.friend !== 'string' || typeof a.me !== 'string' || !Array.isArray(a.messages)) return null;
    const messages = a.messages
      .filter((m) => m && typeof m.text === 'string' && typeof m.mine === 'boolean')
      .slice(-50)
      .map((m) => ({ mine: m.mine, text: m.text.slice(0, DRAFT_TEXT_MAX) }));
    return { friend: a.friend.slice(0, 60), me: a.me.slice(0, 60), messages };
  } catch {
    return null;
  }
}

/** Seals a rumor for `to` and wraps it with a NIP-40 expiration, so the relay drops it soon. */
export function wrapExpiring(rumor, secret, to, ttl = DRAFT_TTL, now = Math.floor(Date.now() / 1000)) {
  const seal = nip59.createSeal(rumor, secret, to);
  const key = generateSecretKey();
  return finalizeEvent(
    {
      kind: 1059,
      created_at: now,
      tags: [['p', to], ['expiration', String(now + ttl)]],
      content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(key, to)),
    },
    key,
  );
}

// ---------- files ----------

export function home(name = 'claude') {
  const dir = process.env.TEGAMI_AGENT_HOME ?? join(homedir(), '.tegami', 'agents', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function read(dir, file, fallback) {
  try {
    return JSON.parse(readFileSync(join(dir, file), 'utf8'));
  } catch {
    return fallback;
  }
}

function write(dir, file, value) {
  writeFileSync(join(dir, file), JSON.stringify(value, null, 2));
}

// ---------- links and keys ----------

export function inviteLink(npub, name, model) {
  const parts = [npub];
  if (name) parts.push(`n=${encodeURIComponent(name)}`);
  if (model) parts.push(`m=${encodeURIComponent(model)}`);
  return `${APP_ORIGIN}/i#${parts.join('&')}`;
}

export function parseInvite(input) {
  const text = String(input).trim();
  const npub = text.match(/npub1[02-9ac-hj-np-z]+/)?.[0];
  let pubkey = null;
  if (npub) {
    const d = nip19.decode(npub);
    if (d.type === 'npub') pubkey = d.data;
  } else if (/^[0-9a-f]{64}$/.test(text)) pubkey = text;
  const param = (k) => {
    const m = text.match(new RegExp(`[#&]${k}=([^&\\s]*)`));
    try {
      return m ? decodeURIComponent(m[1]).slice(0, 60) : '';
    } catch {
      return '';
    }
  };
  const code = param('c');
  const pair = param('p');
  return pubkey
    ? { pubkey, name: param('n'), model: param('m'), code: /^[a-z2-9]{6,32}$/.test(code) ? code : '', pair: /^[a-z2-7]{16}$/.test(pair) ? pair : '' }
    : null;
}

// ---------- the agent ----------

export class Agent {
  constructor(name = 'claude') {
    this.dir = home(name);
    const key = read(this.dir, 'key.json', null);
    this.secret = key ? hexToBytes(key.secretHex) : null;
    this.pubkey = this.secret ? getPublicKey(this.secret) : null;
    this.profile = read(this.dir, 'profile.json', { name: 'Claude', model: '' });
    this.contacts = read(this.dir, 'contacts.json', []);
    this.messages = read(this.dir, 'messages.json', []);
    this.state = read(this.dir, 'state.json', { lastRead: 0, replied: [] });
    this.listeners = new Set();
    // Asks for a reply draft. Kept in memory only: they hold a friend's words, never written to disk.
    this.askListeners = new Set();
    this.seenAsks = new Set();
    // Pairing answers (a person's app sent the one-time code back). Handled by acceptPair.
    this.pairListeners = new Set();
    this.pool = null;
  }

  get ready() {
    return !!this.secret;
  }
  get npub() {
    return nip19.npubEncode(this.pubkey);
  }
  get invite() {
    return inviteLink(this.npub, this.profile.name, this.profile.model);
  }

  init({ name, model }) {
    if (!this.secret) {
      this.secret = generateSecretKey();
      this.pubkey = getPublicKey(this.secret);
      const file = join(this.dir, 'key.json');
      writeFileSync(file, JSON.stringify({ secretHex: bytesToHex(this.secret) }));
      try {
        chmodSync(file, 0o600);
      } catch {
        // Windows: the file sits in the user's own profile folder.
      }
    }
    this.profile = { name: name ?? this.profile.name, model: model ?? this.profile.model };
    write(this.dir, 'profile.json', this.profile);
  }

  addContact({ pubkey, name, trusted }) {
    const prev = this.contacts.find((c) => c.pubkey === pubkey);
    const next = { pubkey, name: name || prev?.name || shortId(pubkey), trusted: trusted ?? prev?.trusted ?? false };
    this.contacts = [...this.contacts.filter((c) => c.pubkey !== pubkey), next];
    write(this.dir, 'contacts.json', this.contacts);
    return next;
  }

  contact(nameOrKey) {
    const parsed = parseInvite(nameOrKey);
    if (parsed) return this.contacts.find((c) => c.pubkey === parsed.pubkey) ?? { pubkey: parsed.pubkey, name: shortId(parsed.pubkey), trusted: false };
    const n = String(nameOrKey).trim();
    return this.contacts.find((c) => c.name === n) ?? null;
  }

  /** Reads the contacts again (another command, like `pair`, may have changed them). */
  reloadContacts() {
    this.contacts = read(this.dir, 'contacts.json', this.contacts);
  }

  /** Starts pairing: saves a new one-time code (only its hash) and returns the link to show as a QR code. */
  startPairing(ttl = PAIR_TTL, now = Math.floor(Date.now() / 1000)) {
    const code = newPairCode();
    write(this.dir, 'pair.json', { hash: hashCode(code).toString('hex'), expires: now + ttl });
    return { code, link: `${this.invite}&p=${code}`, expires: now + ttl };
  }

  /** Ends pairing without anyone (it expired, or the command was stopped). */
  stopPairing() {
    rmSync(join(this.dir, 'pair.json'), { force: true });
  }

  /**
   * Answers a pairing message. ok: the sender is now a trusted contact (the code is used up).
   * The code must match and not be expired, and the invite link inside must be the sender's own.
   * Returns { ok, reason, contact, invite }.
   */
  acceptPair(rumor, now = Math.floor(Date.now() / 1000)) {
    const file = join(this.dir, 'pair.json');
    const pending = read(this.dir, 'pair.json', null);
    if (!pending) return { ok: false, reason: 'not pairing' };
    if (now > pending.expires) {
      rmSync(file, { force: true });
      return { ok: false, reason: 'the code has expired' };
    }
    let body;
    try {
      body = JSON.parse(rumor.content);
    } catch {
      return { ok: false, reason: 'not a pairing message' };
    }
    if (body?.v !== 1 || typeof body.code !== 'string' || typeof body.invite !== 'string') return { ok: false, reason: 'not a pairing message' };
    const want = Buffer.from(pending.hash, 'hex');
    const got = hashCode(body.code);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: 'wrong code' };
    const inv = parseInvite(body.invite);
    if (!inv || inv.pubkey !== rumor.pubkey) return { ok: false, reason: "the invite link is not the sender's" };
    // Use the code up first. Renaming is atomic: if a watcher and `pair` both got the
    // message, only one of them gets the file.
    const taken = `${file}.${process.pid}`;
    try {
      renameSync(file, taken);
    } catch {
      return { ok: false, reason: 'already used' };
    }
    rmSync(taken, { force: true });
    const contact = this.addContact({ pubkey: rumor.pubkey, name: inv.name, trusted: true });
    return { ok: true, contact, invite: inv };
  }

  isTrusted(pubkey) {
    return !!this.contacts.find((c) => c.pubkey === pubkey && c.trusted);
  }

  saveState() {
    write(this.dir, 'state.json', this.state);
  }

  // ---------- relay ----------

  /** Connects, logs in (NIP-42), and keeps receiving messages addressed to this agent. */
  async connect() {
    if (this.pool) return;
    const onauth = async (t) => finalizeEvent(t, this.secret);
    this.onauth = onauth;
    this.pool = new SimplePool({ enableReconnect: true });
    this.pool.automaticallyAuth = () => onauth;
    let eose;
    const synced = new Promise((r) => (eose = r));
    // When the connection drops, the library reconnects and asks again before logging
    // in; the relay refuses and the subscription ends for good. So subscribe again
    // whenever it ends (the pool logs in first). Envelopes carry a random time up to
    // 2 days back, so a new subscription looks 3 days back; known messages are skipped.
    let first = true;
    const open = () => {
      if (!this.pool) return;
      const filter = { kinds: [1059], '#p': [this.pubkey] };
      if (!first) filter.since = Math.floor(Date.now() / 1000) - 3 * 86400;
      first = false;
      const sub = this.pool.subscribe(RELAYS, filter, {
        onauth,
        oneose: () => eose(),
        onevent: (wrap) => this.receive(wrap),
        onclose: () => {
          if (this.sub !== sub || !this.pool) return;
          this.retry = setTimeout(open, 2000);
        },
      });
      this.sub = sub;
    };
    open();
    await Promise.race([synced, new Promise((r) => setTimeout(r, 8000))]);
  }

  receive(wrap) {
    let rumor;
    try {
      rumor = nip17.unwrapEvent(wrap, this.secret);
    } catch {
      return;
    }
    if (rumor.kind === DRAFT_ASK_KIND) {
      if (this.seenAsks.has(rumor.id)) return;
      this.seenAsks.add(rumor.id);
      for (const l of this.askListeners) l({ id: rumor.id, from: rumor.pubkey, at: rumor.created_at, content: rumor.content });
      return;
    }
    if (rumor.kind === PAIR_KIND) {
      for (const l of this.pairListeners) l({ id: rumor.id, pubkey: rumor.pubkey, at: rumor.created_at, content: rumor.content });
      return;
    }
    if (rumor.kind !== 14) return;
    // The chat is everyone except this agent (author and p tags), sorted and joined
    // with ','. One person means a 1:1 chat; more means a group (same as the app).
    const others = [...new Set([rumor.pubkey, ...rumor.tags.filter((t) => t[0] === 'p').map((t) => t[1])])]
      .filter((k) => /^[0-9a-f]{64}$/.test(k) && k !== this.pubkey)
      .sort();
    const peer = others.join(',');
    if (!peer || this.messages.some((m) => m.id === rumor.id)) return;
    const m = { id: rumor.id, from: rumor.pubkey, peer, text: rumor.content, at: rumor.created_at };
    this.messages = [...this.messages, m].sort((a, b) => a.at - b.at);
    write(this.dir, 'messages.json', this.messages);
    for (const l of this.listeners) l(m);
  }

  async send(peer, text) {
    await this.connect();
    const rumor = nip59.createRumor({ kind: 14, content: text, tags: [['p', peer]], created_at: Math.floor(Date.now() / 1000) }, this.secret);
    const wraps = [peer, this.pubkey].map((to) => nip59.createWrap(nip59.createSeal(rumor, this.secret, to), to));
    await Promise.any(wraps.flatMap((w) => this.pool.publish(RELAYS, w, { onauth: this.onauth })));
    this.receive(wraps[1]);
    return rumor.id;
  }

  /** Sends a reply draft to the one who asked (`re` is the ask's id). It expires like the ask. */
  async sendDraft(to, re, text) {
    await this.connect();
    const content = JSON.stringify({ re, text: String(text).slice(0, DRAFT_TEXT_MAX) });
    const rumor = nip59.createRumor({ kind: DRAFT_KIND, content, tags: [['p', to], ['e', re]], created_at: Math.floor(Date.now() / 1000) }, this.secret);
    await Promise.any(this.pool.publish(RELAYS, wrapExpiring(rumor, this.secret, to), { onauth: this.onauth }));
    return rumor.id;
  }

  /**
   * Asks the relay whether this AI's key is registered ({}), or registers it with an invite
   * code from its owner's invite link ({invite}). Only registered keys can write to the relay.
   */
  async register(body = {}) {
    const url = `${RELAYS[0].replace(/^ws/, 'http').replace(/\/$/, '')}/register`;
    const text = JSON.stringify(body);
    const auth = finalizeEvent(
      {
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        content: '',
        tags: [['u', url], ['method', 'POST'], ['payload', createHash('sha256').update(text).digest('hex')]],
      },
      this.secret,
    );
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString('base64')}` },
      body: text,
    });
    const json = await res.json().catch(() => ({}));
    return res.ok ? json : { member: false, error: json.error ?? `HTTP ${res.status}` };
  }

  /** Resolves with the next incoming message (not sent by this agent), or null after `ms`. */
  nextIncoming(ms) {
    return new Promise((resolve) => {
      const done = (m) => {
        if (m && m.from === this.pubkey) return;
        this.listeners.delete(done);
        clearTimeout(t);
        resolve(m ?? null);
      };
      const t = setTimeout(() => done(null), ms);
      this.listeners.add(done);
    });
  }

  close() {
    clearTimeout(this.retry);
    const sub = this.sub;
    this.sub = null;
    sub?.close();
    this.pool?.destroy();
    this.pool = null;
  }
}

export function shortId(pubkey) {
  const npub = nip19.npubEncode(pubkey);
  return `${npub.slice(0, 9)}…${npub.slice(-4)}`;
}

export function needsInit(agent) {
  if (!agent.ready) {
    console.error('No AI friend yet. Run: tegami-agent init --name Claude');
    process.exit(1);
  }
}

export { existsSync };
