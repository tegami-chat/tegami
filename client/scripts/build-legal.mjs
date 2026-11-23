// Reads the Japanese terms of use (keys "tm.") and privacy policy (keys "pv.") from the website's
// dict.json, in the order the two Astro pages (Terms.astro, Privacy.astro) print them, and writes
// src/content/legal.json for the in-app reading screen. Run after the website text changes:
//   node scripts/build-legal.mjs
// Blocks: h1, h2, p, date (text); ol, ul (items, an item may hold a nested list); rows (data
// tables: a title and labelled fields); dl (term and text). Text is a string, or a list of
// pieces when it holds links: { text, href? }. <br> becomes a line break.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SITE = resolve(import.meta.dirname, '../../website/site/src');
const dict = JSON.parse(readFileSync(resolve(SITE, 'content/dict.json'), 'utf8'));

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENT[m]);

function ja(key) {
  const e = dict[key];
  if (!e || typeof e.ja !== 'string') throw new Error(`missing text: ${key}`);
  return e.ja;
}

/** One dict string -> plain string, or pieces when it holds links. */
function text(html) {
  const pieces = [];
  let rest = html.replace(/<br\s*\/?>/g, '\n');
  const link = /<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
  for (let m = link.exec(rest); m; m = link.exec(rest)) {
    if (/\.html($|#)/.test(m[1])) throw new Error(`a link to a draft file: ${m[1]}`);
    if (m.index) pieces.push({ text: m.index ? rest.slice(0, m.index) : '' });
    pieces.push({ text: m[2], href: m[1] });
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest) pieces.push({ text: rest });
  const clean = (t) => decode(t.replace(/<[^>]+>/g, ''));
  const out = pieces.map((p) => (p.href ? { text: clean(p.text), href: p.href } : { text: clean(p.text) }));
  return out.every((p) => !p.href) ? out.map((p) => p.text).join('') : out;
}

/** Keys used by one template line, with a map(...) over numbers expanded. */
function keysOf(line) {
  const m = line.match(/\{\[([^\]]+)\]\.map\(\(n\) => <li><Fragment set:html=\{x\('([^']+)' \+ n\)\} \/><\/li>\)\}/);
  if (m) return [...m[1].matchAll(/'([^']+)'/g)].map((n) => m[2] + n[1]);
  return [...line.matchAll(/x\('([^']+)'\)/g)].map((n) => n[1]);
}
const joined = (keys) => text(keys.map(ja).join('<br>'));

function parse(file, h1Key) {
  const src = readFileSync(resolve(SITE, 'components/pages', file), 'utf8');
  const lines = src.split('\n').map((l) => l.trim());
  const blocks = [{ type: 'h1', text: text(ja(h1Key)) }];
  const lists = []; // open lists, innermost last
  let rows = null;
  let dl = null;
  let lastItem = null;
  for (const line of lines) {
    if (rows) {
      if (line.startsWith('<div class="data-row">')) {
        const k = keysOf(line);
        // title, then label/text pairs
        const fields = [];
        for (let i = 1; i + 1 < k.length; i += 2) fields.push({ label: text(ja(k[i])), text: text(ja(k[i + 1])) });
        rows.rows.push({ title: text(ja(k[0])), fields });
        continue;
      }
      if (line === '</div>') { rows = null; continue; }
      continue;
    }
    if (line.startsWith('<div class="divide-y')) {
      rows = { type: 'rows', rows: [] };
      blocks.push(rows);
      continue;
    }
    if (line === '<dl>') { dl = { type: 'dl', items: [] }; blocks.push(dl); continue; }
    if (line === '</dl>') { dl = null; continue; }
    if (dl) {
      const k = keysOf(line);
      if (k.length === 2) dl.items.push({ term: text(ja(k[0])), text: text(ja(k[1])) });
      continue;
    }
    if (/^<h2>/.test(line)) { blocks.push({ type: 'h2', text: text(ja(keysOf(line)[0])) }); continue; }
    if (/^<p class="mt-12/.test(line)) { blocks.push({ type: 'date', text: joined(keysOf(line)) }); continue; }
    if (/^<p>/.test(line)) { blocks.push({ type: 'p', text: joined(keysOf(line)) }); continue; }
    if (/^<(ol|ul)>$/.test(line)) {
      const type = line.slice(1, 3);
      const items = [];
      if (lists.length) {
        // A list inside an item: belongs to that item.
        (lastItem.sub ??= []).push({ type, items });
      } else {
        blocks.push({ type, items });
      }
      lists.push({ items });
      continue;
    }
    if (/^<\/(ol|ul)>$/.test(line)) { lists.pop(); continue; }
    if (lists.length && /^(<li>|\{\[)/.test(line)) {
      const cur = lists[lists.length - 1].items;
      const keys = keysOf(line);
      if (/^\{\[/.test(line)) {
        for (const key of keys) cur.push({ text: text(ja(key)) });
        // The items of the map belong to the list just opened
      } else {
        lastItem = { text: joined(keys) };
        cur.push(lastItem);
      }
      continue;
    }
  }
  return blocks;
}

// The nested list in pv.del.a.6 is written as <li>..<ul>{map}</ul></li>: sub lists need their own items,
// so the generic walker above attaches them through lastItem.sub.
const out = {
  terms: parse('Terms.astro', 'tm.h'),
  privacy: parse('Privacy.astro', 'pv.h'),
};
writeFileSync(resolve(import.meta.dirname, '../src/content/legal.json'), JSON.stringify(out, null, 1) + '\n', 'utf8');
console.log('terms blocks:', out.terms.length, 'privacy blocks:', out.privacy.length);
