// Builds the web app for app.tegami.chat and checks which relay it talks to.
// Run: npm run build:web   (then deploy with: npx wrangler@4 deploy)
//
// Expo inlines EXPO_PUBLIC_* values at build time and its cache can keep a value
// from an earlier build (for example the local relay used by the tests). So this
// always clears the cache and refuses to finish if the bundle points anywhere else.
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const RELAY = 'wss://relay.tegami.chat';

execSync('npx expo export --platform web --output-dir dist --clear', {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production', EXPO_PUBLIC_TEGAMI_RELAYS: RELAY, EXPO_PUBLIC_TEGAMI_FILES: 'https://relay.tegami.chat' },
});

const dir = join(ROOT, 'dist/_expo/static/js/web');
const relays = new Set();
for (const f of readdirSync(dir)) {
  for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/wss?:\/\/[a-z0-9.-]+(?::\d+)?/gi)) relays.add(m[0]);
}
const wrong = [...relays].filter((r) => r !== RELAY);
if (!relays.has(RELAY) || wrong.length) {
  console.error(`\nThe bundle talks to ${[...relays].join(', ') || 'no relay'}; expected only ${RELAY}. Do not deploy.`);
  process.exit(1);
}
// The file server (photos) must not point at a development address either.
const local = new Set();
for (const f of readdirSync(dir)) {
  for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/g)) local.add(m[0]);
}
if (local.size) {
  console.error(`\nThe bundle points at ${[...local].join(', ')}. Do not deploy.`);
  process.exit(1);
}
// Home Screen app (iPhone needs it for notifications): the manifest and icon links.
const html = join(ROOT, 'dist/index.html');
const head = [
  '<link rel="manifest" href="/manifest.webmanifest">',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-title" content="Tegami">',
].join('');
const page = readFileSync(html, 'utf8');
if (!page.includes('rel="manifest"')) writeFileSync(html, page.replace('</head>', `${head}</head>`));
console.log(`\nOK: the bundle talks only to ${RELAY}.`);
