// Brings the whole conversation history along when an account moves to another device.
//
// The relay keeps envelopes for 30 days, so a new device gets only that much from it. When
// the old device makes the link (lib/transfer.ts), it also writes every message it has into
// one or more files, compresses them (when the browser can), encrypts each with a fresh
// AES-GCM key like a photo and uploads it to the file server. Only what opens each file
// (address, key, nonce, hash: about 360 bytes) goes into the account envelope, which only
// the one-time key of the link can open and which the relay hands out for 10 minutes.
// The new device downloads, checks the hash, decrypts and adds the messages it does not have.
//
// The files themselves stay on the file server, encrypted, until it deletes them after 30
// days, like photos. Photos and files inside the old messages are not carried: only what
// the message says about them (they open as long as the file server still has them).

import { encryptAndUpload, forgetFile, openFile, validFileRef, type FileRef } from './files';
import type { CallRecord, Message } from './tegami';

/** Raw JSON per file before compressing: under the file server's 10 MB even when it cannot compress. */
export const HISTORY_PART_BYTES = 8 * 1024 * 1024;
/** Files per move. Older messages beyond them stay on the old device only. */
export const MAX_HISTORY_PARTS = 4;

export type History = { messages: Message[]; cleared: Record<string, number>; deleted: string[] };

const HEX = /^[0-9a-f]{64}$/;

/**
 * Splits what this device has into file contents, newest messages first so the oldest are
 * the ones left out when there is too much. Messages still waiting to be sent are left out:
 * their copy for my own devices reaches the new device when they go out.
 */
export function historyParts(h: History, partBytes = HISTORY_PART_BYTES, maxParts = MAX_HISTORY_PARTS): { parts: string[]; left: number } {
  const msgs = h.messages.filter((m) => !m.pending && !m.id.startsWith('local:')).sort((a, b) => b.at - a.at);
  const parts: string[] = [];
  const head = (i: number) => (i === 0 ? { cleared: h.cleared, deleted: h.deleted } : {});
  let cur: string[] = [];
  let size = 0;
  let used = 0;
  const flush = () => {
    parts.push(JSON.stringify({ v: 1, ...head(parts.length), messages: cur.map((s) => JSON.parse(s)) }));
    cur = [];
    size = 0;
  };
  for (const m of msgs) {
    const s = JSON.stringify(m);
    if (size + s.length > partBytes && cur.length) {
      flush();
      if (parts.length >= maxParts) break;
    }
    cur.push(s);
    size += s.length + 1;
    used++;
  }
  if (parts.length < maxParts && (cur.length || !parts.length)) flush();
  else if (cur.length) used -= cur.length;
  return { parts, left: msgs.length - used };
}

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

/** Compresses, encrypts and uploads each part. Returns what opens them. */
export async function uploadHistory(h: History, secret: Uint8Array): Promise<FileRef[]> {
  const { parts } = historyParts(h);
  const gzip = typeof CompressionStream !== 'undefined';
  const refs: FileRef[] = [];
  for (const part of parts) {
    let bytes = new TextEncoder().encode(part) as Uint8Array<ArrayBuffer>;
    if (gzip) bytes = (await pipe(bytes, new CompressionStream('gzip'))) as Uint8Array<ArrayBuffer>;
    refs.push(await encryptAndUpload(bytes, gzip ? 'application/gzip' : 'application/json', secret));
  }
  return refs;
}

/** Checks the file list of a bundle. */
export function cleanHistoryRefs(raw: unknown): FileRef[] {
  if (!Array.isArray(raw)) return [];
  const out: FileRef[] = [];
  for (const item of raw.slice(0, MAX_HISTORY_PARTS)) {
    const ref = validFileRef(item);
    if (ref && HEX.test(ref.sha256) && (ref.type === 'application/gzip' || ref.type === 'application/json')) out.push(ref);
  }
  return out;
}

/** Downloads and opens the files. Parts that cannot be opened are skipped. */
export async function downloadHistory(refs: FileRef[]): Promise<History> {
  const out: History = { messages: [], cleared: {}, deleted: [] };
  for (const ref of refs) {
    try {
      // Not kept on this device: the id is unique to this file, and it is forgotten right after.
      const blob = await openFile(`history:${ref.sha256}`, ref);
      void forgetFile(`history:${ref.sha256}`);
      let bytes = new Uint8Array(await blob.arrayBuffer());
      if (ref.type === 'application/gzip') bytes = await pipe(bytes, new DecompressionStream('gzip'));
      const part = readHistoryPart(new TextDecoder().decode(bytes));
      out.messages.push(...part.messages);
      Object.assign(out.cleared, part.cleared);
      out.deleted.push(...part.deleted);
    } catch {
      // Gone from the file server, or broken: the rest still helps.
    }
  }
  return out;
}

/** Checks one part that came from the other device. */
export function readHistoryPart(text: string): History {
  const out: History = { messages: [], cleared: {}, deleted: [] };
  const data = JSON.parse(text) as { v?: unknown; messages?: unknown; cleared?: unknown; deleted?: unknown };
  if (data?.v !== 1) return out;
  if (Array.isArray(data.messages)) for (const raw of data.messages) {
    const m = cleanMessage(raw);
    if (m) out.messages.push(m);
  }
  if (data.cleared && typeof data.cleared === 'object' && !Array.isArray(data.cleared))
    for (const [room, at] of Object.entries(data.cleared)) if (validRoom(room) && typeof at === 'number' && Number.isFinite(at)) out.cleared[room] = at;
  if (Array.isArray(data.deleted)) out.deleted = data.deleted.filter((id): id is string => typeof id === 'string' && id.length <= 200);
  return out;
}

const validRoom = (room: string) => room.split(',').every((p) => HEX.test(p));

function cleanMessage(raw: unknown): Message | null {
  const m = raw as Record<string, unknown>;
  if (!m || typeof m !== 'object') return null;
  if (typeof m.id !== 'string' || !m.id || m.id.length > 200 || m.id.startsWith('local:')) return null;
  if (typeof m.from !== 'string' || !HEX.test(m.from) || typeof m.peer !== 'string' || !validRoom(m.peer)) return null;
  if (typeof m.text !== 'string' || typeof m.at !== 'number' || !Number.isFinite(m.at)) return null;
  const out: Message = { id: m.id, from: m.from, peer: m.peer, text: m.text.slice(0, 100_000), at: Math.floor(m.at) };
  if (m.file !== undefined) {
    const f = validFileRef(m.file);
    if (!f) return null;
    out.file = f;
  }
  if (m.stamp === true && out.file) out.stamp = true;
  const call = m.call as CallRecord | undefined;
  if (call && typeof call === 'object' && ['done', 'missed', 'unanswered'].includes(call.result)) {
    out.call = { video: !!call.video, result: call.result, ...(typeof call.seconds === 'number' && call.seconds >= 0 ? { seconds: Math.floor(call.seconds) } : {}) };
  }
  if (typeof m.got === 'number' && Number.isFinite(m.got)) out.got = m.got;
  if (typeof m.replyTo === 'string' && HEX.test(m.replyTo)) out.replyTo = m.replyTo;
  return out;
}
