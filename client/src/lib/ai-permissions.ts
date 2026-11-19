// What the user lets AI friends do, and the one gate every AI feature must pass.
//
// The switches live here, in the app that holds the user's key, not on the AI's PC:
// an AI can rewrite its own config, but it cannot make this app decrypt a chat for it
// or sign a message in the user's name. Every switch can be changed at any time.
//
// Settings are layered, and every layer must allow an action:
//   all AI   – one switch per action for every AI friend. Off by default.
//   model    – per AI model (e.g. "Anthropic Claude"). Follows "all AI" unless set.
//   AI       – per AI friend. Follows the layers above unless set.
//   friend   – per friend whose chats are touched. Off until the user picks the friend.
// A lower layer can only narrow what an upper layer allows, never widen it.
//
// A switch is off, on, on until a time (one hour, the rest of today), or "ask each time".
// The strictest layer wins: on above and "ask each time" below means asking.
//
// The confirm window is kept for a few moments only (people who are asked too often stop
// reading: Anthropic reports users accept 93% of manual prompts). It appears when:
//   - a switch is set to "ask each time" (never the default),
//   - my AI talks to another person's AI for the first time (the answer is kept a while),
//   - an AI sends a photo, video, file, voice or anything about money without asking first
//     (this one cannot be turned off).
// Turning "send without asking" on asks once, on the screen (components/ai-switches.tsx).
//
// Strangers are never reachable: reading a stranger's words while being able to send
// in the user's name is how prompt injection steals data (the "lethal trifecta").

import { useSyncExternalStore } from 'react';

import { findMoney, findSecret } from './ai-screen';
import { k, load, rawOf, save } from './storage';

/** Actions, from the least to the most power. */
export const AI_ACTIONS = ['contacts', 'read', 'draft', 'send', 'autosend', 'otherAi'] as const;
export type AiAction = (typeof AI_ACTIONS)[number];

/** Actions that touch one friend's chat, so the friend layer applies. */
export const FRIEND_ACTIONS: readonly AiAction[] = ['read', 'draft', 'send', 'autosend'];

/** An action that needs another action allowed too (sending without asking needs sending). */
const NEEDS: Partial<Record<AiAction, AiAction>> = { autosend: 'send' };

/**
 * What AI can do is opened in stages, the least risky first:
 *   1  read: the friend list, reading a chat, reply drafts
 *   2  sending in my name after I press 送る
 *   3  sending without asking, talking to other people's AIs, AI in a group
 * The app works up to AI_STAGE: an action of a later stage is refused by the gate (and
 * logged with the reason 'stage') whatever the switches say. The stage is set in the code,
 * not on screen; a build for tests may raise it with EXPO_PUBLIC_TEGAMI_AI_STAGE.
 */
export const AI_STAGE_OF: Record<AiAction | 'group', 1 | 2 | 3> = { contacts: 1, read: 1, draft: 1, send: 2, autosend: 3, otherAi: 3, group: 3 };
const stageEnv = Number(process.env.EXPO_PUBLIC_TEGAMI_AI_STAGE);
export const AI_STAGE: number = stageEnv >= 1 && stageEnv <= 3 ? Math.floor(stageEnv) : 2;
/** Whether this app does an action (or AI in a group) at all at its stage. */
export const aiStageAllows = (a: AiAction | 'group', stage = AI_STAGE) => AI_STAGE_OF[a] <= stage;

/**
 * How many messages an AI may send in my name without asking (philosophy: an AI once sent
 * more than 500 messages to its owner's family). The user can change the numbers but not
 * turn a limit off: every limit stays between LIMIT_MIN and LIMIT_MAX.
 *   minute: in one minute, to anyone
 *   chat:   in a row in one chat, with no message from a person in between
 *   day:    in 24 hours, to anyone
 */
export type AiLimits = { minute: number; chat: number; day: number };
export const AI_LIMIT_KEYS = ['minute', 'chat', 'day'] as const;
export const DEFAULT_AI_LIMITS: AiLimits = { minute: 5, chat: 20, day: 100 };
export const LIMIT_MIN = 1;
export const LIMIT_MAX: AiLimits = { minute: 60, chat: 200, day: 1000 };
export const clampLimit = (key: keyof AiLimits, n: unknown) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.min(LIMIT_MAX[key], Math.max(LIMIT_MIN, v)) : DEFAULT_AI_LIMITS[key];
};

