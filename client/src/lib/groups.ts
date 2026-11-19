// Groups that keep going when their members change (Tegami's own addition to NIP-17).
//
// NIP-17 has no group id: a chat is the set of people in its p tags, so adding or removing
// someone starts a new chat. A Tegami group has a fixed random id (`gid`) instead:
// - Every chat message carries ["tegami-group", <gid>] next to the usual p tags (the people in
//   the group now). Other NIP-17 apps ignore the tag and still see the p tags, so to them a
//   change of members is a new chat, as before.
// - Every change (create, add, remove, leave, rename, picture, admins) is a rumor of its own
//   kind (GROUP_KIND) holding the whole new state. It is sealed and gift-wrapped like a
//   message, once for each person in the group before and after the change (and my devices),
//   so the relay sees only envelopes.
// - Who made a change is known for sure: the seal is signed by its author and nostr-tools checks
//   that the rumor's pubkey is the seal's. Each device checks the change against the state it
//   already has: in a group with admins only an admin may change it, in a neutral group any
//   member may. Anyone may leave. A device that does not have the group yet (someone was just
//   added) accepts the state only from a friend (or me) who is an admin in that state.
// - Someone added later never gets the earlier messages: those were sealed only for the people
//   in the group at the time. The app also ignores messages older than the state that added me.

import type { FileRef } from './files';
import type { Group } from './tegami';

/** Rumor kind for a group's state (Tegami's own, not a standard NIP). */
export const GROUP_KIND = 10103;
/** The tag that ties a chat message to its group: ["tegami-group", <gid>]. */
export const GROUP_TAG = 'tegami-group';
export const MAX_GROUP_MEMBERS = 100;
const NAME_MAX = 60;

export type GroupMode = 'admin' | 'open';
export type GroupOp = 'create' | 'add' | 'remove' | 'leave' | 'rename' | 'icon' | 'admin';

/** The whole state of a group after one change. members: everyone, the author included. */
export type GroupState = {
  gid: string;
  name: string;
  avatar: FileRef | null;
  members: string[];
  admins: string[];
  mode: GroupMode;
  op: GroupOp;
};

/** What changed, for the line the chat shows. */
export type GroupChange = { op: GroupOp; by: string; added: string[]; removed: string[]; admins: string[]; name: string };

const HEX64 = /^[0-9a-f]{64}$/;
const GID = /^[0-9a-f]{32}$/;
const OPS: GroupOp[] = ['create', 'add', 'remove', 'leave', 'rename', 'icon', 'admin'];

/** A new random group id. */
export function newGid() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** The chat id of a Tegami group (`g-<gid>`). Old NIP-17 groups keep `<pubkey>,<pubkey>…`. */
export function groupRoom(gid: string) {
  return `g-${gid}`;
}
export function gidOf(room: string): string | null {
  const gid = room.startsWith('g-') ? room.slice(2) : '';
  return GID.test(gid) ? gid : null;
}
/** The group id of a rumor, from its tegami-group tag. */
export function groupTagOf(tags: string[][]): string | null {
  const gid = tags.find((t) => t[0] === GROUP_TAG)?.[1] ?? '';
  return GID.test(gid) ? gid : null;
}

const uniq = (xs: string[]) => [...new Set(xs)];

/** Reads a state rumor's content. null when it is not a well-formed state. */
export function parseGroupState(content: string, validAvatar: (x: unknown) => FileRef | null): GroupState | null {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(content);
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object') return null;
  const { gid, name, members, admins, mode, op } = d;
  if (typeof gid !== 'string' || !GID.test(gid)) return null;
  if (typeof name !== 'string') return null;
  if (mode !== 'admin' && mode !== 'open') return null;
  if (typeof op !== 'string' || !OPS.includes(op as GroupOp)) return null;
  if (!Array.isArray(members) || !members.every((m) => typeof m === 'string' && HEX64.test(m))) return null;
  if (!Array.isArray(admins) || !admins.every((m) => typeof m === 'string' && HEX64.test(m))) return null;
  const all = uniq(members as string[]);
  if (!all.length || all.length > MAX_GROUP_MEMBERS) return null;
  const avatar = d.avatar == null ? null : validAvatar(d.avatar);
  if (d.avatar != null && !avatar) return null;
  return {
    gid,
    name: name.slice(0, NAME_MAX),
    avatar,
    members: all,
    admins: uniq(admins as string[]).filter((a) => all.includes(a)),
    mode,
    op: op as GroupOp,
  };
}

/** Everyone in a group I know, me included unless I am no longer in it. */
export function everyone(g: Group, me: string) {
  return g.left ? g.members : uniq([...g.members, me]);
}

/** Whether I may add, remove, rename or change the picture (a neutral group: any member). */
export function canManage(g: Group, me: string) {
  if (!g.gid || g.left) return false;
  return g.mode !== 'admin' || (g.admins ?? []).includes(me);
}

/** The state to send after a change made by me. */
export function stateOf(g: Group, me: string, op: GroupOp): GroupState {
  return {
    gid: g.gid!,
    name: g.name,
    avatar: g.avatar ?? null,
    members: everyone(g, me),
    admins: g.mode === 'admin' ? (g.admins ?? []) : [],
    mode: g.mode ?? 'open',
    op,
  };
}

