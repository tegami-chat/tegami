// AIの検査 (the AI screen) on the owner's PC: the same fixed checks as the app's
// client/src/lib/ai-screen.ts. Keep the two alike; agent/test/screen.test.mjs checks that they
// answer the same for the same cases.
/**
 * Fixed checks on what this AI is about to send and on what it is about to read. They use no
 * model, so nothing leaves the PC.
 *
 * What this is not: a promise that every secret is caught. An AI that spells a key another way
 * gets past the patterns. The checks stop slips and simple tricks; the gate (ai-permissions.ts)
 * decides what an AI may do at all, and nothing here ever widens what the gate allows.
 */


/** What kind of secret an outgoing text looks like it carries: nostrKey, hexKey, recoveryCode, transferLink, apiKey or cardNumber. */
const PATTERNS = [
  // A Nostr secret key (bech32), or one sealed with a password (NIP-49).
  ['nostrKey', /\b(nsec1|ncryptsec1)[02-9ac-hj-np-z]{20,}/i],
  // 64 hex digits standing alone: a secret key in hex looks like this (so do public keys and ids,
  // which an AI has little reason to send in someone's name).
  ['hexKey', /(^|[^0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i],
  // The link that hands this account to a new device (transfer.ts): app.tegami.chat/link#k=...
  ['transferLink', /\/link#[^\s]*k=/i],
  // API keys of the services an AI is usually run with, and of GitHub, Slack and AWS.
  ['apiKey', /\b(sk-ant-[A-Za-z0-9_-]{20,}|sk-or-v1-[A-Za-z0-9]{20,}|sk-(proj-)?[A-Za-z0-9_-]{32,}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/],
];

/** The recovery code's symbols (recovery.ts): 7 groups of 4 from 32 symbols. */
const RECOVERY = /(?<![A-Z0-9])([2-9A-HJ-NP-Z]{4}([-\s][2-9A-HJ-NP-Z]{4}){6}|[2-9A-HJ-NP-Z]{28})(?![A-Z0-9])/;

/** Whether a digit string passes the Luhn check that card numbers carry. */
function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** 13 to 19 digits, maybe split by spaces or dashes, that pass the Luhn check. */
function hasCardNumber(t) {
  for (const m of t.matchAll(/(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

/**
 * The first kind of secret an outgoing text seems to carry, or null. Full-width letters and
 * digits are read as their plain forms first, and hidden characters are taken out, so neither
 * hides a key.
 */
export function findSecret(text) {
  const t = cleanForAi(text).normalize('NFKC');
  for (const [kind, re] of PATTERNS) if (re.test(t)) return kind;
  if (RECOVERY.test(t.toUpperCase())) return 'recoveryCode';
  if (hasCardNumber(t)) return 'cardNumber';
  return null;
}

/** The longest text an AI is handed in one message. */
export const AI_TEXT_MAX = 20_000;

/**
 * A received text as an AI may read it: characters a person cannot see are taken out, so they
 * cannot carry orders to the AI. Taken out: zero-width characters, the ones that turn the
 * writing direction, the invisible "tag" letters (U+E0000 to U+E007F), and every variation
 * selector after the first in a row (a long run of them can spell hidden text; one after a
 * letter or an emoji is kept, as names and emoji use it). Cut at AI_TEXT_MAX.
 */
export function cleanForAi(text) {
  return text
    .replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g, '')
    .replace(/[\u{e0000}-\u{e007f}]/gu, '')
    .replace(/([︀-️\u{e0100}-\u{e01ef}])[︀-️\u{e0100}-\u{e01ef}]+/gu, '$1')
    .slice(0, AI_TEXT_MAX);
}
