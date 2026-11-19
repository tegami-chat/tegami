// What every page shares: the words, the page list, the menus.
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

export const browserAction = (lang: Lang) => ({
  variant: 'primary' as const,
  text: t('cta.browser', lang),
  href: 'https://app.tegami.chat/',
  target: '_blank',
  rel: 'noopener',
});

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

export const PAGES = ['index', 'how', 'faq', 'about', 'compare', 'roadmap', 'status', 'privacy'] as const;
export type PageName = (typeof PAGES)[number];

const PATH: Record<PageName, string> = {
  index: '/',
  how: '/how',
  faq: '/faq',
  about: '/about',
  compare: '/compare',
  roadmap: '/roadmap',
  status: '/status',
  privacy: '/privacy',
};
export const pathOf = (name: PageName, lang: Lang): string =>
  lang === 'ja' ? (PATH[name] === '/' ? '/ja/' : '/ja' + PATH[name]) : PATH[name];

export const META: Record<PageName, Record<Lang, { title: string; desc: string }>> = {
  faq: {
    en: { title: 'FAQ | Tegami', desc: 'Questions people ask first about Tegami.' },
    ja: { title: 'よくある質問 | Tegami', desc: 'Tegamiについて、よく聞かれること。' },
  },
  compare: {
    en: { title: 'Compare apps | Tegami', desc: 'Tegami next to LINE, WhatsApp, Signal and Telegram.' },
    ja: { title: 'ほかのアプリとの比較 | Tegami', desc: 'LINE、WhatsApp、Signal、Telegramと並べた、Tegamiの比較。' },
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
  status: {
    en: { title: 'Status and stats | Tegami', desc: 'Whether the Tegami relay is responding, and weekly usage statistics.' },
    ja: { title: '稼働状況と利用統計 | Tegami', desc: 'Tegamiのリレーの稼働状況と、週ごとの利用統計。' },
  },
};

export function headerData(lang: Lang) {
  return {
    links: [
      { text: t('nav.how', lang), href: link('/how', lang) },
      { text: t('nav.status', lang), href: link('/status', lang) },
      { text: t('nav.faq', lang), href: link('/faq', lang) },
    ],
    actions: [
      {
        text: lang === 'ja' ? 'ブラウザで始める' : 'Open in your browser',
        href: 'https://app.tegami.chat/',
        target: '_blank',
        variant: 'primary' as const,
      },
    ],
  };
}

export function footerData(lang: Lang) {
  const x = (key: string) => t(key, lang);
  return {
    tagline: x('ft.tag'),
    platforms: {
      label: lang === 'ja' ? '使える場所' : 'Where Tegami runs',
      browser: { text: x('ft.os.browser'), status: x('now'), title: lang === 'ja' ? 'ブラウザで始める' : 'Open in your browser', href: 'https://app.tegami.chat/' },
      // Statuses as on the roadmap (rm.now / rm.plan) and in the FAQ.
      others: [
        ['iphone', 'rm.now'],
        ['android', 'rm.now'],
        ['windows', 'rm.plan'],
        ['mac', 'rm.plan'],
        ['linux', 'rm.plan'],
      ].map(([id, st]) => ({ id, text: x('ft.os.' + id), status: x(st) })),
    },
    links: [
      {
        title: x('ft.users'),
        links: [
          { text: x('nav.how'), href: link('/how', lang) },
          { text: x('nav.status'), href: link('/status', lang) },
          { text: x('ft.compare'), href: link('/compare', lang) },
          { text: x('nav.faq'), href: link('/faq', lang) },
        ],
      },
      {
        title: x('ft.devs'),
        links: [
          { text: x('ft.ov'), href: link('/developers', lang) },
          { text: x('dp.arch'), href: link('/developers/architecture', lang) },
          { text: x('dp.enc'), href: link('/developers/encryption', lang) },
          { text: x('dp.keys'), href: link('/developers/keys', lang) },
          { text: x('dp.relay'), href: link('/developers/relay', lang) },
          { text: x('dp.ai'), href: link('/developers/ai', lang) },
          { text: x('dp.spec'), href: link('/developers/spec', lang) },
          { text: x('ft.devcompare'), href: link('/developers/compare', lang) },
          { text: x('ft.devfaq'), href: link('/developers/faq', lang) },
        ],
      },
      {
        title: x('ft.project'),
        links: [
          { text: x('roadmap'), href: link('/roadmap', lang) },
          { text: x('ft.src'), href: 'https://github.com/tegami-chat/tegami', external: true },
          { text: x('ft.issues'), href: 'https://github.com/tegami-chat/tegami/issues', external: true },
        ],
      },
      {
        title: x('ft.community'),
        links: [
          { text: 'X', href: 'https://x.com/tegamichat', external: true },
          { text: 'Bluesky', href: 'https://bsky.app/profile/tegami.chat', external: true },
          { text: 'Mastodon', href: 'https://mastodon.social/@tegamichat', external: true },
          { text: 'Nostr', href: 'https://njump.me/npub1zptpqkxhr98glpt4rqv9945f3hd3q82wghaqth4gwqtmzmtjutsse5a98k', external: true },
        ],
      },
    ],
    secondaryLinks: [
      { text: x('ft.privacy'), href: link('/privacy', lang) },
      { text: x('ft.about'), href: link('/about', lang) },
      { text: 'hello@tegami.chat', href: 'mailto:hello@tegami.chat' },
    ],
    footNote: `© 2026 Tegami contributors. Licensed under <a class="underline" href="https://github.com/tegami-chat/tegami/blob/main/LICENSE" target="_blank" rel="noopener">AGPL-3.0</a>.`,
  };
}
