// Builds tegami.chat into public/.
//
// Two Astro projects, one command:
//   site/  The pages for users (/, /how, /faq, /about, /compare, /roadmap, /status, /privacy and the /ja/ copies).
//          Astro project with our own design (no template). See site/README.md.
//   docs/  The developer pages (/developers/..., /ja/developers/...). Built from Astro Starlight. See docs/README.md.
//
// Each project builds into its own dist/ folder, and this script copies the result into public/.
// It replaces only the files the builds make. /.well-known, _headers and _redirects in public/ are never touched.
//
// Run: node build.mjs   (in this folder; the one command that rebuilds the whole site)
import { readFileSync, readdirSync, mkdirSync, copyFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { execSync } from 'node:child_process';

const run = (dir, cmd) => execSync(cmd, { cwd: dir, stdio: 'inherit' });
// The design guard: the user pages may only use the design tokens and the primitives (site/DESIGN.md).
run('site', 'node scripts/check-design.mjs');
for (const dir of ['site', 'docs']) {
  if (!existsSync(`${dir}/node_modules`)) run(dir, 'npm ci');
  run(dir, 'npm run build');
}

// The user pages must not need any inline script or style (the header policy allows only 'self').
// scripts/inline-hashes.mjs lists the ones it finds; for site/ the list has to stay empty.
const inline = JSON.parse(readFileSync('site/src/inline-hashes.json', 'utf8'));
if (inline.style.length || inline.script.length) {
  throw new Error('site/ now has inline scripts or styles. The page policy (script-src \'self\'; style-src \'self\') would block them. Move them into files.');
}

// User pages. Astro writes the Japanese top page as ja.html; it is served at /ja/, so it becomes ja/index.html.
mkdirSync('public/ja', { recursive: true });
for (const f of readdirSync('site/dist').filter((f) => f.endsWith('.html'))) {
  copyFileSync(`site/dist/${f}`, f === 'ja.html' ? 'public/ja/index.html' : `public/${f}`);
}
for (const f of readdirSync('site/dist/ja').filter((f) => f.endsWith('.html'))) copyFileSync(`site/dist/ja/${f}`, `public/ja/${f}`);
// Their scripts, styles and the page scripts (the animation, the status check and the theme setup).
rmSync('public/_site', { recursive: true, force: true });
cpSync('site/dist/_site', 'public/_site', { recursive: true });
for (const f of ['icon.svg', 'diff.js', 'status.js', 'doc-toc.js', 'theme-init.js', 'site.js']) copyFileSync(`site/dist/${f}`, `public/${f}`);

// The developer docs: replace the docs' files in public/.
for (const d of ['developers', 'ja/developers', '_astro', 'pagefind']) {
  rmSync('public/' + d, { recursive: true, force: true });
  cpSync('docs/dist/' + d, 'public/' + d, { recursive: true });
}
console.log('built');
