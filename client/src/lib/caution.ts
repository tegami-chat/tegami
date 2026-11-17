// A caution under a message about money or with a link, from someone who is not a friend.
// Runs on this device only, on text already here; nothing is sent anywhere.

import { findMoney } from './ai-screen';

const LINK = /https?:\/\/|www\./i;
// Words a stranger's pitch uses besides the money talk ai-screen.ts finds (findMoney).
const STRANGER = ['投資', '儲か', '稼げ', '副業', '当選', '受け取り手数料', '高収入', '簡単に', '紹介料', 'ギフトカード'];

/** Whether a message talks about money or carries a link. */
export function cautionFor(text: string): boolean {
  if (!text) return false;
  // NFKC: full-width "ｈｔｔｐｓ：／／" and half-width "ﾋﾞｯﾄｺｲﾝ" match too.
  const t = text.normalize?.('NFKC') ?? text;
  return LINK.test(t) || STRANGER.some((w) => t.includes(w)) || findMoney(t) !== null;
}
