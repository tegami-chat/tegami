// Whether the friend's screen shows the 「AIが書いた」 mark on what my AI wrote in my name.
// A taste, not a permission: a lower layer may overrule the one above it (unlike the switches in
// lib/ai-permissions.ts, where a lower layer only narrows). Nothing here lets an AI do more.
//
//   all     – every AI. On unless turned off (the app has always marked).
//   ais     – one of my AIs, by its key. Missing: follows all.
//   friends – the friend the message goes to, by key. Missing: follows the AI, then all.
//
// With the mark off, the message carries no ai tag, so the friend's app and my own copy (NIP-17
// sends me the same message) have none. On this device the mark is still drawn: the message's
// id is kept here with the AI that wrote it (`ai.marked`, newest MARKED_MAX).

import { useSyncExternalStore } from 'react';

import { onSealedChange } from './at-rest';
import { k, load, rawOf, save } from './storage';

export type AiMark = { all: boolean; ais: Record<string, boolean>; friends: Record<string, boolean> };
/** What one AI or one friend is set to: follow the layer above, or decide. */
export type AiMarkChoice = 'follow' | 'on' | 'off';
export type AiBy = { pubkey: string; model?: string; name?: string };

const HEX = /^[0-9a-f]{64}$/;
export const MARKED_MAX = 2000;
const DEFAULT: AiMark = { all: true, ais: {}, friends: {} };

function table(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (raw && typeof raw === 'object') for (const [key, v] of Object.entries(raw)) if (HEX.test(key) && typeof v === 'boolean') out[key] = v;
  return out;
}

/** Settings from storage or another device: anything unknown is dropped, so it falls back to marking. */
export function cleanAiMark(raw: unknown): AiMark {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { all: r.all !== false, ais: table(r.ais), friends: table(r.friends) };
}

/** The decision: the friend's layer if it has one, else the AI's, else all. */
export function aiMarkWanted(m: AiMark, ai: string, friend: string): boolean {
  return m.friends[friend] ?? m.ais[ai] ?? m.all;
}

export const choiceOf = (v: boolean | undefined): AiMarkChoice => (v === undefined ? 'follow' : v ? 'on' : 'off');

let cache: { key: string; raw: string | null; value: AiMark } | null = null;
const listeners = new Set<() => void>();

export function getAiMark(): AiMark {
  const key = k('ai.mark');
  const raw = rawOf(key);
  if (cache?.key !== key || cache.raw !== raw) cache = { key, raw, value: cleanAiMark(load<unknown>(key, DEFAULT)) };
  return cache.value;
}

function put(next: AiMark) {
  const key = k('ai.mark');
  save(key, next);
  cache = { key, raw: rawOf(key), value: next };
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  const off = onSealedChange(l);
  return () => {
    listeners.delete(l);
    off();
  };
}

export function useAiMark(): AiMark {
  return useSyncExternalStore(subscribe, getAiMark, getAiMark);
}

export function setAiMarkAll(on: boolean) {
  put({ ...getAiMark(), all: on });
}

/** Sets one AI or one friend; 'follow' takes its own setting away. */
export function setAiMarkChoice(layer: 'ai' | 'friend', id: string, choice: AiMarkChoice) {
  const m = getAiMark();
  const key = layer === 'ai' ? 'ais' : 'friends';
  const { [id]: _gone, ...rest } = m[key];
  put({ ...m, [key]: choice === 'follow' ? rest : { ...rest, [id]: choice === 'on' } });
}

// ---------- messages sent without the mark: still marked on this device ----------

type Marked = AiBy & { id: string };
let markedCache: { key: string; raw: string | null; map: Map<string, AiBy> } | null = null;

function markedMap(): Map<string, AiBy> {
  const key = k('ai.marked');
  const raw = rawOf(key);
  if (markedCache?.key !== key || markedCache.raw !== raw) {
    const list = load<unknown>(key, []);
    const map = new Map<string, AiBy>();
    if (Array.isArray(list)) {
      for (const x of list as Partial<Marked>[]) {
        if (x && typeof x.id === 'string' && typeof x.pubkey === 'string' && HEX.test(x.pubkey)) {
          map.set(x.id, { pubkey: x.pubkey, ...(x.model ? { model: String(x.model).slice(0, 60) } : {}), ...(x.name ? { name: String(x.name).slice(0, 60) } : {}) });
        }
      }
    }
    markedCache = { key, raw, map };
  }
  return markedCache.map;
}

/** Remembers that message `id` was written by `by`, though it carries no mark. Keeps the newest MARKED_MAX. */
export function rememberMarked(id: string, by: AiBy) {
  const key = k('ai.marked');
  const list = load<Marked[]>(key, []);
  const next = [...(Array.isArray(list) ? list : []).filter((x) => x?.id !== id), { id, ...by }].slice(-MARKED_MAX);
  save(key, next);
  markedCache = null;
}

/** The AI that wrote message `id` without the mark, if this device remembers it. */
export function markedBy(id: string): AiBy | undefined {
  return markedMap().get(id);
}
