// Builds tegami.chat from src/*.html.
//
// Each page in src/ holds the English text in the HTML and the Japanese text in a
// `const JA = {...}` table (keyed by data-i18n). This script writes one static page
// per language, with no translation script:
//   public/index.html, public/how.html, ...        English, at /, /how, ...
//   public/ja/index.html, public/ja/how.html, ...  Japanese, at /ja/, /ja/how, ...
// Then it compiles Tailwind into public/tegami.css (no CDN, so the CSP stays strict).
//
// Run: node build.mjs   (in this folder)
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const SITE = 'https://tegami.chat';
// Each page: its source, its address in each language, and which top menu item it belongs to.
const page = (name, path, nav) => ({
  src: `src/${name}.html`,
  path: { en: path, ja: path === '/' ? '/ja/' : '/ja' + path },
  out: { en: `public${path === '/' ? '/index' : path}.html`, ja: `public/ja${path === '/' ? '/index' : path}.html` },
  nav,
});
const PAGES = {
  index: page('index', '/', ''),
  how: page('how', '/how', 'nav.how'),
  developers: page('developers', '/developers', ''),
  'dev-protocol': page('dev-protocol', '/developers/protocol', ''),
  'dev-relay': page('dev-relay', '/developers/relay', ''),
  'dev-ai': page('dev-ai', '/developers/ai', ''),
  'dev-compare': page('dev-compare', '/developers/compare', ''),
  'dev-spec': page('dev-spec', '/developers/spec', ''),
  'dev-faq': page('dev-faq', '/developers/faq', ''),
  compare: page('compare', '/compare', ''),
  roadmap: page('roadmap', '/roadmap', ''),
  faq: page('faq', '/faq', 'nav.faq'),
  privacy: page('privacy', '/privacy', ''),
  about: page('about', '/about', ''),
  status: page('status', '/status', 'nav.status'),
};
// The draft file names the sources link to, and which page each one is.
const DRAFT_LINKS = {
  'TegamiのLP案_2026-11-14.html': 'index',
  'Tegamiの仕組み案_2026-11-14.html': 'how',
  'Tegamiの開発者向け_2026-11-16.html': 'developers',
  'Tegamiの開発者向け_Nostrと暗号.html': 'dev-protocol',
  'Tegamiの開発者向け_リレー.html': 'dev-relay',
  'Tegamiの開発者向け_AI.html': 'dev-ai',
  'Tegamiの開発者向け_比較.html': 'dev-compare',
  'Tegamiの開発者向け_技術仕様.html': 'dev-spec',
  'Tegamiの開発者向け_よくある質問.html': 'dev-faq',
  'Tegamiの比較.html': 'compare',
  'Tegamiのロードマップ案_2026-11-14.html': 'roadmap',
  'Tegamiのよくある質問_2026-11-16.html': 'faq',
  'Tegamiのプライバシーポリシー案_2026-11-14.html': 'privacy',
  'Tegamiの運営者情報案_2026-11-17.html': 'about',
  'Tegamiの稼働状況と利用統計案_2026-11-15.html': 'status',
};
const META = {
  faq: {
    en: { title: 'Tegami FAQ', desc: 'Questions people ask first about Tegami.' },
    ja: { title: 'Tegamiのよくある質問', desc: 'Tegamiについて、よく聞かれること。' },
  },
  'dev-protocol': {
    en: { title: 'Nostr, encryption and keys | Tegami for developers', desc: 'Which parts of Nostr Tegami uses, how messages are sealed, what the relay can see, and how keys are kept.' },
    ja: { title: 'Nostrと暗号と鍵 | 開発者向けのTegamiの説明', desc: 'TegamiがNostrのどこを使うか、メッセージをどう封じるか、リレーに何が見えるか、鍵をどう守るか。' },
  },
  'dev-relay': {
    en: { title: 'Relay, notifications and calls | Tegami for developers', desc: 'The rules of the Tegami relay, and how notifications, calls and photos work.' },
    ja: { title: 'リレー、通知、通話 | 開発者向けのTegamiの説明', desc: 'Tegamiのリレーの決まりと、通知、通話、写真の仕組み。' },
  },
  'dev-ai': {
    en: { title: 'AI | Tegami for developers', desc: 'How your own AI joins Tegami, what it can read, and what goes to the AI provider.' },
    ja: { title: 'AI | 開発者向けのTegamiの説明', desc: '自分のAIがどうつながり、何を読めて、何がAIの会社に渡るか。' },
  },
  'dev-compare': {
    en: { title: 'Compared with other apps | Tegami for developers', desc: 'Tegami next to LINE, WhatsApp, Signal, Telegram and other Nostr apps.' },
    ja: { title: 'ほかのアプリとの比較 | 開発者向けのTegamiの説明', desc: 'LINE、WhatsApp、Signal、Telegram、ほかのNostrアプリとの比較。' },
  },
  'dev-spec': {
    en: { title: 'Technical spec | Tegami for developers', desc: 'Crypto building blocks, relay limits, HTTP endpoints and Tegami event kinds.' },
    ja: { title: '技術仕様 | 開発者向けのTegamiの説明', desc: '暗号の部品、リレーの上限、HTTPの口、Tegami独自のkind。' },
  },
  'dev-faq': {
    en: { title: 'Developer FAQ | Tegami', desc: 'Questions developers ask about Tegami.' },
    ja: { title: '開発者向けのよくある質問 | Tegami', desc: '開発者からよく聞かれること。' },
  },
  compare: {
    en: { title: 'Tegami compared with other apps', desc: 'Tegami next to LINE, WhatsApp, Signal and Telegram.' },
    ja: { title: 'ほかのアプリとの比較 | Tegami', desc: 'LINE、WhatsApp、Signal、Telegramと並べた、Tegamiの比較。' },
  },
  index: {
    en: { title: 'Tegami: your chats belong to you', desc: 'An open-source messaging app built on Nostr. No ads, no tracking, and bring your own AI.' },
    ja: { title: 'Tegami: トークはあなたのもの', desc: 'Nostrで動く、オープンソースのメッセージアプリ。広告も追跡もなく、いつものAIを連れてこられます。' },
  },
  how: {
    en: { title: 'How Tegami keeps you safe', desc: 'What protects your messages, what we can and can\'t see, and what isn\'t done yet.' },
    ja: { title: 'Tegamiの安全の仕組み', desc: 'メッセージを守る仕組みと、運営者に見えるもの、見えないもの、まだ足りないこと。' },
  },
  roadmap: {
    en: { title: 'Tegami roadmap', desc: 'What we\'ve built, and what\'s next.' },
    ja: { title: 'Tegamiのロードマップ', desc: 'できたこと、これから作ること。' },
  },
  privacy: {
    en: { title: 'Tegami privacy policy', desc: 'What Tegami keeps, why, and for how long.' },
    ja: { title: 'Tegamiのプライバシーポリシー', desc: 'Tegamiが何を、なぜ、どれだけの期間預かるか。' },
  },
  about: {
    en: { title: 'About the Tegami operator', desc: 'Who runs Tegami, and how to contact us.' },
    ja: { title: 'Tegamiの運営者情報', desc: 'Tegamiの運営者と連絡先。' },
  },
  developers: {
    en: { title: 'Tegami for developers', desc: 'How Tegami uses Nostr, what the relay can see, keys, AI, and the full technical spec.' },
    ja: { title: '開発者向けのTegamiの説明', desc: 'TegamiがNostrのどこを使うか、リレーに見えるもの、鍵、AI、技術仕様。' },
  },
  status: {
    en: { title: 'Tegami status and usage', desc: 'Whether the Tegami relay is responding, and weekly usage statistics.' },
    ja: { title: 'Tegamiの稼働状況と利用統計', desc: 'Tegamiのリレーの稼働状況と、週ごとの利用統計。' },
  },
};
const LANG_ON = 'block px-4 py-2 text-sm font-semibold text-forest-600 dark:text-forest-300';
const LANG_OFF = 'block px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-white/5';

