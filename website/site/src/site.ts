// What every page shares: the words, the page list, the page titles.
// dict.json holds every sentence as { en, ja }. The pages ask for a key and a language.
import dict from '~/content/dict.json';

export type Lang = 'en' | 'ja';
type Entry = { en: string; ja: string };
const D = dict as Record<string, Entry>;

// The developer docs are folders, and the server redirects /developers to /developers/, so write the slash.
export const link = (path: string, lang: Lang): string => {
  const p = /^\/developers(\/|$)/.test(path) && !path.endsWith('/') ? path + '/' : path;
  return lang === 'ja' ? (p === '/' ? '/ja/' : '/ja' + p) : p;
};

// The sentences link to the draft file names; they become the real addresses, in the page's language.
const DRAFT_LINKS: Record<string, string> = {
  'TegamiのLP案_2026-11-14.html': '/',
  'Tegamiの仕組み案_2026-11-14.html': '/how',
  'Tegamiの開発者向け_2026-11-16.html': '/developers',
  'Tegamiの開発者向け_全体の構成.html': '/developers/architecture',
  'Tegamiの開発者向け_Nostrと暗号.html': '/developers/nostr',
  'Tegamiの開発者向け_暗号化.html': '/developers/encryption',
  'Tegamiの開発者向け_鍵.html': '/developers/keys',
  'Tegamiの開発者向け_リレー.html': '/developers/relay',
  'Tegamiの開発者向け_AI.html': '/developers/ai',
  'Tegamiの開発者向け_比較.html': '/developers/compare',
  'Tegamiの開発者向け_技術仕様.html': '/developers/spec',
  'Tegamiの開発者向け_よくある質問.html': '/developers/faq',
  'Tegamiの比較.html': '/compare',
  'Tegamiのロードマップ案_2026-11-14.html': '/roadmap',
  'Tegamiのよくある質問_2026-11-16.html': '/faq',
  'Tegamiのプライバシーポリシー案_2026-11-14.html': '/privacy',
  'Tegamiの運営者情報案_2026-11-17.html': '/about',
  'Tegamiの稼働状況と利用統計案_2026-11-15.html': '/status',
};
export const fixLinks = (html: string, lang: Lang): string =>
  html.replace(/href="([^"#]+\.html)(#[\w-]+)?"/g, (m, file: string, hash = '') =>
    DRAFT_LINKS[file] ? `href="${link(DRAFT_LINKS[file], lang)}${hash}"` : m
  );

export const t = (key: string, lang: Lang): string => {
  const e = D[key];
  if (!e) throw new Error(`missing text: ${key}`);
  return fixLinks(e[lang] ?? e.en, lang);
};

// The /compare page was taken off on 2026-11-19. To bring it back: add 'compare' to PAGES, restore PATH and META entries (compare: '/compare'), the Footer link and the Compare entry in PageView.astro. Compare.astro and its dict keys are kept.
export const PAGES = ['index', 'how', 'faq', 'about', 'roadmap', 'status', 'privacy', 'donate'] as const;
export type PageName = (typeof PAGES)[number];

const PATH: Record<PageName, string> = {
  index: '/',
  how: '/how',
  faq: '/faq',
  about: '/about',
  roadmap: '/roadmap',
  status: '/status',
  privacy: '/privacy',
  donate: '/donate',
};
export const pathOf = (name: PageName, lang: Lang): string =>
  lang === 'ja' ? (PATH[name] === '/' ? '/ja/' : '/ja' + PATH[name]) : PATH[name];

export const META: Record<PageName, Record<Lang, { title: string; desc: string }>> = {
  faq: {
    en: { title: 'FAQ | Tegami', desc: 'Questions people ask first about Tegami.' },
    ja: { title: 'よくある質問 | Tegami', desc: 'Tegamiについて、よく聞かれること。' },
  },
  index: {
    en: { title: 'Tegami: your chats belong to you', desc: 'An open-source messaging app built on Nostr. No ads, no tracking, and bring your own AI.' },
    ja: { title: 'Tegami: トークはあなたのもの', desc: 'Nostrで動く、オープンソースのメッセージアプリ。広告も追跡もなく、いつものAIを連れてこられます。' },
  },
  how: {
    en: { title: 'Security | Tegami', desc: "What protects your messages, what we can and can't see, and what isn't done yet." },
    ja: { title: '安全の仕組み | Tegami', desc: 'メッセージを守る仕組みと、運営者に見えるもの、見えないもの、まだ足りないこと。' },
  },
  roadmap: {
    en: { title: 'Roadmap | Tegami', desc: "What we've built, and what's next." },
    ja: { title: 'ロードマップ | Tegami', desc: 'できたこと、これから作ること。' },
  },
  privacy: {
    en: { title: 'Privacy policy | Tegami', desc: 'What Tegami keeps, why, and for how long.' },
    ja: { title: 'プライバシーポリシー | Tegami', desc: 'Tegamiが何を、なぜ、どれだけの期間預かるか。' },
  },
  about: {
    en: { title: 'About us | Tegami', desc: 'Who runs Tegami, and how to contact us.' },
    ja: { title: '運営者情報 | Tegami', desc: 'Tegamiの運営者と連絡先。' },
  },
  donate: {
    en: { title: 'Donate | Tegami', desc: 'Support Tegami with a Lightning donation.' },
    ja: { title: '寄付 | Tegami', desc: 'Lightningで、Tegamiの運営を支えられます。' },
  },
  status: {
    en: { title: 'Status and stats | Tegami', desc: 'Whether the Tegami relay is responding, and weekly usage statistics.' },
    ja: { title: '稼働状況と利用統計 | Tegami', desc: 'Tegamiのリレーの稼働状況と、週ごとの利用統計。' },
  },
};