/**
 * One switch. false or missing: off. true: on. 'ask': on, but the user answers each time
 * in the confirm window. { until }: on until that time (seconds), then off again.
 */
export type SwitchValue = boolean | 'ask' | { until: number };
type Switches = Partial<Record<AiAction, SwitchValue>>;
export type AiPermissions = {
  all: Switches;
  models: Record<string, Switches>;
  ais: Record<string, Switches>;
  friends: Record<string, Switches>;
  /**
   * Which other people's AIs my AI may talk to, and until when: key "<my AI>><their AI>".
   * The first time asks once in the confirm window; the answer is kept for a while.
   */
  peerAis: Record<string, { until: number }>;
  /** Limits on sending without asking; a missing key is its default (DEFAULT_AI_LIMITS). */
  limits?: Partial<AiLimits>;
};

/** What an AI was given to read: how many messages, from when to when (unix seconds). */
export type AiRange = { count: number; from: number; to: number };

export type AiLogEntry = {
  at: number;
  /** The AI friend; empty for a switch that ran out (no AI asked). */
  ai: string;
  action: AiAction;
  /** The friend whose chat it was, or the other person's AI. */
  friend?: string;
  /** The other person's AI: the name it gave, to show instead of its key. */
  peerName?: string;
  /** For reading: which messages were handed to the AI. */
  range?: AiRange;
  allowed: boolean;
  /** Which layer stopped it, or why the user was asked. */
  stoppedBy?: Layer;
  /** Asked in the confirm window: what the user answered. */
  answer?: 'allowed' | 'denied';
  /** A switch ran out: which layer and id it was on. */
  expired?: { layer: 'all' | 'model' | 'ai' | 'friend'; id?: string };
  /** A permission with a time limit ended early because something about the AI changed (endAiGrants). */
  ended?: GrantEnd;
};

/**
 * Why the time-limited permissions of one AI ended before their time (endAiGrants):
 * unmarked: the mark「自分のAI」was taken away. removed: the AI friend was removed.
 * model: the AI now says it runs another model. owner: the AI no longer says I am its owner.
 * Like SimpleX's "approve for the rest of the session", a permission given for a while holds
 * only for the AI it was given to; "ずっと" and "off" are the user's own choice and stay.
 */
export type GrantEnd = 'unmarked' | 'removed' | 'model' | 'owner';
export type Layer =
  | 'all'
  | 'model'
  | 'ai'
  | 'friend'
  | 'stranger'
  | 'needs'
  /** The switch had a time limit that has passed. */
  | 'expired'
  /** The switch is set to ask each time. */
  | 'ask'
  /** Photos, videos, files, voice and money: always asked before an AI sends them without asking. */
  | 'always'
  /** My AI has not talked to this person's AI before (or the permission ran out). */
  | 'firstPeer'
  /** This version of the app does not do the action yet (AI_STAGE). */
  | 'stage'
  /** Sending without asking reached a limit (AiLimits); the message waits for 送る instead. */
  | 'limit'
  /** AIの検査: the text looks like it carries a secret (a key, a recovery code, a card number). Never sent by an AI. */
  | 'secret'
  /**
   * The AI read what someone else wrote in the same session (Meta's Agents Rule of Two): what it
   * sends from that session always waits for the user, even with 確認なしで送る on.
   */
  | 'others';

const EMPTY: AiPermissions = { all: {}, models: {}, ais: {}, friends: {}, peerAis: {} };
const LOG_MAX = 1000;
const now = () => Math.floor(Date.now() / 1000);

let cache: { key: string; raw: string | null; value: AiPermissions } | null = null;
const listeners = new Set<() => void>();

/** Read again whenever the stored text changed, so a switch turned off in another tab stops the gate here too. */
export function getAiPermissions(): AiPermissions {
  const key = k('ai.permissions');
  const raw = rawOf(key);
  if (cache?.key !== key || cache.raw !== raw) cache = { key, raw, value: cleanAiPermissions(load<unknown>(key, EMPTY)) };
  return cache.value;
}

function cleanValue(v: unknown): SwitchValue | undefined {
  if (typeof v === 'boolean' || v === 'ask') return v;
  const until = (v as { until?: unknown } | null)?.until;
  if (typeof until === 'number' && Number.isFinite(until) && until > 0) return { until: Math.floor(until) };
  return undefined;
}