// The header and footer every page shares, and their Japanese words.
const LAYOUT = readFileSync('src/_layout.html', 'utf8');
const HEADER = LAYOUT.slice(LAYOUT.indexOf('<header'), LAYOUT.indexOf('</header>') + 9);
const FOOTER = LAYOUT.slice(LAYOUT.indexOf('<footer'), LAYOUT.indexOf('</footer>') + 9);
const jaTable = (html) => Object.fromEntries([...html.matchAll(/^ {2}'([\w.]+)': '([^\n]*)',$/gm)].map((x) => [x[1], x[2]]));
const LAYOUT_JA = jaTable(LAYOUT);
// The current page's menu item changes colour only, never weight, so the menu does not shift between pages.
const NAV_ON = ' text-neutral-900 dark:text-white';

const EXT_ICON = '<svg viewBox="0 0 24 24" class="ml-1 inline-block h-[0.85em] w-[0.85em] align-[-0.1em]" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// Replace the inner HTML of every element carrying data-i18n="key" with dict[key].
function translate(html, dict) {
  const re = /data-i18n="([\w.]+)"/g;
  const hits = [];
  let m;
  while ((m = re.exec(html))) hits.push({ key: m[1], at: m.index });
  for (const { key, at } of hits.reverse()) {
    if (!(key in dict)) continue;
    const open = html.lastIndexOf('<', at);
    const tag = /^<([a-z0-9]+)/i.exec(html.slice(open))[1];
    const start = html.indexOf('>', at) + 1;
    let depth = 1;
    let i = start;
    const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    tagRe.lastIndex = start;
    let t;
    while ((t = tagRe.exec(html))) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) { i = t.index; break; }
    }
    if (depth !== 0) throw new Error(`no closing </${tag}> for ${key}`);
    html = html.slice(0, start) + dict[key] + html.slice(i);
  }
  return html;
}

