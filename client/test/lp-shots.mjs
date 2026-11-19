// Photographs the screens the Tegami website shows (the top page): the chat on a computer,
// and three phone screens of the AI (a chat with the AI, the "send?" check, the group's yes).
//
//   node test/lp-shots.mjs <folder> [dist]
//
// Needs a web build against the dev relay on RELAY_PORT (default 7461), made with
//   EXPO_PUBLIC_TEGAMI_RELAYS=ws://localhost:7461 EXPO_PUBLIC_TEGAMI_FILES=http://localhost:7461
//   EXPO_PUBLIC_TEGAMI_TEST_HOOKS=1 EXPO_PUBLIC_TEGAMI_AI_STAGE=3 npx expo export --platform web --output-dir <dist>
// Everything on screen is made up for the pictures: people are テストA, テストB, テストC and the AI is アシスタント.
// The AI writes through the relay with its own key (a stand-in for tegami-agent), in plain sentences.

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import * as nip19 from 'nostr-tools/nip19';
import * as nip44 from 'nostr-tools/nip44';
import * as nip59 from 'nostr-tools/nip59';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { chromium } from 'playwright-core';
import WebSocket from 'ws';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(process.argv[2] || 'lp-shots');
const DIST = resolve(process.argv[3] || join(ROOT, 'dist-test'));
const RELAY_PORT = Number(process.env.RELAY_PORT || 7461);
const WEB_PORT = Number(process.env.WEB_PORT || 8795);
const ORIGIN = `http://localhost:${WEB_PORT}`;
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
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });

// ---------- helpers (the same ways as test/web.test.mjs) ----------
const text = (p) => p.evaluate(() => document.body.innerText);
const button = (p, name) => p.getByRole('button', { name, exact: true });
async function waitText(p, s) {
  try {
    await p.waitForFunction((s) => document.body.innerText.includes(s), s, { timeout: 15000 });
  } catch {
    throw new Error(`text not shown: ${s} (page: ${(await text(p)).replace(/\s+/g, ' ').slice(0, 200)})`);
  }
}
async function person(name) {
  const context = await browser.newContext({ viewport: { width: 390, height: 760 }, deviceScaleFactor: 2, colorScheme: 'light' });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
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
  const hex = nip19.decode(link.match(/npub1[0-9a-z]+/)[0]).data;
  return { context, page, link, hex };
}
async function befriend(u, other) {
  await u.page.goto(ORIGIN + '/add');
  await waitText(u.page, 'マイQRコード');
  await u.page.getByPlaceholder('https://app.tegami.chat/i#npub…').fill(typeof other === 'string' ? other : other.link);
  await button(u.page, '追加').click();
  await u.page.getByPlaceholder('メッセージ').waitFor();
}
async function befriendMyAi(u, link) {
  await befriend(u, link);
  const hex = nip19.decode(link.match(/npub1[0-9a-z]+/)[0]).data;
  await u.page.goto(`${ORIGIN}/chat/${hex}`);
  await button(u.page, 'メニュー').click();
  await u.page.getByRole('switch', { name: '自分のAI', exact: true }).click();
  await waitText(u.page, 'を自分のAIにしますか？');
  await button(u.page, '自分のAIにする').click();
  await u.page.waitForFunction((h) => JSON.parse(localStorage.getItem('tegami.contacts') || '[]').some((c) => c.pubkey === h && c.mine), hex, { timeout: 10000 });
}
async function say(u, s) {
  await u.page.getByPlaceholder('メッセージ').fill(s);
  await button(u.page, '送る').click();
  await u.page.waitForFunction((t) => JSON.parse(localStorage.getItem('tegami.messages') || '[]').some((m) => m.text === t && !m.pending), s, { timeout: 15000 });
}
const devTrust = (secret) => fetch(`http://localhost:${RELAY_PORT}/_trust`, { method: 'POST', body: JSON.stringify({ pubkey: getPublicKey(secret) }) });
async function relaySend(secret, event) {
  await devTrust(secret);
  return new Promise((ok, fail) => {
    const ws = new WebSocket(`ws://localhost:${RELAY_PORT}`);
    const timer = setTimeout(() => (ws.close(), fail(new Error('relay did not answer'))), 5000);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m[0] === 'AUTH') {
        ws.send(JSON.stringify(['AUTH', finalizeEvent({ kind: 22242, created_at: Math.floor(Date.now() / 1000), tags: [['relay', `ws://localhost:${RELAY_PORT}`], ['challenge', m[1]]], content: '' }, secret)]));
      } else if (m[0] === 'OK' && m[1] !== event.id) {
        ws.send(JSON.stringify(['EVENT', event]));
      } else if (m[0] === 'OK') {
        clearTimeout(timer);
        ws.close();
        m[2] ? ok() : fail(new Error(m[3]));
      }
    });
  });
}
const wrapTo = (secret, to, rumor) => nip59.createWrap(nip59.createSeal(rumor, secret, to), to);
const setPerms = (page, update) =>
  page.evaluate((u) => {
    const s = JSON.parse(localStorage.getItem('tegami.ai.permissions') || '{"all":{},"models":{},"ais":{},"friends":{},"peerAis":{}}');
    for (const [layer, v] of Object.entries(u)) {
      if (layer === 'all') Object.assign(s.all, v);
      else for (const [id, sw] of Object.entries(v)) s[layer][id] = { ...s[layer][id], ...sw };
    }
    localStorage.setItem('tegami.ai.permissions', JSON.stringify(s));
  }, update);

