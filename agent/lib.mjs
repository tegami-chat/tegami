// Core of tegami-agent: one Nostr key for one AI friend, its contacts and messages.
//
// Everything lives in one folder on this computer (TEGAMI_AGENT_HOME, default
// ~/.tegami/agents/<name>). key.json holds the AI's secret key in plain text, like
// an SSH key: the agent has to run unattended, so there is no passkey to unlock it.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
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

// Asks to the owner's app (client/src/lib/ai-actions.ts). The app decides with its AI permissions;
// the AI never holds the owner's key. Each ask and answer expires on the relay like a draft.
export const SEND_ASK_KIND = 25062;
export const SEND_RESULT_KIND = 25063;
export const CONTACTS_ASK_KIND = 25064;
export const CONTACTS_KIND = 25065;
export const PEER_ASK_KIND = 25066;
export const PEER_RESULT_KIND = 25067;
export const AI_GROUP_KIND = 10102;
/** Messages a day with one other person's AI, both ways, unless the owner's app gave another limit. */
export const PEER_DAILY_LIMIT = 20;
const HEX = /^[0-9a-f]{64}$/;

/** The "written by an AI" tag: on the AI's own messages it names itself (other AIs see it is an AI). */
export function aiTag(pubkey, profile) {
  return ['ai', pubkey, String(profile.model ?? '').slice(0, 60), String(profile.name ?? '').slice(0, 60)];
}

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
  return pubkey ? { pubkey, name: param('n'), model: param('m'), code: /^[a-z2-9]{6,32}$/.test(code) ? code : '' } : null;
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
    // Answers from the owner's app, by the id of the ask they answer.
    this.waiters = new Map();
    // The owner's friends, as the owner's app last handed them over (memory only).
    this.ownerFriends = [];
    this.state.peerAis ??= {};
    this.state.peerCount ??= {};
    this.state.groups ??= {};
    // Other people's AIs already asked about (so one AI writing many times asks the owner once an hour).
    this.peerAsked = new Map();
    // Their messages wait here (memory only) until the owner's app answers.
    this.peerWaiting = new Map();
    this.pool = null;
  }

  /** The owner: the first trusted contact (the person whose app holds the AI permissions). */
  get owner() {
    return this.contacts.find((c) => c.trusted) ?? null;
  }

  /** Other people's AIs the owner's app lets this AI talk to now. */
  peerGrant(pubkey, now = Math.floor(Date.now() / 1000)) {
    const g = this.state.peerAis[pubkey];
    return g && g.until > now ? g : null;
  }

  /** Counts one message with another person's AI; false when today's limit is used up. */
  countPeer(pubkey) {
    const g = this.peerGrant(pubkey);
    if (!g) return false;
    const day = new Date().toISOString().slice(0, 10);
    const c = this.state.peerCount[pubkey]?.day === day ? this.state.peerCount[pubkey] : { day, n: 0 };
    if (c.n >= (g.limit ?? PEER_DAILY_LIMIT)) return false;
    this.state.peerCount[pubkey] = { day, n: c.n + 1 };
    this.saveState();
    return true;
  }

  /** A group every member has said yes to (the members' apps send its messages here only then). */
  groupApproved(room) {
    const g = this.state.groups[room];
    return !!g && room.split(',').every((m) => g.answers[m]?.yes === true);
  }

  /** A chat this AI may read and write: contacts only, a granted AI, or an approved group. */
  known(room) {
    if (room.includes(',')) return this.groupApproved(room);
    return this.contacts.some((c) => c.pubkey === room) || !!this.peerGrant(room);
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
    if ([SEND_RESULT_KIND, CONTACTS_KIND, PEER_RESULT_KIND].includes(rumor.kind)) {
      if (!this.isTrusted(rumor.pubkey)) return;
      let data;
      try {
        data = JSON.parse(rumor.content);
      } catch {
        return;
      }
      if (rumor.kind === CONTACTS_KIND && Array.isArray(data.friends))
        this.ownerFriends = data.friends.filter((f) => f && HEX.test(f.pubkey ?? '')).map((f) => ({ pubkey: f.pubkey, name: String(f.name ?? '').slice(0, 60) }));
      if (rumor.kind === PEER_RESULT_KIND && HEX.test(data.peer ?? '')) {
        // A grant, or (until 0) the owner took it back.
        if (Number(data.until) > Math.floor(Date.now() / 1000)) {
          const known = this.state.peerAis[data.peer] ?? {};
          this.state.peerAis[data.peer] = { ...known, until: Number(data.until), limit: Number(data.limit) || PEER_DAILY_LIMIT };
        } else delete this.state.peerAis[data.peer];
        this.saveState();
        const waiting = this.peerWaiting.get(data.peer) ?? [];
        this.peerWaiting.delete(data.peer);
        if (this.peerGrant(data.peer)) for (const w of waiting) this.receive(w);
      }
      const w = this.waiters.get(data.re);
      if (w) {
        this.waiters.delete(data.re);
        w(data);
      }
      return;
    }
    if (rumor.kind === AI_GROUP_KIND) {
      this.applyGroup(rumor);
      return;
    }
    if (rumor.kind !== 14) return;
    // Another person's AI writing as itself: only with the owner's permission, and within the limit.
    const selfTag = rumor.tags.find((t) => t[0] === 'ai' && t[1] === rumor.pubkey);
    const isPeerAi = !!selfTag && rumor.pubkey !== this.pubkey && !this.contacts.some((c) => c.pubkey === rumor.pubkey);
    if (isPeerAi && !rumor.tags.some((t) => t[0] === 'p' && t[1] !== this.pubkey)) {
      if (!this.peerGrant(rumor.pubkey)) {
        const waiting = this.peerWaiting.get(rumor.pubkey) ?? [];
        if (waiting.length < 20) this.peerWaiting.set(rumor.pubkey, [...waiting, wrap]);
        this.askAboutPeer({ pubkey: rumor.pubkey, model: selfTag[2] || undefined, name: selfTag[3] || undefined });
        return;
      }
      if (this.messages.some((m) => m.id === rumor.id) || !this.countPeer(rumor.pubkey)) return;
    }
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

  /**
   * Sends a message as this AI: to a contact, to another person's AI the owner allowed (within
   * the daily limit), or to a group every member said yes to (`peer` is the members, joined by ',').
   */
  async send(peer, text) {
    await this.connect();
    if (this.peerGrant(peer) && !this.contacts.some((c) => c.pubkey === peer) && !this.countPeer(peer)) throw new Error("Today's limit with this AI is used up.");
    const members = peer.split(',');
    const tags = [...members.map((m) => ['p', m]), aiTag(this.pubkey, this.profile)];
    const rumor = nip59.createRumor({ kind: 14, content: text, tags, created_at: Math.floor(Date.now() / 1000) }, this.secret);
    const wraps = [...members, this.pubkey].map((to) => nip59.createWrap(nip59.createSeal(rumor, this.secret, to), to));
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

  /** Sends an ask to the owner's app and waits for its answer (null after `ms`). */
  async askOwner(kind, data, ms = 60_000) {
    const owner = this.owner;
    if (!owner) throw new Error('No owner yet. Run: tegami-agent add "<your invite link>" --trust');
    await this.connect();
    const rumor = nip59.createRumor({ kind, content: JSON.stringify({ v: 1, ...data }), tags: [['p', owner.pubkey]], created_at: Math.floor(Date.now() / 1000) }, this.secret);
    const answer = new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiters.delete(rumor.id);
        resolve(null);
      }, ms);
      this.waiters.set(rumor.id, (d) => {
        clearTimeout(t);
        resolve(d);
      });
    });
    await Promise.any(this.pool.publish(RELAYS, wrapExpiring(rumor, this.secret, owner.pubkey), { onauth: this.onauth }));
    return answer;
  }

  /** The owner's friends (people), if the owner's app allows "友だちの一覧を見る". */
  async ownerContacts(ms) {
    const r = await this.askOwner(CONTACTS_ASK_KIND, {}, ms);
    return r?.friends ? this.ownerFriends : null;
  }

  /**
   * Asks the owner's app to send `text` to one of the owner's friends, in the owner's name.
   * Answers sent, waiting (for the owner to press 送る), declined, stopped, or null (no answer).
   */
  async sendAsOwner(to, text, ms) {
    const r = await this.askOwner(SEND_ASK_KIND, { to, text: String(text).slice(0, DRAFT_TEXT_MAX) }, ms);
    return r?.status ?? null;
  }

  /** Asks the owner's app whether this AI may talk to another person's AI. */
  async askPeer(peer, ms) {
    this.state.peerAis[peer.pubkey] = { ...(this.state.peerAis[peer.pubkey] ?? { until: 0 }), name: peer.name, model: peer.model };
    const r = await this.askOwner(PEER_ASK_KIND, { peer }, ms);
    return !!r && Number(r.until) > Math.floor(Date.now() / 1000);
  }

  /** Someone else's AI wrote: ask the owner once an hour at most (the message waits until allowed). */
  askAboutPeer(peer) {
    const last = this.peerAsked.get(peer.pubkey) ?? 0;
    if (Date.now() - last < 3_600_000 || !this.owner) return;
    this.peerAsked.set(peer.pubkey, Date.now());
    this.askPeer(peer).catch(() => {});
  }

  /** An invitation into a group, or a member's answer (client/src/lib/ai-actions.ts). */
  applyGroup(rumor) {
    let r;
    try {
      r = JSON.parse(rumor.content);
    } catch {
      return;
    }
    if (r?.ai !== this.pubkey || !Array.isArray(r.members)) return;
    const members = [...new Set(r.members.filter((m) => HEX.test(m)))].sort();
    if (!members.includes(rumor.pubkey) || members.includes(this.pubkey)) return;
    const room = members.join(',');
    const cur = this.state.groups[room];
    const at = rumor.created_at;
    if (r.t === 'invite') {
      if (cur && cur.at >= at) return;
      this.state.groups[room] = { at, answers: { [rumor.pubkey]: { yes: true, at } } };
    } else if (r.t === 'answer' && typeof r.yes === 'boolean') {
      if (!cur || at < cur.at || (cur.answers[rumor.pubkey]?.at ?? -1) > at) return;
      cur.answers[rumor.pubkey] = { yes: r.yes, at };
    } else return;
    this.saveState();
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
