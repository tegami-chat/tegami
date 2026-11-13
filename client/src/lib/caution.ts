// A caution under a message about money or with a link, from someone who is not a friend.
// Runs on this device only, on text already here; nothing is sent anywhere.

const LINK = /https?:\/\/|www\./i;
const MONEY = ['振込', '振り込', '送金', '投資', '儲か', '稼げ', 'ギフトカード', '暗号資産', '仮想通貨', 'ビットコイン', '口座', '副業', '当選', '受け取り手数料'];

/** Whether a message talks about money or carries a link. */
export function cautionFor(text: string): boolean {
  if (!text) return false;
  // NFKC: full-width "ｈｔｔｐｓ：／／" and half-width "ﾋﾞｯﾄｺｲﾝ" match too.
  const t = text.normalize?.('NFKC') ?? text;
  return LINK.test(t) || MONEY.some((w) => t.includes(w));
}
