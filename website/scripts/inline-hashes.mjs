// Astro's CSP support hashes the <script> and <style> elements it bundles, but not
//   - style="..." attributes (Starlight uses a few, like style="--depth: 0;"), nor
//   - the plain inline <script> elements that Starlight marks is:inline (theme setup and similar).
// Their text is the same on every build, so this script reads the built pages, hashes each distinct
// value, and keeps src/inline-hashes.json in step. astro.config.mjs puts the hashes in the CSP,
// and 'unsafe-hashes' lets the style hashes apply to attributes. Nothing else inline is allowed.
// If the list changed, this rebuilds once so the new hashes are in the pages.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const hash = (v) => 'sha256-' + createHash('sha256').update(v).digest('base64');
const styles = new Set();
const scripts = new Set();
for (const f of walk('dist').filter((f) => f.endsWith('.html'))) {
  const html = readFileSync(f, 'utf8');
  for (const m of html.matchAll(/<[a-z][^>]*?\sstyle="([^"]*)"/g)) styles.add(hash(decode(m[1])));
  for (const m of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)) if (m[1].trim()) scripts.add(hash(m[1]));
}
const file = 'src/inline-hashes.json';
const next = JSON.stringify({ style: [...styles].sort(), script: [...scripts].sort() }, null, 2) + '\n';
const old = existsSync(file) ? readFileSync(file, 'utf8') : '';
if (old !== next) {
  writeFileSync(file, next);
  console.log(`inline hashes changed (${styles.size} styles, ${scripts.size} scripts); rebuilding once`);
  execSync('npx astro build', { stdio: 'inherit' });
}
