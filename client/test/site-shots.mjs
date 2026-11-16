// Photographs tegami.chat pages from a running local copy (npx wrangler@4 dev --port 8790 in website/).
//
//   node test/site-shots.mjs <folder> [base]
//
// Each page is taken at phone width (390) and computer width (1280), in Japanese, light.
// The animation is frozen near the end of its first scene so every picture shows the full scene.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const OUT = resolve(process.argv[2] || 'site-shots');
const BASE = process.argv[3] || 'http://127.0.0.1:8790';
mkdirSync(OUT, { recursive: true });
const PAGES = [['index', '/ja/'], ['features', '/ja/features'], ['how', '/ja/how'], ['developers', '/ja/developers'], ['dev-protocol', '/ja/developers/protocol'], ['faq', '/ja/faq'], ['index-en', '/']];
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
for (const [w, tag] of [[390, 'phone'], [1280, 'pc']]) {
  const page = await browser.newPage({ viewport: { width: w, height: 900 }, colorScheme: 'light', deviceScaleFactor: 1 });
  for (const [name, path] of PAGES) {
    await page.goto(BASE + path, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    await page.evaluate(() => document.getElementById('diff')?.scrollIntoView());
    await page.waitForTimeout(500);
    await page.evaluate(() => window.tegamiFreeze?.(0.9));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(OUT, `${name}_${tag}.png`), fullPage: true, type: 'png' });
  }
  // the phone menu, open
  if (w < 500) {
    await page.goto(BASE + '/ja/', { waitUntil: 'load' });
    await page.click('[data-menu] summary');
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(OUT, 'menu_phone.png'), type: 'png' });
  }
  await page.close();
}
await browser.close();
console.log('saved to', OUT);