const newer = (at: number, id: string, g: Group) => at > (g.v ?? 0) || (at === (g.v ?? 0) && id > (g.vid ?? ''));

/**
 * Applies a state written by `author` at `at` (rumor id `id`) to the group I have (`prev`).
 * Returns the group as it is now and what changed, or null when the change is not allowed
 * (older than what I have, from someone not in the group, from a non-admin in a group with
 * admins, or a new group from a stranger).
 */
export function applyGroupState(
  prev: Group | undefined,
  s: GroupState,
  author: string,
  at: number,
  id: string,
  me: string,
  isFriend: (pubkey: string) => boolean,
): { group: Group; change: GroupChange } | null {
  let members: string[];
  let admins: string[];
  let mode: GroupMode;
  let name = s.name;
  let avatar = s.avatar;
  const before = prev ? everyone(prev, me) : [];
  if (prev) {
    if (prev.gid !== s.gid || !newer(at, id, prev)) return null;
    if (!before.includes(author)) return null;
    mode = prev.mode ?? 'open';
    if (s.op === 'leave') {
      // Leaving takes only the author out; nothing else in the state is read.
      members = before.filter((m) => m !== author);
      admins = (prev.admins ?? []).filter((a) => a !== author);
      name = prev.name;
      avatar = prev.avatar ?? null;
    } else {
      if (mode === 'admin' && !(prev.admins ?? []).includes(author)) return null;
      if (!s.members.includes(author)) return null; // taking oneself out is leaving
      members = s.members;
      admins = mode === 'admin' ? s.admins : [];
    }
  } else {
    // A group new to me: I must be in it, and it must come from me (my other device) or a friend.
    if (s.op === 'leave' || !s.members.includes(me) || !s.members.includes(author)) return null;
    if (author !== me && !isFriend(author)) return null;
    mode = s.mode;
    if (mode === 'admin' && !s.admins.includes(author)) return null;
    members = s.members;
    admins = mode === 'admin' ? s.admins : [];
  }
  // A group with admins never ends up without one: the first remaining member (by key) takes over.
  if (mode === 'admin' && !admins.length && members.length) admins = [[...members].sort()[0]];
  // Someone just added does not know who was there before: from where they stand, they were added.
  const added = prev || s.op === 'create' ? members.filter((m) => !before.includes(m)) : [me];
  const removed = before.filter((m) => !members.includes(m));
  const past = uniq([...(prev?.past ?? []), ...removed]).filter((m) => !members.includes(m));
  const inGroup = members.includes(me);
  const group: Group = {
    id: groupRoom(s.gid),
    gid: s.gid,
    name,
    members: members.filter((m) => m !== me),
    mode,
    admins,
    v: at,
    vid: id,
    // Messages older than the change that added me are not mine to read.
    since: prev && prev.since !== undefined && !added.includes(me) ? prev.since : at,
    ...(avatar ? { avatar } : {}),
    ...(past.length ? { past } : {}),
    ...(inGroup ? {} : { left: true as const }),
  };
  const newAdmins = admins.filter((a) => !(prev?.admins ?? []).includes(a));
  return { group, change: { op: s.op, by: author, added, removed, admins: newAdmins, name } };
}

/**
 * An older state that put me in the group, arriving after a newer one (a device that was away
 * gets them in any order): the time I joined moves back to it. Returns that time, or null.
 */
export function earlierJoin(prev: Group | undefined, s: GroupState, author: string, at: number, me: string): number | null {
  if (!prev || prev.gid !== s.gid || prev.left || !s.members.includes(me)) return null;
  if (at >= (prev.since ?? 0) || !everyone(prev, me).includes(author)) return null;
  if (prev.mode === 'admin' && !(prev.admins ?? []).includes(author)) return null;
  return at;
}

/**
 * Whether a chat message from `author` written at `at` belongs in the group: from a member, or
 * from someone who has since left but wrote it before that, and never older than when I joined.
 */
export function acceptsMessage(g: Group, author: string, at: number, me: string) {
  if (g.since !== undefined && at < g.since) return false;
  if (author === me || g.members.includes(author)) return true;
  return !!g.past?.includes(author) && at <= (g.v ?? 0);
}

/** The line a chat shows for a change (LINE's wording). */
export function changeText(c: GroupChange, nameOf: (pubkey: string) => string) {
  const by = nameOf(c.by);
  const list = (xs: string[]) => xs.map(nameOf).join('、');
  switch (c.op) {
    case 'create':
      return `${by}がグループを作りました。`;
    case 'leave':
      return `${by}が退会しました。`;
    case 'rename':
      return `${by}がグループ名を「${c.name}」に変更しました。`;
    case 'icon':
      return `${by}がグループのアイコンを変更しました。`;
    case 'admin':
      return `${by}が${list(c.admins)}を管理者にしました。`;
    default: {
      const parts: string[] = [];
      if (c.added.length) parts.push(`${by}が${list(c.added)}をグループに追加しました。`);
      if (c.removed.length) parts.push(`${by}が${list(c.removed)}をグループから削除しました。`);
      return parts.join('\n') || `${by}がグループを変更しました。`;
    }
  }
}
