// Developer docs for tegami.chat (Astro Starlight).
// Build output goes to ./dist; build.mjs in the parent folder copies it into ../public.
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { readFileSync, existsSync } from 'node:fs';

// Hashes of inline styles and scripts that Astro does not hash itself (kept up to date by scripts/inline-hashes.mjs).
const inline = existsSync('./src/inline-hashes.json') ? JSON.parse(readFileSync('./src/inline-hashes.json', 'utf8')) : { style: [], script: [] };

export default defineConfig({
  site: 'https://tegami.chat',
  outDir: './dist',
  // External stylesheets only, so style-src 'self' is enough.
  build: { inlineStylesheets: 'never' },
  // Astro hashes the inline scripts and styles it emits and writes them into a <meta> CSP tag.
  security: {
    csp: {
      directives: [
        "default-src 'none'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
      ],
      // 'unsafe-hashes' lets the listed style="..." attribute values through; any other inline style is still blocked.
      styleDirective: { resources: ["'self'", "'unsafe-hashes'"], hashes: inline.style },
      scriptDirective: { resources: ["'self'", "'wasm-unsafe-eval'"], hashes: inline.script },
    },
  },
  integrations: [
    starlight({
      title: 'Tegami',
      description: 'Developer documentation for Tegami, an open-source messaging app built on Nostr.',
      logo: { src: './src/assets/icon.svg', alt: '' },
      favicon: '/icon.svg',
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        ja: { label: '日本語', lang: 'ja' },
      },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/tegami-chat/tegami' }],
      sidebar: [
        {
          label: 'Getting started',
          translations: { ja: 'はじめに' },
          items: [
            { slug: 'developers', label: 'Overview', translations: { ja: '概要' } },
            { slug: 'developers/architecture', label: 'Architecture', translations: { ja: '全体の構成' } },
            { slug: 'developers/differences', label: 'How Tegami differs', translations: { ja: 'よくある構成との違い' } },
          ],
        },
        {
          label: 'Concepts',
          translations: { ja: '仕組み' },
          items: [
            { slug: 'developers/nostr', label: 'Nostr', translations: { ja: 'Nostrとの関係' } },
            { slug: 'developers/encryption', label: 'Encryption', translations: { ja: '暗号化' } },
            { slug: 'developers/keys', label: 'Keys', translations: { ja: '鍵' } },
            { slug: 'developers/relay', label: 'Relay', translations: { ja: 'リレー' } },
            { slug: 'developers/notifications-calls', label: 'Notifications, calls and media', translations: { ja: '通知、通話、写真' } },
            { slug: 'developers/ai', label: 'AI', translations: { ja: 'AI' } },
          ],
        },
        {
          label: 'Guides',
          translations: { ja: 'ガイド' },
          items: [
            { slug: 'developers/self-host-relay', label: 'Run your own relay', translations: { ja: '自分のリレーを立てる' } },
            { slug: 'developers/connect-ai', label: 'Connect your own AI', translations: { ja: '自分のAIをつなぐ' } },
            { slug: 'developers/contributing', label: 'Contributing', translations: { ja: '開発に参加する' } },
          ],
        },
        {
          label: 'Reference',
          translations: { ja: 'リファレンス' },
          items: [
            { slug: 'developers/spec', label: 'Technical spec', translations: { ja: '技術仕様' } },
          ],
        },
        {
          label: 'Comparison and FAQ',
          translations: { ja: '比較とよくある質問' },
          items: [
            { slug: 'developers/compare', label: 'Comparison for developers', translations: { ja: '開発者向けの比較' } },
            { slug: 'developers/faq', label: 'Developer FAQ', translations: { ja: '開発者向けのよくある質問' } },
          ],
        },
      ],
      components: { SocialIcons: './src/components/SocialIcons.astro' },
      customCss: ['./src/styles/custom.css'],
    }),
  ],
});
