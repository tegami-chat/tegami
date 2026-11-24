// Keeps my own devices in step: friends (and the names I gave them), groups, blocks and
// what AI friends may do.
//
// Each device keeps a ledger: one entry per item ("c:<pubkey>" a friend, "g:<id>" a group,
// "b:<pubkey>" a block, "a:<path>" one AI switch), each with the time it last changed on any
// of my devices (ms) and its value, or no value when it was removed (a tombstone). A change
// here gets the current time; the whole ledger then goes to my own key in a quiet envelope
// (rumor kind ACCOUNT_SYNC_KIND), like the stamp list, and my other devices merge it entry
// by entry: the later time wins. So two devices that change different things at the same
// time both keep both changes, a removal is not undone by a device that had not heard of
// it yet, and envelopes can arrive in any order or more than once.
//
// Not synced:
// - removing a group: deleting a chat is for this device only ("この端末から消えます").
//   It leaves a local tombstone, so an older group entry from another device does not bring
//   it back, but it is never sent.
// - a friend's picture: it comes from the friend's own profile card, which reaches every
//   one of my devices anyway.
// - Tegami groups (chat id `g-<gid>`, groups.ts): their state (members, name, picture, admins)
//   comes only from signed group changes (GROUP_KIND), which are sealed for my devices too, so
//   the ledger does not carry them. Otherwise a ledger entry could set a name or members that
//   no admin signed. The ledger carries only the old NIP-17 groups (id = the members' keys).
// - the AI log: it records what happened on one device.
// - a friend's「AIに読ませない」: like the picture, it comes from the friend's profile card.
//
// My own「自分のメッセージを相手のAIに読ませない」is one entry, "p:noai" (value 1 while on), so all my
// devices tell my friends the same (lib/ai-optout.ts).

import { AI_ACTIONS, AI_LIMIT_KEYS, clampLimit, cleanAiPermissions, type AiLimits, type AiPermissions } from './ai-permissions';
import type { Contact, Group } from './tegami';

/** Rumor kind for my ledger, sent to my own key (Tegami's own kind, like 10100 and 10101). */
export const ACCOUNT_SYNC_KIND = 10102;
/** The ledger goes out again when this old, so a device that was away finds it (the relay keeps envelopes 30 days). */
export const SYNC_RESEND_SECONDS = 20 * 24 * 60 * 60;
/** Tombstones older than this are forgotten. */
export const TOMBSTONE_MS = 365 * 24 * 60 * 60 * 1000;
/**
 * One envelope's content at most, in UTF-8 bytes. A NIP-44 message holds 64 KB, and the
 * rumor is sealed (base64, a third more) and then wrapped, so the content stays well under half.
 */
export const SYNC_PART_BYTES = 24_000;
const bytes = (s: string) => new TextEncoder().encode(s).length;
/** The time of entries that were already here before syncing existed: any real change wins over them. */
export const BASELINE_AT = 1;

export type Entry = { at: number; v?: unknown; local?: true };
export type Ledger = Record<string, Entry>;
export type Section = 'c' | 'g' | 'b' | 'a' | 'p';
/** noai: my「自分のメッセージを相手のAIに読ませない」(lib/ai-optout.ts). */
export type AccountLists = { contacts: Contact[]; groups: Group[]; blocked: string[]; ai: AiPermissions; noai?: boolean };

const HEX = /^[0-9a-f]{64}$/;
/** A Tegami group (`g-<gid>`, groups.ts), whose state comes from signed group changes, not from the ledger. */
export const isTegamiGroup = (g: { id: string; gid?: string }) => !!g.gid || g.id.startsWith('g-');
const validGroupId = (id: string) => id.split(',').length >= 2 && id.split(',').every((p) => HEX.test(p));

