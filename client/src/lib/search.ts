// Searching the messages on this device. Nothing leaves the device: the relay cannot read
// messages, so search can only ever be local.
//
// Matching ignores the differences people do not mean when they type:
//   - full-width and half-width (ＡＢＣ = ABC, ｶﾀｶﾅ = カタカナ, １２３ = 123): Unicode NFKC
//   - upper and lower case (Tegami = tegami)
//   - katakana and hiragana (テガミ = てがみ)
// It does not ignore anything else (no 'ー' or small-kana folding, no kanji readings).

import type { Message } from './tegami';

const KATAKANA = /[ァ-ヶ]/g;

/** The form both the text and the query are compared in. */
export function fold(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(KATAKANA, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

// Folding is the only real work in a search, so each message is folded once. Message
// objects are never changed once stored, so the cache follows them and lets them go.
const folded = new WeakMap<Message, string>();
function foldedText(m: Message) {
  let f = folded.get(m);
  if (f === undefined) {
    f = fold(m.text);
    folded.set(m, f);
  }
  return f;
}

/** Messages with text (not photos, not call records) that contain the query, newest first. */
export function searchMessages(messages: Message[], query: string, limit = 200): Message[] {
  const q = fold(query.trim());
  if (!q) return [];
  const out: Message[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = messages[i];
    if (m.call || m.file || !m.text) continue;
    if (foldedText(m).includes(q)) out.push(m);
  }
  return out;
}

export function matchesName(name: string, query: string) {
  const q = fold(query.trim());
  return !!q && fold(name).includes(q);
}

/**
 * The part of a message to show in a result: a little before the match, the match, and
 * what follows, on one line. The match is found in the folded text and mapped back to the
 * original characters (each character folded after the one before it, so it is close but
 * not exact for the rare characters that fold into several, like ㍿).
 */
export function excerpt(text: string, query: string, before = 12): { head: string; hit: string; tail: string } {
  const flat = text.replace(/\s+/g, ' ');
  const q = fold(query.trim());
  const chars = Array.from(flat);
  // ends[i]: length of the folded text after the first i + 1 characters.
  const ends: number[] = [];
  let len = 0;
  chars.forEach((ch, i) => {
    // Folded with the character before, so a half-width sound mark (ｶﾞ → が) adds nothing.
    len += i ? fold(chars[i - 1] + ch).length - fold(chars[i - 1]).length : fold(ch).length;
    ends.push(len);
  });
  const at = q ? fold(flat).indexOf(q) : -1;
  if (at < 0) return { head: flat, hit: '', tail: '' };
  const first = ends.findIndex((e) => e > at);
  let last = ends.findIndex((e) => e >= at + q.length);
  if (first < 0) return { head: flat, hit: '', tail: '' };
  if (last < first) last = chars.length - 1;
  while (last + 1 < chars.length && ends[last + 1] === ends[last]) last++; // a trailing sound mark
  const from = Math.max(0, first - before);
  return {
    head: (from > 0 ? '…' : '') + chars.slice(from, first).join(''),
    hit: chars.slice(first, last + 1).join(''),
    tail: chars.slice(last + 1).join(''),
  };
}
