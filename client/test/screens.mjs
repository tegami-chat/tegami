// Photographs the main screens at a chosen window size, for reviewing the layout.
//
//   node test/screens.mjs <folder> [width] [height] [dark]
//
// Builds nothing: run `npm run test:web` once first, so dist-test exists,
// built against the dev relay on RELAY_PORT (default 7448, as the tests).

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist-test');
const RELAY_PORT = Number(process.env.RELAY_PORT || 7448);
const WEB_PORT = Number(process.env.WEB_PORT || 8778);
const ORIGIN = `http://localhost:${WEB_PORT}`;
const OUT = resolve(process.argv[2] || 'shots');
const W = Number(process.argv[3] || 1440);
const H = Number(process.argv[4] || 900);
const DARK = process.argv[5] === 'dark';
mkdirSync(OUT, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
  let file = join(DIST, path);
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(WEB_PORT, ok));
const relay = spawn(process.execPath, ['dev/relay.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(RELAY_PORT) }, stdio: 'ignore' });
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`http://localhost:${RELAY_PORT}/`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const text = (p) => p.evaluate(() => document.body.innerText);
const button = (p, name) => p.getByRole('button', { name, exact: true });
async function waitText(p, s) {
  await p.waitForFunction((s) => document.body.innerText.includes(s), s, { timeout: 15000 });
}
async function person(name) {
  const context = await browser.newContext({ viewport: { width: W, height: H }, colorScheme: DARK ? 'dark' : 'light' });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: false },
  });
  await page.goto(ORIGIN + '/');
  await button(page, 'はじめる').click();
  await button(page, 'パスキーを使わずに始める').click();
  await page.waitForSelector('[aria-label="友だち追加"]', { timeout: 15000 });
  await page.goto(ORIGIN + '/add');
  await waitText(page, 'マイQRコード');
  await page.getByPlaceholder('自分の名前').fill(name);
  const link = (await text(page)).match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0];
  return { context, page, link };
}
async function befriend(u, other) {
  await u.page.goto(ORIGIN + '/add');
  await waitText(u.page, 'マイQRコード');
  await u.page.getByPlaceholder('https://app.tegami.chat/i#npub…').fill(other.link);
  await button(u.page, '追加').click();
  await u.page.getByPlaceholder('メッセージ').waitFor();
}
async function send(u, s) {
  await u.page.getByPlaceholder('メッセージ').fill(s);
  await button(u.page, '送る').click();
  await waitText(u.page, s);
}
let n = 0;
async function shot(page, name) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`) });
}

try {
  const a = await person('テストA');
  const b = await person('テストB');
  const c = await person('テストC');
  await befriend(b, a);
  await befriend(a, b);
  await befriend(a, c);
  await befriend(c, a);
  await send(b, 'おはよう。今日の夕方、駅まで迎えに来られる？');
  await send(a, '行けるよ。18時でいい？');
  await send(b, 'ありがとう、18時でお願い');
  await send(c, '週末の予定どうする？');
  await a.page.goto(ORIGIN + '/');
  await a.page.waitForSelector('[aria-label="友だち追加"]');
  await waitText(a.page, 'テストB');
  await shot(a.page, 'list');
  await a.page.getByText('テストB', { exact: true }).first().click();
  await waitText(a.page, '18時でお願い');
  await shot(a.page, 'chat');
  await button(a.page, 'メニュー').click().catch(() => {});
  await shot(a.page, 'chat-info');
  await a.page.goto(ORIGIN + '/');
  await a.page.waitForSelector('[aria-label="友だち追加"]');
  await button(a.page, '友だち').click();
  await shot(a.page, 'friends');
  await a.page.goto(ORIGIN + '/settings');
  await waitText(a.page, 'アカウント');
  await shot(a.page, 'settings');
  for (const [path, word, name] of [
    ['/settings/profile', '自分の名前', 'settings-profile'],
    ['/settings/account', 'アカウントの守り方', 'settings-account'],
    ['/settings/privacy', 'ブロックリスト', 'settings-privacy'],
    ['/settings/talk', '未読数を表示', 'settings-talk'],
    ['/ai', '相手のAI', 'settings-ai'],
  ]) {
    await a.page.goto(ORIGIN + path);
    await waitText(a.page, word);
    await shot(a.page, name);
  }
  await a.page.goto(ORIGIN + '/add');
  await waitText(a.page, 'マイQRコード');
  await shot(a.page, 'add');
  await a.page.goto(ORIGIN + '/group');
  await shot(a.page, 'group');
} finally {
  await browser.close();
  server.close();
  relay.kill();
}
console.log(`saved ${n} screenshots to ${OUT}`);