/** The current values of one section, as ledger keys and plain values. */
export function flatten(section: Section, lists: AccountLists): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // p: the name in their own profile card (profileName); a device without it keeps its own.
  // y: the contact is my own AI (lib/tegami.tsx setMyAi). Only a mark I made counts, never a model name.
  if (section === 'c')
    for (const c of lists.contacts) out[`c:${c.pubkey}`] = { n: c.name, ...(c.profileName ? { p: c.profileName } : {}), ...(c.model ? { m: c.model } : {}), ...(c.mine ? { y: 1 } : {}) };
  if (section === 'g') for (const g of lists.groups) if (!isTegamiGroup(g)) out[`g:${g.id}`] = { n: g.name };
  if (section === 'b') for (const p of lists.blocked) out[`b:${p}`] = 1;
  if (section === 'p' && lists.noai) out['p:noai'] = 1;
  if (section === 'a') {
    const ai = lists.ai;
    for (const [a, v] of Object.entries(ai.all)) out[`a:${JSON.stringify(['all', a])}`] = v;
    for (const field of ['models', 'ais', 'friends'] as const)
      for (const [id, sw] of Object.entries(ai[field])) for (const [a, v] of Object.entries(sw)) out[`a:${JSON.stringify([field, id, a])}`] = v;
    for (const [id, v] of Object.entries(ai.peerAis)) out[`a:${JSON.stringify(['peerAis', id])}`] = v;
    for (const [key, v] of Object.entries(ai.limits ?? {})) out[`a:${JSON.stringify(['limits', key])}`] = v;
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Writes this device's changes in one section into the ledger: a new or changed item gets
 * the time `at`, an item that is gone gets a tombstone. The first time a section is written
 * (an account from before syncing), what is here gets BASELINE_AT instead, so any real
 * change on another device wins over it.
 */
export function stamp(ledger: Ledger | null, section: Section, lists: AccountLists, at: number): { ledger: Ledger; changed: boolean } {
  const next: Ledger = { ...(ledger ?? {}) };
  const mark = `#${section}`;
  const first = !next[mark];
  const when = first ? BASELINE_AT : at;
  let changed = first;
  if (first) next[mark] = { at: 0, local: true };
  const now = flatten(section, lists);
  for (const [key, v] of Object.entries(now)) {
    const e = next[key];
    if (e && e.v !== undefined && same(e.v, v)) continue;
    next[key] = { at: Math.max(when, (e?.at ?? 0) + 1), v };
    changed = true;
  }
  for (const [key, e] of Object.entries(next)) {
    if (!key.startsWith(`${section}:`) || e.v === undefined || key in now) continue;
    next[key] = { at: Math.max(when, e.at + 1), ...(section === 'g' ? { local: true as const } : {}) };
    changed = true;
  }
  return { ledger: next, changed };
}

/** Writes every section (before entries from another device are merged into this one). */
export function stampAll(ledger: Ledger | null, lists: AccountLists, at: number): Ledger {
  let next = ledger;
  for (const s of ['c', 'g', 'b', 'a', 'p'] as const) next = stamp(next, s, lists, at).ledger;
  return next ?? {};
}

/** Whether entry a wins over entry b: the later time, and on the same time a fixed order of the values. */
function wins(a: Entry, b: Entry) {
  if (a.at !== b.at) return a.at > b.at;
  return JSON.stringify(a.v ?? null) > JSON.stringify(b.v ?? null);
}

/** Merges entries from my other device. Returns the sections whose items changed here. */
export function merge(local: Ledger | null, remote: Ledger): { ledger: Ledger; changed: Set<Section> } {
  const next: Ledger = { ...(local ?? {}) };
  const changed = new Set<Section>();
  for (const [key, r] of Object.entries(remote)) {
    const l = next[key];
    if (l && !wins(r, l)) continue;
    next[key] = r.v === undefined ? { at: r.at } : { at: r.at, v: r.v };
    if (!l || !same(l.v, r.v)) changed.add(key[0] as Section);
  }
  return { ledger: next, changed };
}

/** The lists the ledger describes. Pictures and the order of what is already here stay. */
export function materialize(ledger: Ledger, current: AccountLists): AccountLists {
  const live = (prefix: string) =>
    Object.entries(ledger)
      .filter(([key, e]) => key.startsWith(prefix) && e.v !== undefined)
      .sort((x, y) => x[1].at - y[1].at);
  const contactValues = new Map(live('c:').map(([key, e]) => [key.slice(2), e.v as { n: string; p?: string; m?: string; y?: 1 }]));
  const contacts: Contact[] = [];
  const contactOf = (pubkey: string, v: { n: string; p?: string; m?: string; y?: 1 }, avatar?: Contact['avatar'], noai?: true, owner?: Contact['owner'], self?: Contact['self'], profileName?: string): Contact => ({
    pubkey,
    name: v.n,
    ...(v.p || profileName ? { profileName: v.p || profileName } : {}),
    ...(v.m ? { model: v.m } : {}),
    ...(v.y === 1 ? { mine: true as const } : {}),
    ...(avatar ? { avatar } : {}),
    ...(noai ? { noai } : {}),
    ...(owner ? { owner } : {}),
    ...(self ? { self } : {}),
  });
  for (const c of current.contacts) {
    const v = contactValues.get(c.pubkey);
    if (!v) continue;
    contacts.push(contactOf(c.pubkey, v, c.avatar, c.noai, c.owner, c.self, c.profileName));
    contactValues.delete(c.pubkey);
  }
  for (const [pubkey, v] of contactValues) contacts.push(contactOf(pubkey, v));

  const groupValues = new Map(live('g:').map(([key, e]) => [key.slice(2), e.v as { n: string }]));
  const groups: Group[] = [];
  for (const g of current.groups) {
    // Tegami groups are not in the ledger: kept as they are (see the top of this file).
    if (isTegamiGroup(g)) {
      groups.push(g);
      continue;
    }
    const v = groupValues.get(g.id);
    if (!v) continue;
    groups.push({ ...g, name: v.n });
    groupValues.delete(g.id);
  }
  for (const [id, v] of groupValues) groups.push({ id, name: v.n, members: id.split(',') });

  const blockedSet = new Set(live('b:').map(([key]) => key.slice(2)));
  const blocked = [...current.blocked.filter((p) => blockedSet.has(p))];
  for (const p of blockedSet) if (!blocked.includes(p)) blocked.push(p);

  const raw: Record<string, Record<string, unknown>> & { all: Record<string, unknown>; peerAis: Record<string, unknown>; limits: Record<string, unknown> } = {
    all: {},
    models: {},
    ais: {},
    friends: {},
    peerAis: {},
    limits: {},
  };
  for (const [key, e] of live('a:')) {
    let path: unknown;
    try {
      path = JSON.parse(key.slice(2));
    } catch {
      continue;
    }
    if (!Array.isArray(path)) continue;
    if (path[0] === 'all' && path.length === 2) raw.all[path[1]] = e.v;
    else if (path[0] === 'peerAis' && path.length === 2) raw.peerAis[path[1]] = e.v;
    else if (path[0] === 'limits' && path.length === 2) raw.limits[path[1]] = e.v;
    else if (['models', 'ais', 'friends'].includes(path[0]) && path.length === 3) {
      const table = raw[path[0]] as Record<string, Record<string, unknown>>;
      (table[path[1]] ??= {})[path[2]] = e.v;
    }
  }
  return { contacts, groups, blocked, ai: cleanAiPermissions(raw), noai: ledger['p:noai']?.v === 1 };
}

/** Checks entries that came from another device (or a bundle). Unknown or broken entries are dropped. */
export function cleanEntries(raw: unknown): Ledger {
  const out: Ledger = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, val] of Object.entries(raw).slice(0, 20_000)) {
    if (!Array.isArray(val) || typeof val[0] !== 'number' || !Number.isFinite(val[0]) || val[0] < 0) continue;
    const at = Math.floor(val[0]);
    if (val.length < 2) {
      if (/^[cbap]:/.test(key) && key.length <= 400) out[key] = { at };
      continue;
    }
    const v = cleanValue(key, val[1]);
    if (v !== undefined) out[key] = { at, v };
  }
  return out;
}