/**
 * Checks settings that came from outside (a link to another device or a recovery backup)
 * or from an older version on this device. Unknown actions and unknown values are dropped,
 * so an older bundle without settings, or a broken one, gives every switch its default
 * (all AI off). Settings of the first version (only true and false) keep their meaning.
 */
export function cleanAiPermissions(raw: unknown): AiPermissions {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const switches = (v: unknown): Switches => {
    const out: Switches = {};
    if (!v || typeof v !== 'object') return out;
    for (const a of AI_ACTIONS) {
      const value = cleanValue((v as Record<string, unknown>)[a]);
      if (value !== undefined) out[a] = value;
    }
    return out;
  };
  const table = (v: unknown): Record<string, Switches> => {
    const out: Record<string, Switches> = {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    for (const [id, sw] of Object.entries(v).slice(0, 1000)) {
      if (id.length > 200) continue;
      const clean = switches(sw);
      if (Object.keys(clean).length) out[id] = clean;
    }
    return out;
  };
  const peerAis: Record<string, { until: number }> = {};
  if (r.peerAis && typeof r.peerAis === 'object' && !Array.isArray(r.peerAis))
    for (const [id, g] of Object.entries(r.peerAis).slice(0, 1000)) {
      const v = cleanValue(g);
      if (id.length <= 200 && v && typeof v === 'object') peerAis[id] = v;
    }
  const limits: Partial<AiLimits> = {};
  if (r.limits && typeof r.limits === 'object' && !Array.isArray(r.limits))
    for (const key of AI_LIMIT_KEYS) {
      const v = (r.limits as Record<string, unknown>)[key];
      if (typeof v === 'number' && Number.isFinite(v)) limits[key] = clampLimit(key, v);
    }
  return {
    all: switches(r.all),
    models: table(r.models),
    ais: table(r.ais),
    friends: table(r.friends),
    peerAis,
    ...(Object.keys(limits).length ? { limits } : {}),
  };
}

/** The limits in force: the user's numbers, never off, never 0. */
export function aiLimits(p: AiPermissions): AiLimits {
  const out = { ...DEFAULT_AI_LIMITS };
  for (const key of AI_LIMIT_KEYS) if (p.limits?.[key] !== undefined) out[key] = clampLimit(key, p.limits[key]);
  return out;
}

/** Sets one limit (kept between LIMIT_MIN and LIMIT_MAX). */
export function setAiLimit(key: keyof AiLimits, n: number) {
  const p = getAiPermissions();
  put({ ...p, limits: { ...p.limits, [key]: clampLimit(key, n) } });
}

/** One message an AI sent in my name: when, and to which chat. */
export type AiSent = { at: number; to: string };

/**
 * Which limit sending one more message to `to` would pass, or null. `sent` is what AIs sent
 * in my name on this device; `inARow` is how many messages at the end of that chat an AI
 * wrote in my name, with no message from a person after them.
 */
export function overAiLimit(p: AiPermissions, sent: AiSent[], inARow: number, at = now()): keyof AiLimits | null {
  const l = aiLimits(p);
  if (sent.filter((x) => at - x.at < 60).length >= l.minute) return 'minute';
  if (inARow >= l.chat) return 'chat';
  if (sent.filter((x) => at - x.at < 86400).length >= l.day) return 'day';
  return null;
}

export function loadAiSent(at = now()): AiSent[] {
  return load<AiSent[]>(k('ai.sent'), []).filter((x) => x && at - x.at < 86400);
}
export function recordAiSent(to: string, at = now()) {
  save(k('ai.sent'), [...loadAiSent(at), { at, to }].slice(-2000));
}

/**
 * Whether `next` lets AIs do more than `prev` (settings that came from my other device):
 * a switch went from off to ask or on, or from ask to on, an AI's or a model's switch that was
 * off now follows the layer above, a time limit got longer, another person's AI was allowed,
 * or a limit on sending went up.
 */
export function aiWidened(prev: AiPermissions, next: AiPermissions, at = now()): boolean {
  // How much a switch allows: its level, then how long it stays on.
  const rank = (v: SwitchValue | undefined, follows: boolean): [number, number] => {
    if (v === undefined) return follows ? [2, Infinity] : [0, 0];
    const l = level(v, at);
    if (l !== 2) return [l, 0];
    return [2, typeof v === 'object' ? v.until : Infinity];
  };
  const more = (a: SwitchValue | undefined, b: SwitchValue | undefined, follows: boolean) => {
    const [la, ua] = rank(a, follows);
    const [lb, ub] = rank(b, follows);
    return lb > la || (lb === la && ub > ua);
  };
  for (const act of AI_ACTIONS) if (more(prev.all[act], next.all[act], false)) return true;
  for (const field of ['models', 'ais', 'friends'] as const) {
    const ids = new Set([...Object.keys(prev[field]), ...Object.keys(next[field])]);
    for (const id of ids)
      for (const act of AI_ACTIONS) if (more(prev[field][id]?.[act], next[field][id]?.[act], field !== 'friends')) return true;
  }
  for (const [id, g] of Object.entries(next.peerAis)) if (g.until > at && g.until > (prev.peerAis[id]?.until ?? 0)) return true;
  const a = aiLimits(prev);
  const b = aiLimits(next);
  return AI_LIMIT_KEYS.some((key) => b[key] > a[key]);
}

/** Replaces every switch at once (an account moved or restored from another device). The log stays. */
export function replaceAiPermissions(next: unknown) {
  put(cleanAiPermissions(next));
}

function put(next: AiPermissions) {
  const key = k('ai.permissions');
  save(key, next);
  // Without storage (private mode) raw stays null and the switches live in memory.
  cache = { key, raw: rawOf(key), value: next };
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useAiPermissions(): AiPermissions {
  return useSyncExternalStore(subscribe, getAiPermissions, getAiPermissions);
}

export type Scope = { layer: 'all' } | { layer: 'model' | 'ai' | 'friend'; id: string };

function tableOf(layer: 'model' | 'ai' | 'friend') {
  return layer === 'model' ? 'models' : layer === 'ai' ? 'ais' : 'friends';
}

/** Sets one switch: on, off, 'ask' (each time), or on until a time. */
export function setAiSwitch(scope: Scope, action: AiAction, value: SwitchValue) {
  setAiSwitches(scope, { [action]: value });
}

/** Sets several switches of one layer at once (the "read only" choice). */
export function setAiSwitches(scope: Scope, values: Partial<Record<AiAction, SwitchValue>>) {
  const p = getAiPermissions();
  if (scope.layer === 'all') return put({ ...p, all: { ...p.all, ...values } });
  const field = tableOf(scope.layer);
  const table = p[field];
  put({ ...p, [field]: { ...table, [scope.id]: { ...table[scope.id], ...values } } });
}

/** The read-only choice: see the friend list, read chats and write drafts; nothing is sent. */
export const READ_ONLY: Record<AiAction, boolean> = { contacts: true, read: true, draft: true, send: false, autosend: false, otherAi: false };

/** 0: off, 1: ask each time, 2: on. A time limit that has passed counts as off. */
function level(v: SwitchValue | undefined, at: number): 0 | 1 | 2 {
  if (v === true) return 2;
  if (v === 'ask') return 1;
  if (v && typeof v === 'object') return at < v.until ? 2 : 0;
  return 0;
}
const ranOut = (v: SwitchValue | undefined, at: number) => !!v && typeof v === 'object' && at >= v.until;

/** The value set on one layer (undefined: not set, so it follows the layer above or is off). */
export function rawValue(p: AiPermissions, scope: Scope, action: AiAction): SwitchValue | undefined {
  if (scope.layer === 'all') return p.all[action];
  return p[tableOf(scope.layer)][scope.id]?.[action];
}

/** The switch as shown on screen: the model and AI layers follow the layer above unless set. */
export function switchValue(p: AiPermissions, scope: Scope, action: AiAction, at = now()): boolean {
  const v = rawValue(p, scope, action);
  if (scope.layer === 'model' || scope.layer === 'ai') return v === undefined || level(v, at) > 0;
  return level(v, at) > 0;
}

export type AiContent = {
  /** What the AI wants to send. */
  kind: 'text' | 'photo' | 'video' | 'file' | 'voice' | 'stamp';
  text?: string;
};

export type AiRequest = {
  /** The AI friend's public key. */
  ai: string;
  /** The AI friend's model, as its invite link carried it. */
  model?: string;
  action: AiAction;
  /** Whose chat the action touches (friend actions only). */
  friend?: string;
  /** What the AI wants to send (send and autosend). */
  content?: AiContent;
  /** The other person's AI (otherAi only). */
  peer?: { pubkey: string; name?: string; model?: string };
  /** For reading: the messages that will be handed over, kept in the log. */
  range?: AiRange;
  /**
   * For sending: false only when the AI's program says this session read nothing written by
   * anyone but the user. Left out counts as read (an older program does not say).
   */
  readOthers?: boolean;
};

/** A web address in a text: http(s)://, www., or a bare domain with a common ending. */
const LINK = /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|jp|io|co|app|chat|me|ly|gl|xyz|info|biz|link|site|top|dev|page|shop)\b/;

/**
 * Photos, videos, files, voice, links and what looks like money: an AI never sends them
 * without the user seeing them first. Money is found by fixed patterns (ai-screen.ts findMoney:
 * accounts, payment apps, crypto, gift cards, words that move money, an amount someone asks for),
 * so the screen says "お金の話に見える文" and never promises every money talk is caught.
 */
export function needsConfirm(content?: AiContent): boolean {
  if (!content) return false;
  if (content.kind !== 'text') return true;
  const t = (content.text ?? '').normalize?.('NFKC').toLowerCase() ?? '';
  return LINK.test(t) || findMoney(content.text ?? '') !== null;
}

export type AiDecision = { verdict: 'allow' | 'ask' | 'deny'; by?: Layer };

/**
 * Decides one request. `isFriend` says whether the pubkey is in the user's friends
 * (strangers are always refused). Every layer must allow the action, and the strictest
 * layer wins: a lower layer can narrow "on" to "ask each time" but never widen.
 */
export function decideAi(p: AiPermissions, r: AiRequest, isFriend: (pubkey: string) => boolean, at = now(), stage = AI_STAGE): AiDecision {
  const a = r.action;
  if (!aiStageAllows(a, stage)) return { verdict: 'deny', by: 'stage' };
  // AIの検査: a key, a recovery code or a card number is never sent by an AI, whatever the switches say.
  if ((a === 'send' || a === 'autosend') && r.content?.text && findSecret(r.content.text)) return { verdict: 'deny', by: 'secret' };
  let lv = level(p.all[a], at);
  if (lv === 0) return { verdict: 'deny', by: ranOut(p.all[a], at) ? 'expired' : 'all' };
  const needs = NEEDS[a];
  if (needs && decideAi(p, { ...r, action: needs }, isFriend, at, stage).verdict === 'deny') return { verdict: 'deny', by: 'needs' };
  const narrow = (v: SwitchValue | undefined, layer: Layer): AiDecision | null => {
    if (v === undefined) return null;
    const l = level(v, at);
    if (l === 0) return { verdict: 'deny', by: ranOut(v, at) ? 'expired' : layer };
    lv = Math.min(lv, l) as 0 | 1 | 2;
    return null;
  };
  const byModel = r.model ? narrow(p.models[r.model]?.[a], 'model') : null;
  if (byModel) return byModel;
  const byAi = narrow(p.ais[r.ai]?.[a], 'ai');
  if (byAi) return byAi;
  if (FRIEND_ACTIONS.includes(a)) {
    if (!r.friend || !isFriend(r.friend)) return { verdict: 'deny', by: 'stranger' };
    const f = p.friends[r.friend]?.[a];
    if (level(f, at) === 0) return { verdict: 'deny', by: ranOut(f, at) ? 'expired' : 'friend' };
    lv = Math.min(lv, level(f, at)) as 0 | 1 | 2;
  }
  if (a === 'otherAi') {
    if (!r.peer?.pubkey || !/^[0-9a-f]{64}$/.test(r.peer.pubkey)) return { verdict: 'deny', by: 'stranger' };
    const grant = p.peerAis[`${r.ai}>${r.peer.pubkey}`];
    if (!grant || at >= grant.until) return { verdict: 'ask', by: 'firstPeer' };
  }
  if (lv === 1) return { verdict: 'ask', by: 'ask' };
  if (a === 'autosend' && needsConfirm(r.content)) return { verdict: 'ask', by: 'always' };
  if (a === 'autosend' && r.readOthers !== false) return { verdict: 'ask', by: 'others' };
  return { verdict: 'allow' };
}

/** The layer that stopped a request, or why it must be asked; null when it may go ahead. */
export function checkAi(p: AiPermissions, r: AiRequest, isFriend: (pubkey: string) => boolean, at = now()): Layer | null {
  const d = decideAi(p, r, isFriend, at);
  return d.verdict === 'allow' ? null : (d.by ?? 'all');
}

function writeLog(entry: AiLogEntry) {
  const log = load<AiLogEntry[]>(k('ai.log'), []);
  save(k('ai.log'), [...log, entry].slice(-LOG_MAX));
  for (const l of logListeners) l();
}

function logRequest(r: AiRequest, allowed: boolean, by?: Layer, answer?: 'allowed' | 'denied') {
  writeLog({
    at: now(),
    ai: r.ai,
    action: r.action,
    ...(r.friend ? { friend: r.friend } : r.peer ? { friend: r.peer.pubkey } : {}),
    ...(!r.friend && r.peer?.name ? { peerName: r.peer.name.slice(0, 60) } : {}),
    ...(r.range && allowed ? { range: r.range } : {}),
    allowed,
    ...(by ? { stoppedBy: by } : {}),
    ...(answer ? { answer } : {}),
  });
}

/**
 * The gate without asking: true only when the request may go ahead with no confirm window.
 * A request that needs the user's answer returns false here (logged as stopped); use askAi
 * to show the confirm window instead.
 */
export function gateAi(r: AiRequest, isFriend: (pubkey: string) => boolean): boolean {
  expireAiSwitches();
  const d = decideAi(getAiPermissions(), r, isFriend);
  logRequest(r, d.verdict === 'allow', d.by);
  return d.verdict === 'allow';
}

/** once: only this time. day / month: this other AI until the end of today / for 30 days. no: refuse. */
export type AiAnswer = 'once' | 'day' | 'month' | 'no';
/** What the confirm window shows, and the way to answer it. */
export type AiAsk = { request: AiRequest; why: Layer; answer: (a: AiAnswer) => void };

let asking: AiAsk | null = null;
const askListeners = new Set<() => void>();

/** The confirm window (components/ai-confirm.tsx) reads this; without the window on screen, asking refuses. */
export function useAiAsk(): AiAsk | null {
  return useSyncExternalStore(
    (l) => {
      askListeners.add(l);
      return () => askListeners.delete(l);
    },
    () => asking,
    () => asking,
  );
}

/** The end of today on this device's clock, in seconds. */
function endOfToday() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** The switches' time limits: one hour from now, or the rest of today. */
export function untilFor(choice: 'hour' | 'today'): { until: number } {
  return { until: choice === 'hour' ? now() + 3600 : endOfToday() };
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * The gate with asking: decides the request and, when the user must answer, shows the
 * confirm window and waits for the answer. Every decision and every answer is logged.
 */
export function askAi(r: AiRequest, isFriend: (pubkey: string) => boolean): Promise<boolean> {
  expireAiSwitches();
  const d = decideAi(getAiPermissions(), r, isFriend);
  if (d.verdict !== 'ask' || askListeners.size === 0) {
    logRequest(r, d.verdict === 'allow', d.by);
    return Promise.resolve(d.verdict === 'allow');
  }
  // One window at a time: the next request waits for the answer to this one.
  const next = queue.then(
    () =>
      new Promise<boolean>((done) => {
        asking = {
          request: r,
          why: d.by ?? 'ask',
          answer: (a) => {
            asking = null;
            for (const l of askListeners) l();
            const yes = a !== 'no';
            if (yes && r.action === 'otherAi' && r.peer && a !== 'once') {
              const p = getAiPermissions();
              const until = a === 'day' ? endOfToday() : now() + 30 * 86400;
              put({ ...p, peerAis: { ...p.peerAis, [`${r.ai}>${r.peer.pubkey}`]: { until } } });
            }
            logRequest(r, yes, d.by, yes ? 'allowed' : 'denied');
            done(yes);
          },
        };
        for (const l of askListeners) l();
      }),
  );
  queue = next.catch(() => {});
  return next;
}

/**
 * Turns switches whose time limit has passed off again and writes each to the log.
 * Runs before every decision and once a minute while the app is open.
 */
export function expireAiSwitches(at = now()) {
  const p = getAiPermissions();
  let changed = false;
  const sweep = (sw: Switches, layer: 'all' | 'model' | 'ai' | 'friend', id?: string): Switches => {
    let out = sw;
    for (const a of AI_ACTIONS) {
      if (!ranOut(sw[a], at)) continue;
      out = { ...out, [a]: false };
      changed = true;
      writeLog({
        at,
        ai: '',
        action: a,
        ...(layer === 'friend' && id ? { friend: id } : {}),
        allowed: false,
        stoppedBy: 'expired',
        expired: { layer, ...(id ? { id } : {}) },
      });
    }
    return out;
  };
  const sweepTable = (t: Record<string, Switches>, layer: 'model' | 'ai' | 'friend') =>
    Object.fromEntries(Object.entries(t).map(([id, sw]) => [id, sweep(sw, layer, id)]));
  const next: AiPermissions = {
    all: sweep(p.all, 'all'),
    models: sweepTable(p.models, 'model'),
    ais: sweepTable(p.ais, 'ai'),
    friends: sweepTable(p.friends, 'friend'),
    peerAis: Object.fromEntries(Object.entries(p.peerAis).filter(([, g]) => at < g.until)),
  };
  if (Object.keys(next.peerAis).length !== Object.keys(p.peerAis).length) changed = true;
  if (changed) put(next);
}

const logListeners = new Set<() => void>();
let logCache: { key: string; raw: string | null; value: AiLogEntry[] } | null = null;

function getLog(): AiLogEntry[] {
  const key = k('ai.log');
  const raw = rawOf(key);
  if (logCache?.key !== key || logCache.raw !== raw) logCache = { key, raw, value: load<AiLogEntry[]>(key, []) };
  return logCache.value;
}

export function useAiLog(): AiLogEntry[] {
  return useSyncExternalStore(
    (l) => {
      logListeners.add(l);
      return () => logListeners.delete(l);
    },
    getLog,
    getLog,
  );
}

/**
 * Takes back my AI's permission to talk to another person's AI (lib/ai-actions.ts tells the AI).
 * The next time it asks, the confirm window asks again.
 */
export function removePeerAi(ai: string, peer: string) {
  const p = getAiPermissions();
  const key = `${ai}>${peer}`;
  if (!p.peerAis[key]) return;
  const { [key]: _, ...rest } = p.peerAis;
  put({ ...p, peerAis: rest });
}

/**
 * Turns every "all AI" switch off at once, which stops every AI whatever the lower layers say,
 * and takes back every permission my AIs had to talk to other people's AIs. Returns those
 * permissions as [my AI, their AI] pairs, so the app can tell each AI (lib/tegami.tsx stopAi).
 */
export function stopAllAi(): [string, string][] {
  const p = getAiPermissions();
  const taken = Object.keys(p.peerAis).map((key) => key.split('>') as [string, string]);
  put({ ...p, all: Object.fromEntries(AI_ACTIONS.map((a) => [a, false])), peerAis: {} });
  return taken;
}

/**
 * Ends the permissions given to one AI for a while: its switches set to "1時間" or "今日だけ"
 * on the AI layer, and its permissions to talk to other people's AIs. Each is written to the log
 * with the reason. Returns the other AIs it may no longer talk to, so the app can tell the AI.
 * Switches set to on (ずっと), off or 毎回確認 are left as the user set them, except when the AI
 * friend was removed: then nothing set for it is kept, so adding it again starts from the defaults.
 */
export function endAiGrants(ai: string, why: GrantEnd, at = now()): string[] {
  const p = getAiPermissions();
  const sw = p.ais[ai] ?? {};
  let changed = false;
  let next: Switches = sw;
  for (const a of AI_ACTIONS) {
    const v = sw[a];
    if (!v || typeof v !== 'object' || at >= v.until) continue;
    next = { ...next, [a]: false };
    changed = true;
    writeLog({ at, ai, action: a, allowed: false, ended: why });
  }
  const prefix = `${ai}>`;
  const peers = Object.keys(p.peerAis).filter((key) => key.startsWith(prefix));
  for (const key of peers) writeLog({ at, ai, action: 'otherAi', friend: key.slice(prefix.length), allowed: false, ended: why });
  if (!changed && !peers.length && !(why === 'removed' && p.ais[ai])) return [];
  const ais = { ...p.ais };
  if (why === 'removed') delete ais[ai];
  else ais[ai] = next;
  put({ ...p, ais, peerAis: Object.fromEntries(Object.entries(p.peerAis).filter(([key]) => !key.startsWith(prefix))) });
  return peers.map((key) => key.slice(prefix.length));
}

/** Logs a request stopped outside decideAi (a limit on sending, AI in a group at this stage). */
export function logAiStop(r: AiRequest, by: Layer) {
  logRequest(r, false, by);
}
