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
const PAGES = {
  index: { src: 'src/index.html', path: { en: '/', ja: '/ja/' }, out: { en: 'public/index.html', ja: 'public/ja/index.html' } },
  how: { src: 'src/how.html', path: { en: '/how', ja: '/ja/how' }, out: { en: 'public/how.html', ja: 'public/ja/how.html' } },
  roadmap: { src: 'src/roadmap.html', path: { en: '/roadmap', ja: '/ja/roadmap' }, out: { en: 'public/roadmap.html', ja: 'public/ja/roadmap.html' } },
  privacy: { src: 'src/privacy.html', path: { en: '/privacy', ja: '/ja/privacy' }, out: { en: 'public/privacy.html', ja: 'public/ja/privacy.html' } },
};
// The draft file names the sources link to, and which page each one is.
const DRAFT_LINKS = {
  'TegamiのLP案_2026-11-14.html': 'index',
  'Tegamiの仕組み案_2026-11-14.html': 'how',
  'Tegamiのロードマップ案_2026-11-14.html': 'roadmap',
  'Tegamiのプライバシーポリシー案_2026-11-14.html': 'privacy',
};
const META = {
  index: {
    en: { title: 'Tegami: your chats belong to you', desc: 'An open-source messaging app built on Nostr. No ads, no tracking, and bring your own AI.' },
    ja: { title: 'Tegami: トークはあなたのもの', desc: 'Nostrで動く、オープンソースのメッセージアプリ。広告も追跡もなく、いつものAIを連れてこられます。' },
  },
  how: {
    en: { title: 'How Tegami keeps your chats private', desc: 'What happens to a message, and what the server can and can\'t see.' },
    ja: { title: 'Tegamiが会話を守る仕組み', desc: 'メッセージがどう届き、サーバーに何が見えて何が見えないのか。' },
  },
  roadmap: {
    en: { title: 'Tegami roadmap', desc: 'What we\'ve built, and what\'s next.' },
    ja: { title: 'Tegamiのロードマップ', desc: 'できたこと、これから作ること。' },
  },
  privacy: {
    en: { title: 'Tegami privacy policy', desc: 'What Tegami keeps, why, and for how long.' },
    ja: { title: 'Tegamiのプライバシーポリシー', desc: 'Tegamiが何を、なぜ、どれだけの期間預かるか。' },
  },
};
const LANG_ON = 'block px-4 py-2 text-sm font-semibold text-forest-600 dark:text-forest-300';
const LANG_OFF = 'block px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-white/5';

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
  const ja = Object.fromEntries([...html.matchAll(/^ {2}'([\w.]+)': '([^\n]*)',$/gm)].map((x) => [x[1], x[2]]));
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
  // anchors on the home page from other pages already point to /#x; on the home page keep #x
  writeFileSync(page.out[lang], html);
}

mkdirSync('public/ja', { recursive: true });
for (const name of Object.keys(PAGES)) for (const lang of ['en', 'ja']) build(name, lang);
copyFileSync('src/icon.svg', 'public/icon.svg');
execSync('npx --yes tailwindcss@3.4.16 -c tailwind.config.cjs -i src/input.css -o public/tegami.css --minify', { stdio: 'inherit' });
console.log('built');
