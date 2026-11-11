// Core of tegami-agent: one Nostr key for one AI friend, its contacts and messages.
//
// Everything lives in one folder on this computer (TEGAMI_AGENT_HOME, default
// ~/.tegami/agents/<name>). key.json holds the AI's secret key in plain text, like
// an SSH key: the agent has to run unattended, so there is no passkey to unlock it.

import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as nip17 from 'nostr-tools/nip17';
import * as nip19 from 'nostr-tools/nip19';
import * as nip59 from 'nostr-tools/nip59';
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import WebSocket from 'ws';

useWebSocketImplementation(WebSocket);

export const RELAYS = (process.env.TEGAMI_RELAYS ?? 'wss://relay.tegami.chat').split(',');
export const APP_ORIGIN = 'https://app.tegami.chat';

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
  return pubkey ? { pubkey, name: param('n'), model: param('m') } : null;
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
