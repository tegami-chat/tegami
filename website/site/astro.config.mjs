// User pages for tegami.chat (AstroWind template). Build output goes to ./dist;
// build.mjs in the parent folder copies the pages into ../public.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import icon from 'astro-icon';
import astrowind from './vendor/integration';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Hashes of inline styles and scripts that Astro does not hash itself (kept up to date by ../scripts/inline-hashes.mjs).
// The user pages have none, so the list stays empty; build.mjs fails if it is not.
const inline = existsSync('./src/inline-hashes.json') ? JSON.parse(readFileSync('./src/inline-hashes.json', 'utf8')) : { style: [], script: [] };

export default defineConfig({
  site: 'https://tegami.chat',
  outDir: './dist',
  output: 'static',
  // how.html and ja/how.html, the same file names as before.
  build: {
    format: 'file',
    // External stylesheets only, so style-src 'self' is enough.
    inlineStylesheets: 'never',
    // The developer docs use _astro; keep the two sets of files apart.
    assets: '_site',
  },
  security: {
    csp: {
      directives: [
        "default-src 'none'",
        "img-src 'self'",
        "font-src 'self'",
        "connect-src 'self' https://relay.tegami.chat",
        "base-uri 'none'",
        "form-action 'none'",
      ],
      styleDirective: { resources: ["'self'"], hashes: inline.style },
      scriptDirective: { resources: ["'self'"], hashes: inline.script },
    },
  },
  integrations: [icon({ include: { tabler: ['*'] } }), astrowind({ config: './src/config.yaml' })],
  vite: {
    plugins: [tailwindcss()],
    // Small scripts would be written into the page; keep them as files so script-src 'self' is enough.
    build: { assetsInlineLimit: 0 },
    resolve: {
      alias: {
        '~': path.resolve(__dirname, './src'),
      },
    },
  },
});
