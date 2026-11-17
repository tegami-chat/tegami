/**
 * AIの検査 (the AI screen): fixed checks on what an AI is about to send and on what an AI is
 * about to read. They run on this device only and use no model, so nothing leaves the device.
 *
 * The same checks live in agent/screen.mjs (the watcher on the owner's PC). Keep the two alike:
 * agent/test/screen.test.mjs and client/test/ai-screen.test.mjs share the cases.
 *
 * What this is not: a promise that every secret is caught. An AI that spells a key another way
 * gets past the patterns. The checks stop slips and simple tricks; the gate (ai-permissions.ts)
 * decides what an AI may do at all, and nothing here ever widens what the gate allows.
 */

/** What kind of secret an outgoing text looks like it carries. */
export type SecretKind = 'nostrKey' | 'hexKey' | 'recoveryCode' | 'transferLink' | 'apiKey' | 'cardNumber';

const PATTERNS: [SecretKind, RegExp][] = [
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
function luhn(digits: string) {
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
function hasCardNumber(t: string) {
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
export function findSecret(text: string): SecretKind | null {
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
export function cleanForAi(text: string): string {
  return text
    .replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g, '')
    .replace(/[\u{e0000}-\u{e007f}]/gu, '')
    .replace(/([︀-️\u{e0100}-\u{e01ef}])[︀-️\u{e0100}-\u{e01ef}]+/gu, '$1')
    .slice(0, AI_TEXT_MAX);
}

// ---------- お金の話に見える文 ----------

/**
 * What kind of money talk a text looks like: an account, a payment app, a crypto address or
 * invoice, a gift card, words that move money, or an amount with a request or a hurry.
 */
export type MoneyKind = 'bankAccount' | 'paymentApp' | 'crypto' | 'giftCard' | 'moneyWords' | 'amountAsk' | 'urgentMoney';

// A bank and a branch, or an account type with a 7-digit number, or Japan Post's 記号 and 番号.
const BANK = /(銀行|信金|信用金庫|信用組合|労金|ろうきん|農協|ゆうちょ|バンク)[^\n]{0,20}(支店|出張所|店番|営業部)|(普通|当座|口座番号?|口座)\s*[:：]?\s*(no\.?)?\s*\d{7}(?!\d)|記号\s*[:：]?\s*\d{5}[^\d]{0,6}番号\s*[:：]?\s*\d{8}(?!\d)|口座[^\n]{0,8}(こちら|番号|教えて|情報|確認|宛|名義|に(入|振|送)|へ|に入れ|下記)/;
// Payment and remittance apps, in Japan and abroad.
const PAY_APP = /paypay|line\s*pay|楽天\s*ペイ|rakuten\s*pay|メルペイ|merpay|au\s*pay|d\s*払い|kyash|\bwise\b|paypal|venmo|revolut|cash\s*app|zelle|apple\s*pay|google\s*pay/;
// What someone does with an app that moves money.
const PAY_ACT = /送|払|振|請求|チャージ|残高|受け取|入金|出金|もら|id|リンク|割り勘|立て替|精算|お願い|me\s*\$|\d/;
// Bitcoin (bech32 and legacy), Lightning invoices and LNURL, Ethereum-style addresses.
const CRYPTO = /\b(bc1|tb1)[02-9ac-hj-np-z]{25,87}\b|(?<![A-Za-z0-9])[13][a-km-zA-HJ-NP-Z1-9]{25,34}(?![A-Za-z0-9])|\bln(bc|tb|bcrt)[0-9a-z]{20,}|\blnurl1[02-9ac-hj-np-z]{20,}|lightning:|\b0x[0-9a-fA-F]{40}\b/i;
// Gift and prepaid cards by name.
const GIFT_WORDS = /ギフト\s*(券|カード|コード)|gift\s*card|プリペイド|itunes\s*カード|google\s*play\s*(カード|ギフト)|apple\s*(gift|ギフト)|amazon\s*ギフト|(amazon|apple|google)\s*の?ギフト|webmoney|bitcash|電子マネー/;
// Card codes: Amazon (4-6-4/5), Apple (X and 15), groups of four. Letters and digits both.
const GIFT_CODE = /(?<![A-Z0-9])([A-Z0-9]{4}-[A-Z0-9]{6}-[A-Z0-9]{4,5}|X[A-Z0-9]{15}|[A-Z0-9]{4}(-[A-Z0-9]{4}){3,4})(?![A-Z0-9])/g;
// Words that move money, or that only come up when someone wants money.
const MONEY_WORDS = /振込|振り込|振込み|送金|入金|暗証番号|カード番号|口座番号|口座情報|ネットバンキング|キャッシュカード|仮想通貨|暗号資産|ビットコイン|bitcoin|\bbtc\b|イーサリアム|ethereum|\busdt\b|ウォレット|元本保証|配当|利回り|月利|儲か|稼げ|稼い|融資|還付|売上金|示談|登録料|前払い|未納|滞納|未払い|還付金|給付金|当選金|手数料|示談金|立て替|立替|精算(?!機)|払い戻し|返済|atmで操作|atmに行|お金が戻|\bsats\b|bank\s*account|account\s*number|routing\s*number|card\s*number|\bpin\s*(code|number)|\bwire\s*(money|transfer|the|me|it)|\btax\s*refund|guaranteed\s*returns?/;
// Words about money that need an ask, an amount or a hurry beside them.
const MONEY_SOFT = /お金|支払|払い|払って|払う|払え|返金|請求|会費|費用|代金|チケット代|生活費|家賃|口座|現金|残高|投資|利益|両替|お年玉|おこづかい|お小遣い/;
// Asking for something, or promising to do it.
const ASK = /ください|下さい|ほしい|欲しい|お願い|頼む|頼み|ちょうだい|頂戴|くれ(る|ない|ませ)?|もらえ|貸して|送って|払って(ね|よ|お|く|も|ほ|$|[。！!?？、])|振り込んで|用意|必要|教えて|よろしく|できる[?？]|しよ|しとい|しておい|して$|\bplease\b|\bsend\b|\bpay\b/;
// Hurry.
const URGENT = /至急|大至急|今すぐ|すぐに|今日中|本日中|急ぎ|急いで|期限|緊急|ピンチ|助けて|法的措置/;
// An amount: a currency sign, digits with a currency or 万 and 千, or the same in kanji numerals.
const AMOUNT = /[¥$€£]\s*\d|\d[\d,.]*\s*(円|万円?|千円|ドル|ユーロ|元|yen|usd|jpy|btc|sats?)(?![歩人回件個本枚台点位号名])|[〇一二三四五六七八九十百千万億]*[十百千万億][〇一二三四五六七八九十百千]*(円|万(?![歩人回件個本枚台点位号名]))/;

/** Whether a card-code-shaped run has both letters and digits (a word in capitals is not a code). */
function hasGiftCode(t: string) {
  for (const m of t.matchAll(GIFT_CODE)) if (/[A-Z]/.test(m[0]) && /\d/.test(m[0])) return true;
  return false;
}

/**
 * The first kind of money talk a text seems to carry, or null. Fixed patterns only: they find
 * accounts, payment apps, crypto addresses, gift cards and words that move money, and an amount
 * only when someone asks for it or hurries. A price said in passing is not money talk here.
 * What this is not: a promise that every money talk is caught (the screen says "お金の話に見える文").
 */
export function findMoney(text: string): MoneyKind | null {
  const raw = cleanForAi(text).normalize('NFKC');
  const t = raw.toLowerCase();
  if (CRYPTO.test(raw)) return 'crypto';
  if (BANK.test(t)) return 'bankAccount';
  if (GIFT_WORDS.test(t) || hasGiftCode(raw.toUpperCase())) return 'giftCard';
  if (PAY_APP.test(t) && PAY_ACT.test(t.replace(PAY_APP, ''))) return 'paymentApp';
  if (MONEY_WORDS.test(t)) return 'moneyWords';
  const amount = AMOUNT.test(t);
  if (amount && ASK.test(t)) return 'amountAsk';
  if ((amount || MONEY_SOFT.test(t)) && URGENT.test(t)) return 'urgentMoney';
  if (MONEY_SOFT.test(t) && ASK.test(t)) return 'amountAsk';
  return null;
}
