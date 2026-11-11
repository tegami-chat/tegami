// Builds the web app for app.tegami.chat and checks which relay it talks to.
// Run: npm run build:web   (then deploy with: npx wrangler@4 deploy)
//
// Expo inlines EXPO_PUBLIC_* values at build time and its cache can keep a value
// from an earlier build (for example the local relay used by the tests). So this
// always clears the cache and refuses to finish if the bundle points anywhere else.
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const RELAY = 'wss://relay.tegami.chat';

execSync('npx expo export --platform web --output-dir dist --clear', {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production', EXPO_PUBLIC_TEGAMI_RELAYS: RELAY },
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
console.log(`\nOK: the bundle talks only to ${RELAY}.`);