function cleanValue(key: string, v: unknown): unknown {
  const id = key.slice(2);
  if (key.startsWith('c:')) {
    const c = v as { n?: unknown; p?: unknown; m?: unknown; y?: unknown };
    if (!HEX.test(id) || !c || typeof c.n !== 'string') return undefined;
    const name = c.n.slice(0, 40);
    const pn = typeof c.p === 'string' ? c.p.trim().slice(0, 40) : '';
    return { n: name, ...(pn ? { p: pn } : {}), ...(typeof c.m === 'string' && c.m ? { m: c.m.slice(0, 80) } : {}), ...(c.y === 1 ? { y: 1 } : {}) };
  }
  if (key.startsWith('g:')) {
    const g = v as { n?: unknown };
    if (!validGroupId(id) || !g || typeof g.n !== 'string') return undefined;
    return { n: g.n.slice(0, 60) };
  }
  if (key.startsWith('b:')) return HEX.test(id) && v === 1 ? 1 : undefined;
  if (key === 'p:noai') return v === 1 ? 1 : undefined;
  if (key.startsWith('a:') && key.length <= 400) {
    let path: unknown;
    try {
      path = JSON.parse(id);
    } catch {
      return undefined;
    }
    if (!Array.isArray(path) || !path.every((p) => typeof p === 'string')) return undefined;
    if (path[0] === 'limits') {
      const key = path[1] as keyof AiLimits;
      return path.length === 2 && (AI_LIMIT_KEYS as readonly string[]).includes(key) && typeof v === 'number' && Number.isFinite(v)
        ? clampLimit(key, v)
        : undefined;
    }
    const action = path[path.length - 1];
    if (path[0] !== 'peerAis' && !(AI_ACTIONS as readonly string[]).includes(action)) return undefined;
    // Let the AI settings' own check decide which values are valid.
    const probe =
      path[0] === 'all' ? { all: { [action]: v } } : path[0] === 'peerAis' ? { peerAis: { [path[1]]: v } } : { [path[0]]: { [path[1]]: { [action]: v } } };
    const clean = cleanAiPermissions(probe) as unknown as Record<string, unknown>;
    const got =
      path[0] === 'all'
        ? (clean.all as Record<string, unknown>)[action]
        : path[0] === 'peerAis'
          ? (clean.peerAis as Record<string, unknown>)[path[1]]
          : ((clean[path[0]] as Record<string, Record<string, unknown>> | undefined)?.[path[1]] ?? {})[action];
    return got;
  }
  return undefined;
}

