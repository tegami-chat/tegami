// Design guard. Run by ../../build.mjs before the build; exits with an error when a page or a home section
// uses a value that belongs in the tokens (src/styles/global.css) or in a primitive (src/components/ui).
// The rule is in ../DESIGN.md: pages compose primitives; a new value goes into the tokens first.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['src/components/home', 'src/components/pages'];

// Files that may break a rule, by file name, with the reason. Keep this list short.
// Format: 'File.astro': { rules: ['rule-id', ...], why: '...' }
const ALLOW = {
  // (empty on purpose: every home section and page composes the primitives. Add an entry only for a content-specific visual.)
};

const V = '(?:[\\w-]+:)*'; // variant prefixes such as md: dark: hover:
const SCALE = ['0', '1', '2', '3', '4', '6', '8', '12', '16', 'px', 'auto'];
const RULES = [
  { id: 'arbitrary-value', why: 'arbitrary values such as w-[12px] or text-[13px]: add a token instead', re: new RegExp('^' + V + '!?-?[a-z-]+-\\[[^\\]]+\\]$') },
  { id: 'arbitrary-variant', why: 'arbitrary variants such as [&_p]:mt-0: put the rule in Prose or global.css', re: new RegExp('^' + V + '!?\\[[^\\]]+\\]:') },
  { id: 'max-width', why: 'raw max-w-*: use Container (prose, content, wide)', re: new RegExp('^' + V + 'max-w-') },
  { id: 'font-size', why: 'raw font size: use text-display, text-title, text-section, text-subsection, text-lead, text-body, text-small, text-caption', re: new RegExp('^' + V + 'text-(xs|sm|base|lg|xl|[2-9]xl)$') },
  { id: 'section-padding', why: 'large padding: use the rhythm of Section (page, default, compact)', re: new RegExp('^' + V + 'p[xy]?-(1[0-9]|2[0-9]|[5-9]\\d)$|^' + V + 'p[xy]?-(10|14|20|24)$') },
  { id: 'palette-colour', why: 'raw palette colour: use a semantic colour (bg-surface, text-fg-muted, border-line, text-accent, ...)', re: new RegExp('^' + V + '(bg|text|border|divide|ring|fill|stroke|from|to)-(white|black|neutral|gray|slate|zinc|stone|red|amber|forest|nostr|paper|night)(-|$|/)') },
  { id: 'dark-variant', why: 'dark: in a page: the semantic colours already have dark values; a special dark look belongs in a primitive', re: /^(?:[\w-]+:)*dark:/ },
  { id: 'radius', why: 'raw radius: use rounded-control, rounded-box or rounded-pill', re: new RegExp('^' + V + 'rounded(-(none|xs|sm|md|lg|xl|2xl|3xl|full))?$') },
  { id: 'shadow', why: 'raw shadow: use shadow-card or shadow-pop', re: new RegExp('^' + V + 'shadow-(xs|sm|md|lg|xl|2xl)$') },
  {
    id: 'spacing-step', why: 'gap, space and margin come from one set of steps: ' + SCALE.join(', '),
    test: (tok) => {
      const m = tok.replace(/^(?:[\w-]+:)*!?/, '').match(/^(-?)(?:gap(?:-[xy])?|space-[xy]|m[xytblr]?)-(.+)$/);
      return !!m && !SCALE.includes(m[2]);
    },
  },
];

const files = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : p.endsWith('.astro') && files.push(p); } })(join(site, 'src/components/home'));
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : p.endsWith('.astro') && files.push(p); } })(join(site, 'src/components/pages'));

const problems = [];
for (const file of files) {
  const name = file.split(/[\\/]/).pop();
  const allowed = new Set(ALLOW[name]?.rules ?? []);
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    // Only the text inside quotes can be a class list; skip comments.
    if (/^\s*(\/\/|<!--)/.test(line)) return;
    for (const q of line.matchAll(/(["'`])((?:(?!\1).)*)\1/g)) {
      for (const raw of q[2].split(/\s+/)) {
        if (!raw || /[{}()=<>,;]/.test(raw)) continue;
        const tok = raw;
        for (const r of RULES) {
          if (allowed.has(r.id)) continue;
          if (r.re ? r.re.test(tok) : r.test(tok)) problems.push(`${relative(site, file).replace(/\\/g, '/')}:${i + 1}  ${tok}  [${r.id}] ${r.why}`);
        }
      }
    }
  });
}

if (problems.length) {
  console.error('Design guard failed. Pages and home sections must compose the primitives and tokens (see website/site/DESIGN.md):\n');
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`Design guard: ${files.length} files, no raw design values.`);
