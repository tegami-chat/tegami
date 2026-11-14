// Builds every app icon file from one glyph (envelope bubble, tail at the lower left).
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
const root = process.argv[2];
const P = '#f4f1e8', G = '#1d6b4b', FLAP = '#bbd3c9';  // the flap: the colour of ".chat" on the business card (white at 70% over the green)
// The glyph in a 512 box, computed from the body's size so the proportions can be tuned in one
// place. Sized like other messaging apps (2026-11-14): the whole glyph about 68% of the icon's
// width, the body 1.2 : 1 (LINE's glyph is 0.67 wide, Google Chat's 0.76).
const W = 300, H = 250, R = 58;                 // body width, height, corner radius
const x0 = 256 - W / 2, x1 = 256 + W / 2, y0 = 112, y1 = y0 + H;
const body = `M${x0 + R} ${y0} H${x1 - R} Q${x1} ${y0} ${x1} ${y0 + R} V${y1 - R} Q${x1} ${y1} ${x1 - R} ${y1} H${x0 + R} Q${x0} ${y1} ${x0} ${y1 - R} V${y0 + R} Q${x0} ${y0} ${x0 + R} ${y0} Z`;
// The flap: a lighter face from the top corners to a rounded point a little below the middle.
const ay = y0 + 0.58 * H;
const flap = `M${x0} ${y0 + 20} Q${x0 + 4} ${y0 + 4} ${x0 + 20} ${y0 + 1} L${x1 - 20} ${y0 + 1} Q${x1 - 4} ${y0 + 4} ${x1} ${y0 + 20} L${256 + 26} ${ay - 20} Q256 ${ay} ${256 - 26} ${ay - 20} Z`;
// A short tail from the bottom edge near the lower left corner, with a slight neck (option D).
const tx = x0 + 32, ty = y1;
const tail = `M${tx} ${ty - 6} Q${tx + 8} ${ty + 14} ${tx - 4} ${ty + 36} Q${tx - 12} ${ty + 50} ${tx + 4} ${ty + 46} Q${tx + 54} ${ty + 30} ${tx + 94} ${ty - 4} Z`;
// Where the glyph sits: halfway between the body's centre and the centre of the whole box (body top
// to tail tip). The thin tail weighs little, so centring the box left empty space under the body.
const CX = 256, CY = ((y0 + y1) / 2 + (y0 + ty + 50) / 2) / 2;
const glyph = (scale, id, mono = false) =>
  `<g transform="translate(512 512) scale(${scale}) translate(${-CX} ${-CY})">` +
  (mono
    ? `<path d="${body}" fill="#fff"/><path d="${tail}" fill="#fff"/>`
    : `<defs><clipPath id="${id}"><path d="${body}"/></clipPath></defs><path d="${body}" fill="${G}"/><path d="${tail}" fill="${G}"/><path clip-path="url(#${id})" d="${flap}" fill="${FLAP}"/>`) +
  `</g>`;
const svg = (inner, bg = true) => `<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">${bg ? `<rect width="1024" height="1024" fill="${P}"/>` : ''}${inner}</svg>`;
// Square icons (iOS, web): the glyph about 68% wide, inside Apple's safe margins.
const main = svg(glyph(2.27, 'b'));
// Android adaptive foreground: everything inside the 66/108 safe circle (diameter 626 px of 1024).
const fg = svg(glyph(1.47, 'f'), false);
const mono = svg(glyph(1.47, 'm', true), false);
const bgOnly = svg('');
// Splash: the glyph alone on transparent, the splash colour comes from app.json.
const splash = svg(glyph(2.0, 's'), false);
writeFileSync(`${root}/assets/images/tegami-icon.svg`, main);
writeFileSync(`${root}/assets/images/tegami-glyph.json`, JSON.stringify({ body, flap, tail, cx: CX, cy: CY, iconScale: 2.27 / 2 }));
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