/** What goes to my other devices: everything but local tombstones and very old ones, in a fixed order. */
export function shareable(ledger: Ledger, now = Date.now()): Record<string, [number] | [number, unknown]> {
  const out: Record<string, [number] | [number, unknown]> = {};
  for (const key of Object.keys(ledger).sort()) {
    const e = ledger[key];
    if (e.local) continue;
    if (e.v === undefined) {
      if (now - e.at > TOMBSTONE_MS) continue;
      out[key] = [e.at];
    } else out[key] = [e.at, e.v];
  }
  return out;
}

/** Splits what is shared into envelope contents of at most SYNC_PART_BYTES each. */
export function syncParts(ledger: Ledger, now = Date.now()): string[] {
  const parts: string[] = [];
  let cur: Record<string, unknown> = {};
  let size = 20;
  for (const [key, val] of Object.entries(shareable(ledger, now))) {
    const add = bytes(JSON.stringify(key)) + bytes(JSON.stringify(val)) + 2;
    if (size + add > SYNC_PART_BYTES && Object.keys(cur).length) {
      parts.push(JSON.stringify({ v: 1, e: cur }));
      cur = {};
      size = 20;
    }
    cur[key] = val;
    size += add;
  }
  if (Object.keys(cur).length || !parts.length) parts.push(JSON.stringify({ v: 1, e: cur }));
  return parts;
}

/** Reads one envelope's content. Null when it is not a ledger. */
export function readSyncPart(content: string): Ledger | null {
  try {
    const data = JSON.parse(content) as { v?: unknown; e?: unknown };
    if (data?.v !== 1) return null;
    return cleanEntries(data.e);
  } catch {
    return null;
  }
}

/** Ledger entries for a bundle (the link to another device, the recovery backup). */
export function ledgerForBundle(ledger: Ledger | null): Record<string, [number] | [number, unknown]> | undefined {
  return ledger ? shareable(ledger) : undefined;
}
