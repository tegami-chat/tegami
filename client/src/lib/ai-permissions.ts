// What the user lets AI friends do, and the one gate every AI feature must pass.
//
// The switches live here, in the app that holds the user's key, not on the AI's PC:
// an AI can rewrite its own config, but it cannot make this app decrypt a chat for it
// or sign a message in the user's name. Every switch can be changed at any time.
//
// Settings are layered, and every layer must allow an action:
//   all AI   – one switch per action for every AI friend. Off by default.
//   model    – per AI model (e.g. "Anthropic Claude"). Follows "all AI" unless turned off.
//   AI       – per AI friend. Follows the layers above unless turned off.
//   friend   – per friend whose chats are touched. Off until the user picks the friend.
// A lower layer can only narrow what an upper layer allows, never widen it.
//
// Strangers are never reachable: reading a stranger's words while being able to send
// in the user's name is how prompt injection steals data (the "lethal trifecta").

import { useSyncExternalStore } from 'react';

import { k, load, save } from './storage';

/** Actions, from the least to the most power. */
export const AI_ACTIONS = ['contacts', 'read', 'draft', 'send', 'autosend', 'otherAi'] as const;
export type AiAction = (typeof AI_ACTIONS)[number];

/** Actions that touch one friend's chat, so the friend layer applies. */
export const FRIEND_ACTIONS: readonly AiAction[] = ['read', 'draft', 'send', 'autosend'];

/** An action that needs another action allowed too (sending without asking needs sending). */
const NEEDS: Partial<Record<AiAction, AiAction>> = { autosend: 'send' };

type Switches = Partial<Record<AiAction, boolean>>;
export type AiPermissions = {
  all: Switches;
  models: Record<string, Switches>;
  ais: Record<string, Switches>;
  friends: Record<string, Switches>;
};

export type AiLogEntry = {
  at: number;
  ai: string;
  action: AiAction;
  friend?: string;
  allowed: boolean;
  /** Which layer stopped it, when it was stopped. */
  stoppedBy?: Layer;
};
export type Layer = 'all' | 'model' | 'ai' | 'friend' | 'stranger' | 'needs';

const EMPTY: AiPermissions = { all: {}, models: {}, ais: {}, friends: {} };
const LOG_MAX = 1000;

let cache: { key: string; value: AiPermissions } | null = null;
const listeners = new Set<() => void>();

export function getAiPermissions(): AiPermissions {
  const key = k('ai.permissions');
  if (cache?.key !== key) cache = { key, value: { ...EMPTY, ...load<AiPermissions>(key, EMPTY) } };
  return cache.value;
}

function put(next: AiPermissions) {
  const key = k('ai.permissions');
  cache = { key, value: next };
  save(key, next);
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useAiPermissions(): AiPermissions {
  return useSyncExternalStore(subscribe, getAiPermissions, getAiPermissions);
}

type Scope = { layer: 'all' } | { layer: 'model' | 'ai' | 'friend'; id: string };

/** Turns one switch on or off. */
export function setAiSwitch(scope: Scope, action: AiAction, on: boolean) {
  const p = getAiPermissions();
  if (scope.layer === 'all') return put({ ...p, all: { ...p.all, [action]: on } });
  const field = scope.layer === 'model' ? 'models' : scope.layer === 'ai' ? 'ais' : 'friends';
  const table = p[field];
  put({ ...p, [field]: { ...table, [scope.id]: { ...table[scope.id], [action]: on } } });
}

/** The switch as shown on screen: the layers above "all AI" follow it unless turned off. */
export function switchValue(p: AiPermissions, scope: Scope, action: AiAction): boolean {
  if (scope.layer === 'all') return p.all[action] === true;
  if (scope.layer === 'friend') return p.friends[scope.id]?.[action] === true;
  const table = scope.layer === 'model' ? p.models : p.ais;
  return table[scope.id]?.[action] !== false;
}

export type AiRequest = {
  /** The AI friend's public key. */
  ai: string;
  /** The AI friend's model, as its invite link carried it. */
  model?: string;
  action: AiAction;
  /** Whose chat the action touches (friend actions only). */
  friend?: string;
};

/**
 * Decides one request. `isFriend` says whether the pubkey is in the user's friends
 * (strangers are always refused). Returns which layer stopped it, or null when allowed.
 */
export function checkAi(p: AiPermissions, r: AiRequest, isFriend: (pubkey: string) => boolean): Layer | null {
  if (p.all[r.action] !== true) return 'all';
  const needs = NEEDS[r.action];
  if (needs && checkAi(p, { ...r, action: needs }, isFriend)) return 'needs';
  if (r.model && p.models[r.model]?.[r.action] === false) return 'model';
  if (p.ais[r.ai]?.[r.action] === false) return 'ai';
  if (FRIEND_ACTIONS.includes(r.action)) {
    if (!r.friend || !isFriend(r.friend)) return 'stranger';
    if (p.friends[r.friend]?.[r.action] !== true) return 'friend';
  }
  return null;
}

/** The gate: decides a request and writes it to the log on this device. */
export function gateAi(r: AiRequest, isFriend: (pubkey: string) => boolean): boolean {
  const stoppedBy = checkAi(getAiPermissions(), r, isFriend);
  const entry: AiLogEntry = {
    at: Math.floor(Date.now() / 1000),
    ai: r.ai,
    action: r.action,
    ...(r.friend ? { friend: r.friend } : {}),
    allowed: !stoppedBy,
    ...(stoppedBy ? { stoppedBy } : {}),
  };
  const log = load<AiLogEntry[]>(k('ai.log'), []);
  save(k('ai.log'), [...log, entry].slice(-LOG_MAX));
  for (const l of logListeners) l();
  return !stoppedBy;
}

const logListeners = new Set<() => void>();
let logCache: { key: string; raw: string | null; value: AiLogEntry[] } | null = null;

function getLog(): AiLogEntry[] {
  const key = k('ai.log');
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    raw = null;
  }
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

/** Turns every "all AI" switch off at once, which stops every AI whatever the lower layers say. */
export function stopAllAi() {
  const p = getAiPermissions();
  put({ ...p, all: Object.fromEntries(AI_ACTIONS.map((a) => [a, false])) });
}