function build(name, lang) {
  const page = PAGES[name];
  let html = readFileSync(page.src, 'utf8');
  html = html.replace(/<header[\s\S]*?<\/header>/, HEADER).replace(/<footer[\s\S]*?<\/footer>/, FOOTER);
  const ja = { ...jaTable(html), ...LAYOUT_JA };
  if (lang === 'ja') html = translate(html, ja);

  // drop the draft-only scripts: Tailwind CDN + config, theme bootstrap, translation table
  html = html.replace(/<script>\n\(function \(\) \{\n {2}var t;.*?<\/script>\n/s, '');
  html = html.replace(/<script src="https:\/\/cdn\.tailwindcss\.com[^"]*"><\/script>\n<script>\ntailwind\.config = .*?<\/script>\n/s, '');
  html = html.replace(/<style>\n {2}:lang\(ja\).*?<\/style>\n/s, '');
  html = html.replace(/\n<script>\n\/\/ 言葉の切り替え。.*?<\/script>\n/s, '\n<script src="/site.js"></script>\n');

  // head: language, title, description, alternates, stylesheet
  const meta = META[name][lang];
  const url = SITE + page.path[lang];
  const head = [
    `<title>${esc(meta.title)}</title>`,
    `<meta name="description" content="${esc(meta.desc)}">`,
    `<meta property="og:title" content="${esc(meta.title)}">`,
    `<meta property="og:description" content="${esc(meta.desc)}">`,
    `<meta property="og:url" content="${url}">`,
    `<link rel="canonical" href="${url}">`,
    `<link rel="alternate" hreflang="en" href="${SITE + page.path.en}">`,
    `<link rel="alternate" hreflang="ja" href="${SITE + page.path.ja}">`,
    `<link rel="alternate" hreflang="x-default" href="${SITE + page.path.en}">`,
    `<link rel="icon" href="/icon.svg" type="image/svg+xml">`,
    `<link rel="stylesheet" href="/tegami.css">`,
    `<script src="/theme.js"></script>`,
  ].join('\n');
  html = html.replace(/<html lang="[^"]*">/, `<html lang="${lang}">`);
  html = html.replace(/<title>.*?<\/title>/, head);

  // links between pages
  for (const [draft, target] of Object.entries(DRAFT_LINKS)) {
    html = html.replace(new RegExp(`href="${draft}(#[\\w-]+)?"`, 'g'), (_, hash) => `href="${PAGES[target].path[lang]}${hash ?? ''}"`);
  }
  // language menu: link to this page in each language, mark the current one
  html = html.replace(/<a href="\?lang=(en|ja)"([^>]*?) data-lang="(en|ja)" class="[^"]*">/g,
    (_, l, attrs, l2) => `<a href="${page.path[l]}"${attrs} data-lang="${l2}" class="${l === lang ? LANG_ON : LANG_OFF}"${l === lang ? ' aria-current="true"' : ''}>`);
  // the menu item for this page
  if (page.nav) html = html.replace(new RegExp(`(<a href="[^"]*" class="[^"]*)(" data-nav="${page.nav.replace('.', '\.')}")`, 'g'), `$1${NAV_ON}" aria-current="page$2`);
  // the pages' own scripts
  html = html.replace('<script src="status.js"></script>', '<script src="/status.js"></script>');
  html = html.replace('<script src="diff.js"></script>', '<script src="/diff.js"></script>');
  // text that differs by language and sits in attributes, where data-i18n cannot reach
  const TOK = lang === 'ja'
    ? { soon: '準備中', browser: 'ブラウザで始める', avail: '使える場所' }
    : { soon: 'Coming soon', browser: 'Open in your browser', avail: 'Where Tegami runs' };
  html = html.replace(/@(soon|browser|avail)@/g, (_, k) => TOK[k]);
  // every link that opens in a new tab gets the external-link icon and a hidden note for screen readers
  html = html.replace(/(<a\b[^>]*\btarget="_blank"[^>]*>)([\s\S]*?)(<\/a>)/g, (_, open, inner, close) => {
    const icon = /\bdata-noext\b/.test(open) ? '' : EXT_ICON;
    return open + inner + icon + `<span class="sr-only">${lang === 'ja' ? '（新しいタブで開きます）' : ' (opens in a new tab)'}</span>` + close;
  });
  // anchors on the home page from other pages already point to /#x; on the home page keep #x
  writeFileSync(page.out[lang], html);
}

mkdirSync('public/ja/developers', { recursive: true });
mkdirSync('public/developers', { recursive: true });
for (const name of Object.keys(PAGES)) for (const lang of ['en', 'ja']) build(name, lang);
copyFileSync('src/icon.svg', 'public/icon.svg');
for (const f of ['status.js', 'diff.js', 'site.js', 'theme.js']) copyFileSync('src/' + f, 'public/' + f);
execSync('npx --yes tailwindcss@3.4.16 -c tailwind.config.cjs -i src/input.css -o public/tegami.css --minify', { stdio: 'inherit' });
console.log('built');