/** A stand-in AI: its own key. `write` puts a plain sentence in the owner's chat; `ask` asks the owner's app to send one. */
async function fakeAi(owner, name, model) {
  const sk = generateSecretKey();
  const hex = getPublicKey(sk);
  await devTrust(sk);
  const link = `${ORIGIN}/i#${nip19.npubEncode(hex)}&n=${encodeURIComponent(name)}&m=${encodeURIComponent(model)}`;
  await befriendMyAi(owner, link);
  const write = (s) => {
    const rumor = nip59.createRumor({ kind: 14, content: s, tags: [['p', owner.hex], ['ai', hex, model, name]] }, sk);
    return relaySend(sk, wrapTo(sk, owner.hex, rumor));
  };
  const ask = async (data) => {
    const now = Math.floor(Date.now() / 1000);
    const rumor = nip59.createRumor({ kind: 25062, content: JSON.stringify({ v: 1, readOthers: false, ...data, n: Math.random() }), tags: [['p', owner.hex]], created_at: now }, sk);
    const seal = nip59.createSeal(rumor, sk, owner.hex);
    const key = generateSecretKey();
    const wrap = finalizeEvent({ kind: 1059, created_at: now, tags: [['p', owner.hex], ['expiration', String(now + 600)]], content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(key, owner.hex)) }, key);
    await relaySend(sk, wrap);
  };
  return { sk, hex, write, ask };
}

const NAME = 'アシスタント';
const MODEL = 'Anthropic Claude';
const shot = async (page, file) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, file) });
  console.log('shot', file);
};

try {
  const a = await person('テストA');
  const b = await person('テストB');
  const c = await person('テストC');
  await befriend(b, a);
  await befriend(a, b);
  await befriend(a, c);
  await befriend(c, a);
  const ai = await fakeAi(a, NAME, MODEL);
  await setPerms(a.page, { all: { read: true, send: true }, friends: { [b.hex]: { send: true } } });

  // The weekend plan with テストB.
  await a.page.goto(`${ORIGIN}/chat/${b.hex}`);
  await say(b, '週末、どこか出かけない？');
  await waitText(a.page, '週末、どこか出かけない？');
  await say(a, 'いいね。土曜なら空いてるよ');
  await waitText(b.page, '土曜なら空いてるよ');
  await say(b, 'じゃあ土曜の午前にしよう。何時がいい？');
  await waitText(a.page, '何時がいい？');
  await say(c, '来週のごはん、あとで決めよう');

  // A chat with the AI.
  await a.page.goto(`${ORIGIN}/chat/${ai.hex}`);
  await say(a, 'テストBに、土曜の待ち合わせの時間を提案しておいて');
  await ai.write('わかりました。午前10時でどうでしょう。送る前に確認しますね。');
  await waitText(a.page, '送る前に確認しますね');
  await shot(a.page, 'phone-ai-chat.png');

  // The AI wants to send: the message waits for 送る, with the friend and the words shown.
  await ai.ask({ to: b.hex, text: '土曜の午前10時でどう？' });
  await a.page.getByTestId('ai-proposal').waitFor({ timeout: 15000 });
  await waitText(a.page, 'アシスタントが送ろうとしています');
  await shot(a.page, 'phone-ai-send.png');
  await button(a.page, '送る').click();
  await waitText(b.page, '土曜の午前10時でどう？');
  await b.page.goto(`${ORIGIN}/chat/${a.hex}`);
  await waitText(b.page, '土曜の午前10時でどう？');
  await say(b, '10時で大丈夫。駅前のカフェで待ち合わせにしよう');
  await a.page.goto(`${ORIGIN}/chat/${b.hex}`);
  await waitText(a.page, '駅前のカフェ');

  // A group, and its owner calls the AI: the other members are asked.
  await a.page.goto(`${ORIGIN}/`);
  await button(a.page, '友だち').click();
  await a.page.getByText('グループを作る').click();
  await a.page.getByPlaceholder('グループの名前').fill('週末の予定');
  await a.page.getByRole('checkbox', { name: 'テストB' }).click();
  await a.page.getByRole('checkbox', { name: 'テストC' }).click();
  await button(a.page, '作る').click();
  await a.page.getByPlaceholder('メッセージ').fill('土曜、みんなでごはんに行かない？');
  await button(a.page, '送る').click();
  for (const u of [b, c]) {
    await u.page.goto(`${ORIGIN}/`);
    await waitText(u.page, '週末の予定');
    await u.page.getByText('週末の予定').click();
    await waitText(u.page, '土曜、みんなでごはんに行かない？');
  }
  await say(b, 'いいね、行きたい！');
  await waitText(a.page, 'いいね、行きたい！');
  await button(a.page, 'その他').click();
  await button(a.page, `${NAME}をグループに招待`).click();
  await waitText(a.page, `${NAME}をこのグループに招待しますか？`);
  await button(a.page, '招待').click();
  await waitText(b.page, `テストAが${NAME}（${MODEL}）を招待しています`);
  await waitText(b.page, '同意 1/3人');
  await shot(b.page, 'phone-ai-consent.png');

  // The computer screen: the chat with テストB, light and dark.
  await a.page.setViewportSize({ width: 1440, height: 900 });
  await a.page.goto(`${ORIGIN}/chat/${b.hex}`);
  await waitText(a.page, '駅前のカフェ');
  await a.page.reload();
  await waitText(a.page, '駅前のカフェ');
  await shot(a.page, 'pc-chat-light.png');
  await a.page.emulateMedia({ colorScheme: 'dark' });
  await shot(a.page, 'pc-chat-dark.png');
  console.log('page text (pc):', (await text(a.page)).replace(/\s+/g, ' ').slice(0, 400));
} finally {
  await browser.close();
  server.close();
  relay.kill();
}
