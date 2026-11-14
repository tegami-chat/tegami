// Builds every app icon file from one glyph (envelope bubble, tail at the lower left).
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
const root = process.argv[2];
const P = '#f4f1e8', G = '#1d6b4b', FLAP = '#3f8a67';
// The glyph in a 512 box (body 100..412 x 112..358, tail down to y≈400).
const body = 'M156 112 H356 Q412 112 412 168 V302 Q412 358 356 358 H156 Q100 358 100 302 V168 Q100 112 156 112 Z';
const flap = 'M100 132 Q104 116 120 113 L392 113 Q408 116 412 132 L282 234 Q256 254 230 234 Z';
// Grows out of the left side: the outer edge carries the body's left edge down, so there is no notch.
const tail = 'M100 290 C100 330 108 346 118 360 C128 374 128 386 123 394 Q117 403 132 400 C166 392 194 374 220 356 L220 290 Z';
// Visual centre of the glyph's box (x 100..412, y 112..402).
const CX = 256, CY = 257;
const glyph = (scale, id, mono = false) =>
  `<g transform="translate(512 512) scale(${scale}) translate(${-CX} ${-CY})">` +
  (mono
    ? `<path d="${body}" fill="#fff"/><path d="${tail}" fill="#fff"/>`
    : `<defs><clipPath id="${id}"><path d="${body}"/></clipPath></defs><path d="${body}" fill="${G}"/><path d="${tail}" fill="${G}"/><path clip-path="url(#${id})" d="${flap}" fill="${FLAP}"/>`) +
  `</g>`;
const svg = (inner, bg = true) => `<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">${bg ? `<rect width="1024" height="1024" fill="${P}"/>` : ''}${inner}</svg>`;
// Square icons (iOS, web): the glyph about 61% wide, inside Apple's safe margins.
const main = svg(glyph(2.0, 'b'));
// Android adaptive foreground: everything inside the 66/108 safe circle (diameter 626 px of 1024).
const fg = svg(glyph(1.47, 'f'), false);
const mono = svg(glyph(1.47, 'm', true), false);
const bgOnly = svg('');
// Splash: the glyph alone on transparent, the splash colour comes from app.json.
const splash = svg(glyph(2.0, 's'), false);
writeFileSync(`${root}/assets/images/tegami-icon.svg`, main);
const out = [
  [main, 'assets/images/icon.png', 1024, false],
  [main, 'assets/images/favicon.png', 48, false],
  [main, 'public/apple-touch-icon.png', 180, false],
  [main, 'public/icon-192.png', 192, false],
  [main, 'public/icon-512.png', 512, false],
  [fg, 'assets/images/android-icon-foreground.png', 512, true],
  [bgOnly, 'assets/images/android-icon-background.png', 512, false],
  [mono, 'assets/images/android-icon-monochrome.png', 432, true],
  [splash, 'assets/images/splash-icon.png', 512, true],
];
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
for (const [s, file, size, transparent] of out) {
  const p = await b.newPage({ viewport: { width: size, height: size } });
  await p.setContent(`<html><body style="margin:0;background:transparent">${s.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await p.screenshot({ path: `${root}/${file}`, omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
  await p.close();
}
await b.close();
console.log('made', out.length, 'files');
