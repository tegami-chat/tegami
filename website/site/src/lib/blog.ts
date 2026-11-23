// The blog: which posts a page or a feed shows. A draft is left out everywhere (no page, no list, no feed item).
import { getCollection, type CollectionEntry } from 'astro:content';
import type { Lang } from '~/site';

export type Post = CollectionEntry<'blog'>;

// Posts in one language, newest first.
export const postsOf = async (lang: Lang): Promise<Post[]> =>
  (await getCollection('blog', (p) => !p.data.draft && p.data.lang === lang)).sort((a, b) => b.data.date.localeCompare(a.data.date) || a.id.localeCompare(b.id));

export const blogPath = (lang: Lang, slug?: string): string => (lang === 'ja' ? '/ja/blog' : '/blog') + (slug ? '/' + slug : '');

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// The RSS 2.0 feed of one language, written by hand.
export const feed = async (lang: Lang): Promise<Response> => {
  const posts = await postsOf(lang);
  const base = 'https://tegami.chat';
  const items = posts.map((p) => {
    const url = base + blogPath(lang, p.id);
    return `    <item>
      <title>${esc(p.data.title)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <pubDate>${new Date(p.data.date + 'T00:00:00Z').toUTCString()}</pubDate>
      <description>${esc(p.data.description)}</description>
    </item>`;
  });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${lang === 'ja' ? 'Tegami ブログ' : 'Tegami blog'}</title>
    <link>${base}${blogPath(lang)}</link>
    <description>${lang === 'ja' ? 'Tegamiからのお知らせ。' : 'News from Tegami.'}</description>
    <language>${lang}</language>
${items.join('\n')}
  </channel>
</rss>
`;
  return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
};
