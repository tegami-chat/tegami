// Blog posts: a link to another site opens in a new tab and gets the same mark as ExtMark.astro
// (the arrow icon and a note for screen readers). mailto: and links inside tegami.chat are left alone.
// Astro 7 renders Markdown with Sätteri, so this is a Sätteri HAST plugin (see astro.config.mjs).
import { defineHastPlugin } from 'satteri';

const ICON = { type: 'element', tagName: 'svg', properties: { viewBox: '0 0 24 24', className: ['ml-1', 'inline-block', 'h-[0.85em]', 'w-[0.85em]', 'align-[-0.1em]'], fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round', ariaHidden: 'true' },
  children: [{ type: 'element', tagName: 'path', properties: { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3' }, children: [] }] };
const NOTE = { ja: '（新しいタブで開きます）', en: ' (opens in a new tab)' };

export default defineHastPlugin({
  name: 'external-links',
  element: {
    filter: ['a'],
    visit(node, ctx) {
      const href = String(node.properties?.href ?? '');
      if (!/^https?:\/\//.test(href) || /^https:\/\/tegami\.chat(\/|$)/.test(href)) return;
      // Posts live in blog/ja/ and blog/en/; the folder tells the language.
      const lang = /\/ja\//.test(ctx.fileURL?.pathname ?? '') ? 'ja' : 'en';
      ctx.setProperty(node, 'target', '_blank');
      ctx.setProperty(node, 'rel', ['noopener']);
      ctx.appendChild(node, [structuredClone(ICON), { type: 'element', tagName: 'span', properties: { className: ['sr-only'] }, children: [{ type: 'text', value: NOTE[lang] }] }]);
    },
  },
});
