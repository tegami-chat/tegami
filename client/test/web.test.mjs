// End-to-end tests for starting and opening a Tegami account in a real browser.
//
// Chrome is driven by Playwright. Passkeys come from Chrome's virtual authenticator
// (DevTools WebAuthn domain), so no real passkey is created. Behaviour of providers
// that the virtual authenticator cannot imitate (a password manager that returns no
// PRF result, a cancelled prompt) is reproduced by wrapping navigator.credentials.
//
// Run:  npm run test:web
// Needs Google Chrome installed. Set CHROME_PATH to use another Chromium build.

import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import * as nip19 from 'nostr-tools/nip19';
import * as nip44 from 'nostr-tools/nip44';
import * as nip59 from 'nostr-tools/nip59';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { chromium } from 'playwright-core';
import WebSocket from 'ws';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist-test');
// Ports can be moved when another copy of these tests runs at the same time.
const RELAY_PORT = Number(process.env.RELAY_PORT || 7448);
const WEB_PORT = Number(process.env.WEB_PORT || 8766);
const ORIGIN = `http://localhost:${WEB_PORT}`;
// "Tegamiへの意見" goes to this key in the test build (the official account's key otherwise).
const FEEDBACK_SK = new Uint8Array(32).fill(7);
const FEEDBACK_HEX = getPublicKey(FEEDBACK_SK);
const CHROME =
  process.env.CHROME_PATH ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ].find((p) => existsSync(p));

// ---------- setup ----------

function sh(cmd, args, env) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'inherit', shell: true });
    p.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} ${args.join(' ')} exited ${code}`))));
  });
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.ttf': 'font/ttf' };
function serve() {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
    let file = join(DIST, path);
    if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(WEB_PORT, () => ok(server)));
}

// ---------- helpers ----------

/** Options for Chrome's virtual authenticator. */
const AUTH = { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true };

/**
 * Wraps navigator.credentials in the page to imitate providers.
 *   stripCreatePrf: 'results' removes the PRF output at create (provider returns it only on use)
 *                   'all'     removes the PRF extension result entirely (provider ignores PRF)
 *   failCreate / failGet:     throw NotAllowedError (user cancelled, or provider cannot find the passkey)
 *   noWebAuthn:               the browser has no WebAuthn at all
 */
function wrapper(opts) {
  return `(() => {
    window.__wrap = ${JSON.stringify(opts)};
    window.__calls = { create: 0, get: 0 };
    if (window.__wrap.noWebAuthn) { delete window.PublicKeyCredential; return; }
    const c = navigator.credentials;
    const create = c.create.bind(c), get = c.get.bind(c);
    const deny = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
    c.create = async (args) => {
      const o = window.__wrap;
      window.__calls.create++;
      if (o.failCreate) return deny();
      const cred = await create(args);
      if (!o.stripCreatePrf) return cred;
      const ext = cred.getClientExtensionResults();
      const out = { ...ext };
      if (o.stripCreatePrf === 'all') delete out.prf; else out.prf = { enabled: true };
      cred.getClientExtensionResults = () => out;
      return cred;
    };
    c.get = async (args) => {
      const o = window.__wrap;
      window.__calls.get++;
      if (o.failGet) return deny();
      return get(args);
    };
  })();`;
}

// Records every peer connection and every event the page sends, for the call tests.
const RECORDER = `(() => {
  window.__pcs = [];
  const PC = window.RTCPeerConnection;
  if (PC) {
    window.RTCPeerConnection = function (...a) { const pc = new PC(...a); window.__pcs.push(pc); return pc; };
    window.RTCPeerConnection.prototype = PC.prototype;
  }
  window.__sent = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) {
    try { const m = JSON.parse(d); if (m[0] === 'EVENT') window.__sent.push(m[1]); } catch {}
    return send.call(this, d);
  };
})();`;

// SHOTS=<folder> saves screenshots of the screens new words appear on (for reviewing the
// wording before a release), with a shots.json that says what each one shows.
const SHOTS = process.env.SHOTS;
// --narrow runs every test in a phone-sized window (the one-column screens); without it the
// window is 1280 wide (the desktop layout: rail, chat list and the open chat side by side).
const NARROW = process.argv.includes('--narrow') || !!SHOTS;
const shotList = [];
async function shot(page, name, note) {
  if (!SHOTS) return;
  await page.waitForTimeout(400);
  const file = `${String(shotList.length + 1).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: join(SHOTS, file) });
  shotList.push({ file, note });
}
/** A browser dialog (confirm) cannot be photographed: its words are kept instead. */
function shotDialog(name, message, note) {
  if (SHOTS) shotList.push({ dialog: message, name, note });
}

/**
 * Desktop layout: the chat list stays on screen beside the open chat, so a message or a name can
 * be both in a list row (its preview) and in the open screen. The list comes first in the page,
 * so the tests' text lookups take the last match: the one on the open screen.
 */
function preferOpenScreen(page) {
  const find = page.getByText.bind(page);
  page.getByText = (...args) => find(...args).last();
}

async function newUser(browser, { prf = true, wrap = {}, authenticator = true } = {}) {
  const context = await browser.newContext(
    SHOTS ? { viewport: { width: 390, height: 760 }, deviceScaleFactor: 2 } : NARROW ? { viewport: { width: 390, height: 760 } } : { viewport: { width: 1280, height: 800 } },
  );
  await context.addInitScript(wrapper(wrap));
  await context.addInitScript(RECORDER);
  const page = await context.newPage();
  if (!NARROW) preferOpenScreen(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  let authenticatorId = null;
  if (authenticator) ({ authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { ...AUTH, hasPrf: prf } }));
  page.on('pageerror', (e) => console.log('    page error:', e.message));  await page.goto(ORIGIN + '/');
  return { context, page, cdp, authenticatorId };
}

const text = (page) => page.evaluate(() => document.body.innerText);
const storage = (page) => page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
const calls = (page) => page.evaluate(() => window.__calls);
const button = (page, name) => page.getByRole('button', { name, exact: true });
/** Opens settings: the header link on a phone, the gear on the rail on a desktop (both are buttons named 設定). */
const openSettings = async (page, part) => {
  await button(page, '設定').click();
  // A row of the top list (the rail on a wide screen has buttons of its own: the page's is last).
  if (part) await page.getByRole('button', { name: part, exact: true }).last().click();
};
/** Where the person's details are: a screen of their own on a phone, a column beside the chat on a desktop. */
const infoArea = (page) => (NARROW ? page : page.getByRole('complementary'));
/** Leaves the person's details: back on a phone, the close button of the column on a desktop. */
const closeInfo = (page) => button(page, NARROW ? '戻る' : '閉じる').click();

async function waitOpen(page) {
  await page.waitForFunction(() => {
    const t = document.body.innerText;
    return !!document.querySelector('[aria-label="友だち追加"]') && !t.includes('はじめる') && !t.includes('ひらく');
  }, null, { timeout: 15000 }).catch(async () => {
    throw new Error(`account did not open (page: ${(await text(page)).replace(/\s+/g, ' ').slice(0, 160)})`);
  });
}
/** The moving link's key leaves the address bar (within a moment of loading). */
async function keyLeavesAddressBar(page) {
  for (let i = 0; i < 30; i++) {
    if (!page.url().includes('k=')) return true;
    await page.waitForTimeout(100);
  }
  return false;
}
async function waitText(page, s) {
  try {
    await page.waitForFunction((s) => document.body.innerText.includes(s), s, { timeout: 15000 });
  } catch {
    throw new Error(`text not shown: ${s} (page: ${(await text(page)).replace(/\s+/g, ' ').slice(0, 160)})`);
  }
}
/** No 64-character hex string (a raw secret key) anywhere in localStorage. */
async function noRawKey(page) {
  const all = JSON.stringify(await storage(page));
  return !/"secretHex"/.test(all);
}

// ---------- calls ----------

/** Someone who starts without a passkey (fast) and has a name on their invite link. */
async function person(browser, name) {
  const u = await newUser(browser, { prf: false });
  await button(u.page, 'はじめる').click();
  await button(u.page, 'パスキーを使わずに始める').click();
  await waitOpen(u.page);
  await u.page.goto(ORIGIN + '/add');
  await waitText(u.page, 'マイQRコード');
  await u.page.getByPlaceholder('自分の名前').fill(name);
  u.link = (await text(u.page)).match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0];
  u.hex = nip19.decode(u.link.match(/npub1[0-9a-z]+/)[0]).data;
  return u;
}
/** u adds other (a person or an invite link) as a friend and ends up in the chat with them. */
async function befriend(u, other) {
  await u.page.goto(ORIGIN + '/add');
  await waitText(u.page, 'マイQRコード');
  await u.page.getByPlaceholder('https://app.tegami.chat/i#npub…').fill(typeof other === 'string' ? other : other.link);
  await button(u.page, '追加').click();
  await u.page.getByPlaceholder('メッセージ').waitFor();
}
/** u marks a friend as their own AI: the switch 自分のAI in the chat's info, and its confirm. */
async function markMyAi(u, hex, shotName) {
  await u.page.goto(`${ORIGIN}/chat/${hex}`);
  await button(u.page, 'メニュー').click();
  await u.page.getByRole('switch', { name: '自分のAI', exact: true }).click();
  await waitText(u.page, 'を自分のAIにしますか？');
  if (shotName) await shot(u.page, shotName, '自分のAIにする前の確認');
  await button(u.page, '自分のAIにする').click();
  await u.page.waitForFunction((h) => JSON.parse(localStorage.getItem('tegami.contacts') || '[]').some((c) => c.pubkey === h && c.mine), hex, { timeout: 10000 });
}
/** u adds an AI by its invite link and marks it as their own AI. */
async function befriendMyAi(u, link) {
  await befriend(u, link);
  await markMyAi(u, nip19.decode(link.match(/npub1[0-9a-z]+/)[0]).data);
}
const pcState = (page) => page.evaluate(() => window.__pcs.map((p) => p.connectionState));
async function waitConnected(page) {
  try {
    await page.waitForFunction(() => window.__pcs.some((p) => p.connectionState === 'connected'), null, { timeout: 20000 });
  } catch {
    throw new Error(`not connected: ${JSON.stringify(await pcState(page))}`);
  }
}
async function noText(page, s, ms) {
  await page.waitForTimeout(ms);
  assert(!(await text(page)).includes(s), `"${s}" is shown`);
}

/** Registers `secret` with the dev relay as if invited (so it may write). */
const devTrust = (secret) =>
  fetch(`http://localhost:${RELAY_PORT}/_trust`, { method: 'POST', body: JSON.stringify({ pubkey: getPublicKey(secret) }) });
/** From now on, keys that register without an invite are open keys (true), or invited (false). */
const devOpen = (on) => fetch(`http://localhost:${RELAY_PORT}/_open`, { method: 'POST', body: JSON.stringify({ on }) });
/** Sends one event to the dev relay as `secret` (logs in with NIP-42 first; registers it as invited). */
async function relaySend(secret, event) {
  await devTrust(secret);
  return new Promise((ok, fail) => {
    const ws = new WebSocket(`ws://localhost:${RELAY_PORT}`);
    const timer = setTimeout(() => (ws.close(), fail(new Error('relay did not answer'))), 5000);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m[0] === 'AUTH') {
        const auth = finalizeEvent(
          { kind: 22242, created_at: Math.floor(Date.now() / 1000), tags: [['relay', `ws://localhost:${RELAY_PORT}`], ['challenge', m[1]]], content: '' },
          secret,
        );
        ws.send(JSON.stringify(['AUTH', auth]));
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
/** A call signal from `secret` to `to`, written `age` seconds ago, in an envelope the relay still hands out. */
function signalFrom(secret, to, data, age = 0) {
  const now = Math.floor(Date.now() / 1000);
  const rumor = nip59.createRumor({ kind: 25050, content: JSON.stringify(data), tags: [['p', to]], created_at: now - age }, secret);
  const seal = nip59.createSeal(rumor, secret, to);
  const k = generateSecretKey();
  return finalizeEvent(
    {
      kind: 1059,
      created_at: now,
      tags: [['p', to], ['expiration', String(now + 60)]],
      content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(k, to)),
    },
    k,
  );
}

// ---------- the dev relay (stopped and started again by the outbox tests) ----------

let relay = null;
async function startRelay() {
  relay = spawn(process.execPath, ['dev/relay.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(RELAY_PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://localhost:${RELAY_PORT}/`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the dev relay did not start');
}
async function stopRelay() {
  const r = relay;
  relay = null;
  if (!r || r.exitCode !== null) return;
  await new Promise((ok) => {
    r.once('exit', ok);
    r.kill();
  });
}
/** Every envelope on the dev relay addressed to this pubkey (read with a throwaway login). */
function envelopesFor(hex) {
  const secret = generateSecretKey();
  return new Promise((ok, fail) => {
    const ws = new WebSocket(`ws://localhost:${RELAY_PORT}`);
    const found = [];
    const timer = setTimeout(() => (ws.close(), fail(new Error('relay did not answer'))), 5000);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m[0] === 'AUTH') {
        const auth = finalizeEvent(
          { kind: 22242, created_at: Math.floor(Date.now() / 1000), tags: [['relay', `ws://localhost:${RELAY_PORT}`], ['challenge', m[1]]], content: '' },
          secret,
        );
        ws.send(JSON.stringify(['AUTH', auth]));
      } else if (m[0] === 'OK') {
        ws.send(JSON.stringify(['REQ', 'q', { kinds: [1059], '#p': [hex] }]));
      } else if (m[0] === 'EVENT') {
        found.push(m[2]);
      } else if (m[0] === 'EOSE') {
        clearTimeout(timer);
        ws.close();
        ok(found);
      }
    });
  });
}
const unreadBadges = (page) => page.locator('[data-testid="unread"]');
/** A chat message (kind 14) from `secret` to `to`, as another Nostr app would write it. */
function rumorTo(secret, to, content, tags = [], created_at = Math.floor(Date.now() / 1000)) {
  return nip59.createRumor({ kind: 14, content, tags: [['p', to], ...tags], created_at }, secret);
}
function wrapTo(secret, to, rumor) {
  return nip59.createWrap(nip59.createSeal(rumor, secret, to), to);
}
/** Every message the dev relay holds for `secret`, opened. Waits until `ready(messages)`. */
async function inboxOf(secret, ready = () => true) {
  const me = getPublicKey(secret);
  for (let i = 0; i < 50; i++) {
    const wraps = await new Promise((ok, fail) => {
      const ws = new WebSocket(`ws://localhost:${RELAY_PORT}`);
      const got = [];
      const timer = setTimeout(() => (ws.close(), fail(new Error('relay did not answer'))), 5000);
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m[0] === 'AUTH') {
          const auth = finalizeEvent(
            { kind: 22242, created_at: Math.floor(Date.now() / 1000), tags: [['relay', `ws://localhost:${RELAY_PORT}`], ['challenge', m[1]]], content: '' },
            secret,
          );
          ws.send(JSON.stringify(['AUTH', auth]));
        } else if (m[0] === 'OK') {
          ws.send(JSON.stringify(['REQ', 'inbox', { kinds: [1059], '#p': [me] }]));
        } else if (m[0] === 'EVENT') {
          got.push(m[2]);
        } else if (m[0] === 'EOSE') {
          clearTimeout(timer);
          ws.close();
          ok(got);
        }
      });
    });
    const opened = wraps.flatMap((w) => {
      try {
        return [nip59.unwrapEvent(w, secret)];
      } catch {
        return [];
      }
    });
    if (ready(opened)) return opened;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('the messages did not reach the relay');
}

// ---------- tests ----------

const results = [];
async function test(name, fn) {
  // ONLY=<part of a name> runs just the matching tests.
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  try {
    await fn();
    results.push([name, true]);
    console.log(`  ok    ${name}`);
  } catch (e) {
    results.push([name, false]);
    console.log(`  FAIL  ${name}\n        ${e.message.split('\n').slice(0, process.env.ONLY ? 8 : 1).join('\n        ')}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  if (!CHROME) throw new Error('Google Chrome not found. Set CHROME_PATH.');
  console.log(NARROW ? 'window: 390 x 760 (phone layout)' : 'window: 1280 x 800 (desktop layout)');
  if (!process.env.SKIP_BUILD && !process.argv.includes('--skip-build')) {
    await sh('npx', ['expo', 'export', '--platform', 'web', '--output-dir', 'dist-test', '--clear'], {
      EXPO_PUBLIC_TEGAMI_RELAYS: `ws://localhost:${RELAY_PORT}`,
      EXPO_PUBLIC_TEGAMI_FILES: `http://localhost:${RELAY_PORT}`,
      EXPO_PUBLIC_TURNSTILE_SITEKEY: '',
      EXPO_PUBLIC_TEGAMI_TEST_HOOKS: '1',
      // Every AI stage open, so the tests reach sending without asking, other AIs and AI in a
      // group (the app itself works at stage 2: lib/ai-permissions.ts AI_STAGE).
      EXPO_PUBLIC_TEGAMI_AI_STAGE: '3',
      EXPO_PUBLIC_TEGAMI_FEEDBACK: FEEDBACK_HEX,
    });
  }
  await startRelay();
  const server = await serve();
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: !process.env.HEADED,
    // Calls: a fake camera and microphone, allowed without asking.
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });

  try {
    await test('PRF at create: starts with one prompt, reopens with the passkey', async () => {
      const u = await newUser(browser);
      await button(u.page, 'はじめる').click();
      await waitOpen(u.page);
      const s = await storage(u.page);
      assert(s['tegami.vault'] && !s['tegami.device'], 'expected a passkey vault only');
      assert(await noRawKey(u.page), 'raw key found in storage');
      const c = await calls(u.page);
      assert(c.create === 1 && c.get === 0, `prompts: ${JSON.stringify(c)}`);
      await u.page.reload();
      await button(u.page, 'ひらく').click();
      await waitOpen(u.page);
      await u.context.close();
    });

    await test('PRF only on use: asks a second time, then starts', async () => {
      const u = await newUser(browser, { wrap: { stripCreatePrf: 'results' } });
      await button(u.page, 'はじめる').click();
      await waitOpen(u.page);
      const c = await calls(u.page);
      assert(c.create === 1 && c.get === 1, `prompts: ${JSON.stringify(c)}`);
      assert((await storage(u.page))['tegami.vault'], 'no passkey vault');
      await u.context.close();
    });

    await test('No PRF (enabled: false): offers retry and starting without a passkey', async () => {
      const u = await newUser(browser, { prf: false });
      await button(u.page, 'はじめる').click();
      await waitText(u.page, 'このパスキーの保存先では、鍵を守れませんでした');
      assert(await button(u.page, '保存先を選び直す').isVisible(), 'no retry button');
      await button(u.page, 'パスキーを使わずに始める').click();
      await waitOpen(u.page);
      const s = await storage(u.page);
      assert(s['tegami.device'] && !s['tegami.vault'] && !s['tegami.account'], `storage: ${Object.keys(s)}`);
      assert(await noRawKey(u.page), 'raw key found in storage');
      const npub = await u.page.evaluate(() => localStorage.getItem('tegami.device'));
      await u.page.reload();
      await waitOpen(u.page); // opens without any prompt
      assert((await u.page.evaluate(() => localStorage.getItem('tegami.device'))) === npub, 'device vault changed');
      await u.context.close();
    });

    await test('Password manager without PRF (no result, passkey not offered back): no silent failure', async () => {
      const u = await newUser(browser, { wrap: { stripCreatePrf: 'all', failGet: true } });
      await button(u.page, 'はじめる').click();
      await waitText(u.page, 'このパスキーの保存先では、鍵を守れませんでした');
      assert(await button(u.page, '保存先を選び直す').isVisible(), 'no retry button');
      assert(!(await storage(u.page))['tegami.vault'], 'a vault was saved anyway');
      await u.context.close();
    });

    await test('Retry after a failed provider: choosing another store works', async () => {
      const u = await newUser(browser, { wrap: { stripCreatePrf: 'all', failGet: true } });
      await button(u.page, 'はじめる').click();
      await waitText(u.page, '保存先を選び直す');
      // The person now picks the browser's own passkey store: lift the imitation.
      await u.page.evaluate(() => (window.__wrap = {}));
      await button(u.page, '保存先を選び直す').click();
      await waitOpen(u.page);
      assert((await storage(u.page))['tegami.vault'], 'no passkey vault after retry');
      await u.context.close();
    });

    await test('Cancel at create: stays on the start screen without a message', async () => {
      const u = await newUser(browser, { wrap: { failCreate: true } });
      await button(u.page, 'はじめる').click();
      await u.page.waitForTimeout(500);
      const t = await text(u.page);
      assert(t.includes('はじめる') && !t.includes('鍵を守れ') && !t.includes('使えませんでした'), `screen: ${t}`);
      await u.context.close();
    });

    await test('No WebAuthn: starts without a passkey, no retry offered', async () => {
      const u = await newUser(browser, { wrap: { noWebAuthn: true }, authenticator: false });
      await button(u.page, 'はじめる').click();
      await waitText(u.page, 'このブラウザはパスキーを使えません');
      assert(!(await button(u.page, '保存先を選び直す').count()), 'retry shown without WebAuthn');
      await button(u.page, 'パスキーを使わずに始める').click();
      await waitOpen(u.page);
      assert((await storage(u.page))['tegami.device'], 'no device vault');
      await u.context.close();
    });

    await test('Passkey not found when opening: explains where the passkey is', async () => {
      const u = await newUser(browser);
      await button(u.page, 'はじめる').click();
      await waitOpen(u.page);
      await u.page.reload();
      await u.page.evaluate(() => {
        navigator.credentials.get = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
      });
      await button(u.page, 'ひらく').click();
      await waitText(u.page, 'パスワード管理アプリの画面が出た時は');
      await u.context.close();
    });

    await test('Tampered vault: reports the failure instead of opening', async () => {
      const u = await newUser(browser);
      await button(u.page, 'はじめる').click();
      await waitOpen(u.page);
      await u.page.evaluate(() => {
        const v = JSON.parse(localStorage.getItem('tegami.vault'));
        v.ciphertext = v.ciphertext.slice(0, -4) + (v.ciphertext.endsWith('AAAA') ? 'BBBB' : 'AAAA');
        localStorage.setItem('tegami.vault', JSON.stringify(v));
      });
      await u.page.reload();
      await button(u.page, 'ひらく').click();
      await waitText(u.page, 'パスキーを使えませんでした');
      await u.context.close();
    });

    await test('Locked account: other screens stay behind the gate', async () => {
      const u = await newUser(browser);
      await button(u.page, 'はじめる').click();
      await waitOpen(u.page);
      await u.page.goto(ORIGIN + '/add');
      await waitText(u.page, 'ひらく');
      const t = await text(u.page);
      assert(t.includes('ひらく') && !t.includes('マイQRコード'), `screen: ${t.slice(0, 80)}`);
      await u.context.close();
    });

    await test('Legacy unprotected account: moved into a device vault, same key', async () => {
      const u = await newUser(browser, { authenticator: false });
      const hex = '1'.repeat(64);
      await u.page.evaluate((hex) => localStorage.setItem('tegami.account', JSON.stringify({ secretHex: hex })), hex);
      await u.page.reload();
      await waitOpen(u.page);
      const s = await storage(u.page);
      assert(s['tegami.device'] && !s['tegami.account'], `storage: ${Object.keys(s)}`);
      await u.page.goto(ORIGIN + '/add');
      await waitText(u.page, 'マイQRコード');
      // npub of secret 0x11..11
      assert((await text(u.page)).includes('npub1'), 'no invite link');
      await u.context.close();
    });

    await test('Two people: invite link, add, and a message arrives through the relay', async () => {
      const a = await newUser(browser);
      await button(a.page, 'はじめる').click();
      await waitOpen(a.page);
      await a.page.goto(ORIGIN + '/add');
      await button(a.page, 'ひらく').click();
      await waitText(a.page, 'マイQRコード');
      await a.page.getByPlaceholder('自分の名前').fill('あ');
      const link = (await text(a.page)).match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0];
      const b = await newUser(browser, { prf: false });
      await b.page.goto(link.replace('https://app.tegami.chat', ORIGIN));
      await button(b.page, 'はじめる').click();
      await button(b.page, 'パスキーを使わずに始める').click();
      await waitText(b.page, 'マイQRコード');
      assert((await b.page.getByPlaceholder('表示する名前').inputValue()) === 'あ', 'name not carried by the invite');
      await button(b.page, '追加').click();
      await b.page.getByPlaceholder('メッセージ').fill('こんにちは');
      await button(b.page, '送る').click();
      await a.page.goto(ORIGIN + '/');
      await button(a.page, 'ひらく').click();
      await waitOpen(a.page);
      await waitText(a.page, '知らない人から');
      await a.page.getByText('知らない人から').click();
      await waitText(a.page, 'こんにちは');
      await a.context.close();
      await b.context.close();
    });
    await test('Photo: made smaller, encrypted before upload, shown to the other person', async () => {
      async function person(name) {
        const u = await newUser(browser, { prf: false });
        await button(u.page, 'はじめる').click();
        await button(u.page, 'パスキーを使わずに始める').click();
        await waitOpen(u.page);
        await u.page.goto(ORIGIN + '/add');
        await waitText(u.page, 'マイQRコード');
        await u.page.getByPlaceholder('自分の名前').fill(name);
        u.link = (await text(u.page)).match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0];
        return u;
      }
      async function befriend(u, other) {
        await u.page.goto(ORIGIN + '/add');
        await waitText(u.page, 'マイQRコード');
        await u.page.getByPlaceholder('https://app.tegami.chat/i#npub…').fill(other.link);
        await button(u.page, '追加').click();
        await u.page.getByPlaceholder('メッセージ').waitFor();
      }
      const a = await person('あゆみ');
      const b = await person('ばんり');
      await befriend(b, a);
      await befriend(a, b); // a is now in the chat with b

      // A 3000 x 2000 PNG drawn in the page, so it has to be made smaller.
      const png = Buffer.from(
        await a.page.evaluate(() => {
          const c = document.createElement('canvas');
          c.width = 3000;
          c.height = 2000;
          const g = c.getContext('2d');
          g.fillStyle = '#b5452f';
          g.fillRect(0, 0, 3000, 2000);
          g.fillStyle = '#ffffff';
          g.fillRect(500, 500, 1000, 600);
          return c.toDataURL('image/png').split(',')[1];
        }),
        'base64',
      );
      const chooser = a.page.waitForEvent('filechooser');
      await button(a.page, '写真').click();
      await (await chooser).setFiles({ name: 'test.png', mimeType: 'image/png', buffer: png });
      await a.page.locator('img[alt="写真"]').first().waitFor({ timeout: 15000 });

      const sent = await a.page.evaluate(() => JSON.parse(localStorage.getItem('tegami.messages')).find((m) => m.file)?.file);
      assert(sent && sent.dim === '1600x1067', `photo not made smaller: ${sent?.dim}`);
      const stored = Buffer.from(await (await fetch(sent.url)).arrayBuffer());
      // Ciphertext looks random, so check the image signatures, not one byte (1 in 128 by chance).
      const head = stored.subarray(0, 4).toString('hex');
      assert(stored.length > 0 && !head.startsWith('ffd8ff') && head !== '89504e47', 'the server holds an unencrypted image');

      await b.page.goto(ORIGIN + '/');
      await waitText(b.page, '写真'); // chat list preview
      await b.page.getByText('あゆみ').click();
      const img = b.page.locator('img[alt="写真"]').first();
      await img.waitFor({ timeout: 15000 });
      await b.page.waitForFunction(() => {
        const i = document.querySelector('img[alt="写真"]');
        return i && i.complete && i.naturalWidth === 1600;
      }, null, { timeout: 15000 });
      for (const u of [a, b]) await u.context.close();
    });

    await test('Settings: key protection shown, crash reports only when allowed and scrubbed, export has no key', async () => {
      const u = await newUser(browser);
      await button(u.page, 'はじめる').click();
      await waitOpen(u.page);
      await openSettings(u.page);
      await waitText(u.page, 'パスキー');
      await u.page.goto(ORIGIN + '/settings/account');
      await button(u.page, 'ひらく').click();
      await waitText(u.page, 'パスキーで守っています');
      await u.page.goto(ORIGIN + '/settings/privacy');
      await button(u.page, 'ひらく').click();
      const crashes = async () => (await fetch(`http://localhost:${RELAY_PORT}/_crashes`)).json();
      const throwSoon = (tag) =>
        u.page.evaluate((tag) => setTimeout(() => { throw new Error(`boom-${tag} "my secret text" ${'ab'.repeat(32)}`); }), tag);

      // Off by default: nothing is sent.
      assert(!(await u.page.getByRole('switch', { name: 'Tegamiに報告を送る' }).isChecked()), 'crash reports are on by default');
      await throwSoon('off');
      await u.page.waitForTimeout(800);
      assert(!(await crashes()).some((r) => r.message.includes('boom-off')), 'a report was sent while off');

      // On: sent, without the quoted text or the long hex.
      await u.page.getByRole('switch', { name: 'Tegamiに報告を送る' }).click();
      await throwSoon('on');
      let got;
      for (let i = 0; i < 30 && !got; i++) {
        await u.page.waitForTimeout(100);
        got = (await crashes()).find((r) => r.message.includes('boom-on'));
      }
      assert(got, 'no report after turning it on');
      assert(!JSON.stringify(got).includes('my secret text') && !JSON.stringify(got).includes('abab'.repeat(8)), `not scrubbed: ${got.message}`);
      assert(got.platform === 'web', 'platform missing');

      // The choice is remembered.
      // Reloading /settings shows the lock first, then the same screen again.
      await u.page.reload();
      await button(u.page, 'ひらく').click();
      await waitText(u.page, '利用状況の統計');
      await waitText(u.page, '送受信の数などを週ごとに見る');
      assert(await u.page.getByRole('switch', { name: 'Tegamiに報告を送る' }).isChecked(), 'the choice was not remembered');
      await u.page.goto(ORIGIN + '/settings/talk');
      await button(u.page, 'ひらく').click();

      // Export: a JSON file with the chats, never the key.
      const dl = u.page.waitForEvent('download');
      await u.page.getByText('トーク履歴を書き出す').click();
      const file = await (await dl).path();
      const data = JSON.parse(readFileSync(file, 'utf8'));
      assert(data.app === 'Tegami' && Array.isArray(data.messages) && data.me.startsWith('npub1'), 'export shape');
      const vault = await u.page.evaluate(() => localStorage.getItem('tegami.vault'));
      assert(!readFileSync(file, 'utf8').includes(JSON.parse(vault).ciphertext), 'export contains the vault');

      // 戻る goes up one page at a time: the talk page, the settings list, then the home screen
      // (on a desktop: the rail's chats).
      if (NARROW) {
        await button(u.page, '戻る').click();
        await u.page.getByTestId('ai-permissions-state').waitFor();
        await button(u.page, '戻る').click();
      } else await button(u.page, 'トーク').first().click();
      await waitOpen(u.page);
      await u.context.close();
    });

    await test('Another device: a 10-minute link moves the key, name and contacts; both devices then send and receive', async () => {
      // After a page load the lock screen (passkey) or the screen itself comes up; open if locked.
      const openIfLocked = async (page, expect) => {
        await page.waitForFunction((e) => document.body.innerText.includes('ひらく') || document.body.innerText.includes(e), expect, { timeout: 15000 });
        if ((await text(page)).includes('ひらく')) await button(page, 'ひらく').click();
      };
      const inviteOf = async (page) => {
        await page.goto(ORIGIN + '/add');
        await openIfLocked(page, 'マイQRコード');
        await waitText(page, 'マイQRコード');
        return (await text(page)).match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0];
      };
      // A uses a passkey and has a friend B.
      const a = await newUser(browser);
      await button(a.page, 'はじめる').click();
      await waitOpen(a.page);
      const b = await newUser(browser, { prf: false });
      await button(b.page, 'はじめる').click();
      await button(b.page, 'パスキーを使わずに始める').click();
      await waitOpen(b.page);
      await b.page.goto(ORIGIN + '/add');
      await waitText(b.page, 'マイQRコード');
      await b.page.getByPlaceholder('自分の名前').fill('びー');
      const bLink = (await text(b.page)).match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0];
      await a.page.goto(bLink.replace('https://app.tegami.chat', ORIGIN));
      await button(a.page, 'ひらく').click();
      await waitText(a.page, 'マイQRコード');
      await a.page.getByPlaceholder('自分の名前').fill('えー');
      await button(a.page, '追加').click();
      await waitText(a.page, 'びー');
      const aInvite = await inviteOf(a.page);
      const aHex = nip19.decode(aInvite.match(/npub1[0-9a-z]+/)[0]).data;

      // A makes the link in settings.
      await a.page.goto(ORIGIN + '/settings/account');
      await openIfLocked(a.page, '別の端末でも使う');
      await a.page.getByText('別の端末でも使う').click();
      await waitText(a.page, 'まで使えます');
      const moveLink = (await text(a.page)).match(/http:\/\/localhost:\d+\/link#k=[A-Za-z0-9_-]+/)?.[0];
      assert(moveLink, 'no link on the settings screen');
      assert(await a.page.getByLabel('別の端末で読み取るQRコード').isVisible(), 'no QR code');

      // A second device opens it, gets the same account, name and friend.
      const a2 = await newUser(browser);
      await a2.page.goto(moveLink);
      await waitText(a2.page, 'えーさんのアカウントを受け取りました');
      assert(await keyLeavesAddressBar(a2.page), `the key stayed in the address bar: ${a2.page.url()}`);
      await button(a2.page, 'この端末で使う').click();
      await waitOpen(a2.page);
      await waitText(a2.page, 'びー');
      assert((await inviteOf(a2.page)).includes(aInvite.match(/npub1[0-9a-z]+/)[0]), 'not the same account');
      assert(await noRawKey(a2.page), 'raw key stored on the new device');
      assert((await storage(a2.page))['tegami.vault'], 'the new device did not protect the key with its passkey');

      // B writes to A: both devices get it. A2 writes to B: A sees its own message too.
      await b.page.goto(`${ORIGIN}/chat/${aHex}`);
      await b.page.getByPlaceholder('メッセージ').fill('両方に届く？');
      await button(b.page, '送る').click();
      for (const p of [a.page, a2.page]) {
        await p.goto(ORIGIN + '/');
        await openIfLocked(p, 'びー');
        await p.getByText('びー').first().click();
        await waitText(p, '両方に届く？');
      }
      await a2.page.getByPlaceholder('メッセージ').fill('新しい端末から');
      await button(a2.page, '送る').click();
      await waitText(a.page, '新しい端末から');
      await waitText(b.page, '新しい端末から');

      // Pasting the link (an iPhone Home Screen app cannot be reached by scanning).
      const a3 = await newUser(browser, { prf: false });
      await button(a3.page, '別の端末から受け取る').click();
      await a3.page.getByPlaceholder('別の端末で作ったリンクを貼る').fill(moveLink);
      await button(a3.page, '受け取る').click();
      await waitText(a3.page, 'えーさんのアカウントを受け取りました');
      await button(a3.page, 'この端末で使う').click();
      await button(a3.page, 'パスキーを使わずに始める').click();
      await waitOpen(a3.page);
      await waitText(a3.page, 'びー');
      await a3.context.close();

      // The same link on a device that already has an account replaces nothing: the
      // account can be added as a second one, and B's own account stays as it was.
      await b.page.goto(moveLink);
      await waitText(b.page, 'この端末には、すでにTegamiのアカウントがあります');
      assert(await keyLeavesAddressBar(b.page), 'the key stayed in the address bar of a device with an account');
      await button(b.page, 'アカウントを追加して受け取る').click();
      await waitText(b.page, 'えーさんのアカウントを受け取りました');
      await button(b.page, 'この端末で使う').click();
      await button(b.page, 'パスキーを使わずに始める').click();
      await waitOpen(b.page);
      await waitText(b.page, 'えー ▾');
      await waitText(b.page, 'びー'); // A's friend, in A's account
      const bKeys = Object.keys(await storage(b.page));
      assert(bKeys.includes('tegami.device') && bKeys.some((k) => /^tegami@[0-9a-f]{8}\.device$/.test(k)), `storage: ${bKeys}`);
      assert(await noRawKey(b.page), 'raw key stored for the added account');
      // The same link once more: this device has that account already, so it offers to switch.
      await b.page.goto(moveLink);
      await button(b.page, 'アカウントを追加して受け取る').click();
      await waitText(b.page, 'このアカウントは、この端末にすでにあります（えー）');
      await button(b.page, '切り替える').click();
      await waitOpen(b.page);
      await waitText(b.page, 'えー ▾');
      await b.page.getByText('えー ▾').click();
      await waitText(b.page, '使用中');
      await b.page.getByRole('button', { name: 'びー', exact: true }).click();
      await waitOpen(b.page);
      await waitText(b.page, 'びー ▾');
      const bAccounts = JSON.parse((await storage(b.page))['tegami.accounts']).list;
      assert(bAccounts.length === 2, `accounts on B's browser: ${JSON.stringify(bAccounts)}`);

      // A broken or expired link explains itself and lets the person start fresh.
      const c = await newUser(browser, { prf: false });
      await c.page.goto(ORIGIN + '/link#k=' + 'A'.repeat(43));
      await waitText(c.page, 'このリンクは使えません');
      await button(c.page, '新しく始める').click();
      await button(c.page, 'はじめる').click();
      await button(c.page, 'パスキーを使わずに始める').click();
      await waitOpen(c.page);
      for (const u of [a, a2, b, c]) await u.context.close();
    });

    await test('Own devices: the link brings messages older than 30 days; friends, groups and blocks changed on one device reach the other', async () => {
      const a = await person(browser, 'えー');
      const b = await person(browser, 'びー');
      const c = await person(browser, 'しー');
      await befriend(a, b);
      // A message from 60 days ago: the relay keeps only 30 days, so only A has it.
      const oldAt = Math.floor(Date.now() / 1000) - 60 * 86400;
      await a.page.evaluate(
        ({ peer, at }) => {
          const list = JSON.parse(localStorage.getItem('tegami.messages') || '[]');
          list.unshift({ id: '9'.repeat(64), from: peer, peer, text: '六十日前の手紙', at, got: at * 1000 });
          localStorage.setItem('tegami.messages', JSON.stringify(list));
        },
        { peer: b.hex, at: oldAt },
      );
      await a.page.goto(ORIGIN + '/settings/account');
      await waitText(a.page, '別の端末でも使う');
      await a.page.getByText('別の端末でも使う').click();
      await waitText(a.page, 'まで使えます');
      const moveLink = (await text(a.page)).match(/http:\/\/localhost:\d+\/link#k=[A-Za-z0-9_-]+/)?.[0];
      assert(moveLink, 'no moving link');
      const a2 = await newUser(browser, { prf: false });
      await a2.page.goto(moveLink);
      await button(a2.page, 'この端末で使う').click();
      await button(a2.page, 'パスキーを使わずに始める').click();
      await waitOpen(a2.page);
      await a2.page.getByText('びー').first().click();
      await waitText(a2.page, '六十日前の手紙');
      // The relay never had it: it came in the history file, once.
      const files = await a2.page.evaluate(() => JSON.parse(localStorage.getItem('tegami.messages') || '[]').filter((m) => m.text === '六十日前の手紙').length);
      assert(files === 1, `the old message is there ${files} times`);

      // A2 adds C as a friend: A, still open, gets C too.
      await befriend(a2, c);
      await a.page.goto(ORIGIN + '/');
      await button(a.page, '友だち').click();
      await waitText(a.page, 'しー');
      const contactsOf = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('tegami.contacts') || '[]').map((x) => x.name).sort().join(','));
      assert((await contactsOf(a.page)) === 'しー,びー', `A's friends: ${await contactsOf(a.page)}`);

      // A2 makes a group with B and C: it shows on A.
      await a2.page.goto(ORIGIN + '/');
      await button(a2.page, '友だち').click();
      await a2.page.getByText('グループを作る').click();
      await a2.page.getByPlaceholder('グループの名前').fill('いつもの三人');
      await a2.page.getByRole('checkbox', { name: 'びー' }).click();
      await a2.page.getByRole('checkbox', { name: 'しー' }).click();
      await button(a2.page, '作る').click();
      await a.page.waitForFunction(() => JSON.parse(localStorage.getItem('tegami.groups') || '[]').some((g) => g.name === 'いつもの三人'), null, { timeout: 15000 });

      // A blocks C: A2 has C blocked too. A2 unblocks: A lets C back.
      await a.page.goto(`${ORIGIN}/chat/${c.hex}`);
      await button(a.page, 'メニュー').click();
      await waitText(a.page, 'ビデオ通話');
      await button(a.page, 'ブロック').click();
      await waitText(a.page, 'しーをブロックしますか？');
      await button(a.page, 'ブロック').click();
      await button(infoArea(a.page), 'ブロック解除').waitFor();
      const blockedOn = (p, hex) => p.waitForFunction((h) => JSON.parse(localStorage.getItem('tegami.blocked') || '[]').includes(h), hex, { timeout: 15000 });
      const notBlockedOn = (p, hex) => p.waitForFunction((h) => !JSON.parse(localStorage.getItem('tegami.blocked') || '[]').includes(h), hex, { timeout: 15000 });
      await blockedOn(a2.page, c.hex);
      await a2.page.goto(ORIGIN + '/settings/privacy');
      await waitText(a2.page, 'ブロックリスト');
      await button(a2.page, 'ブロック解除').click();
      await notBlockedOn(a.page, c.hex);
      for (const u of [a, a2, b, c]) await u.context.close();
    });

    await test('Connection dropped (phone put the browser away): messages still arrive after reconnecting', async () => {
      const make = async (name) => {
        const u = await newUser(browser, { prf: false });
        await button(u.page, 'はじめる').click();
        await button(u.page, 'パスキーを使わずに始める').click();
        await waitOpen(u.page);
        await u.page.goto(ORIGIN + '/add');
        await waitText(u.page, 'マイQRコード');
        await u.page.getByPlaceholder('自分の名前').fill(name);
        u.link = (await text(u.page)).match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0];
        return u;
      };
      const a = await make('えー');
      const b = await make('びー');
      await b.page.goto(a.link.replace('https://app.tegami.chat', ORIGIN));
      await button(b.page, '追加').click();
      await a.page.goto(b.link.replace('https://app.tegami.chat', ORIGIN));
      await button(a.page, '追加').click();
      await a.page.getByPlaceholder('メッセージ').waitFor();
      await b.page.getByPlaceholder('メッセージ').fill('切れる前');
      await button(b.page, '送る').click();
      await waitText(a.page, '切れる前');

      await fetch(`http://localhost:${RELAY_PORT}/_drop`, { method: 'POST' });
      await a.page.waitForTimeout(4000); // the library reconnects after a short wait
      await b.page.getByPlaceholder('メッセージ').fill('つなぎ直した後');
      await button(b.page, '送る').click();
      await waitText(a.page, 'つなぎ直した後');
      await a.context.close();
      await b.context.close();
    });

    await test('Notifications: the switch registers this device with the relay (signed), and turning off removes it', async () => {
      // Test Chrome cannot reach a real push service, so the subscription is stood in for.
      const u = await newUser(browser, { prf: false });
      await u.context.grantPermissions(['notifications'], { origin: ORIGIN });
      await u.page.addInitScript(() => {
        PushManager.prototype.subscribe = async () => ({
          endpoint: 'https://fcm.googleapis.com/fcm/send/test-device',
          toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/test-device', keys: { p256dh: 'BTESTp256dh', auth: 'TESTauth' } }),
          unsubscribe: async () => true,
        });
        PushManager.prototype.getSubscription = async () => null;
      });
      await u.page.reload();
      await button(u.page, 'はじめる').click();
      await button(u.page, 'パスキーを使わずに始める').click();
      await waitOpen(u.page);
      assert(await u.page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration('/sw.js'))), 'the service worker is not registered');
      await openSettings(u.page);
      const sw = u.page.getByRole('switch', { name: '通知', exact: true });
      await sw.waitFor();
      assert(!(await sw.isChecked()), 'notifications are on before asking');
      await sw.click();
      const devices = async () => (await fetch(`http://localhost:${RELAY_PORT}/_push`)).json();
      let list = [];
      for (let i = 0; i < 30 && !list.length; i++) {
        await u.page.waitForTimeout(100);
        list = await devices();
      }
      assert(list.some((d) => d.endpoint.endsWith('/test-device')), 'the device was not registered with the relay');
      assert(list.some((d) => d.keys?.p256dh === 'BTESTp256dh' && d.keys?.auth === 'TESTauth'), 'the device keys were not sent to the relay');
      assert(await sw.isChecked(), 'the switch did not turn on');
      await sw.click();
      for (let i = 0; i < 30 && list.length; i++) {
        await u.page.waitForTimeout(100);
        list = await devices();
      }
      assert(!list.length, 'the device was not removed when turning off');
      await u.context.close();
    });

    await test('Notifications on iPhone outside the Home Screen: says how to add Tegami to the Home Screen', async () => {
      const context = await browser.newContext({ viewport: NARROW ? { width: 390, height: 760 } : { width: 1280, height: 800 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1' });
      await context.addInitScript(() => {
        delete window.PushManager;
        delete window.PublicKeyCredential; // start without a passkey, quickly
      });
      const page = await context.newPage();
      await page.goto(ORIGIN + '/');
      await button(page, 'はじめる').click();
      await button(page, 'パスキーを使わずに始める').click();
      await waitOpen(page);
      await openSettings(page);
      await waitText(page, 'ホーム画面に追加');
      await context.close();
    });

    await test('Group of three: everyone sees the group name and who said what', async () => {
      // Each person starts without a passkey (fast) and sets a name.
      async function person(name) {
        const u = await newUser(browser, { prf: false });
        await button(u.page, 'はじめる').click();
        await button(u.page, 'パスキーを使わずに始める').click();
        await waitOpen(u.page);
        await u.page.goto(ORIGIN + '/add');
        await waitText(u.page, 'マイQRコード');
        await u.page.getByPlaceholder('自分の名前').fill(name);
        u.link = (await text(u.page)).match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0];
        return u;
      }
      async function befriend(u, other) {
        await u.page.goto(ORIGIN + '/add');
        await waitText(u.page, 'マイQRコード');
        await u.page.getByPlaceholder('https://app.tegami.chat/i#npub…').fill(other.link);
        await button(u.page, '追加').click();
        await u.page.getByPlaceholder('メッセージ').waitFor();
      }
      const a = await person('あきら');
      const b = await person('ぶんた');
      const c = await person('ちえ');
      await befriend(a, b);
      await befriend(a, c);
      await befriend(b, a);
      await befriend(c, a);

      await a.page.goto(ORIGIN + '/');
      await button(a.page, '友だち').click();
      await a.page.getByText('グループを作る').click();
      await a.page.getByPlaceholder('グループの名前').fill('家族');
      assert(await button(a.page, '作る').isDisabled(), 'can create a group with nobody picked');
      await a.page.getByRole('checkbox', { name: 'ぶんた' }).click();
      await a.page.getByRole('checkbox', { name: 'ちえ' }).click();
      await button(a.page, '作る').click();
      await a.page.getByPlaceholder('メッセージ').fill('みんなへ');
      await button(a.page, '送る').click();

      // B knows A, so the group shows in B's list under its name.
      await b.page.goto(ORIGIN + '/');
      await waitText(b.page, '家族');
      await b.page.getByText('家族').click();
      await waitText(b.page, 'みんなへ');
      assert((await text(b.page)).includes('あきら'), "B does not see who wrote");
      await b.page.getByPlaceholder('メッセージ').fill('了解');
      await button(b.page, '送る').click();

      // C sees both messages in the same group.
      await c.page.goto(ORIGIN + '/');
      await waitText(c.page, '家族');
      await c.page.getByText('家族').click();
      await waitText(c.page, '了解');
      const t = await text(c.page);
      assert(t.includes('みんなへ') && t.includes('あきら'), `C screen: ${t.slice(0, 120)}`);
      // The 1:1 chat between C and A stays separate.
      await c.page.goto(ORIGIN + '/');
      await waitText(c.page, 'あきら');
      for (const u of [a, b, c]) await u.context.close();
    });

    await test('Group members: add, rename, change the picture, remove, leave; the same chat goes on and someone added later does not see earlier messages', async () => {
      const a = await person(browser, 'あきら');
      const b = await person(browser, 'ぶんた');
      const c = await person(browser, 'ちえ');
      const d = await person(browser, 'だい');
      for (const o of [b, c, d]) await befriend(a, o);
      for (const o of [b, c, d]) await befriend(o, a);
      const openGroup = async (u, name) => {
        await u.page.goto(ORIGIN + '/');
        await waitText(u.page, name);
        await u.page.getByText(name, { exact: true }).first().click();
        await u.page.getByTestId('chat-title').last().waitFor();
      };
      // The group's details: beside the chat on a desktop (閉じる), a screen of its own on a phone.
      const closeInfo = async (u) => (NARROW ? u.page.goBack() : button(u.page, '閉じる').click());
      const sendText = async (u, t) => {
        await u.page.getByPlaceholder('メッセージ').fill(t);
        await button(u.page, '送る').click();
      };

      await a.page.goto(ORIGIN + '/group');
      await a.page.getByPlaceholder('グループの名前').fill('家族');
      await a.page.getByRole('checkbox', { name: 'ぶんた' }).click();
      await a.page.getByRole('checkbox', { name: 'ちえ' }).click();
      await shot(a.page, 'group-new', 'グループを作る画面（管理者だけがメンバーを変更できる）');
      await button(a.page, '作る').click();
      await waitText(a.page, 'あきらがグループを作成しました。');
      await sendText(a, '前の話');
      await openGroup(b, '家族');
      await waitText(b.page, '前の話');
      await waitText(b.page, 'あきらがグループを作成しました。');

      // A adds D.
      await button(a.page, 'メニュー').click();
      await button(a.page, 'メンバーを追加').click();
      await shot(a.page, 'group-add', 'グループの情報の画面：メンバーを追加');
      await a.page.getByRole('checkbox', { name: 'だい' }).click();
      await button(a.page, '追加').click();
      await waitText(a.page, 'メンバー（4）');
      await shot(a.page, 'group-members', 'グループの情報の画面：メンバーの一覧');
      // D sees the group under its name, but nothing from before being added, even after reloading.
      await openGroup(d, '家族');
      await waitText(d.page, 'あきらがだいをグループに追加しました。');
      await d.page.reload();
      await d.page.getByPlaceholder('メッセージ').waitFor();
      await d.page.waitForTimeout(1500);
      assert(!(await text(d.page)).includes('前の話'), 'D sees a message from before being added');
      // The page closed after the group was saved but before its line was: the relay's replay brings the line back.
      await d.page.evaluate(() => {
        const list = JSON.parse(localStorage.getItem('tegami.messages')).filter((m) => !m.notice);
        localStorage.setItem('tegami.messages', JSON.stringify(list));
      });
      await d.page.reload();
      await waitText(d.page, 'あきらがだいをグループに追加しました。');
      // The same chat goes on: what A writes now reaches B and D in the chat they already have.
      await openGroup(a, '家族');
      await sendText(a, 'あとの話');
      await waitText(d.page, 'あとの話');
      await waitText(b.page, 'あとの話');
      assert((await text(b.page)).includes('前の話'), 'B lost the earlier messages: the group became a new chat');
      await waitText(b.page, 'をグループに追加しました。'); // B does not know D: a short id

      // B (any member of a group without admins) renames it.
      await button(b.page, 'メニュー').click();
      await button(b.page, 'グループ名を変更').click();
      await b.page.getByPlaceholder('グループの名前').fill('親戚');
      await button(b.page, '保存').click();
      await closeInfo(b);
      await waitText(a.page, 'ぶんたがグループ名を「親戚」に変更しました。');
      assert((await a.page.getByTestId('chat-title').innerText()).includes('親戚'), 'the title did not follow the new name');

      // A changes the picture; B gets it.
      const png = Buffer.from(
        await a.page.evaluate(() => {
          const cv = document.createElement('canvas');
          cv.width = 300;
          cv.height = 300;
          const g = cv.getContext('2d');
          g.fillStyle = '#106c4a';
          g.fillRect(0, 0, 300, 300);
          return cv.toDataURL('image/png').split(',')[1];
        }),
        'base64',
      );
      await button(a.page, 'メニュー').click();
      const chooser = a.page.waitForEvent('filechooser');
      await button(a.page, 'アイコンを変更').click();
      await (await chooser).setFiles({ name: 'g.png', mimeType: 'image/png', buffer: png });
      await waitText(b.page, 'あきらがグループのアイコンを変更しました。');
      // Nobody else here has a picture: an image on B's screen is the group's.
      await b.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="avatar-img"]')].some((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 });

      // A removes C: C keeps the chat but can no longer write, and gets nothing new.
      await a.page.goto(ORIGIN + '/');
      await openGroup(a, '親戚');
      await button(a.page, 'メニュー').click();
      await button(a.page, 'ちえを削除').click();
      await shot(a.page, 'group-remove', 'メンバーを削除する確認');
      await button(a.page, '削除').click();
      await waitText(a.page, 'メンバー（3）');
      await openGroup(c, '親戚');
      await waitText(c.page, 'あきらがちえを退会させました。');
      await waitText(c.page, 'このグループのメンバーではありません');
      await shot(c.page, 'group-removed', '削除された人のトーク');
      assert(!(await c.page.getByPlaceholder('メッセージ').count()), 'C can still write');
      await openGroup(a, '親戚');
      await sendText(a, 'ちえぬき');
      await waitText(d.page, 'ちえぬき');
      await c.page.waitForTimeout(1500);
      assert(!(await text(c.page)).includes('ちえぬき'), 'C still gets messages after removal');

      // D leaves: A is told, and the group is gone from D.
      await button(d.page, 'メニュー').click();
      await button(d.page, 'グループを退会').click();
      await shot(d.page, 'group-leave', 'グループを退会する確認');
      await button(d.page, '退会').click();
      await waitText(a.page, 'だいが退会しました。');
      await d.page.goto(ORIGIN + '/');
      await d.page.waitForTimeout(1000);
      await d.page.reload();
      await waitOpen(d.page);
      await d.page.waitForTimeout(1500);
      assert(!(await text(d.page)).includes('親戚'), 'the group came back to D after leaving');
      for (const u of [a, b, c, d]) await u.context.close();
    });

    await test('Group with admins: only admins change members; an admin can make someone admin', async () => {
      const a = await person(browser, 'あきら');
      const b = await person(browser, 'ぶんた');
      const c = await person(browser, 'ちえ');
      for (const o of [b, c]) await befriend(a, o);
      for (const o of [b, c]) await befriend(o, a);
      await befriend(b, c);
      await a.page.goto(ORIGIN + '/group');
      await a.page.getByPlaceholder('グループの名前').fill('部活');
      await a.page.getByRole('checkbox', { name: 'ぶんた' }).click();
      await a.page.getByRole('checkbox', { name: 'ちえ' }).click();
      await a.page.getByRole('switch', { name: '管理者だけがメンバーを変更できる' }).click();
      await button(a.page, '作る').click();
      await waitText(a.page, 'あきらがグループを作成しました。');
      await b.page.goto(ORIGIN + '/');
      await waitText(b.page, '部活');
      await b.page.getByText('部活', { exact: true }).first().click();
      await button(b.page, 'メニュー').click();
      await waitText(b.page, 'メンバー（3）');
      await waitText(b.page, '管理者');
      assert(!(await button(b.page, 'メンバーを追加').count()), 'a member who is not an admin can add people');
      assert(!(await button(b.page, 'ちえを削除').count()), 'a member who is not an admin can remove people');
      await (NARROW ? b.page.goBack() : button(b.page, '閉じる').click());
      await button(a.page, 'メニュー').click();
      await shot(a.page, 'group-admin', '管理者がいるグループの情報の画面');
      await button(a.page, 'ぶんたを管理者にする').click();
      await waitText(b.page, 'あきらがぶんたを管理者にしました。');
      await button(b.page, 'メニュー').click();
      await button(b.page, 'メンバーを追加').waitFor({ timeout: 15000 });
      for (const u of [a, b, c]) await u.context.close();
    });

    await test('Voice call: B answers, both connect, hanging up ends it on both sides; signals expire', async () => {
      const a = await person(browser, 'あおい');
      const b = await person(browser, 'ばく');
      await befriend(b, a);
      await befriend(a, b);
      await b.page.goto(ORIGIN + '/'); // B is somewhere else in the app
      const before = await a.page.evaluate(() => window.__sent.length);
      await button(a.page, '通話').click();
      await button(a.page, '音声通話').click();
      await waitText(a.page, '呼び出し中');
      await waitText(b.page, '音声通話');
      assert((await text(b.page)).includes('あおい'), 'B does not see who calls');
      await button(b.page, '応答').click();
      await waitConnected(a.page);
      await waitConnected(b.page);
      for (const p of [a.page, b.page]) await p.waitForFunction(() => /(^|\s)0:0\d(\s|$)/.test(document.body.innerText), null, { timeout: 5000 });
      // B hears A: the remote audio element plays a live track.
      assert(
        await b.page.evaluate(() => document.querySelector('audio[data-call="remote-audio"]')?.srcObject?.getAudioTracks()[0]?.readyState === 'live'),
        'no remote audio on B',
      );
      await button(a.page, 'ミュート').click();
      await button(a.page, 'ミュート解除').waitFor();
      await button(a.page, '通話を終了').click();
      await waitText(b.page, '通話が終了しました');
      await b.page.waitForFunction(() => window.__pcs.every((p) => p.connectionState === 'closed'), null, { timeout: 5000 });
      assert((await pcState(a.page)).every((s) => s === 'closed'), 'A still connected');
      // Both chats note the call.
      await waitText(a.page, '音声通話 0:');
      await b.page.getByText('あおい').first().click();
      await waitText(b.page, '音声通話 0:');
      // Every envelope sent for the call carries an expiration a minute ahead.
      // (Quiet envelopes are not for the call: my friend list going to my other devices, lib/own-sync.ts.)
      const sent = (await a.page.evaluate(() => window.__sent)).slice(before).filter((ev) => !ev.tags.some((t) => t[0] === 't' && t[1] === 'quiet'));
      const now = Math.floor(Date.now() / 1000);
      assert(sent.length >= 2, `only ${sent.length} envelopes sent`);
      for (const ev of sent) {
        const exp = Number(ev.tags.find((t) => t[0] === 'expiration')?.[1]);
        assert(ev.kind === 1059 && exp > now - 60 && exp <= now + 61, `envelope without a short expiration: ${JSON.stringify(ev.tags)}`);
      }
      // Only the ringing offer to B is marked as a call (so B's notification can say so).
      const marked = sent.filter((ev) => ev.tags.some((t) => t[0] === 't' && t[1] === 'call'));
      assert(marked.length === 1 && marked[0].tags.find((t) => t[0] === 'p')?.[1] === b.hex, `call marks: ${marked.length}`);
      for (const u of [a, b]) await u.context.close();
    });

    await test('Reopening right after a call: the ended call does not ring again, and the next call connects', async () => {
      const a = await person(browser, 'あさ');
      const b = await person(browser, 'ばん');
      await befriend(b, a);
      await befriend(a, b);
      await b.page.goto(ORIGIN + '/');
      await button(a.page, '通話').click();
      await button(a.page, '音声通話').click();
      await button(b.page, '応答').click();
      await waitConnected(a.page);
      await button(a.page, '通話を終了').click();
      await waitText(b.page, '通話が終了しました');
      // B reopens within the minute the signals still live on the relay.
      await b.page.goto(ORIGIN + '/');
      await waitOpen(b.page);
      await noText(b.page, '応答', 3000);
      // A calls again: B rings for the new call, answers, and both connect.
      await button(a.page, '通話').click();
      await button(a.page, '音声通話').click();
      await button(b.page, '応答').click();
      await waitConnected(b.page);
      await button(a.page, '通話を終了').click();
      for (const u of [a, b]) await u.context.close();
    });

    await test('Video call declined: the caller is told, nothing rings any more', async () => {
      const a = await person(browser, 'あん');
      const b = await person(browser, 'べん');
      await befriend(b, a);
      await befriend(a, b);
      await button(a.page, 'メニュー').click();
      await button(a.page, 'ビデオ通話').click();
      await waitText(b.page, 'ビデオ通話');
      await a.page.waitForFunction(() => document.querySelector('video[data-call="local-video"]')?.srcObject?.getVideoTracks().length === 1, null, { timeout: 5000 });
      await button(b.page, '拒否').click();
      await waitText(a.page, '応答がありません');
      assert(!(await button(b.page, '応答').count()), 'B still rings');
      await waitText(a.page, '応答なし');
      for (const u of [a, b]) await u.context.close();
    });

    await test("A stranger's call does not ring", async () => {
      const b = await person(browser, 'びわ');
      const c = await person(browser, 'ちか');
      await befriend(c, b); // C knows B, B does not know C
      await b.page.goto(ORIGIN + '/');
      await button(c.page, '通話').click();
      await button(c.page, '音声通話').click();
      await waitText(c.page, '呼び出し中');
      await noText(b.page, '応答', 5000);
      const t = await text(b.page);
      assert(!t.includes('不在着信') && !t.includes('知らない人から'), 'the stranger left a trace');
      await button(c.page, '通話を終了').click();
      for (const u of [b, c]) await u.context.close();
    });

    await test('Call relay (TURN): used when the relay hands out credentials, STUN only when it does not; the voice goes first', async () => {
      const devTurn = (on) => fetch(`http://localhost:${RELAY_PORT}/_turn`, { method: 'POST', body: JSON.stringify({ on }) });
      const asked = async () => (await (await fetch(`http://localhost:${RELAY_PORT}/_turn`)).json()).asked;
      const servers = (page) => page.evaluate(() => window.__pcs.at(-1)?.getConfiguration().iceServers ?? []);
      const hasTurn = (list) => list.some((s) => [s.urls].flat().some((u) => u.startsWith('turn:')) && s.username === 'dev-user' && s.credential === 'dev-pass');
      // No TURN on the relay: the call connects with STUN only.
      await devTurn(false);
      const a = await person(browser, 'あい');
      const b = await person(browser, 'ぶん');
      await befriend(b, a);
      await befriend(a, b);
      await button(a.page, '通話').click();
      await button(a.page, '音声通話').click();
      await button(b.page, '応答').click();
      await waitConnected(a.page);
      await waitConnected(b.page);
      for (const p of [a.page, b.page]) {
        const list = await servers(p);
        assert(list.length && !hasTurn(list) && list.every((s) => [s.urls].flat().every((u) => u.startsWith('stun:'))), `STUN only expected: ${JSON.stringify(list)}`);
      }
      // The microphone is asked for with echo cancellation, noise suppression and gain control.
      const c = await a.page.evaluate(() => window.__pcs.at(-1).getSenders().find((s) => s.track?.kind === 'audio').track.getConstraints());
      assert(c.echoCancellation === true && c.noiseSuppression === true && c.autoGainControl === true, `audio constraints: ${JSON.stringify(c)}`);
      // The voice gets high priority on the network.
      const prio = await a.page.evaluate(async () => {
        const s = window.__pcs.at(-1).getSenders().find((x) => x.track?.kind === 'audio');
        for (let i = 0; i < 20 && s.getParameters().encodings?.[0]?.priority !== 'high'; i++) await new Promise((r) => setTimeout(r, 100));
        return s.getParameters().encodings?.[0]?.priority;
      });
      assert(prio === 'high', `audio priority: ${prio}`);
      await button(a.page, '通話を終了').click();
      await waitText(b.page, '通話が終了しました');
      assert((await asked()).length === 0, 'credentials handed out while TURN was off');

      // TURN on: both sides get credentials and put them in the peer connection; the call still connects.
      await devTurn(true);
      const c2 = await person(browser, 'ちよ');
      const d = await person(browser, 'でん');
      await befriend(d, c2);
      await befriend(c2, d);
      await button(c2.page, '通話').click();
      await button(c2.page, 'ビデオ通話').click();
      await waitText(d.page, 'ビデオ通話');
      await button(d.page, '応答').click();
      await waitConnected(c2.page);
      await waitConnected(d.page);
      for (const p of [c2.page, d.page]) assert(hasTurn(await servers(p)), `no TURN in ${JSON.stringify(await servers(p))}`);
      const list = await asked();
      assert(list.includes(c2.hex) && list.includes(d.hex), `asked: ${JSON.stringify(list)}`);
      // The video keeps its frame rate when the network gets tight.
      const pref = await c2.page.evaluate(() => window.__pcs.at(-1).getSenders().find((s) => s.track?.kind === 'video')?.getParameters().degradationPreference);
      assert(pref === 'maintain-framerate' || pref === undefined, `degradationPreference: ${pref}`);
      await button(c2.page, '通話を終了').click();
      await waitText(d.page, '通話が終了しました');
      // A second call reuses the credentials (they last hours): the relay is not asked again.
      const before = (await asked()).length;
      await button(c2.page, '通話').click();
      await button(c2.page, '音声通話').click();
      await button(d.page, '応答').click();
      await waitConnected(d.page);
      assert(hasTurn(await servers(c2.page)) && hasTurn(await servers(d.page)), 'second call without TURN');
      assert((await asked()).length === before, `asked again: ${(await asked()).length - before}`);
      await button(c2.page, '通話を終了').click();
      await devTurn(false);
      for (const u of [a, b, c2, d]) await u.context.close();
    });

    await test('Call relay settings: "always relay" never goes direct; my own TURN server replaces Tegami and Cloudflare', async () => {
      const devTurn = (on) => fetch(`http://localhost:${RELAY_PORT}/_turn`, { method: 'POST', body: JSON.stringify({ on }) });
      const config = (page) =>
        page.evaluate(() => {
          const c = window.__pcs.at(-1)?.getConfiguration();
          return c ? { iceServers: c.iceServers, iceTransportPolicy: c.iceTransportPolicy } : null;
        });
      const urls = (cfg) => cfg.iceServers.flatMap((s) => [s.urls].flat());
      const openCallNetwork = async (page) => {
        await page.goto(ORIGIN + '/');
        await openSettings(page);
        await button(page, '通話の中継').click();
        await waitText(page, '通話を常に中継する');
      };
      await devTurn(false);
      const a = await person(browser, 'あさひ');
      const b = await person(browser, 'ぶどう');
      await befriend(b, a);
      await befriend(a, b);
      await a.page.goto(ORIGIN + '/');
      await openSettings(a.page);
      await waitText(a.page, 'Tegamiのサーバー');
      await button(a.page, '通話の中継').click();
      await waitText(a.page, '直接つながる通話では、相手にIPアドレスが見えます。');
      await a.page.getByRole('switch', { name: '通話を常に中継する' }).click();
      await waitText(a.page, '相手にIPアドレスが見えません。');
      await shot(a.page, 'call-network-relay', '設定の「通話の中継」：通話を常に中継するをオンにした画面');

      // Always relay, but the relay has no TURN: the call ends before it rings, and nothing goes direct.
      await a.page.goto(ORIGIN + '/');
      await a.page.goto(`${ORIGIN}/chat/${b.hex}`);
      await button(a.page, '通話').click();
      await button(a.page, '音声通話').click();
      await waitText(a.page, '中継のサーバーを使えませんでした');
      await noText(b.page, '応答', 4000);
      assert((await a.page.evaluate(() => window.__pcs.length)) === 0, 'a peer connection was made without TURN');

      // Always relay with TURN: my side gathers relay candidates only, so my address is not in the offer.
      // (Reloaded: the app remembers for ten minutes that the relay had no TURN.)
      await devTurn(true);
      await a.page.goto(`${ORIGIN}/chat/${b.hex}`);
      await button(a.page, '通話').click();
      await button(a.page, '音声通話').click();
      await button(b.page, '応答').waitFor({ timeout: 15000 });
      const cfgA = await config(a.page);
      assert(cfgA.iceTransportPolicy === 'relay', `policy: ${cfgA.iceTransportPolicy}`);
      assert(urls(cfgA).some((u) => u.startsWith('turn:')), `no TURN: ${JSON.stringify(cfgA.iceServers)}`);
      const sdp = await a.page.evaluate(() => window.__pcs.at(-1).localDescription?.sdp ?? '');
      assert(sdp && !/typ (host|srflx)/.test(sdp), `my address in the offer: ${sdp.match(/a=candidate.*/g)}`);
      await button(b.page, '応答').click();
      await b.page.waitForFunction(() => window.__pcs.length > 0, null, { timeout: 10000 });
      const cfgB = await config(b.page);
      assert(cfgB.iceTransportPolicy === 'all', `the other side was forced to relay: ${cfgB.iceTransportPolicy}`);
      await button(a.page, '通話を終了').click();
      await devTurn(false);

      // My own TURN server: only it is used (no Tegami relay credentials, no stun.cloudflare.com).
      await openCallNetwork(a.page);
      await a.page.getByRole('switch', { name: '通話を常に中継する' }).click();
      await a.page.getByRole('radio', { name: '自分のサーバー' }).click();
      await a.page.getByLabel('アドレス', { exact: true }).fill('http://example.com');
      await waitText(a.page, '「turn:」か「turns:」で始まるアドレスを入れてください。');
      assert(await button(a.page, '保存').isDisabled(), 'saved an address that is not turn:');
      await a.page.getByLabel('アドレス', { exact: true }).fill('turn:127.0.0.1:9');
      await a.page.getByLabel('ユーザー名', { exact: true }).fill('me');
      await a.page.getByLabel('パスワード', { exact: true }).fill('secret');
      await button(a.page, '接続を試す').click();
      await waitText(a.page, 'つながりませんでした。');
      await button(a.page, '保存').click();
      await waitText(a.page, '保存しました');
      await shot(a.page, 'call-network-own', '設定の「通話の中継」：自分のサーバーを入れて保存した画面');
      await a.page.goto(ORIGIN + '/');
      await a.page.goto(`${ORIGIN}/chat/${b.hex}`);
      await button(a.page, '通話').click();
      await button(a.page, '音声通話').click();
      await button(b.page, '応答').click();
      await waitConnected(a.page);
      const own = urls(await config(a.page));
      assert(own.includes('turn:127.0.0.1:9') && own.includes('stun:127.0.0.1:9'), `own: ${own}`);
      assert(!own.some((u) => u.includes('cloudflare')), `Cloudflare still used: ${own}`);
      assert((await config(a.page)).iceServers.some((s) => s.username === 'me' && s.credential === 'secret'), 'no credentials');
      await button(a.page, '通話を終了').click();

      // Back to the Tegami server.
      await openCallNetwork(a.page);
      await a.page.getByRole('radio', { name: 'Tegamiのサーバー' }).click();
      await a.page.goto(ORIGIN + '/');
      await openSettings(a.page);
      await waitText(a.page, 'Tegamiのサーバー');
      for (const u of [a, b]) await u.context.close();
    });

    await test('A late signal (written more than a minute ago) does not ring; a fresh one does', async () => {
      const b = await person(browser, 'ぼたん');
      const x = generateSecretKey();
      await befriend(b, `https://app.tegami.chat/i#${nip19.npubEncode(getPublicKey(x))}&n=${encodeURIComponent('えっくす')}`);
      await b.page.goto(ORIGIN + '/');
      await waitText(b.page, 'えっくす');
      const offer = (id) => ({ t: 'offer', id, video: false, sdp: 'v=0\r\n' });
      await relaySend(x, signalFrom(x, b.hex, offer('a'.repeat(32)), 120));
      await noText(b.page, '応答', 3000);
      // The same kind of envelope, written now: rings (so the late one really reached B).
      await relaySend(x, signalFrom(x, b.hex, offer('b'.repeat(32))));
      await button(b.page, '応答').waitFor({ timeout: 10000 });
      await button(b.page, '拒否').click();
      await b.context.close();
    });


    await test('Recovery code: backup on the relay is encrypted, follows changes, restores on a new device; wrong, old and turned-off codes fail', async () => {
      const openIfLocked = async (page, expect) => {
        await page.waitForFunction((e) => document.body.innerText.includes('ひらく') || document.body.innerText.includes(e), expect, { timeout: 15000 });
        if ((await text(page)).includes('ひらく')) await button(page, 'ひらく').click();
      };
      const backups = async () => (await fetch(`http://localhost:${RELAY_PORT}/_backups`)).json();
      const until = async (cond, what) => {
        for (let i = 0; i < 60; i++) {
          if (await cond()) return;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`timed out: ${what}`);
      };
      /** Opens a backup here in the test, the way the app does (HKDF of the code → id and AES-GCM key). */
      const decrypt = async (code, body) => {
        const ikm = new TextEncoder().encode(code.replace(/-/g, ''));
        const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
        const bits = (info) =>
          crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('tegami/recovery/v1'), info: new TextEncoder().encode(info) }, base, 256);
        const id = Buffer.from(await bits('backup id')).toString('hex');
        const signerPub = getPublicKey(new Uint8Array(await bits('backup signer')));
        const key = await crypto.subtle.importKey('raw', await bits('backup key'), 'AES-GCM', false, ['decrypt']);
        const { iv, ct } = JSON.parse(body);
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv, 'base64url'), additionalData: new TextEncoder().encode(id) }, key, Buffer.from(ct, 'base64url'));
        return { id, signerPub, bundle: JSON.parse(Buffer.from(pt).toString()) };
      };
      /** Tries a code on a fresh browser. Returns the screen text after trying. */
      const tryCode = async (code, { use = false } = {}) => {
        const u = await newUser(browser, { prf: false });
        await button(u.page, '復旧コードを使う').click();
        await u.page.getByPlaceholder('復旧コード').fill(code);
        await button(u.page, '復旧').click();
        await u.page.waitForFunction(() => /受け取りました|コードが正しくありません/.test(document.body.innerText), null, { timeout: 15000 });
        const t = await text(u.page);
        if (!use) await u.context.close();
        return { u, t };
      };

      // A (passkey) has a name and a friend B.
      const a = await newUser(browser);
      await button(a.page, 'はじめる').click();
      await waitOpen(a.page);
      const b = await newUser(browser, { prf: false });
      await button(b.page, 'はじめる').click();
      await button(b.page, 'パスキーを使わずに始める').click();
      await waitOpen(b.page);
      await b.page.goto(ORIGIN + '/add');
      await waitText(b.page, 'マイQRコード');
      await b.page.getByPlaceholder('自分の名前').fill('びー');
      const bLink = (await text(b.page)).match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0].replace('https://app.tegami.chat', ORIGIN);
      await a.page.goto(bLink);
      await button(a.page, 'ひらく').click();
      await waitText(a.page, 'マイQRコード');
      await a.page.getByPlaceholder('自分の名前').fill('えー');
      await button(a.page, '追加').click();
      await a.page.getByPlaceholder('メッセージ').waitFor();
      await a.page.goto(ORIGIN + '/add');
      await openIfLocked(a.page, 'マイQRコード');
      await waitText(a.page, 'マイQRコード');
      const aNpub = (await text(a.page)).match(/npub1[0-9a-z]+/)[0];
      const aHex = nip19.decode(aNpub).data;

      // Turn recovery on: the code is shown once.
      await a.page.goto(ORIGIN + '/settings/account');
      await openIfLocked(a.page, '復旧コードを作成');
      await button(a.page, '復旧コードを作成').click();
      await waitText(a.page, 'このコードは今だけ表示されます');
      const code1 = (await a.page.getByTestId('recovery-code').innerText()).trim();
      assert(/^([2-9A-HJ-NP-Z]{4}-){6}[2-9A-HJ-NP-Z]{4}$/.test(code1), `code format: ${code1}`);
      let list = await backups();
      assert(list.length === 1, `relay backups: ${list.length}`);
      const first = list[0];
      assert(!/えー|びー|secretHex|npub/.test(first.data) && first.data.length < 64 * 1024, 'the relay holds readable account data');
      assert(!JSON.stringify(first).includes(aHex), 'the relay row contains the account key');
      const opened = await decrypt(code1, first.data);
      assert(opened.id === first.id && opened.bundle.myName === 'えー' && opened.bundle.contacts[0]?.name === 'びー', 'backup content');
      assert(first.pubkey === opened.signerPub, 'the backup is not signed with the key from the code');
      assert(!(await storage(a.page))['tegami.recovery']?.includes(code1.replace(/-/g, '')), 'the code is kept on the device in the clear');
      await button(a.page, '保管しました').click();
      await waitText(a.page, '端末をすべて失っても、復旧コードで戻せます');
      assert(!(await text(a.page)).includes(code1), 'the code is still on the screen');

      // Rename the friend: the backup follows (after a short pause).
      await a.page.goto(bLink);
      await openIfLocked(a.page, 'マイQRコード');
      await a.page.getByPlaceholder('表示する名前').fill('びーさん');
      await button(a.page, '名前を変える').click();
      await a.page.getByPlaceholder('メッセージ').waitFor();
      await until(async () => {
        const [cur] = await backups();
        return cur && (await decrypt(code1, cur.data)).bundle.contacts[0]?.name === 'びーさん';
      }, 'the backup was not refreshed after renaming');

      // The relay cannot be reached: after 3 failed refreshes in a row, settings says so
      // in one line; the next successful refresh takes the line away.
      const BEHIND = '復旧コードの控えを更新できていません';
      await a.page.goto(ORIGIN + '/settings/account');
      await openIfLocked(a.page, '復旧コードを削除');
      await waitText(a.page, '復旧コードを削除');
      await a.page.waitForTimeout(2500); // the refresh every app start makes, before the relay goes away
      let attempts = 0;
      await a.page.route('**/backup/**', (route) => {
        attempts++;
        return route.abort();
      });
      // The warning shows on the top list; the name is one page below it (no reload in between).
      await button(a.page, '戻る').click();
      await a.page.getByRole('button', { name: 'プロフィール', exact: true }).last().click();
      const nameBox = a.page.getByPlaceholder('相手に表示される名前');
      const setName = async (n) => {
        await nameBox.fill(n);
        await button(a.page, '戻る').click();
        await a.page.getByTestId('ai-permissions-state').waitFor();
      };
      const toName = () => a.page.getByRole('button', { name: 'プロフィール', exact: true }).last().click();
      await button(a.page, '戻る').click();
      for (const n of ['え1', 'え2']) {
        const before = attempts;
        await toName();
        await setName(n);
        await until(async () => attempts > before, 'no refresh was tried');
        assert(!(await text(a.page)).includes(BEHIND), `shown after ${attempts} failures`);
      }
      await toName();
      await setName('え3');
      await waitText(a.page, BEHIND);
      await a.page.unroute('**/backup/**');
      await toName();
      await setName('えーさん');
      await a.page.waitForFunction((t) => !document.body.innerText.includes(t), BEHIND, { timeout: 15000 }).catch(() => {
        throw new Error('the line stayed after the relay came back');
      });
      const [now] = await backups();
      assert((await decrypt(code1, now.data)).bundle.myName === 'えーさん', 'the backup after the relay came back');
      await toName();
      await setName('えー');
      await until(async () => (await decrypt(code1, (await backups())[0].data)).bundle.myName === 'えー', 'name back');

      // A new device restores with the code (typed in lower case, with spaces).
      const typed = code1.toLowerCase().replace(/-/g, ' ');
      const r = await tryCode(typed, { use: true });
      assert(r.t.includes('えーさんのアカウントを受け取りました'), `restore screen: ${r.t.slice(0, 120)}`);
      await button(r.u.page, 'この端末で使う').click();
      await button(r.u.page, 'パスキーを使わずに始める').click();
      await waitOpen(r.u.page);
      await waitText(r.u.page, 'びーさん');
      await r.u.page.goto(ORIGIN + '/add');
      await waitText(r.u.page, 'マイQRコード');
      assert((await text(r.u.page)).includes(aNpub), 'not the same account');
      assert((await r.u.page.getByPlaceholder('自分の名前').inputValue()) === 'えー', 'name not restored');
      await r.u.page.goto(ORIGIN + '/settings/account');
      await waitText(r.u.page, '端末をすべて失っても、復旧コードで戻せます');

      // Wrong codes fail cleanly and leave the start screen as it was.
      for (const wrong of ['2222-3333-4444-5555-6666-7777-8888', 'hello']) {
        const w = await tryCode(wrong);
        assert(w.t.includes('コードが正しくありません') && w.t.includes('はじめる'), `wrong code screen: ${w.t.slice(0, 120)}`);
      }

      // A new code: the old one stops working, the new one works.
      await a.page.goto(ORIGIN + '/settings/account');
      await openIfLocked(a.page, 'コードを更新');
      await button(a.page, 'コードを更新').click();
      await waitText(a.page, 'このコードは今だけ表示されます');
      const code2 = (await a.page.getByTestId('recovery-code').innerText()).trim();
      assert(code2 !== code1, 'the same code again');
      await until(async () => (await backups()).length === 1, 'the old backup was not deleted');
      assert((await tryCode(code1)).t.includes('コードが正しくありません'), 'the old code still works');
      assert((await tryCode(code2)).t.includes('えーさんのアカウントを受け取りました'), 'the new code does not work');

      // The restored device still has the old code: its next refresh finds the backup gone
      // and turns recovery off there instead of bringing the old code back.
      await r.u.page.goto(ORIGIN + '/settings/account');
      await waitText(r.u.page, '復旧コードを作成');
      assert((await backups()).length === 1, 'the old code came back');
      assert((await tryCode(code1)).t.includes('コードが正しくありません'), 'the old code works again');
      await r.u.context.close();

      // Turning off deletes the backup; the code then fails.
      await button(a.page, '保管しました').click();
      await button(a.page, '復旧コードを削除').click();
      await waitText(a.page, '復旧コードを作成');
      assert((await backups()).length === 0, 'the backup is still on the relay');
      assert((await tryCode(code2)).t.includes('コードが正しくありません'), 'the code works after turning off');
      for (const u of [a, b]) await u.context.close();
    });

    await test('Unread: counts on the list and the tab, cleared by opening the chat; own messages never count; the switch hides them', async () => {
      const a = await person(browser, 'うに');
      const b = await person(browser, 'べに');
      await befriend(b, a);
      await befriend(a, b);
      await a.page.goto(ORIGIN + '/');
      await waitText(a.page, 'べに');
      assert((await unreadBadges(a.page).count()) === 0, 'a badge before anything arrived');

      await b.page.getByPlaceholder('メッセージ').fill('いち');
      await button(b.page, '送る').click();
      await b.page.getByPlaceholder('メッセージ').fill('に');
      await button(b.page, '送る').click();
      await a.page.getByLabel('未読 2件').waitFor({ timeout: 15000 });
      await a.page.waitForFunction(() => document.title === '(2) Tegami', null, { timeout: 5000 });

      // Opening the chat reads it; my reply (its copy also comes back from the relay) does not count.
      await a.page.getByText('べに').first().click();
      await waitText(a.page, 'に');
      await a.page.getByPlaceholder('メッセージ').fill('こちらから');
      await button(a.page, '送る').click();
      await a.page.waitForTimeout(800);
      await a.page.goto(ORIGIN + '/');
      await waitText(a.page, 'こちらから');
      assert((await unreadBadges(a.page).count()) === 0, 'still unread after opening the chat, or my own message counted');
      assert((await a.page.title()) === 'Tegami', `title: ${await a.page.title()}`);
      await a.page.reload();
      await waitText(a.page, 'こちらから');
      await a.page.waitForTimeout(1500); // everything comes back from the relay after a reload
      assert((await unreadBadges(a.page).count()) === 0, 'messages became unread again after a reload');

      // A new one while I am on the list counts.
      await b.page.getByPlaceholder('メッセージ').fill('さん');
      await button(b.page, '送る').click();
      await a.page.getByLabel('未読 1件').waitFor({ timeout: 15000 });

      // The switch hides the counts (and the tab number), and brings them back.
      await openSettings(a.page, 'トーク');
      const sw = a.page.getByRole('switch', { name: '未読数を表示' });
      await sw.waitFor();
      assert(await sw.isChecked(), 'unread counts are off by default');
      await sw.click();
      assert((await a.page.title()) === 'Tegami', 'the tab still shows a number');
      await a.page.goto(ORIGIN + '/');
      await waitText(a.page, 'さん');
      assert((await unreadBadges(a.page).count()) === 0, 'counts shown while turned off');
      await a.page.goto(ORIGIN + '/settings/talk');
      await a.page.getByRole('switch', { name: '未読数を表示' }).click();
      await a.page.goto(ORIGIN + '/');
      await a.page.getByLabel('未読 1件').waitFor({ timeout: 5000 });

      // Someone not in my friends: the 「知らない人から」 row shows their total.
      const c = await person(browser, 'ちり');
      await befriend(c, a);
      await c.page.getByPlaceholder('メッセージ').fill('はじめまして');
      await button(c.page, '送る').click();
      await c.page.getByPlaceholder('メッセージ').fill('よろしく');
      await button(c.page, '送る').click();
      await a.page.getByRole('button', { name: /知らない人から/ }).getByLabel('未読 2件').waitFor({ timeout: 15000 });
      await a.page.waitForFunction(() => document.title === '(3) Tegami', null, { timeout: 5000 });

      // Moving to a new device: what was written before it was set up is not unread there.
      await a.page.goto(ORIGIN + '/settings/account');
      await a.page.getByText('別の端末でも使う').click();
      await waitText(a.page, 'まで使えます');
      const moveLink = (await text(a.page)).match(/http:\/\/localhost:\d+\/link#k=[A-Za-z0-9_-]+/)[0];
      const a2 = await newUser(browser, { prf: false });
      await a2.page.goto(moveLink);
      await button(a2.page, 'この端末で使う').click();
      await button(a2.page, 'パスキーを使わずに始める').click();
      await waitOpen(a2.page);
      await waitText(a2.page, 'さん');
      await waitText(a2.page, '知らない人から');
      await a2.page.waitForTimeout(1000);
      assert((await unreadBadges(a2.page).count()) === 0, 'old messages are unread on the new device');
      assert((await a2.page.title()) === 'Tegami', `new device title: ${await a2.page.title()}`);
      // ...but a new one is.
      await b.page.getByPlaceholder('メッセージ').fill('よん');
      await button(b.page, '送る').click();
      await a2.page.getByLabel('未読 1件').waitFor({ timeout: 15000 });
      for (const u of [a, a2, b, c]) await u.context.close();
    });

    await test('Outbox: written while the relay is down, kept through a reload, delivered exactly once when it is back; 削除する removes one', async () => {
      const a = await person(browser, 'あさ');
      const b = await person(browser, 'ばん');
      await befriend(b, a);
      await befriend(a, b);
      await b.page.goto(ORIGIN + '/');

      await stopRelay();
      await a.page.waitForTimeout(500);
      await a.page.getByPlaceholder('メッセージ').fill('あとで届く');
      await button(a.page, '送る').click();
      await waitText(a.page, '未送信');
      assert((await a.page.getByPlaceholder('メッセージ').inputValue()) === '', 'the text stayed in the box');
      await a.page.getByPlaceholder('メッセージ').fill('やめる分');
      await button(a.page, '送る').click();
      await a.page.waitForFunction(() => document.body.innerText.split('未送信').length === 3, null, { timeout: 15000 });

      // Giving up on one removes it here.
      await a.page.getByText('やめる分').click();
      // Like LINE: resend now, or delete. Resending while the relay is still down keeps it waiting.
      await button(a.page, '再送する').click();
      await a.page.waitForTimeout(500);
      assert((await text(a.page)).includes('やめる分'), 'resending removed the message');
      await a.page.getByText('やめる分').click();
      await button(a.page, '削除する').click();
      await noText(a.page, 'やめる分', 300);

      // Still waiting after a reload.
      await a.page.reload();
      await waitText(a.page, 'あとで届く');
      await waitText(a.page, '未送信');
      assert(!(await text(a.page)).includes('やめる分'), 'the stopped message came back after a reload');
      const box = await a.page.evaluate(() => JSON.parse(localStorage.getItem('tegami.outbox')));
      assert(box.length === 1 && box[0].wraps.length === 2 && box[0].done.length === 0, `outbox: ${JSON.stringify(box).slice(0, 120)}`);

      // The relay is back: sent without anyone doing anything, once.
      await startRelay();
      await a.page.waitForFunction(() => !document.body.innerText.includes('未送信'), null, { timeout: 20000 });
      await b.page.getByText('あさ').first().click();
      await waitText(b.page, 'あとで届く');
      await b.page.waitForTimeout(1500);
      const bt = NARROW ? await text(b.page) : await b.page.getByRole('main').innerText();
      assert(bt.split('あとで届く').length === 2, 'the other person sees it more than once');
      assert(!bt.includes('やめる分'), 'the stopped message was delivered');
      assert((await envelopesFor(b.hex)).length === 1, `envelopes for B: ${(await envelopesFor(b.hex)).length}`);
      assert((await envelopesFor(a.hex)).length === 1, `envelopes for my own devices: ${(await envelopesFor(a.hex)).length}`);
      assert((await a.page.evaluate(() => JSON.parse(localStorage.getItem('tegami.outbox')))).length === 0, 'the outbox is not empty');

      // Offline in the browser (no network at all): waits, then goes when the network returns.
      await a.context.setOffline(true);
      await a.page.getByPlaceholder('メッセージ').fill('電波が戻ったら');
      await button(a.page, '送る').click();
      await waitText(a.page, '未送信');
      await a.context.setOffline(false);
      await a.page.waitForFunction(() => !document.body.innerText.includes('未送信'), null, { timeout: 20000 });
      await waitText(b.page, '電波が戻ったら');
      for (const u of [a, b]) await u.context.close();
    });

    await test('Outbox: a photo whose upload failed is shown, uploaded later and delivered once', async () => {
      const a = await person(browser, 'あお');
      const b = await person(browser, 'びわ');
      await befriend(b, a);
      await befriend(a, b);
      await b.page.goto(ORIGIN + '/');
      const png = Buffer.from(
        await a.page.evaluate(() => {
          const c = document.createElement('canvas');
          c.width = 400;
          c.height = 300;
          const g = c.getContext('2d');
          g.fillStyle = '#2f6db5';
          g.fillRect(0, 0, 400, 300);
          return c.toDataURL('image/png').split(',')[1];
        }),
        'base64',
      );
      await stopRelay();
      await a.page.waitForTimeout(500);
      const chooser = a.page.waitForEvent('filechooser');
      await button(a.page, '写真').click();
      await (await chooser).setFiles({ name: 'test.png', mimeType: 'image/png', buffer: png });
      await waitText(a.page, '未送信');
      await a.page.locator('img[alt="写真"]').first().waitFor({ timeout: 15000 });
      await a.page.reload();
      await waitText(a.page, '未送信');
      await a.page.locator('img[alt="写真"]').first().waitFor({ timeout: 15000 });

      await startRelay();
      await a.page.waitForFunction(() => !document.body.innerText.includes('未送信'), null, { timeout: 30000 });
      const sent = await a.page.evaluate(() => JSON.parse(localStorage.getItem('tegami.messages')).find((m) => m.file));
      assert(sent && !sent.id.startsWith('local:') && sent.file.url.startsWith('http'), `sent: ${JSON.stringify(sent).slice(0, 120)}`);
      await b.page.getByText('あお').first().click();
      await b.page.waitForFunction(() => {
        const i = document.querySelector('img[alt="写真"]');
        return i && i.complete && i.naturalWidth === 400;
      }, null, { timeout: 15000 });
      assert((await b.page.locator('img[alt="写真"]').count()) === 1, 'more than one photo arrived');
      assert((await envelopesFor(b.hex)).length === 1, 'more than one envelope for B');
      for (const u of [a, b]) await u.context.close();
    });

    await test('AI friend: invite link shows the model, and the AI on the computer replies', async () => {
      const AGENT = join(ROOT, '../agent');
      const home = mkdtempSync(join(tmpdir(), 'tegami-agent-'));
      const env = { ...process.env, TEGAMI_AGENT_HOME: home, TEGAMI_RELAYS: `ws://localhost:${RELAY_PORT}` };
      const cli = (...a) => execFileSync(process.execPath, [join(AGENT, 'agent.mjs'), ...a], { env, encoding: 'utf8' });
      let watch;
      try {
        const aiLink = cli('init', '--name', 'クロード', '--model', 'Anthropic Claude').match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0];
        const u = await newUser(browser);
        await u.page.goto(aiLink.replace('https://app.tegami.chat', ORIGIN));
        await button(u.page, 'はじめる').click();
        await waitText(u.page, 'Anthropic Claude');
        // My link carries my invite code once the relay has answered: the AI registers with it.
        await u.page.waitForFunction(() => /&c=[a-z2-9]+/.test(document.body.innerText), null, { timeout: 10000 });
        const myLink = (await text(u.page)).match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0];
        cli('add', myLink, '--name', 'わたし', '--trust');
        watch = spawn(process.execPath, [join(AGENT, 'agent.mjs'), 'watch', '--command', `node "${join(AGENT, 'test/echo.mjs')}"`], { env, stdio: 'pipe' });
        await new Promise((r) => watch.stdout.once('data', r));
        await button(u.page, '追加').click();
        await waitText(u.page, 'クロード（Anthropic Claude）');
        await u.page.getByPlaceholder('メッセージ').fill('はじめまして');
        await button(u.page, '送る').click();
        await waitText(u.page, 'echo: わたし: はじめまして');
        await u.page.goto(ORIGIN + '/');
        await button(u.page, 'ひらく').click();
        await waitText(u.page, 'Anthropic Claude');
        await u.context.close();
      } finally {
        watch?.kill();
        rmSync(home, { recursive: true, force: true });
      }
    });

    await test('AI pairing: adding the AI from the QR code of `tegami-agent pair` makes it reply to me', async () => {
      const AGENT = join(ROOT, '../agent');
      const home = mkdtempSync(join(tmpdir(), 'tegami-agent-'));
      const env = { ...process.env, TEGAMI_AGENT_HOME: home, TEGAMI_RELAYS: `ws://localhost:${RELAY_PORT}` };
      let pair;
      let watch;
      try {
        pair = spawn(process.execPath, [join(AGENT, 'agent.mjs'), 'pair', '--name', 'クロード', '--minutes', '2'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        pair.stdout.on('data', (d) => (out += d));
        const exited = new Promise((r) => pair.on('exit', r));
        const waitOut = async (s) => {
          for (let i = 0; i < 150 && !out.includes(s); i++) await new Promise((r) => setTimeout(r, 100));
          assert(out.includes(s), `agent did not print "${s}": ${out.slice(-300)}`);
        };
        await waitOut('&p=');
        const aiLink = out.match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0];
        const u = await person(browser, 'わたし');
        // The QR code scan accepts the link with the pairing code.
        assert((await u.page.evaluate((l) => window.inviteFromQr(l), aiLink)) === aiLink, 'the QR code scan refused the pairing link');
        // My link carries my invite code once the relay has answered: the AI registers with it.
        await u.page.waitForFunction(() => /&c=[a-z2-9]+/.test(document.body.innerText), null, { timeout: 10000 });
        // A pasted pairing link starts with 自分のAIとして追加 off: the person turns it on.
        await u.page.goto(ORIGIN + '/add');
        await waitText(u.page, 'マイQRコード');
        await u.page.getByPlaceholder('https://app.tegami.chat/i#npub…').fill(aiLink);
        const asMine = u.page.getByRole('switch', { name: '自分のAIとして追加', exact: true });
        await asMine.waitFor();
        assert(!(await asMine.isChecked()), 'a pasted pairing link starts as my AI');
        await asMine.click();
        await shot(u.page, 'ai-pair-add', 'QRコードでつなぐ時。自分のAIとして追加');
        await button(u.page, '追加').click();
        await u.page.getByPlaceholder('メッセージ').waitFor();
        const aiHex = nip19.decode(aiLink.match(/npub1[0-9a-z]+/)[0]).data;
        assert(
          await u.page.evaluate((h) => JSON.parse(localStorage.getItem('tegami.contacts') || '[]').some((c) => c.pubkey === h && c.mine), aiHex),
          'pairing did not mark the AI as mine',
        );
        await waitOut('Paired with わたし');
        await waitOut('Registered with the Tegami relay');
        assert((await exited) === 0, 'pair did not finish');
        watch = spawn(process.execPath, [join(AGENT, 'agent.mjs'), 'watch', '--command', `node "${join(AGENT, 'test/echo.mjs')}"`], { env, stdio: 'pipe' });
        await new Promise((r) => watch.stdout.once('data', r));
        await u.page.getByPlaceholder('メッセージ').fill('はじめまして');
        await button(u.page, '送る').click();
        await waitText(u.page, 'echo: わたし: はじめまして');
        await shot(u.page, 'ai-pair-chat', 'AI paired by QR code answers');
        await u.context.close();
      } finally {
        pair?.kill();
        watch?.kill();
        rmSync(home, { recursive: true, force: true });
      }
    });

    // ---------- reply and search ----------

    await test('Reply: B sees the quote above the reply, tapping it scrolls to and marks the original; cancel works', async () => {
      const a = await person(browser, 'あみ');
      const b = await person(browser, 'ばく');
      await befriend(a, b);
      await befriend(b, a); // b is in the chat with a
      await b.page.getByPlaceholder('メッセージ').fill('最初のメッセージ');
      await button(b.page, '送る').click();
      for (let i = 1; i <= 15; i++) {
        await b.page.getByPlaceholder('メッセージ').fill(`つづき${i}`);
        await button(b.page, '送る').click();
      }
      await a.page.goto(ORIGIN + '/');
      await a.page.getByText('ばく').first().click();
      await waitText(a.page, 'つづき15');
      const original = a.page.getByText('最初のメッセージ', { exact: true });
      await original.click({ button: 'right' });
      await button(a.page, 'リプライ').click();
      // The composer shows what the reply is to; キャンセル takes it away.
      const bar = () => a.page.getByRole('button', { name: 'キャンセル' });
      await bar().waitFor();
      await bar().click();
      await bar().waitFor({ state: 'detached' });
      await original.click({ button: 'right' });
      await button(a.page, 'リプライ').click();
      await bar().waitFor();
      const replying = (await a.page.getByTestId('replying').innerText()).replace(/\s+/g, ' ');
      assert(replying.includes('ばく 最初のメッセージ'), `the composer shows: ${replying}`);
      await a.page.getByPlaceholder('メッセージ').fill('それに返信');
      await button(a.page, '送る').click();
      await bar().waitFor({ state: 'detached' });

      // B: the reply carries the quote (B's own name and the first line).
      await waitText(b.page, 'それに返信');
      const stored = await b.page.evaluate(() => JSON.parse(localStorage.getItem('tegami.messages')));
      const orig = stored.find((m) => m.text === '最初のメッセージ');
      const reply = stored.find((m) => m.text === 'それに返信');
      assert(reply.replyTo === orig.id, `replyTo: ${reply.replyTo} vs ${orig.id}`);
      const quote = b.page.getByTestId('quote');
      assert((await quote.innerText()).replace(/\s+/g, ' ').trim() === 'ばく 最初のメッセージ', `quote: ${await quote.innerText()}`);
      // The original bubble (not the quote): is it on the screen?
      const originalInView = () =>
        b.page.evaluate(() =>
          [...document.querySelectorAll('div')].some((el) => {
            if (el.innerText !== '最初のメッセージ' || el.children.length || el.closest('[data-testid="quote"]')) return false;
            const r = el.getBoundingClientRect();
            return r.height > 0 && r.bottom > 0 && r.top < innerHeight;
          }),
        );
      assert(!(await originalInView()), 'the original was already on screen (the scroll is not tested)');
      await quote.click();
      const marked = b.page.getByTestId('highlighted');
      await marked.waitFor({ timeout: 5000 });
      assert((await marked.innerText()).includes('最初のメッセージ'), `marked: ${await marked.innerText()}`);
      await b.page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="highlighted"]');
        const r = el?.getBoundingClientRect();
        return r && r.bottom > 0 && r.top < innerHeight;
      }, null, { timeout: 5000 });
      await marked.waitFor({ state: 'detached', timeout: 5000 }); // the mark goes away
      for (const u of [a, b]) await u.context.close();
    });

    await test('Reply on the wire: e tags as NIP-17 writes them; photos quote as 写真; an original not on the device', async () => {
      const b = await person(browser, 'べに');
      const x = generateSecretKey();
      const xHex = getPublicKey(x);
      await befriend(b, `https://app.tegami.chat/i#${nip19.npubEncode(xHex)}&n=${encodeURIComponent('えっくす')}`);
      const first = rumorTo(x, b.hex, 'えっくすの一言');
      await relaySend(x, wrapTo(x, b.hex, first));
      await waitText(b.page, 'えっくすの一言');

      // A text reply: kind 14 with ["e", id, relay].
      await b.page.getByText('えっくすの一言', { exact: true }).click({ button: 'right' });
      await button(b.page, 'リプライ').click();
      await b.page.getByPlaceholder('メッセージ').fill('べにの返信');
      await button(b.page, '送る').click();
      let inbox = await inboxOf(x, (all) => all.some((r) => r.content === 'べにの返信'));
      const r1 = inbox.find((r) => r.content === 'べにの返信');
      assert(r1 && r1.kind === 14, 'reply not received');
      const e1 = r1.tags.filter((t) => t[0] === 'e');
      assert(e1.length === 1 && e1[0][1] === first.id && e1[0][2] === `ws://localhost:${RELAY_PORT}` && e1[0].length === 3, `e tag: ${JSON.stringify(e1)}`);

      // A photo, then a photo sent as a reply to it: kind 15 with ["e", id, relay, "reply"].
      const png = Buffer.from(
        await b.page.evaluate(() => {
          const c = document.createElement('canvas');
          c.width = 300;
          c.height = 200;
          c.getContext('2d').fillRect(0, 0, 300, 200);
          return c.toDataURL('image/png').split(',')[1];
        }),
        'base64',
      );
      const sendPng = async () => {
        const chooser = b.page.waitForEvent('filechooser');
        await button(b.page, '写真').click();
        await (await chooser).setFiles({ name: 'test.png', mimeType: 'image/png', buffer: png });
      };
      await sendPng();
      await b.page.locator('img[alt="写真"]').first().waitFor({ timeout: 15000 });
      await b.page.locator('img[alt="写真"]').first().click({ button: 'right' });
      await button(b.page, 'リプライ').click();
      await b.page.getByRole('button', { name: 'キャンセル' }).waitFor();
      assert(/べに\s*写真/.test(await b.page.getByTestId('replying').innerText()), 'the composer does not say 写真');
      await sendPng();
      await b.page.getByRole('button', { name: 'キャンセル' }).waitFor({ state: 'detached', timeout: 15000 });
      inbox = await inboxOf(x, (all) => all.filter((r) => r.kind === 15).length === 2);
      const photos = inbox.filter((r) => r.kind === 15).sort((p, q) => p.created_at - q.created_at);
      assert(photos.length === 2, `photos received: ${photos.length}`);
      const photo = photos.find((r) => !r.tags.some((t) => t[0] === 'e'));
      const photoReply = photos.find((r) => r.tags.some((t) => t[0] === 'e'));
      const e2 = photoReply?.tags.filter((t) => t[0] === 'e');
      assert(photo && e2?.length === 1 && e2[0][1] === photo.id && e2[0][3] === 'reply', `photo e tag: ${JSON.stringify(e2)}`);

      // X replies to B's photo: B sees the quote with 写真.
      await relaySend(x, wrapTo(x, b.hex, rumorTo(x, b.hex, '写真ありがとう', [['e', photo.id, '', 'reply']])));
      await waitText(b.page, '写真ありがとう');
      const quotes = await b.page.getByTestId('quote').allInnerTexts();
      assert(quotes.filter((q) => /べに\s*写真/.test(q)).length === 2, `quotes: ${JSON.stringify(quotes)}`);

      // X replies to something B never had: a quiet line instead of the quote.
      await relaySend(x, wrapTo(x, b.hex, rumorTo(x, b.hex, '昔の話', [['e', 'f'.repeat(64), '']])));
      await waitText(b.page, '昔の話');
      await waitText(b.page, 'このメッセージはありません');
      await b.context.close();
    });

    await test('Reply in a group: the third person sees who wrote the original', async () => {
      const a = await person(browser, 'あきら');
      const b = await person(browser, 'ぶんた');
      const c = await person(browser, 'ちえ');
      await befriend(a, b);
      await befriend(a, c);
      await befriend(b, a);
      await befriend(c, a);
      await a.page.goto(ORIGIN + '/');
      await button(a.page, '友だち').click();
      await a.page.getByText('グループを作る').click();
      await a.page.getByPlaceholder('グループの名前').fill('家族');
      await a.page.getByRole('checkbox', { name: 'ぶんた' }).click();
      await a.page.getByRole('checkbox', { name: 'ちえ' }).click();
      await button(a.page, '作る').click();
      await a.page.getByPlaceholder('メッセージ').fill('みんなへ\n二行目');
      await button(a.page, '送る').click();

      await b.page.goto(ORIGIN + '/');
      await b.page.getByText('家族').click();
      await waitText(b.page, 'みんなへ');
      await b.page.getByText(/みんなへ/).last().click({ button: 'right' });
      await button(b.page, 'リプライ').click();
      await b.page.getByPlaceholder('メッセージ').fill('了解です');
      await button(b.page, '送る').click();

      await c.page.goto(ORIGIN + '/');
      await c.page.getByText('家族').click();
      await waitText(c.page, '了解です');
      const quote = c.page.getByTestId('quote');
      assert((await quote.innerText()).replace(/\s+/g, ' ').trim() === 'あきら みんなへ', `quote: ${await quote.innerText()}`);
      await quote.click();
      await c.page.getByTestId('highlighted').waitFor({ timeout: 5000 });
      assert((await c.page.getByTestId('highlighted').innerText()).includes('二行目'), 'the original is not marked');
      for (const u of [a, b, c]) await u.context.close();
    });

    await test('Search: across chats, ignoring width, case and kana; chat names; opening a result marks it; nothing found', async () => {
      const a = await person(browser, 'あや');
      const x = generateSecretKey();
      const y = generateSecretKey();
      await befriend(a, `https://app.tegami.chat/i#${nip19.npubEncode(getPublicKey(x))}&n=${encodeURIComponent('えっくす')}`);
      await befriend(a, `https://app.tegami.chat/i#${nip19.npubEncode(getPublicKey(y))}&n=${encodeURIComponent('わいわい')}`);
      const now = Math.floor(Date.now() / 1000);
      await relaySend(x, wrapTo(x, a.hex, rumorTo(x, a.hex, 'ＴｅｇａｍｉでＡＢＣを話そう', [], now - 200)));
      await relaySend(y, wrapTo(y, a.hex, rumorTo(y, a.hex, 'テガミの話をしよう', [], now - 100)));
      for (let i = 1; i <= 15; i++) await relaySend(y, wrapTo(y, a.hex, rumorTo(y, a.hex, `ほかの話${i}`, [], now - 100 + i)));
      await a.page.goto(ORIGIN + '/');
      await waitText(a.page, 'ほかの話15');
      const box = a.page.getByPlaceholder('検索');
      const results = async () => (await text(a.page)).replace(/\s+/g, ' ');

      await box.fill('abc');
      await waitText(a.page, 'メッセージ');
      let t = await results();
      assert(t.includes('えっくす') && t.includes('ＡＢＣ') && !t.includes('テガミの話'), `abc: ${t.slice(0, 200)}`);
      await box.fill('TEGAMI');
      await waitText(a.page, 'ＡＢＣ');
      t = await results();
      assert(!t.includes('テガミの話'), 'TEGAMI matched katakana');
      await box.fill('てがみ'); // hiragana finds katakana
      await waitText(a.page, 'テガミの話をしよう');
      assert(!(await results()).includes('ＡＢＣ'), 'てがみ matched the latin text');
      await box.fill('ﾃｶﾞﾐ'); // half-width katakana too
      await waitText(a.page, 'テガミの話をしよう');
      await box.fill('ワイワイ'); // a chat's name
      await waitText(a.page, 'トーク');
      assert((await results()).includes('わいわい'), 'chat name not found');
      await box.fill('ぜったいにない言葉');
      await waitText(a.page, '検索結果はありません');

      // Open a result: the chat opens at that message, marked.
      await box.fill('てがみ');
      await a.page.getByText('テガミの話をしよう').click();
      await a.page.getByPlaceholder('メッセージ').waitFor();
      const marked = a.page.getByTestId('highlighted');
      await marked.waitFor({ timeout: 5000 });
      assert((await marked.innerText()).includes('テガミの話をしよう'), `marked: ${await marked.innerText()}`);
      await a.page.waitForFunction(() => {
        const r = document.querySelector('[data-testid="highlighted"]')?.getBoundingClientRect();
        return r && r.bottom > 0 && r.top < innerHeight;
      }, null, { timeout: 5000 });
      // Back: the search is still there.
      await a.page.goBack();
      await waitText(a.page, 'テガミの話をしよう');
      assert((await box.inputValue()) === 'てがみ', 'the search was lost');
      await a.context.close();
    });

    await test('Accounts: two on one browser keep their friends and messages apart; switching from the list and the title', async () => {
      const u = await person(browser, 'あい');
      const x = generateSecretKey();
      await befriend(u, `https://app.tegami.chat/i#${nip19.npubEncode(getPublicKey(x))}&n=${encodeURIComponent('えっくす')}`);
      await relaySend(x, wrapTo(x, u.hex, rumorTo(x, u.hex, 'あいさんへの手紙')));
      await u.page.goto(ORIGIN + '/');
      await waitText(u.page, 'あいさんへの手紙');
      assert(!(await text(u.page)).includes('▾'), 'the title switches accounts with only one account');

      // Add a second account from settings; going back is offered while adding.
      await openSettings(u.page, 'アカウント');
      await waitText(u.page, '使用中');
      await button(u.page, 'アカウントを追加').click();
      await button(u.page, 'キャンセル').waitFor();
      await button(u.page, 'はじめる').click();
      await button(u.page, 'パスキーを使わずに始める').click();
      await waitOpen(u.page);
      let t = await text(u.page);
      assert(!t.includes('えっくす') && !t.includes('あいさんへの手紙'), `the first account's chats show in the second: ${t.slice(0, 200)}`);
      await u.page.goto(ORIGIN + '/add');
      await waitText(u.page, 'マイQRコード');
      await u.page.getByPlaceholder('自分の名前').fill('びい');
      const bHex = nip19.decode((await text(u.page)).match(/npub1[0-9a-z]+/)[0]).data;
      assert(bHex !== u.hex, 'the second account has the same key');
      await relaySend(x, wrapTo(x, bHex, rumorTo(x, bHex, 'びいさんへの手紙')));
      await u.page.goto(ORIGIN + '/');
      await waitText(u.page, 'びい ▾');
      await waitText(u.page, '知らない人から'); // x is not B's friend
      assert(!(await text(u.page)).includes('あいさんへの手紙'), 'a message for A shows in B');

      // Switch with the title; A's chats come back, B's message does not show there.
      await u.page.getByText('びい ▾').click();
      await u.page.getByRole('button', { name: 'あい', exact: true }).click();
      await waitOpen(u.page);
      await waitText(u.page, 'あい ▾');
      await waitText(u.page, 'あいさんへの手紙');
      t = await text(u.page);
      assert(!t.includes('知らない人から') && !t.includes('びいさんへの手紙'), "B's message shows in A");
      // The open account is remembered across a reload.
      await u.page.reload();
      await waitOpen(u.page);
      await waitText(u.page, 'あい ▾');
      // B still has its message after switching back from settings.
      await openSettings(u.page, 'アカウント');
      await u.page.getByRole('button', { name: 'びい', exact: true }).click();
      await waitOpen(u.page);
      await u.page.getByText('知らない人から').click();
      await waitText(u.page, 'びいさんへの手紙');
      const s = await storage(u.page);
      assert(JSON.parse(s['tegami.messages']).every((m) => m.text !== 'びいさんへの手紙'), "B's message in A's storage");
      await u.context.close();
    });

    await test('Accounts: an account from the earlier version becomes the first one; giving up adding goes back to it', async () => {
      const u = await person(browser, 'まえ');
      const x = generateSecretKey();
      await relaySend(x, wrapTo(x, u.hex, rumorTo(x, u.hex, '前の版からの手紙')));
      await u.page.goto(ORIGIN + '/');
      await waitText(u.page, '知らない人から');
      // The earlier version had no account list.
      await u.page.evaluate(() => localStorage.removeItem('tegami.accounts'));
      const before = await storage(u.page);
      await u.page.reload();
      await waitOpen(u.page);
      await waitText(u.page, '知らない人から');
      const after = await storage(u.page);
      for (const k of ['tegami.device', 'tegami.messages', 'tegami.myName', 'tegami.setupAt'])
        assert(after[k] === before[k], `${k} changed when the account list was made`);

      await openSettings(u.page, 'アカウント');
      await button(u.page, 'アカウントを追加').click();
      await button(u.page, 'キャンセル').click();
      await waitOpen(u.page);
      await waitText(u.page, '知らない人から');
      const left = await storage(u.page);
      assert(!Object.keys(left).some((k) => k.startsWith('tegami@')), `storage left behind: ${Object.keys(left)}`);
      assert(JSON.parse(left['tegami.accounts']).list.length === 1, `account list: ${left['tegami.accounts']}`);
      // Closing the app while adding: the empty account is gone next time, and the first one opens.
      await u.page.goto(ORIGIN + '/settings/account');
      await button(u.page, 'アカウントを追加').click();
      await button(u.page, 'はじめる').waitFor();
      await u.page.evaluate(() => {
        const i = JSON.parse(localStorage.getItem('tegami.accounts'));
        i.current = 'main';
        localStorage.setItem('tegami.accounts', JSON.stringify(i));
      });
      await u.page.reload();
      await waitOpen(u.page);
      assert(JSON.parse((await storage(u.page))['tegami.accounts']).list.length === 1, 'the empty account stayed in the list');
      await u.context.close();
    });

    await test('Accounts: notifications are per account; turning one off keeps the other on the same browser', async () => {
      const u = await newUser(browser, { prf: false });
      await u.context.grantPermissions(['notifications'], { origin: ORIGIN });
      await u.page.addInitScript(() => {
        window.__unsubscribed = 0;
        const sub = {
          endpoint: 'https://fcm.googleapis.com/fcm/send/shared-device',
          toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/shared-device', keys: { p256dh: 'BTESTp256dh', auth: 'TESTauth' } }),
          unsubscribe: async () => {
            window.__unsubscribed++;
            return true;
          },
        };
        PushManager.prototype.subscribe = async () => sub;
        PushManager.prototype.getSubscription = async () => sub;
      });
      await u.page.reload();
      const begin = async () => {
        await button(u.page, 'はじめる').click();
        await button(u.page, 'パスキーを使わずに始める').click();
        await waitOpen(u.page);
      };
      await begin();
      const sw = () => u.page.getByRole('switch', { name: '通知', exact: true });
      const devices = async () => (await (await fetch(`http://localhost:${RELAY_PORT}/_push`)).json()).filter((d) => d.endpoint.endsWith('/shared-device'));
      const until = async (n) => {
        let list = [];
        for (let i = 0; i < 30; i++) {
          list = await devices();
          if (list.length === n) return list;
          await u.page.waitForTimeout(100);
        }
        throw new Error(`expected ${n} registrations, got ${list.length}`);
      };
      await openSettings(u.page);
      await sw().click();
      const [first] = await until(1);
      await u.page.getByRole('button', { name: 'アカウント', exact: true }).last().click();
      await button(u.page, 'アカウントを追加').click();
      await begin();
      await openSettings(u.page);
      assert(!(await sw().isChecked()), 'the second account shows notifications on before turning them on');
      await sw().click();
      const both = await until(2);
      assert(new Set(both.map((d) => d.pubkey)).size === 2 && both.some((d) => d.pubkey === first.pubkey), 'not one registration per account');
      await sw().click();
      const [kept] = await until(1);
      assert(kept.pubkey === first.pubkey, 'the wrong account was removed');
      assert((await u.page.evaluate(() => window.__unsubscribed)) === 0, 'the shared subscription was stopped while the first account uses it');
      // The first account (no name: shown by its short id) still has notifications on.
      await u.page.getByRole('button', { name: 'アカウント', exact: true }).last().click();
      await (NARROW ? u.page : u.page.getByRole('main')).getByRole('button', { name: /^npub1[^（]*$/ }).click();
      await waitOpen(u.page);
      await openSettings(u.page);
      assert(await sw().isChecked(), 'the first account lost its notifications');
      await sw().click();
      await until(0);
      // The relay forgets it first; the subscription stops right after.
      await u.page.waitForFunction(() => window.__unsubscribed === 1, null, { timeout: 5000 }).catch(() => {
        throw new Error('the subscription was not stopped when no account uses it');
      });
      await u.context.close();
    });

    await test('Accounts: a notification says which account it is for, marks it in the list, and opens it', async () => {
      const u = await newUser(browser, { prf: false });
      await u.context.grantPermissions(['notifications'], { origin: ORIGIN });
      // A push straight to the service worker, as the relay would send it (DevTools).
      const sw = await u.context.newCDPSession(u.page);
      const regs = new Map();
      sw.on('ServiceWorker.workerRegistrationUpdated', (e) => {
        for (const r of e.registrations) if (!r.isDeleted) regs.set(r.scopeURL, r.registrationId);
      });
      await sw.send('ServiceWorker.enable');
      const push = async (data) => {
        for (let i = 0; i < 50 && !regs.size; i++) await u.page.waitForTimeout(100);
        assert(regs.size, 'no service worker registration');
        await sw.send('ServiceWorker.deliverPushMessage', { origin: ORIGIN, registrationId: [...regs.values()][0], data: JSON.stringify(data) });
      };
      const notices = () => u.page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag })));
      const clearNotices = () => u.page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).forEach((n) => n.close()));
      const waitNotice = async (pred, what) => {
        for (let i = 0; i < 50; i++) {
          const list = await notices();
          if (list.some(pred)) return list;
          await u.page.waitForTimeout(100);
        }
        throw new Error(`no notification ${what}: ${JSON.stringify(await notices())}`);
      };
      const begin = async (name) => {
        await button(u.page, 'はじめる').click();
        await button(u.page, 'パスキーを使わずに始める').click();
        await waitOpen(u.page);
        await u.page.goto(ORIGIN + '/settings/profile');
        await u.page.getByPlaceholder('相手に表示される名前').fill(name);
        await u.page.waitForTimeout(300);
        // Up to the settings list, then the account page with the list of accounts.
        await button(u.page, '戻る').click();
        await u.page.getByRole('button', { name: 'アカウント', exact: true }).last().click();
        await waitText(u.page, '使用中');
      };
      await begin('えー');
      const key = (name) => u.page.evaluate((n) => JSON.parse(localStorage.getItem('tegami.accounts')).list.find((a) => a.name === n)?.pubkey, name);
      const aKey = await key('えー');
      // One account: the notification is titled Tegami, as before.
      await push({ t: 'message', p: aKey });
      await waitNotice((n) => n.title === 'Tegami' && n.body === '新しいメッセージがあります', 'titled Tegami');
      await clearNotices();

      await button(u.page, 'アカウントを追加').click();
      await begin('びー');
      const bKey = await key('びー');
      // Two accounts: the title is the account's name; a call and a message for different accounts both stay.
      await push({ t: 'message', p: aKey });
      await waitNotice((n) => n.title === 'えー' && n.body === '新しいメッセージがあります', 'titled えー');
      await push({ t: 'call', p: bKey });
      const both = await waitNotice((n) => n.title === 'びー' && n.body === '着信があります', 'titled びー');
      assert(both.length === 2, `one notification replaced the other: ${JSON.stringify(both)}`);
      // The list in settings counts what arrived for the other account (a call does not count;
      // the open account never shows one). A push may tell of several messages (n).
      await u.page.getByRole('button', { name: 'えー（未読 1件）', exact: true }).waitFor({ timeout: 5000 });
      await push({ t: 'message', p: aKey, n: 3 });
      await u.page.getByRole('button', { name: 'えー（未読 4件）', exact: true }).waitFor({ timeout: 5000 });
      await push({ t: 'message', p: bKey });
      await u.page.waitForTimeout(500);
      assert(await u.page.getByRole('button', { name: 'びー（使用中）', exact: true }).isVisible(), 'the open account shows a count');
      // The chat list shows the other accounts' total next to the title.
      await u.page.goto(ORIGIN + '/');
      await waitOpen(u.page);
      await u.page.getByRole('button', { name: /びー ▾/ }).getByLabel('未読 4件').waitFor({ timeout: 5000 });
      await openSettings(u.page);
      // Tapping the notification: the service worker leaves the request in IndexedDB and sends a
      // message. An app that was asleep (iPhone) misses the message and reads the request when it
      // is on screen again; here the request is left and only the screen coming back is signalled.
      const leaveOpenRequest = (p, at) =>
        u.page.evaluate(
          ([p, at]) =>
            new Promise((ok) => {
              const req = indexedDB.open('tegami-sw', 1);
              req.onupgradeneeded = () => req.result.createObjectStore('kv');
              req.onsuccess = () => {
                const tx = req.result.transaction('kv', 'readwrite');
                tx.objectStore('kv').put({ p, at }, 'open');
                tx.oncomplete = ok;
              };
            }),
          [p, at],
        );
      await u.page.goto(ORIGIN + '/');
      await waitOpen(u.page);
      await leaveOpenRequest(aKey, Date.now() - 5 * 60_000); // an old tap: ignored
      await u.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await u.page.waitForTimeout(800);
      await waitText(u.page, 'びー ▾');
      // The screen comes back first and the request is written a moment later (both are woken
      // by the same tap): the app looks again for a few seconds.
      await u.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await u.page.waitForTimeout(700);
      await leaveOpenRequest(aKey, Date.now());
      await waitOpen(u.page);
      await waitText(u.page, 'えー ▾');
      // The request is used once: coming back to the screen again stays on A after switching to B.
      await u.page.getByText('えー ▾').click();
      await u.page.getByRole('button', { name: /^びー/ }).click();
      await waitOpen(u.page);
      await u.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await u.page.waitForTimeout(800);
      await waitText(u.page, 'びー ▾');
      // The message path (app awake): the request plus a message opens the account at once.
      await leaveOpenRequest(aKey, Date.now());
      await u.page.evaluate((p) => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { tegami: 'open', p } })), aKey);
      await waitOpen(u.page);
      await waitText(u.page, 'えー ▾');
      // Seen: back on B, A is no longer marked.
      await openSettings(u.page, 'アカウント');
      await u.page.getByRole('button', { name: 'びー', exact: true }).click();
      await waitOpen(u.page);
      await openSettings(u.page, 'アカウント');
      await u.page.getByRole('button', { name: 'えー', exact: true }).waitFor();
      // Tapping it while the app is closed opens /?a=<key>: that account, and the address goes back to /.
      await push({ t: 'message', p: aKey });
      await u.page.getByRole('button', { name: 'えー（未読 1件）', exact: true }).waitFor({ timeout: 5000 });
      await u.page.goto(`${ORIGIN}/?a=${aKey}`);
      await waitOpen(u.page);
      await waitText(u.page, 'えー ▾');
      assert(!u.page.url().includes('a='), `the key stayed in the address: ${u.page.url()}`);
      // A key that is not on this device changes nothing.
      await u.page.goto(`${ORIGIN}/?a=${'0'.repeat(64)}`);
      await waitOpen(u.page);
      await waitText(u.page, 'えー ▾');
      // The test notifications show on the real desktop (Windows): close them.
      await clearNotices();
      await u.context.close();
    });
    await test('Registration: an invite link registers as invited and carries my code; without one, only friends get my messages', async () => {
      const members = async () => (await (await fetch(`http://localhost:${RELAY_PORT}/_members`)).json());
      const via = async (hex) => (await members()).find((m) => m.pubkey === hex)?.via;
      // A: registered as invited. Its invite link carries its code.
      const a = await person(browser, 'えー');
      await a.page.waitForFunction(() => /&c=[a-z2-9]+/.test(document.body.innerText), null, { timeout: 10000 });
      a.link = (await text(a.page)).match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0];
      assert(/&c=[a-z2-9]{6,}/.test(a.link), `no code in the invite link: ${a.link}`);
      assert((await via(a.hex)) === 'invite', 'A is not registered as invited');
      // B starts without an invite: an open key, and no code to hand out.
      await devOpen(true);
      try {
        const b = await person(browser, 'びー');
        await b.page.waitForTimeout(1500);
        assert((await via(b.hex)) === 'open', `B is ${await via(b.hex)}, not open`);
        assert(!/&c=/.test(await text(b.page)), 'an open key shows an invite code');
        // B writes to A, who has not added B: A never sees it, not even under 知らない人から.
        await befriend(b, a.link.replace(/&c=[a-z2-9]+/, ''));
        await b.page.getByPlaceholder('メッセージ').fill('知らない人からの手紙');
        await button(b.page, '送る').click();
        await b.page.waitForFunction(() => !document.body.innerText.includes('未送信'), null, { timeout: 10000 });
        const envelopes = await envelopesFor(a.hex);
        assert(envelopes.some((e) => e.tegami_open === 1), 'the relay did not mark the envelope');
        await a.page.goto(ORIGIN + '/');
        await waitOpen(a.page);
        await noText(a.page, '知らない人から', 2500);
        // Once A adds B, B's messages arrive.
        await befriend(a, b);
        await b.page.getByPlaceholder('メッセージ').fill('友達になった後の手紙');
        await button(b.page, '送る').click();
        await waitText(a.page, '友達になった後の手紙');
        assert(!(await text(a.page)).includes('知らない人からの手紙'), 'the message from before A added B showed up');
        // C opens A's invite link: registered as invited by A, even though C starts a new account.
        const c = await newUser(browser, { prf: false });
        await c.page.goto(a.link.replace('https://app.tegami.chat', ORIGIN));
        await button(c.page, 'はじめる').click();
        await button(c.page, 'パスキーを使わずに始める').click();
        await waitText(c.page, 'マイQRコード');
        const cLink = (await text(c.page)).match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0];
        const cHex = nip19.decode(cLink.match(/npub1[0-9a-z]+/)[0]).data;
        for (let i = 0; i < 30 && (await via(cHex)) !== 'invite'; i++) await c.page.waitForTimeout(200);
        const cRow = (await members()).find((m) => m.pubkey === cHex);
        assert(cRow?.via === 'invite' && cRow.invitedBy === a.hex, `C is ${JSON.stringify(cRow)}`);
        // B adds A with A's full link (with the code): B becomes invited too.
        // (A is already B's friend: the button renames, and the code still registers B.)
        await b.page.goto(ORIGIN + '/add');
        await waitText(b.page, 'マイQRコード');
        await b.page.getByPlaceholder('https://app.tegami.chat/i#npub…').fill(a.link);
        await button(b.page, '名前を変える').click();
        for (let i = 0; i < 30 && (await via(b.hex)) !== 'invite'; i++) await b.page.waitForTimeout(200);
        assert((await via(b.hex)) === 'invite', "B did not become invited with A's code");
        for (const u of [b, c]) await u.context.close();
      } finally {
        await devOpen(false);
      }
      await a.context.close();
    });

    await test('AI permissions: layered switches, a layer above locks the one below, and they are kept per account', async () => {
      const a = await person(browser, 'あおい');
      const b = await person(browser, 'テストB');
      await befriend(a, b);
      const aiKey = generateSecretKey();
      const aiLink = `${ORIGIN}/i#${nip19.npubEncode(getPublicKey(aiKey))}&n=${encodeURIComponent('クロード')}&m=${encodeURIComponent('Anthropic Claude')}`;
      await befriendMyAi(a, aiLink);
      const p = a.page;
      const perms = () => p.evaluate(() => JSON.parse(localStorage.getItem('tegami.ai.permissions') || 'null'));
      const sw = (name) => p.getByRole('switch', { name, exact: true });

      // Settings → AIの権限: every switch starts off, and the settings row says so.
      await p.goto(ORIGIN + '/settings');
      await p.getByTestId('ai-permissions-state').waitFor();
      assert((await p.getByTestId('ai-permissions-state').innerText()) === 'すべてオフ', 'the settings row does not say all off');
      await shot(p, 'settings-top', '設定の一覧。分野ごとの行と、今の状態');
      await p.getByRole('button', { name: 'AI', exact: true }).last().click();
      await waitText(p, '相手のAI');
      await shot(p, 'settings-ai', 'AIの画面の先頭。自分のAIの説明');
      await waitText(p, 'AIの使用');
      await waitText(p, 'AI友だち');
      await waitText(p, 'AIモデル');
      await waitText(p, '友だち');
      for (const name of ['友だちの一覧を見る', 'トークを読む', '確認なしで送る'])
        assert(!(await sw(name).isChecked()), `${name} starts on`);
      await shot(p, 'ai-permissions', 'AIの権限：すべて最初はオフ');

      // A friend's switch is locked while "all AI" has it off.
      await p.getByText('テストB', { exact: true }).click();
      await waitText(p, 'テストBとのトークでAIができること');
      assert(await sw('トークを読む').isDisabled(), 'friend switch can be turned on while all AI is off');
      await waitText(p, '「AIの使用」でオフになっています');
      await p.goBack();
      await sw('トークを読む').click();
      assert((await perms()).all.read === true, 'all.read was not saved');
      await shot(p, 'ai-permissions-on', 'AIの権限：AIの使用でトークを読むをオン');
      await p.getByText('テストB', { exact: true }).click();
      await waitText(p, 'テストBとのトークでAIができること');
      assert(!(await sw('トークを読む').isDisabled()), 'friend switch still locked');
      assert(!(await sw('トークを読む').isChecked()), 'a friend is picked before the user picks them');
      await sw('トークを読む').click();
      assert((await perms()).friends[b.hex].read === true, 'friend read was not saved');
      await shot(p, 'ai-permissions-friend', 'AIの権限：友だちごとの画面');
      await p.goBack();

      // An AI follows "all AI" until turned off; turning the model off locks it.
      await p.getByText('クロード', { exact: true }).click();
      await waitText(p, 'できること');
      assert(await sw('トークを読む').isChecked(), 'the AI does not follow all AI');
      await shot(p, 'ai-permissions-ai', 'AIの権限：AI ごとの画面');
      await p.goBack();
      await p.getByText('Anthropic Claude', { exact: true }).last().click();
      await sw('トークを読む').click();
      await p.goBack();
      await p.getByText('クロード', { exact: true }).click();
      assert(await sw('トークを読む').isDisabled(), 'the AI switch is not locked by its model');
      await waitText(p, '「Anthropic Claude」でオフになっています');
      await shot(p, 'ai-permissions-locked', 'AIの権限：モデルでオフになった AI');
      await p.goBack();

      // "Stop all AI" turns every all-AI switch off.
      await button(p, 'すべてオフにする').click();
      assert(Object.values((await perms()).all).every((v) => v === false), 'stop all AI left a switch on');
      await p.getByText('AIの記録', { exact: true }).click();
      await waitText(p, 'まだ記録はありません');
      await shot(p, 'ai-log', 'AIの記録（まだ空）');

      // The chat info of a friend and of the AI open their own page.
      await p.goto(ORIGIN + '/');
      await p.getByText('テストB').first().click();
      await p.getByRole('button', { name: 'メニュー' }).click();
      await p.getByText('AIの権限', { exact: true }).click();
      await waitText(p, 'テストBとのトークでAIができること');
      for (const u of [a, b]) await u.context.close();
    });

    await test('AI permission levels: how long a switch stays on, read only in one go, asking once before sending without asking, and the confirm window', async () => {
      const a = await person(browser, 'あおい');
      const b = await person(browser, 'テストB');
      await befriend(a, b);
      const aiKey = generateSecretKey();
      const aiHex = getPublicKey(aiKey);
      await befriendMyAi(a, `${ORIGIN}/i#${nip19.npubEncode(aiHex)}&n=${encodeURIComponent('クロード')}&m=${encodeURIComponent('Anthropic Claude')}`);
      const p = a.page;
      const perms = () => p.evaluate(() => JSON.parse(localStorage.getItem('tegami.ai.permissions') || 'null'));
      const sw = (name) => p.getByRole('switch', { name, exact: true });
      const chip = (name) => p.getByRole('radio', { name, exact: true });
      const confirmShown = () => p.getByTestId('ai-confirm').isVisible().catch(() => false);
      /** Starts an AI request through the gate; returns a function that waits for its answer. */
      const ask = async (r) => {
        await p.evaluate((r) => {
          window.__answer = window.__tegamiAskAi(r);
        }, { ai: aiHex, model: 'Anthropic Claude', ...r });
        return () => p.evaluate(() => window.__answer);
      };

      // Read only in one go.
      await p.goto(ORIGIN + '/ai');
      await waitText(p, 'AIの使用');
      await button(p, '読むと下書きだけにする').click();
      let now = await perms();
      assert(now.all.contacts === true && now.all.read === true && now.all.draft === true, 'read only did not turn reading on');
      assert(!now.all.send && !now.all.autosend && !now.all.otherAi, 'read only turned sending on');
      assert(!(await button(p, '読むと下書きだけにする').isVisible().catch(() => false)), 'the read-only button stays while already read only');

      // How long: a switch that is on shows its term; one hour sets a time limit.
      await chip('トークを読む：1時間').click();
      now = await perms();
      assert(typeof now.all.read?.until === 'number' && now.all.read.until > Date.now() / 1000 + 3500, 'one hour was not saved');
      await waitText(p, 'まで');
      await shot(p, 'ai-terms', 'AIの使用：オンのスイッチの下に「ずっと」「今日だけ」「1時間」「毎回確認」。1時間を選ぶと終わる時刻が出る');
      await chip('トークを読む：ずっと').click();
      assert((await perms()).all.read === true, 'back to always');

      // Turning "send without asking" on asks once; cancel leaves it off.
      await sw('確認してから送る').click();
      await sw('確認なしで送る').click();
      await waitText(p, '「確認なしで送る」をオンにしますか？');
      await shot(p, 'ai-autosend-confirm', '「確認なしで送る」をオンにする時に1回だけ出る確認');
      await button(p, 'キャンセル').click();
      assert(!(await perms()).all.autosend, 'cancel turned it on');
      await sw('確認なしで送る').click();
      await button(p, 'オンにする').click();
      assert((await perms()).all.autosend === true, 'autosend was not turned on');

      // テストB: read only, then sending (sending without asking asks once there too, with the name).
      await p.getByText('テストB', { exact: true }).click();
      await waitText(p, 'テストBとのトークでAIができること');
      await button(p, '読むと下書きだけにする').click();
      await sw('確認してから送る').click();
      await sw('確認なしで送る').click();
      await waitText(p, 'あなたの名前でテストBに');
      await button(p, 'オンにする').click();
      now = await perms();
      assert(now.friends[b.hex].read === true && now.friends[b.hex].autosend === true, 'friend switches not saved');

      // Plain text goes without a window; a photo and money always ask, with to whom and what.
      await p.goto(ORIGIN + '/ai');
      await waitText(p, 'AIの使用');
      // readOthers: false = the AI's session has read only the owner's own words (Rule of Two).
      let answer = await ask({ action: 'autosend', friend: b.hex, readOthers: false, content: { kind: 'text', text: '明日の10時でどう？' } });
      assert((await answer()) === true && !(await confirmShown()), 'plain text was asked');
      // After reading someone else's words (or not saying), sending without asking asks first.
      answer = await ask({ action: 'autosend', friend: b.hex, content: { kind: 'text', text: '明日の10時でどう？' } });
      await p.getByTestId('ai-confirm').waitFor();
      await waitText(p, 'クロードが送ろうとしています');
      // The window says why it came up although 確認なしで送る is on.
      await waitText(p, 'ほかの人が書いた文を読んだ後は、毎回確かめてから送ります');
      await shot(p, 'ai-confirm-others', 'ほかの人の文を読んだAIが確認なしで送ろうとした時の確認');
      await button(p, '送らない').click();
      assert((await answer()) === false, 'refusing after reading others still sent');
      answer = await ask({ action: 'autosend', friend: b.hex, readOthers: false, content: { kind: 'photo' } });
      await p.getByTestId('ai-confirm').waitFor();
      await waitText(p, 'クロードが送ろうとしています');
      await waitText(p, '宛先');
      await waitText(p, '写真、動画、ファイル、音声、リンク、お金の話に見える文は、毎回確かめてから送ります');
      await shot(p, 'ai-confirm-photo', 'AI が写真を確認なしで送ろうとした時の確認（宛先と中身を大きく出す）');
      await button(p, '送る').click();
      assert((await answer()) === true, 'sending the photo was not allowed');
      answer = await ask({ action: 'autosend', friend: b.hex, readOthers: false, content: { kind: 'text', text: '3000円を振り込んでください' } });
      await waitText(p, '3000円を振り込んでください');
      await shot(p, 'ai-confirm-money', 'AI がお金の話を確認なしで送ろうとした時の確認');
      await button(p, '送らない').click();
      assert((await answer()) === false, 'refusing still sent');

      // Another person's AI: asked the first time with its name and model, then kept.
      await sw('ほかの人のAIと話す').click();
      const peer = { pubkey: 'e'.repeat(64), name: 'テストCのAI', model: 'OpenAI GPT' };
      answer = await ask({ action: 'otherAi', peer });
      await waitText(p, 'クロードがほかの人のAIと話そうとしています');
      await waitText(p, 'OpenAI GPT');
      await shot(p, 'ai-confirm-peer', '自分の AI が初めてほかの人のAIと話す時の確認');
      await button(p, '30日間許可').click();
      assert((await answer()) === true, 'the other AI was not allowed');
      assert((await perms()).peerAis[`${aiHex}>${'e'.repeat(64)}`]?.until > Date.now() / 1000 + 29 * 86400, '30 days were not kept');
      answer = await ask({ action: 'otherAi', peer });
      assert((await answer()) === true && !(await confirmShown()), 'asked again for the same AI');

      // Ask each time.
      await chip('トークを読む：毎回確認').click();
      answer = await ask({ action: 'read', friend: b.hex });
      await waitText(p, 'クロードがトークを読もうとしています');
      await button(p, '今回だけ許可').click();
      assert((await answer()) === true, 'once was not allowed');

      // A time limit that has passed: the switch is turned off and the log says so.
      await p.evaluate(() => {
        const v = JSON.parse(localStorage.getItem('tegami.ai.permissions'));
        v.all.contacts = { until: Math.floor(Date.now() / 1000) - 5 };
        localStorage.setItem('tegami.ai.permissions', JSON.stringify(v));
      });
      await p.reload();
      await waitText(p, 'AIの使用');
      await p.waitForFunction(() => JSON.parse(localStorage.getItem('tegami.ai.permissions')).all.contacts === false, null, { timeout: 5000 });
      await p.getByText('AIの記録', { exact: true }).click();
      await waitText(p, '期間が終わったため、自動でオフに戻しました');
      await waitText(p, '写真、動画、ファイル、音声、リンク、お金の話に見える文は確認：許可しました');
      await waitText(p, '初めて話すほかの人のAI：許可しました');
      await waitText(p, 'クロード：ほかの人のAIと話す（テストCのAI）');
      assert(!(await p.getByText(/npub1/).count()), 'the log shows the other AI by its key');
      await waitText(p, 'クロード：メッセージを送る（テストB）');
      await shot(p, 'ai-log-levels', 'AIの記録：確認の答えと、期間が終わったスイッチ');
      for (const u of [a, b]) await u.context.close();
    });

    await test('AI permissions move with the account: the link to another device and the recovery code carry them, the log stays', async () => {
      const a = await person(browser, 'あおい');
      const b = await person(browser, 'テストB');
      await befriend(a, b);
      const aiLink = `${ORIGIN}/i#${nip19.npubEncode(getPublicKey(generateSecretKey()))}&n=${encodeURIComponent('クロード')}&m=${encodeURIComponent('Anthropic Claude')}`;
      await befriendMyAi(a, aiLink);
      const p = a.page;
      const perms = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('tegami.ai.permissions') || 'null'));
      // The same settings, whatever order the switches were turned in.
      const same = (x, y) => {
        const sorted = (v) => (v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, sorted(v[key])])) : v);
        return JSON.stringify(sorted(x)) === JSON.stringify(sorted(y));
      };
      const log = (page) => page.evaluate(() => localStorage.getItem('tegami.ai.log'));
      const sw = (name) => p.getByRole('switch', { name, exact: true });

      // All AI may read; for テストB too; the Anthropic Claude model may not.
      await p.goto(ORIGIN + '/ai');
      await waitText(p, 'AIの使用');
      await sw('トークを読む').click();
      await p.getByText('テストB', { exact: true }).click();
      await waitText(p, 'テストBとのトークでAIができること');
      await sw('トークを読む').click();
      await p.goBack();
      await p.getByText('Anthropic Claude', { exact: true }).last().click();
      await sw('トークを読む').click();
      await p.goBack();
      const want = await perms(p);
      assert(want.all.read === true && want.friends[b.hex].read === true && want.models['Anthropic Claude'].read === false, 'settings were not saved');
      // A decision log on this device: it must not move.
      await p.evaluate(() => localStorage.setItem('tegami.ai.log', JSON.stringify([{ at: 1, ai: 'x', action: 'read', allowed: false, stoppedBy: 'all' }])));

      // The 10-minute link brings the settings, not the log.
      await p.goto(ORIGIN + '/settings/account');
      await p.getByText('別の端末でも使う').click();
      await waitText(p, 'まで使えます');
      const moveLink = (await text(p)).match(/http:\/\/localhost:\d+\/link#k=[A-Za-z0-9_-]+/)?.[0];
      assert(moveLink, 'no moving link');
      const a2 = await newUser(browser, { prf: false });
      await a2.page.goto(moveLink);
      await button(a2.page, 'この端末で使う').click();
      await button(a2.page, 'パスキーを使わずに始める').click();
      await waitOpen(a2.page);
      assert(same(await perms(a2.page), want), 'the AI settings did not move with the link');
      assert((await log(a2.page)) === null, 'the AI log moved with the link');
      await a2.page.goto(ORIGIN + '/ai');
      await waitText(a2.page, 'AIの使用');
      assert(await a2.page.getByRole('switch', { name: 'トークを読む', exact: true }).isChecked(), 'the screen on the new device shows it off');
      await a2.context.close();
      await p.getByText('閉じる').click().catch(() => {});

      // The recovery backup carries them, and follows a change made after the code was made.
      await p.goto(ORIGIN + '/settings/account');
      await button(p, '復旧コードを作成').click();
      await waitText(p, 'このコードは今だけ表示されます');
      const code = (await p.getByTestId('recovery-code').innerText()).trim();
      await button(p, '保管しました').click();
      const backupData = async () => (await (await fetch(`http://localhost:${RELAY_PORT}/_backups`)).json())[0]?.data;
      const before = await backupData();
      assert(before, 'no backup on the relay');
      await p.goto(ORIGIN + '/ai');
      await waitText(p, 'AIの使用');
      await sw('友だちの一覧を見る').click();
      for (let i = 0; i < 100 && (await backupData()) === before; i++) await p.waitForTimeout(100);
      assert((await backupData()) !== before, 'the backup was not refreshed after an AI switch changed');
      const after = await perms(p);
      assert(after.all.contacts === true, 'the new switch was not saved');

      const r = await newUser(browser, { prf: false });
      await button(r.page, '復旧コードを使う').click();
      await r.page.getByPlaceholder('復旧コード').fill(code);
      await button(r.page, '復旧').click();
      await waitText(r.page, '受け取りました');
      await button(r.page, 'この端末で使う').click();
      await button(r.page, 'パスキーを使わずに始める').click();
      await waitOpen(r.page);
      assert(same(await perms(r.page), after), 'the AI settings did not come back with the recovery code');
      assert((await log(r.page)) === null, 'the AI log came back with the recovery code');
      await r.context.close();

      // Turn recovery off again so other tests see an empty relay.
      await p.goto(ORIGIN + '/settings/account');
      await button(p, '復旧コードを削除').click();
      await waitText(p, '復旧コードを作成');
      for (const u of [a, b]) await u.context.close();
    });

    await test('AI draft: only when allowed, the AI reads that chat and its draft lands in the composer, unsent', async () => {
      const AGENT = join(ROOT, '../agent');
      const home = mkdtempSync(join(tmpdir(), 'tegami-agent-'));
      const env = { ...process.env, TEGAMI_AGENT_HOME: home, TEGAMI_RELAYS: `ws://localhost:${RELAY_PORT}` };
      const cli = (...a) => execFileSync(process.execPath, [join(AGENT, 'agent.mjs'), ...a], { env, encoding: 'utf8' });
      let watch;
      try {
        const a = await person(browser, 'あおい');
        const b = await person(browser, 'テストB');
        const st = await person(browser, 'しらない');
        const p = a.page;
        const aiLink = cli('init', '--name', 'クロード', '--model', 'Anthropic Claude').match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0];
        const aiHex = nip19.decode(aiLink.match(/npub1[0-9a-z]+/)[0]).data;
        await befriendMyAi(a, aiLink.replace('https://app.tegami.chat', ORIGIN));
        await p.goto(ORIGIN + '/add');
        await p.waitForFunction(() => /&c=[a-z2-9]+/.test(document.body.innerText), null, { timeout: 10000 });
        cli('add', (await text(p)).match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0], '--name', 'あおい', '--trust');
        watch = spawn(process.execPath, [join(AGENT, 'agent.mjs'), 'watch', '--command', `node "${join(AGENT, 'test/echo.mjs')}"`], { env, stdio: 'pipe' });
        await new Promise((r) => watch.stdout.once('data', r));

        await befriend(b, a);
        await b.page.getByPlaceholder('メッセージ').fill('あした映画いく？');
        await button(b.page, '送る').click();
        await befriend(a, b);
        await waitText(p, 'あした映画いく？');
        await p.getByPlaceholder('メッセージ').fill('いいね');
        await button(p, '送る').click();
        await waitText(b.page, 'いいね');

        const ASK = 'クロードに下書きを頼む';
        const toAi = async () => (await envelopesFor(aiHex)).length;
        const composer = () => p.getByPlaceholder('メッセージ');
        const openPlus = async () => {
          await button(p, 'その他').click();
          await p.getByTestId('plus-panel').waitFor();
        };
        const plusShut = async () => {
          if (await p.getByTestId('plus-panel').count()) await button(p, 'その他').click();
        };

        // Every switch off: no way to ask, and nothing goes to the AI.
        const before = await toAi();
        await openPlus();
        assert((await button(p, ASK).count()) === 0, 'the ask button shows while the switches are off');
        await plusShut();

        // "All AI" on for reading and drafting, but not yet for this friend: still nothing.
        await p.goto(ORIGIN + '/ai');
        const sw = (name) => p.getByRole('switch', { name, exact: true });
        await sw('トークを読む').click();
        await sw('返信の下書きを作る').click();
        await p.goto(ORIGIN + `/chat/${b.hex}`);
        await openPlus();
        assert((await button(p, ASK).count()) === 0, 'the ask button shows before the friend is picked');
        await plusShut();
        await p.goto(ORIGIN + '/ai');
        await p.getByText('テストB', { exact: true }).click();
        await waitText(p, 'テストBとのトークでAIができること');
        await sw('トークを読む').click();
        await sw('返信の下書きを作る').click();

        // Allowed: the first ask tells once that the chat leaves Tegami's encryption.
        await p.goto(ORIGIN + `/chat/${b.hex}`);
        await waitText(p, 'あした映画いく？');
        await openPlus();
        await shot(p, 'ai-draft-plus', '＋を押した時。AIの権限で許した時だけ「クロードに下書きを頼む」が出る');
        await button(p, ASK).click();
        await waitText(p, 'AIにトークを読ませますか？');
        await shot(p, 'ai-draft-notice', '最初の1回だけ出るお知らせ');
        await button(p, 'キャンセル').click();
        assert((await toAi()) === before, 'something went to the AI after キャンセル');
        await openPlus();
        await button(p, ASK).click();
        await button(p, '読ませる').click();
        await p.waitForFunction(() => document.querySelector('textarea[placeholder="メッセージ"]')?.value.startsWith('echo:'), null, { timeout: 15000 });
        const drafted = await composer().inputValue();
        assert(drafted === 'echo: テストB: あした映画いく？\nあおい: いいね', `the draft: ${JSON.stringify(drafted)}`);
        assert((await toAi()) === before + 1, 'not exactly one ask went to the AI');
        // The composer grows to show every line of the draft, up to a limit, and shrinks back.
        const inputBox = () => p.evaluate(() => {
          const el = document.querySelector('textarea[placeholder="メッセージ"]');
          return { h: el.offsetHeight, w: el.offsetWidth, hidden: el.scrollHeight > el.clientHeight };
        });
        const two = await inputBox();
        assert(two.h >= 64 && !two.hidden, `a two-line draft: ${JSON.stringify(two)}`);
        await shot(p, 'ai-draft-filled', 'AI の下書きが入力欄に入った。送るボタンを押すまで送られない');

        // The draft is not sent: it reaches neither the friend nor this chat.
        await p.waitForTimeout(2500);
        assert(!(await text(b.page)).includes('echo:'), 'the draft was sent to the friend');
        const mine = await p.evaluate(() => JSON.parse(localStorage.getItem('tegami.messages') || '[]'));
        assert(!mine.some((m) => m.text.startsWith('echo:')), 'the draft was added as a message');
        assert(!(await envelopesFor(b.hex)).some((e) => e.created_at >= Math.floor(Date.now() / 1000) - 5), 'something new went to the friend');

        await composer().fill(Array.from({ length: 12 }, (_, i) => `行${i + 1}`).join('\n'));
        const many = await inputBox();
        assert(many.h <= 140 && many.h >= 130, `twelve lines stop growing at the limit: ${JSON.stringify(many)}`);
        // While writing, +, camera and photo fold into one ">" so the text field is wider (as LINE does).
        assert((await button(p, 'カメラ').count()) === 0, 'the camera button stays while writing');
        const narrowW = (await inputBox()).w;
        await shot(p, 'composer-many-lines', '12行を入れた時。左のボタンは「>」1つにたたまれ、入力欄は決まった高さで止まり、中を動かして読む');
        await button(p, 'ボタンを表示').click();
        await button(p, 'カメラ').waitFor({ timeout: 5000 });
        assert((await inputBox()).w < narrowW, 'the field did not get narrower when the buttons came back');
        await shot(p, 'composer-tools-shown', '「>」を押すと、＋、カメラ、写真のボタンが戻る');
        await composer().fill('');
        await button(p, 'カメラ').waitFor({ timeout: 5000 });
        const empty = await inputBox();
        assert(empty.h === 44, `an empty composer goes back to one line: ${JSON.stringify(empty)}`);

        // The second ask asks nothing first.
        await openPlus();
        await button(p, ASK).click();
        assert((await p.getByTestId('dialog').count()) === 0, 'the notice showed twice');
        await p.waitForFunction(() => document.querySelector('textarea[placeholder="メッセージ"]')?.value.startsWith('echo:'), null, { timeout: 15000 });
        await composer().fill('');

        // Turned off in another tab: the gate here stops it at once, and the button goes away.
        const p2 = await a.context.newPage();
        await p2.goto(ORIGIN + '/');
        const sent = await toAi();
        await openPlus();
        await p2.evaluate((hex) => {
          const s = JSON.parse(localStorage.getItem('tegami.ai.permissions'));
          s.friends[hex].read = false;
          localStorage.setItem('tegami.ai.permissions', JSON.stringify(s));
        }, b.hex);
        await button(p, ASK).click();
        await waitText(p, 'AIの権限で止めました');
        await p.waitForTimeout(1000);
        assert((await toAi()) === sent, 'the AI got the chat after the switch was turned off');
        await openPlus();
        assert((await button(p, ASK).count()) === 0, 'the ask button still shows after the switch was turned off');
        await plusShut();
        await p2.close();

        // The log: what was handed over, and when it was stopped.
        await p.goto(ORIGIN + '/ai/log');
        await waitText(p, '渡したメッセージ：2通');
        await waitText(p, '止めました：この友だちの設定でオフ');
        await shot(p, 'ai-draft-log', 'AIの記録。読ませたメッセージの数と時刻');

        // A stranger's chat: never, even with a friend switch stored for them.
        await p.evaluate((hex) => {
          const s = JSON.parse(localStorage.getItem('tegami.ai.permissions'));
          s.friends[hex] = { read: true, draft: true };
          localStorage.setItem('tegami.ai.permissions', JSON.stringify(s));
        }, st.hex);
        await befriend(st, a);
        await st.page.getByPlaceholder('メッセージ').fill('おかねかして');
        await button(st.page, '送る').click();
        await p.goto(ORIGIN + `/chat/${st.hex}`);
        await waitText(p, 'おかねかして');
        await openPlus();
        assert((await button(p, ASK).count()) === 0, "the ask button shows in a stranger's chat");
        for (const u of [a, b, st]) await u.context.close();
      } finally {
        watch?.kill();
        rmSync(home, { recursive: true, force: true });
      }
    });

    // ---------- AI friends acting through the gate (lib/ai-actions.ts) ----------
    // A stand-in AI: its own key, asking its owner's app the way tegami-agent does.
    const fakeAi = async (owner, name = 'クロード', model = 'Anthropic Claude', mine = true) => {
      const sk = generateSecretKey();
      const hex = getPublicKey(sk);
      await devTrust(sk);
      const link = `${ORIGIN}/i#${nip19.npubEncode(hex)}&n=${encodeURIComponent(name)}&m=${encodeURIComponent(model)}`;
      await (mine ? befriendMyAi(owner, link) : befriend(owner, link));
      /** Sends one ask to the owner's app (expires like the app's own asks). Returns its id. */
      const ask = async (kind, data, from = sk) => {
        const now = Math.floor(Date.now() / 1000);
        // A send ask says the AI read only the owner's words, unless a test says otherwise (Rule of Two).
        // Two asks with the same words in the same second would be the same rumor (one id): a nonce keeps them apart.
        const rumor = nip59.createRumor({ kind, content: JSON.stringify({ v: 1, ...(kind === 25062 ? { readOthers: false } : {}), ...data, n: Math.random() }), tags: [['p', owner.hex]], created_at: now }, from);
        const seal = nip59.createSeal(rumor, from, owner.hex);
        const key = generateSecretKey();
        const wrap = finalizeEvent(
          { kind: 1059, created_at: now, tags: [['p', owner.hex], ['expiration', String(now + 600)]], content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(key, owner.hex)) },
          key,
        );
        await relaySend(from, wrap);
        return rumor.id;
      };
      /** The owner's app's answer to ask `re` (with status `want` when given: an ask may be answered twice). */
      const answer = async (kind, re, want) => {
        const hit = (r) => r.kind === kind && JSON.parse(r.content).re === re && (!want || JSON.parse(r.content).status === want);
        const got = await inboxOf(sk, (rs) => rs.some(hit)).catch(() => inboxOf(sk));
        const found = got.filter(hit).pop() ?? got.filter((r) => r.kind === kind && JSON.parse(r.content).re === re).pop();
        return found ? JSON.parse(found.content) : {};
      };
      return { sk, hex, ask, answer };
    };
    const setPerms = (page, update) =>
      page.evaluate((u) => {
        const s = JSON.parse(localStorage.getItem('tegami.ai.permissions') || '{"all":{},"models":{},"ais":{},"friends":{},"peerAis":{}}');
        for (const [layer, v] of Object.entries(u)) {
          if (layer === 'all') Object.assign(s.all, v);
          else for (const [id, sw] of Object.entries(v)) s[layer][id] = { ...s[layer][id], ...sw };
        }
        localStorage.setItem('tegami.ai.permissions', JSON.stringify(s));
      }, update);
    const storedTexts = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('tegami.messages') || '[]').map((m) => m.text));

    await test('AI opt-out: a marked message and a friend who says no stay out of drafts; the choice reaches my other device', async () => {
      const AGENT = join(ROOT, '../agent');
      const home = mkdtempSync(join(tmpdir(), 'tegami-agent-'));
      const env = { ...process.env, TEGAMI_AGENT_HOME: home, TEGAMI_RELAYS: `ws://localhost:${RELAY_PORT}` };
      const cli = (...args) => execFileSync(process.execPath, [join(AGENT, 'agent.mjs'), ...args], { env, encoding: 'utf8' });
      let watch;
      try {
        const a = await person(browser, 'あおい');
        const b = await person(browser, 'テストB');
        const p = a.page;
        const aiLink = cli('init', '--name', 'クロード', '--model', 'Anthropic Claude').match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0];
        const aiHex = nip19.decode(aiLink.match(/npub1[0-9a-z]+/)[0]).data;
        await befriendMyAi(a, aiLink.replace('https://app.tegami.chat', ORIGIN));
        await p.goto(ORIGIN + '/add');
        await p.waitForFunction(() => /&c=[a-z2-9]+/.test(document.body.innerText), null, { timeout: 10000 });
        cli('add', (await text(p)).match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0], '--name', 'あおい', '--trust');
        watch = spawn(process.execPath, [join(AGENT, 'agent.mjs'), 'watch', '--command', `node "${join(AGENT, 'test/echo.mjs')}"`], { env, stdio: 'pipe' });
        await new Promise((r) => watch.stdout.once('data', r));
        await setPerms(p, { all: { read: true, draft: true }, friends: { [b.hex]: { read: true, draft: true } } });

        // テストB writes one plain message, then one with this chat's「AIに読ませない」on.
        await befriend(b, a);
        const bp = b.page;
        await bp.getByPlaceholder('メッセージ').fill('ふつうの文');
        await button(bp, '送る').click();
        await button(bp, 'その他').click();
        await bp.getByTestId('plus-panel').waitFor();
        await shot(bp, 'noai-plus', '＋を押した時。「AIに読ませない」の切り替え');
        await bp.getByRole('switch', { name: 'AIに読ませない', exact: true }).click();
        await bp.getByTestId('noai-here').waitFor();
        await bp.getByPlaceholder('メッセージ').fill('ひみつの文');
        await shot(bp, 'noai-here', 'このトークで「AIに読ませない」をオンにした時。入力欄の上に出る');
        await button(bp, '送る').click();
        await bp.getByTestId('noai-mark').waitFor();
        // Settings lists the chat under「相手のAI」, and 解除 there turns the chat's switch off.
        await bp.goto(ORIGIN + '/ai');
        await waitText(bp, 'AIに読ませないトーク');
        assert((await bp.getByTestId('noai-chat').count()) === 1, 'settings does not list the one chat');
        await bp.getByTestId('noai-chat').scrollIntoViewIfNeeded();
        await shot(bp, 'noai-chats', '設定の「相手のAI」。AIに読ませないトークの一覧');
        await bp.getByTestId('noai-chat').getByRole('button', { name: /解除/ }).click();
        assert((await bp.getByTestId('noai-chat').count()) === 0, 'the chat stays in the list after 解除');
        await bp.goto(ORIGIN + `/chat/${a.hex}`);
        await waitText(bp, 'ひみつの文');
        assert((await bp.getByTestId('noai-here').count()) === 0, 'the chat is still marked after 解除 in settings');
        await bp.getByPlaceholder('メッセージ').fill('またふつう');
        await button(bp, '送る').click();
        await waitText(bp, 'またふつう');
        assert((await bp.getByTestId('noai-mark').count()) === 1, 'the mark is on more than the one marked message');

        // あおい sees the mark on that one message only, and it never goes to the AI.
        await befriend(a, b);
        await waitText(p, 'またふつう');
        await p.getByTestId('noai-mark').waitFor();
        assert((await p.getByTestId('noai-mark').count()) === 1, 'the receiver shows the mark on more than one message');
        await shot(p, 'noai-mark', '受け取った側。「AIに読ませない」の印が付いた吹き出し');
        const toAi = async () => (await envelopesFor(aiHex)).length;
        const before = await toAi();
        await button(p, 'その他').click();
        await button(p, 'クロードに下書きを頼む').click();
        await waitText(p, 'AIにトークを読ませますか？');
        await waitText(p, '「AIに読ませない」の印が付いた文は渡しません。');
        await shot(p, 'noai-notice', '最初のお知らせ。印の付いた文は渡さないと書く');
        await button(p, '読ませる').click();
        await p.waitForFunction(() => document.querySelector('textarea[placeholder="メッセージ"]')?.value.startsWith('echo:'), null, { timeout: 15000 });
        const drafted = await p.getByPlaceholder('メッセージ').inputValue();
        assert(drafted === 'echo: テストB: ふつうの文\nテストB: またふつう', `the draft: ${JSON.stringify(drafted)}`);
        assert((await toAi()) === before + 1, 'not exactly one ask went to the AI');
        await p.getByPlaceholder('メッセージ').fill('');

        // テストB has a second device; turning the setting on reaches it and every friend.
        await bp.goto(ORIGIN + '/settings/account');
        await bp.getByText('別の端末でも使う').click();
        await waitText(bp, 'まで使えます');
        const moveLink = (await text(bp)).match(/http:\/\/localhost:\d+\/link#k=[A-Za-z0-9_-]+/)?.[0];
        assert(moveLink, 'no moving link');
        const b2 = await newUser(browser, { prf: false });
        await b2.page.goto(moveLink);
        await button(b2.page, 'この端末で使う').click();
        await button(b2.page, 'パスキーを使わずに始める').click();
        await waitOpen(b2.page);
        await bp.goto(ORIGIN + '/ai');
        const mySwitch = (page) => page.getByRole('switch', { name: '自分の文を相手のAIに読ませない', exact: true });
        await mySwitch(bp).click();
        await shot(bp, 'noai-setting', '設定の「AI」。自分の文を相手のAIに読ませない');
        await b2.page.waitForFunction(() => localStorage.getItem('tegami.noai') === 'true', null, { timeout: 15000 });
        await b2.page.goto(ORIGIN + '/ai');
        await mySwitch(b2.page).waitFor();
        assert((await mySwitch(b2.page).isChecked()) === true, 'the setting did not reach my other device');
        await p.waitForFunction(
          (hex) => JSON.parse(localStorage.getItem('tegami.contacts') || '[]').some((c) => c.pubkey === hex && c.noai === true),
          b.hex,
          { timeout: 15000 },
        );

        // Now nothing of テストB may be read: no ask goes out, and the chat says why.
        const later = await toAi();
        await p.goto(ORIGIN + `/chat/${b.hex}`);
        await waitText(p, 'またふつう');
        await button(p, 'その他').click();
        await button(p, 'クロードに下書きを頼む').click();
        await waitText(p, '下書きを頼めません');
        await waitText(p, 'テストBさんは、自分の文を相手のAIに読ませない設定にしています。');
        await shot(p, 'noai-refused', '相手が断っている時に下書きを頼んだ時');
        await p.waitForTimeout(1000);
        assert((await toAi()) === later, 'something went to the AI from a friend who said no');

        // Turned off on the second device: it reaches the first, and drafts work again.
        await mySwitch(b2.page).click();
        await bp.waitForFunction(() => localStorage.getItem('tegami.noai') === 'false', null, { timeout: 15000 });
        await p.waitForFunction(
          (hex) => JSON.parse(localStorage.getItem('tegami.contacts') || '[]').some((c) => c.pubkey === hex && !c.noai),
          b.hex,
          { timeout: 15000 },
        );
        for (const u of [a, b, b2]) await u.context.close();
      } finally {
        watch?.kill();
      }
    });

    await test("AI owner: marking my AI signs its key; a friend of the AI sees whose AI it is, and not after the mark is taken away", async () => {
      const AGENT = join(ROOT, '../agent');
      const home = mkdtempSync(join(tmpdir(), 'tegami-agent-'));
      const env = { ...process.env, TEGAMI_AGENT_HOME: home, TEGAMI_RELAYS: `ws://localhost:${RELAY_PORT}`, TEGAMI_SECRET_STORE: 'plain' };
      const cli = (...args) => execFileSync(process.execPath, [join(AGENT, 'agent.mjs'), ...args], { env, encoding: 'utf8' });
      const cardFile = join(home, 'owner-card.json');
      const card = () => (existsSync(cardFile) ? JSON.parse(readFileSync(cardFile, 'utf8')).card : undefined);
      const waitCard = async (pred) => {
        for (let i = 0; i < 150 && !pred(card()); i++) await new Promise((r) => setTimeout(r, 100));
        assert(pred(card()), `the AI's card is not as expected: ${JSON.stringify(card())}`);
      };
      let watch;
      try {
        const a = await person(browser, 'あおい');
        const b = await person(browser, 'テストB');
        const aiLink = cli('init', '--name', 'クロード', '--model', 'Anthropic Claude').match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0];
        const aiHex = nip19.decode(aiLink.match(/npub1[0-9a-z]+/)[0]).data;
        await befriend(a, aiLink.replace('https://app.tegami.chat', ORIGIN));
        await a.page.goto(ORIGIN + '/add');
        await a.page.waitForFunction(() => /&c=[a-z2-9]+/.test(document.body.innerText), null, { timeout: 10000 });
        cli('add', (await text(a.page)).match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0], '--name', 'あおい', '--trust');
        cli('add', b.link, '--name', 'テストB');
        cli('setting', 'dailyReplies', '20');
        watch = spawn(process.execPath, [join(AGENT, 'agent.mjs'), 'watch', '--command', `node "${join(AGENT, 'test/echo.mjs')}"`], { env, stdio: 'pipe' });
        await new Promise((r) => watch.stdout.once('data', r));

        // テストB knows あおい and the AI. Before あおい marks it, the AI's owner is not known.
        await befriend(b, a);
        // テストB calls the AI by a name of their own: the AI's own name shows as 元の名前.
        await befriend(b, aiLink.replace('https://app.tegami.chat', ORIGIN).replace(/&n=[^&]*/, `&n=${encodeURIComponent('くろちゃん')}`));
        const bp = b.page;
        const info = async () => {
          await bp.goto(`${ORIGIN}/chat/${aiHex}`);
          await button(bp, 'メニュー').click();
          await waitText(bp, 'Anthropic Claude');
        };
        cli('send', 'テストB', '印の前');
        await waitText(bp, '印の前');
        await info();
        await waitText(bp, '持ち主：未確認');
        await bp.getByTestId('owner-unknown').waitFor();
        await waitText(bp, '元の名前：クロード');
        await shot(bp, 'ai-owner-unknown', 'AIの友だちの画面。持ち主の署名が無い時。自分で付けた呼び名の下に元の名前');

        // あおい marks it as their own AI: the app signs a card and hands it to the AI.
        await markMyAi(a, aiHex);
        await waitCard((c) => c?.pubkey === a.hex);
        writeFileSync(join(home, 'model.json'), JSON.stringify({ model: 'claude-opus-5-5', at: Math.floor(Date.now() / 1000) }));
        cli('send', 'テストB', '印の後');
        await bp.goto(`${ORIGIN}/chat/${aiHex}`);
        await waitText(bp, '印の後');
        await info();
        await waitText(bp, '持ち主：あおい');
        await bp.getByTestId('owner-signed').waitFor();
        await noText(bp, 'ビデオ通話', 0);
        await shot(bp, 'ai-owner-signed', 'AIの友だちの画面。持ち主の署名を確かめた時');
        await noText(bp, '持ち主：未確認', 500);
        // The details: what the signature proves, apart from what the AI says of itself.
        await button(bp, 'AIの詳しい情報').click();
        await waitText(bp, 'あおいの鍵で署名されています。本名や本人確認の印ではありません。');
        await waitText(bp, 'claude-opus-5-5');
        const signed = await text(bp);
        assert(signed.includes('署名で確かめた情報') && /持ち主\s*\S?\s*あおい/.test(signed) && signed.includes('あおいの鍵で署名されています。本名や本人確認の印ではありません。'), `the signed part: ${signed}`);
        const self = signed;
        assert(/AIの名前\s*クロード/.test(self) && /使っているサービス\s*Anthropic Claude/.test(self) && /動いているモデル\s*claude-opus-5-5/.test(self), `the AI's own info: ${self}`);
        await shot(bp, 'ai-about', 'AIの詳しい情報の画面');
        // On あおい's own screen the AI is theirs: no owner line.
        await a.page.goto(`${ORIGIN}/chat/${aiHex}`);
        await button(a.page, 'メニュー').click();
        await waitText(a.page, 'Anthropic Claude');
        await noText(a.page, '持ち主：', 500);

        // あおい takes the mark away: the card is taken back, and the next message says no owner.
        await a.page.getByRole('switch', { name: '自分のAI', exact: true }).click();
        await waitCard((c) => c === null);
        cli('send', 'テストB', '取り消しの後');
        await bp.goto(`${ORIGIN}/chat/${aiHex}`);
        await waitText(bp, '取り消しの後');
        await info();
        await waitText(bp, '持ち主：未確認');
        await bp.getByTestId('owner-unknown').waitFor();
        await button(bp, 'AIの詳しい情報').click();
        await waitText(bp, '持ち主の署名がありません。');
        for (const u of [a, b]) await u.context.close();
      } finally {
        watch?.kill();
      }
    });

    await test('AI sends in my name: only through the gate, after I press 送る or without asking when allowed; the friend sees AIが書いた', async () => {
      const a = await person(browser, 'あおい');
      const b = await person(browser, 'テストB');
      const st = await person(browser, 'しらない');
      await befriend(b, a);
      await befriend(a, b);
      const ai = await fakeAi(a);
      const p = a.page;
      await p.goto(ORIGIN + '/');

      // Every switch off: the friend list and sending are both stopped, nothing reaches テストB.
      let id = await ai.ask(25064, {});
      assert((await ai.answer(25065, id)).stopped === true, 'the friend list was handed over with every switch off');
      id = await ai.ask(25062, { to: b.hex, text: 'スイッチがオフ' });
      assert((await ai.answer(25063, id)).status === 'stopped', 'a send ask was not stopped with every switch off');

      // The friend list: people only (not the AI itself, not blocked people).
      await setPerms(p, { all: { contacts: true } });
      id = await ai.ask(25064, {});
      const list = (await ai.answer(25065, id)).friends;
      assert(JSON.stringify(list) === JSON.stringify([{ pubkey: b.hex, name: 'テストB' }]), `the friend list: ${JSON.stringify(list)}`);

      // "確認してから送る" for テストB: the message waits for 送る, with the friend and the words shown.
      await setPerms(p, { all: { send: true }, friends: { [b.hex]: { send: true } } });
      id = await ai.ask(25062, { to: b.hex, text: '明日10時でどう？' });
      await p.getByTestId('ai-proposal').waitFor({ timeout: 15000 });
      await waitText(p, 'クロードが送ろうとしています');
      await waitText(p, '明日10時でどう？');
      assert((await ai.answer(25063, id)).status === 'waiting', 'the AI was not told it waits');
      await shot(p, 'ai-send-proposal', 'AIが送ろうとしている時。確認してから送るがオンの時だけ。送るを押すまで送られない');
      await button(p, '送らない').click();
      assert((await ai.answer(25063, id, 'declined')).status === 'declined', 'the AI was not told it was not sent');
      await p.waitForTimeout(1500);
      assert(!(await storedTexts(b.page)).includes('明日10時でどう？'), 'sent although 送らない was pressed');

      id = await ai.ask(25062, { to: b.hex, text: 'じゃあ11時は？' });
      await p.getByTestId('ai-proposal').waitFor({ timeout: 15000 });
      await button(p, '送る').click();
      assert((await ai.answer(25063, id, 'sent')).status === 'sent', 'the AI was not told it was sent');
      await b.page.goto(ORIGIN + `/chat/${a.hex}`);
      await waitText(b.page, 'じゃあ11時は？');
      await waitText(b.page, 'AIが書いた（Anthropic Claude）');
      await shot(b.page, 'ai-written-mark', '受け取った側。AIが書いたメッセージには「AIが書いた」とモデルが出る');
      await p.goto(ORIGIN + `/chat/${b.hex}`);
      await waitText(p, 'AIが書いた（Anthropic Claude）');

      // Opening the app again: the relay hands the same ask out again, and nothing is sent twice.
      await p.reload();
      await waitText(p, 'じゃあ11時は？');
      await p.waitForTimeout(2500);
      assert((await p.getByTestId('ai-proposal').count()) === 0, 'the same ask was shown again');
      assert((await storedTexts(b.page)).filter((t) => t === 'じゃあ11時は？').length === 1, 'the same message reached テストB twice');

      // A switch turned off while the message waited: 送る is stopped by the gate.
      id = await ai.ask(25062, { to: b.hex, text: '待っている間に止める' });
      await p.getByTestId('ai-proposal').waitFor({ timeout: 15000 });
      await setPerms(p, { friends: { [b.hex]: { send: false } } });
      await button(p, '送る').click();
      await waitText(p, 'AIの権限で止めました');
      await button(p, 'OK').click();
      assert((await ai.answer(25063, id, 'stopped')).status === 'stopped', 'not stopped after the switch went off');

      // "確認なしで送る": it goes at once, still marked as written by the AI.
      await setPerms(p, { all: { autosend: true }, friends: { [b.hex]: { send: true, autosend: true } } });
      id = await ai.ask(25062, { to: b.hex, text: 'すぐ届くメッセージ' });
      assert((await ai.answer(25063, id)).status === 'sent', 'not sent without asking');
      assert((await p.getByTestId('ai-proposal').count()) === 0, 'asked although 確認なしで送る is on');
      await waitText(b.page, 'すぐ届くメッセージ');

      // Money: always asked, even with 確認なしで送る (the window cannot be turned off).
      id = await ai.ask(25062, { to: b.hex, text: '口座に3万円振り込んでおいて' });
      await p.getByTestId('ai-confirm').waitFor({ timeout: 15000 });
      await waitText(p, '口座に3万円振り込んでおいて');
      await shot(p, 'ai-send-money', 'お金の話は、確認なしで送るがオンでも必ず確認する');
      await button(p, '送らない').click();
      assert((await ai.answer(25063, id)).status === 'declined', 'the AI was not told it was declined');

      // Never a stranger, never an ask from someone who is not my AI.
      id = await ai.ask(25062, { to: st.hex, text: '知らない人へ' });
      assert((await ai.answer(25063, id)).status === 'stopped', 'a stranger was not refused');
      const fake = generateSecretKey();
      await devTrust(fake);
      await ai.ask(25062, { to: b.hex, text: 'AIのふりをした人' }, fake);
      await p.waitForTimeout(2500);
      assert((await p.getByTestId('ai-proposal').count()) === 0, 'an ask from someone who is not my AI was shown');
      assert(!(await storedTexts(b.page)).includes('AIのふりをした人'), 'an ask from someone who is not my AI was sent');

      // The log says what the AI sent and what was stopped.
      await p.goto(ORIGIN + '/ai/log');
      await waitText(p, 'クロード：メッセージを送る（テストB）');
      for (const u of [a, b, st]) await u.context.close();
    });

    await test("AI and another person's AI: asked once, kept a while, taken back from the AI's screen", async () => {
      const a = await person(browser, 'あおい');
      const ai = await fakeAi(a);
      const p = a.page;
      await p.goto(ORIGIN + '/');
      const other = getPublicKey(generateSecretKey());
      const peer = { pubkey: other, name: 'テストCのAI', model: 'Google Gemini' };

      let id = await ai.ask(25066, { peer });
      assert((await ai.answer(25067, id)).until === 0, 'allowed with the switch off');
      await setPerms(p, { all: { otherAi: true } });
      id = await ai.ask(25066, { peer });
      await p.getByTestId('ai-confirm').waitFor({ timeout: 15000 });
      await waitText(p, 'テストCのAI');
      await button(p, '30日間許可').click();
      const got = await ai.answer(25067, id);
      assert(got.until > Date.now() / 1000 + 29 * 86400 && got.limit === 20, `the grant: ${JSON.stringify(got)}`);

      // Asked again later: no window, the same grant.
      id = await ai.ask(25066, { peer });
      assert((await ai.answer(25067, id)).until === got.until, 'asked again within the 30 days');

      await p.goto(ORIGIN + `/ai/ai/${ai.hex}`);
      await waitText(p, '話してよいほかの人のAI');
      await waitText(p, 'テストCのAI');
      await shot(p, 'ai-peer-list', 'AI友だちの画面。話してよいほかの人のAIと、許可をやめる');
      await button(p, '許可をやめる').click();
      // Taking it back is not an answer to an ask: it has no re, and says until 0 for that AI.
      await inboxOf(ai.sk, (rs) => rs.some((r) => r.kind === 25067 && !JSON.parse(r.content).re && JSON.parse(r.content).peer === other && JSON.parse(r.content).until === 0));
      await noText(p, 'テストCのAI', 500);
      await a.context.close();
    });

    await test('Only my own AI may ask: a friend with only a model name is refused, the AI screen keeps it apart; marking it lets it ask', async () => {
      const a = await person(browser, 'あおい');
      const b = await person(browser, 'テストB');
      await befriend(b, a);
      await befriend(a, b);
      const ai = await fakeAi(a, 'なのるAI', 'Anthropic Claude', false);
      const p = a.page;
      await setPerms(p, { all: { contacts: true, send: true }, friends: { [b.hex]: { send: true } } });
      await p.goto(ORIGIN + '/');
      await ai.ask(25064, {});
      await ai.ask(25062, { to: b.hex, text: 'モデル名だけの相手' });
      await p.waitForTimeout(3000);
      assert(!(await inboxOf(ai.sk)).some((r) => r.kind === 25065 || r.kind === 25063), 'a friend with only a model name was answered');
      assert((await p.getByTestId('ai-proposal').count()) === 0, 'an ask from a friend with only a model name was shown');

      await p.goto(ORIGIN + '/ai');
      await waitText(p, 'ほかの人のAI');
      await waitText(p, 'Anthropic Claude');
      assert(!(await text(p)).includes('AI友だち'), 'a friend with only a model name is listed as my AI');
      await p.getByText('ほかの人のAI', { exact: true }).scrollIntoViewIfNeeded();
      await shot(p, 'ai-other-ais', 'AIの権限：自分のAIではないAIは「ほかの人のAI」に分ける');

      await markMyAi(a, ai.hex, 'ai-mark-mine');
      await shot(p, 'ai-mark-mine-on', 'トークの相手の画面：自分のAIのスイッチ');
      const id = await ai.ask(25064, {});
      const list = (await ai.answer(25065, id)).friends;
      assert(JSON.stringify(list) === JSON.stringify([{ pubkey: b.hex, name: 'テストB' }]), `the friend list after marking: ${JSON.stringify(list)}`);
      await p.goto(ORIGIN + '/ai');
      await waitText(p, 'AI友だち');
      assert((await p.getByText('ほかの人のAI', { exact: true }).count()) === 0, 'my AI is still listed with the other AIs');
      for (const u of [a, b]) await u.context.close();
    });

    await test('すべてオフにする: my AIs are told to stop, permissions to talk to other AIs are taken back; a switch on again tells them to go on', async () => {
      const a = await person(browser, 'あおい');
      const ai = await fakeAi(a);
      const p = a.page;
      const other = getPublicKey(generateSecretKey());
      await setPerms(p, { all: { read: true, otherAi: true }, peerAis: { [`${ai.hex}>${other}`]: { until: Math.floor(Date.now() / 1000) + 86400 } } });
      await p.goto(ORIGIN + '/ai');
      await button(p, 'すべてオフにする').click();
      const content = (r) => JSON.parse(r.content);
      const got = await inboxOf(ai.sk, (rs) => rs.some((r) => r.kind === 25069) && rs.some((r) => r.kind === 25067 && content(r).peer === other && content(r).until === 0));
      const stop = got.filter((r) => r.kind === 25069).pop();
      assert(content(stop).v === 1 && content(stop).stop === true && typeof content(stop).at === 'number', `the stop signal: ${stop.content}`);
      assert(stop.tags.some((t) => t[0] === 'p' && t[1] === ai.hex), 'the stop signal is not for the AI');
      const perms = await p.evaluate(() => JSON.parse(localStorage.getItem('tegami.ai.permissions')));
      assert(Object.keys(perms.peerAis).length === 0, 'a permission to talk to another AI was kept');
      assert(Object.values(perms.all).every((v) => v === false), 'a switch stayed on');

      await p.getByRole('switch', { name: 'トークを読む', exact: true }).click();
      await inboxOf(ai.sk, (rs) => rs.some((r) => r.kind === 25069 && content(r).stop === false));
      await a.context.close();
    });

    await test('Limits on sending without asking: over the limit the message waits for 送る; the list marks what an AI sent', async () => {
      const a = await person(browser, 'あおい');
      const b = await person(browser, 'テストB');
      await befriend(b, a);
      await befriend(a, b);
      const ai = await fakeAi(a);
      const p = a.page;
      await setPerms(p, { all: { send: true, autosend: true }, friends: { [b.hex]: { send: true, autosend: true } } });
      await p.goto(ORIGIN + '/ai');
      await waitText(p, '確認なしで送る量の上限');
      for (let i = 0; i < 18; i++) await button(p, '同じトークに続けて送れる数を減らす').click();
      assert((await p.getByTestId('ai-limit-chat').innerText()) === '2通', 'the limit did not go down to 2');
      // The limit per minute goes down to 1, never to 0.
      for (let i = 0; i < 4; i++) await button(p, '1分間に送れる数を減らす').click();
      assert(await button(p, '1分間に送れる数を減らす').isDisabled(), 'the limit per minute can go below 1');
      assert((await p.getByTestId('ai-limit-minute').innerText()) === '1通', 'the limit per minute is not 1');
      for (let i = 0; i < 4; i++) await button(p, '1分間に送れる数を増やす').click();
      assert((await p.getByTestId('ai-limit-minute').innerText()) === '5通', 'the limit per minute did not go back up');
      await shot(p, 'ai-limits', 'AIの権限：確認なしで送る量の上限');

      await p.goto(ORIGIN + '/');
      for (const t of ['一通目', '二通目']) {
        const id = await ai.ask(25062, { to: b.hex, text: t });
        assert((await ai.answer(25063, id)).status === 'sent', `${t} was not sent without asking`);
      }
      const id = await ai.ask(25062, { to: b.hex, text: '三通目' });
      const third = await ai.answer(25063, id);
      assert(third.status === 'waiting' && third.reason === 'limit', `the third: ${JSON.stringify(third)}`);
      await p.getByTestId('ai-proposal').waitFor({ timeout: 15000 });
      await p.waitForTimeout(1000);
      assert(!(await storedTexts(b.page)).includes('三通目'), 'sent over the limit');
      await p.getByTestId('ai-written').first().waitFor({ timeout: 10000 });
      await shot(p, 'ai-written-list', 'トーク一覧：AIが自分の名前で送ったメッセージに印');
      await p.goto(ORIGIN + '/ai/log');
      await waitText(p, '送る量の上限に達したため');
      for (const u of [a, b]) await u.context.close();
    });

    await test('Two of my devices: one more AI permission on one is told on the other; the same AI ask is sent once', async () => {
      const a = await person(browser, 'あおい');
      const b = await person(browser, 'テストB');
      await befriend(b, a);
      await befriend(a, b);
      const ai = await fakeAi(a);
      await a.page.goto(ORIGIN + '/settings/account');
      await waitText(a.page, '別の端末でも使う');
      await a.page.getByText('別の端末でも使う').click();
      await waitText(a.page, 'まで使えます');
      const moveLink = (await text(a.page)).match(/http:\/\/localhost:\d+\/link#k=[A-Za-z0-9_-]+/)?.[0];
      const a2 = await newUser(browser, { prf: false });
      await a2.page.goto(moveLink);
      await button(a2.page, 'この端末で使う').click();
      await button(a2.page, 'パスキーを使わずに始める').click();
      await waitOpen(a2.page);
      await a2.page.waitForFunction((h) => JSON.parse(localStorage.getItem('tegami.contacts') || '[]').some((c) => c.pubkey === h && c.mine), ai.hex, { timeout: 15000 });

      // A turns a switch on: A2 says so in one line on the list, until the AI screen is opened.
      await a.page.goto(ORIGIN + '/ai');
      await a.page.getByRole('switch', { name: 'トークを読む', exact: true }).click();
      await a2.page.goto(ORIGIN + '/');
      await a2.page.getByTestId('ai-widened').waitFor({ timeout: 20000 });
      await waitText(a2.page, 'ほかの端末でAIの権限が広がりました');
      await shot(a2.page, 'ai-widened', 'トーク一覧：ほかの端末でAIの権限が広がった時の1行');
      await a2.page.getByTestId('ai-widened').click();
      await waitText(a2.page, 'AIの使用');
      await a2.page.goto(ORIGIN + '/');
      await waitText(a2.page, 'テストB');
      assert((await a2.page.getByTestId('ai-widened').count()) === 0, 'the line stayed after opening the AI screen');
      // Narrowing is not told.
      await a.page.getByRole('switch', { name: 'トークを読む', exact: true }).click();
      await a2.page.waitForFunction(() => !JSON.parse(localStorage.getItem('tegami.ai.permissions') || '{}').all?.read, null, { timeout: 15000 });
      await a2.page.waitForTimeout(500);
      assert((await a2.page.getByTestId('ai-widened').count()) === 0, 'narrowing was told as widening');

      // Both devices handle the same ask without asking: テストB gets the message once.
      for (const u of [a, a2]) await setPerms(u.page, { all: { send: true, autosend: true }, friends: { [b.hex]: { send: true, autosend: true } } });
      await a.page.goto(ORIGIN + '/');
      await a2.page.goto(ORIGIN + '/');
      await ai.ask(25062, { to: b.hex, text: '二台で一通' });
      await b.page.goto(`${ORIGIN}/chat/${a.hex}`);
      await waitText(b.page, '二台で一通');
      await b.page.waitForTimeout(3000);
      assert((await storedTexts(b.page)).filter((t) => t === '二台で一通').length === 1, 'the same AI ask reached テストB twice');
      // Sending after checking: pressing 送る on one device takes the waiting message off the other.
      for (const u of [a, a2]) await setPerms(u.page, { all: { autosend: false }, friends: { [b.hex]: { autosend: false } } });
      await ai.ask(25062, { to: b.hex, text: '片方で送る' });
      await a.page.getByTestId('ai-proposal').waitFor({ timeout: 15000 });
      await a2.page.getByTestId('ai-proposal').waitFor({ timeout: 15000 });
      await button(a.page, '送る').click();
      await a2.page.waitForFunction(() => !document.querySelector('[data-testid="ai-proposal"]'), null, { timeout: 15000 });
      await b.page.waitForTimeout(2000);
      assert((await storedTexts(b.page)).filter((t) => t === '片方で送る').length === 1, 'the waiting message reached テストB twice');
      for (const u of [a, a2, b]) await u.context.close();
    });

    await test('AI in a group: invited by its owner, it gets the group only while every member says yes', async () => {
      const a = await person(browser, 'あおい');
      const b = await person(browser, 'テストB');
      const c = await person(browser, 'テストC');
      await befriend(a, b);
      await befriend(a, c);
      await befriend(b, a);
      await befriend(c, a);
      const ai = await fakeAi(a);
      await setPerms(a.page, { all: { read: true } });

      await a.page.goto(ORIGIN + '/');
      await button(a.page, '友だち').click();
      await a.page.getByText('グループを作る').click();
      await a.page.getByPlaceholder('グループの名前').fill('家族');
      await a.page.getByRole('checkbox', { name: 'テストB' }).click();
      await a.page.getByRole('checkbox', { name: 'テストC' }).click();
      await button(a.page, '作る').click();
      await a.page.getByPlaceholder('メッセージ').fill('みんなへ');
      await button(a.page, '送る').click();
      for (const u of [b, c]) {
        await u.page.goto(ORIGIN + '/');
        await waitText(u.page, '家族');
        await u.page.getByText('家族').click();
        await waitText(u.page, 'みんなへ');
      }
      const aiGot = async () => (await inboxOf(ai.sk)).filter((r) => r.kind === 14).map((r) => r.content);
      const say = async (u, t) => {
        await u.page.getByPlaceholder('メッセージ').fill(t);
        await button(u.page, '送る').click();
        await u.page.waitForFunction((t) => JSON.parse(localStorage.getItem('tegami.messages') || '[]').some((m) => m.text === t && !m.pending), t, { timeout: 15000 });
      };

      // The owner invites from the + panel. Nothing goes to the AI yet.
      await button(a.page, 'その他').click();
      await button(a.page, 'クロードをグループに招待').click();
      await waitText(a.page, 'クロードをこのグループに招待しますか？');
      await shot(a.page, 'ai-group-invite', '＋からAIをグループに招待する時の確認');
      await button(a.page, '招待').click();
      await waitText(b.page, 'あおいがクロード（Anthropic Claude）を招待しています');
      await waitText(b.page, '同意 1/3人');
      await shot(b.page, 'ai-group-asked', 'ほかのメンバーの画面。同意するまでAIには届かない');
      await say(a, '招待のあと');
      await button(b.page, '同意する').click();
      await waitText(c.page, '同意 2/3人');
      await say(b, 'テストBは同意した');
      await c.page.waitForTimeout(1000);
      assert(!(await aiGot()).some((t) => ['招待のあと', 'テストBは同意した'].includes(t)), 'the AI got the group before everyone said yes');

      // Everyone said yes: messages reach the AI, and what it writes shows in the group.
      await button(c.page, '同意する').click();
      for (const u of [a, b, c]) await waitText(u.page, 'クロード（Anthropic Claude）が参加しています');
      await shot(c.page, 'ai-group-joined', '全員が同意した後');
      await say(b, '全員そろった');
      await inboxOf(ai.sk, (rs) => rs.some((r) => r.kind === 14 && r.content === '全員そろった'));
      const others = [a.hex, b.hex, c.hex];
      const fromAi = (t) => {
        const rumor = nip59.createRumor({ kind: 14, content: t, tags: [...others.map((x) => ['p', x]), ['ai', ai.hex, 'Anthropic Claude', 'クロード']] }, ai.sk);
        return Promise.all(others.map((x) => relaySend(ai.sk, wrapTo(ai.sk, x, rumor))));
      };
      await fromAi('AIです、よろしく');
      await waitText(c.page, 'AIです、よろしく');
      assert((await c.page.getByText('クロード', { exact: true }).count()) > 0, 'the AI is not named as the writer');

      // テストC takes the yes back: her own messages stop at once, the others stop when they hear it.
      await button(c.page, '同意をやめる').click();
      await say(c, 'もう読まないで');
      await b.page.waitForFunction(() => !document.body.innerText.includes('が参加しています'), null, { timeout: 15000 });
      await say(b, 'テストBの次の言葉');
      await a.page.waitForTimeout(1500);
      const after = await aiGot();
      assert(!after.includes('もう読まないで') && !after.includes('テストBの次の言葉'), 'the AI still got the group after a member said no');
      await fromAi('同意がないのに書いた');
      await c.page.waitForTimeout(2000);
      assert(!(await storedTexts(c.page)).includes('同意がないのに書いた'), 'a message from the AI shows after a member said no');
      for (const u of [a, b, c]) await u.context.close();
    });

    await test('AI called into a 1:1 chat: only after the other person says yes, and only until they take it back', async () => {
      const a = await person(browser, 'あおい');
      const b = await person(browser, 'テストB');
      await befriend(b, a);
      await befriend(a, b);
      const ai = await fakeAi(a);
      await setPerms(a.page, { all: { read: true } });
      const aiGot = async () => (await inboxOf(ai.sk)).filter((r) => r.kind === 14).map((r) => r.content);
      const say = async (u, t) => {
        await u.page.getByPlaceholder('メッセージ').fill(t);
        await button(u.page, '送る').click();
        await u.page.waitForFunction((t) => JSON.parse(localStorage.getItem('tegami.messages') || '[]').some((m) => m.text === t && !m.pending), t, { timeout: 15000 });
      };
      await a.page.goto(ORIGIN + `/chat/${b.hex}`);
      await b.page.goto(ORIGIN + `/chat/${a.hex}`);
      await button(a.page, 'その他').click();
      await button(a.page, 'クロードをトークに呼ぶ').click();
      await waitText(a.page, 'クロードをこのトークに呼びますか？');
      await shot(a.page, 'ai-chat-call', '1対1のトークでAIを呼ぶ時の確認');
      await button(a.page, '呼ぶ').click();
      await waitText(b.page, 'あおいがクロード（Anthropic Claude）を呼んでいます');
      await shot(b.page, 'ai-chat-asked', '相手の画面。相手が同意するまでAIには届かない');
      await say(a, '同意の前');
      await say(b, 'テストBも同意の前');
      await b.page.waitForTimeout(1000);
      assert(!(await aiGot()).some((t) => t.includes('同意の前')), 'the AI got the chat before the other person said yes');

      await button(b.page, '同意する').click();
      for (const u of [a, b]) await waitText(u.page, 'クロード（Anthropic Claude）が参加しています');
      await say(b, '同意のあと');
      await inboxOf(ai.sk, (rs) => rs.some((r) => r.kind === 14 && r.content === '同意のあと'));
      const rumor = nip59.createRumor({ kind: 14, content: 'AIです', tags: [['p', a.hex], ['p', b.hex], ['ai', ai.hex, 'Anthropic Claude', 'クロード']] }, ai.sk);
      await Promise.all([a.hex, b.hex].map((x) => relaySend(ai.sk, wrapTo(ai.sk, x, rumor))));
      await waitText(b.page, 'AIです');
      assert((await b.page.getByText('クロード', { exact: true }).count()) > 0, 'the AI is not named as the writer');
      assert(!(await b.page.evaluate(() => JSON.parse(localStorage.getItem('tegami.groups') || '[]'))).length, 'the AI made a new group');

      await button(b.page, '同意をやめる').click();
      await say(b, 'もう読まないで');
      await a.page.waitForFunction(() => !document.body.innerText.includes('が参加しています'), null, { timeout: 15000 });
      await say(a, 'あおいの次の言葉');
      await a.page.waitForTimeout(1500);
      const after = await aiGot();
      assert(!after.includes('もう読まないで') && !after.includes('あおいの次の言葉'), 'the AI still got the chat after the yes was taken back');
      for (const u of [a, b]) await u.context.close();
    });

    await test('Block: a blocked person cannot reach me; their chat and calls disappear; unblocking lets them back', async () => {
      const a = await person(browser, 'えー');
      const b = await person(browser, 'びー');
      await befriend(b, a);
      await befriend(a, b);
      await a.page.goto(ORIGIN + '/');
      await b.page.getByPlaceholder('メッセージ').fill('ブロック前の手紙');
      await button(b.page, '送る').click();
      await waitText(a.page, 'ブロック前の手紙');
      await a.page.getByText('びー').first().click();
      await waitText(a.page, 'ブロック前の手紙');

      await shot(a.page, 'chat-buttons', 'トークの画面。上に音声通話・メニュー、下に＋・カメラ・写真・メッセージ入力（スタンプ）・録音のボタン');
      await button(a.page, 'メニュー').click();
      await waitText(a.page, 'ビデオ通話');
      await shot(a.page, 'chat-detail', '「メニュー」を押した時に出る詳細の画面（ビデオ通話・ブロック・通報・トークを削除）');
      await button(a.page, 'ブロック').click();
      await waitText(a.page, 'びーをブロックしますか？');
      await waitText(a.page, 'ブロックした相手とはメッセージの送受信ができなくなります。相手には伝わりません。');
      assert(await button(a.page, 'ブロックして通報').isVisible(), 'no block-and-report button');
      await shot(a.page, 'block-dialog', '「ブロック」を押した時に出る確認のダイアログ');
      await button(a.page, 'ブロック').click();
      await button(infoArea(a.page), 'ブロック解除').waitFor();
      // The unblock dialog on the detail screen also works (cancel keeps them blocked).
      await button(infoArea(a.page), 'ブロック解除').click();
      await waitText(a.page, 'ブロックを解除しますか？');
      await waitText(a.page, 'この相手からのメッセージを受け取るようになります。');
      await button(a.page, 'キャンセル').click();
      await closeInfo(a.page);
      await waitText(a.page, 'ブロック中');
      assert(await button(a.page, 'ブロック解除').isVisible(), 'no unblock button on blocked chat bar');
      assert(!(await a.page.getByPlaceholder('メッセージ').count()), 'input shown while blocked');
      await shot(a.page, 'blocked-chat', 'ブロックした相手とのトーク');

      // The ブロック解除 button in the blocked chat bar opens the unblock dialog and unblocks.
      await button(a.page, 'ブロック解除').click();
      await waitText(a.page, 'ブロックを解除しますか？');
      await a.page.getByTestId('dialog').getByRole('button', { name: 'ブロック解除', exact: true }).click();
      await a.page.getByPlaceholder('メッセージ').waitFor();
      // Block again to check that messages and calls while blocked are dropped.
      await button(a.page, 'メニュー').click();
      await waitText(a.page, 'ビデオ通話');
      await button(a.page, 'ブロック').click();
      await waitText(a.page, 'びーをブロックしますか？');
      await button(a.page, 'ブロック').click();
      await button(infoArea(a.page), 'ブロック解除').waitFor();
      await closeInfo(a.page);
      await waitText(a.page, 'ブロック中');

      await b.page.getByPlaceholder('メッセージ').fill('ブロック中の手紙');
      await button(b.page, '送る').click();
      await noText(a.page, 'ブロック中の手紙', 2000);
      await button(b.page, '通話').click();
      await button(b.page, '音声通話').click();
      await waitText(b.page, '呼び出し中');
      await noText(a.page, '応答', 2000);
      await button(b.page, '通話を終了').click();

      await a.page.goBack();
      await noText(a.page, 'ブロック中の手紙', 1000);
      assert(!(await text(a.page)).includes('びー'), 'blocked chat still in the list');

      await openSettings(a.page, 'プライバシー');
      await waitText(a.page, 'ブロックリスト');
      await waitText(a.page, 'びー');
      await a.page.getByText('ブロックリスト').scrollIntoViewIfNeeded();
      await shot(a.page, 'settings-blocklist', '設定の画面のブロックリスト');

      // Moving the account to another device brings the block list along.
      await button(a.page, '戻る').click();
      await a.page.getByRole('button', { name: 'アカウント', exact: true }).last().click();
      await a.page.getByText('別の端末でも使う').click();
      await waitText(a.page, 'まで使えます');
      const moveLink = (await text(a.page)).match(/http:\/\/localhost:\d+\/link#k=[A-Za-z0-9_-]+/)?.[0];
      assert(moveLink, 'no moving link');
      const a2 = await newUser(browser);
      await a2.page.goto(moveLink);
      await button(a2.page, 'この端末で使う').click();
      await waitOpen(a2.page);
      await a2.page.waitForFunction(() => JSON.parse(localStorage.getItem('tegami.blocked') || '[]').length > 0, null, { timeout: 15000 });
      await a2.page.goto(ORIGIN + '/settings/privacy');
      await a2.page.waitForFunction(() => /ひらく|ブロックリスト/.test(document.body.innerText), null, { timeout: 15000 });
      if ((await text(a2.page)).includes('ひらく')) await button(a2.page, 'ひらく').click();
      // Unlocking may land on the settings list: then open the privacy page from it.
      await a2.page.waitForFunction(() => /ブロックリスト|プライバシー/.test(document.body.innerText), null, { timeout: 15000 });
      if (!(await text(a2.page)).includes('ブロックリスト')) await a2.page.getByRole('button', { name: 'プライバシー', exact: true }).last().click();
      await waitText(a2.page, 'ブロックリスト');
      assert(!(await text(a2.page)).includes('ブロックしている人はいません'), 'the block list did not move');
      await waitText(a2.page, 'びー');
      await a2.context.close();
      await a.page.getByText('閉じる').click().catch(() => {});

      await button(a.page, '戻る').click();
      await a.page.getByRole('button', { name: 'プライバシー', exact: true }).last().click();
      await button(a.page, 'ブロック解除').click();
      await waitText(a.page, 'ブロックしている人はいません');
      await shot(a.page, 'settings-blocklist-empty', 'ブロックを解除した後の設定の画面');

      // Back to the chat list without reloading (a reload would fetch the dropped envelopes again).
      if (NARROW) {
        await button(a.page, '戻る').click();
        await a.page.getByTestId('ai-permissions-state').waitFor();
        await button(a.page, '戻る').click();
      } else await button(a.page, 'トーク').first().click();
      await waitText(a.page, 'びー');
      await b.page.getByPlaceholder('メッセージ').fill('解除後の手紙');
      await button(b.page, '送る').click();
      await waitText(a.page, '解除後の手紙');
      await a.page.getByText('びー').first().click();
      await waitText(a.page, '解除後の手紙');
      assert((await text(a.page)).includes('ブロック前の手紙'), 'old message lost');
      assert(!(await text(a.page)).includes('ブロック中の手紙'), 'message while blocked appeared');
      for (const u of [a, b]) await u.context.close();
    });

    await test("Report and caution: a stranger's money talk shows a caution; reporting reaches the relay with messages only when attached", async () => {
      const a = await person(browser, 'えー');
      const b = await person(browser, 'びー');
      // Only B adds A: B is a stranger to A.
      await befriend(b, a);
      await b.page.getByPlaceholder('メッセージ').fill('この投資で必ず儲かります https://example.com');
      await button(b.page, '送る').click();
      await b.page.getByPlaceholder('メッセージ').fill('振込先はこちらの口座です');
      await button(b.page, '送る').click();
      await b.page.waitForFunction(() => !document.body.innerText.includes('未送信'), null, { timeout: 10000 });
      const cautionTitle = 'お金やリンクの話に注意してください';
      const cautionBody = 'この相手は友だちではありません。お金の振り込みやリンクを開くよう求められたら、詐欺かもしれません。';
      assert(!(await text(b.page)).includes(cautionTitle), 'the caution shows under my own message');

      await a.page.goto(ORIGIN + '/');
      await waitOpen(a.page);
      await waitText(a.page, '知らない人から');
      await a.page.getByText('知らない人から').click();
      await a.page.getByText('振込先はこちらの口座です', { exact: false }).first().click();
      await waitText(a.page, cautionTitle);
      await waitText(a.page, cautionBody);
      assert((await a.page.getByTestId('caution-card').count()) === 1, 'caution card should show once per chat');
      await shot(a.page, 'caution', '知らない人から、お金やリンクの話が届いた時の注意カード');

      // Report: scam, without attaching messages.
      await button(a.page, '通報').click();
      await waitText(a.page, '通報する理由');
      await waitText(a.page, 'なりすまし');
      await waitText(a.page, 'メッセージを添える');
      await waitText(a.page, 'オンにすると、直近のメッセージ（2件）を送ります');
      await a.page.getByRole('switch', { name: 'メッセージを添える' }).click();
      await waitText(a.page, '直近のメッセージ（2件）を送ります');
      assert(!(await text(a.page)).includes('オンにすると、'), 'report line did not update when switch turned on');
      await a.page.getByRole('switch', { name: 'メッセージを添える' }).click();
      await waitText(a.page, 'オンにすると、直近のメッセージ（2件）を送ります');
      await waitText(a.page, '通報したことは相手に伝わりません。');
      await shot(a.page, 'report-panel', '「通報」を押した時に出る画面');
      await a.page.getByRole('radio', { name: '詐欺', exact: true }).click();
      await button(a.page, '同意して送信').click();
      await waitText(a.page, '通報しました');
      await shot(a.page, 'report-done', '通報を送った後の画面');
      const reports = await (await fetch(`http://localhost:${RELAY_PORT}/_reports`)).json();
      const about = reports.filter((r) => r.reported === b.hex);
      assert(about.length === 1, `reports about B: ${JSON.stringify(about)}`);
      assert(about[0].reason === 'scam' && about[0].reporter === a.hex, `report: ${JSON.stringify(about[0])}`);
      assert(!about[0].messages, `messages went along without being attached: ${JSON.stringify(about[0].messages)}`);
      // (A second report about B today is refused by the relay; relay/test/report.test.mjs covers it.)

      // Then block, from the same panel (opens the block confirmation dialog).
      await button(a.page, 'ブロックする').click();
      await waitText(a.page, 'をブロックしますか？');
      await button(a.page, 'ブロック').click();
      await waitText(a.page, 'ブロック中');
      for (const u of [a, b]) await u.context.close();
    });

    await test('Avatar: set in settings, sent privately to friends only, shown in their list; removing it reaches them too', async () => {
      const a = await person(browser, 'あゆみ');
      const b = await person(browser, 'ばんり');
      const c = await person(browser, 'ちえ');
      await befriend(b, a);
      await befriend(a, b);
      // C only added A (A did not add C).
      await befriend(c, a);
      await b.page.goto(ORIGIN + '/');
      await c.page.goto(ORIGIN + '/');
      await waitText(b.page, 'あゆみ');
      await waitText(c.page, 'あゆみ');
      assert(await b.page.getByTestId('avatar-initial').last().isVisible(), 'expected initial placeholder before avatar');
      // C's own envelopes to itself (its friend list for its other devices, lib/own-sync.ts) are
      // there already; nothing more may arrive for C.
      await c.page.waitForFunction(() => {
        const s = JSON.parse(localStorage.getItem('tegami.syncSent') || 'null');
        return s && s.hash.includes(JSON.stringify(Object.keys(JSON.parse(localStorage.getItem('tegami.sync'))).find((k) => k.startsWith('c:'))));
      }, null, { timeout: 15000 });
      const cOwn = (await envelopesFor(c.hex)).length;

      await a.page.goto(ORIGIN + '/settings/profile');
      await waitText(a.page, 'アイコンを変更');
      await shot(a.page, 'settings-avatar', '設定の画面のアイコン（まだ設定していない時）');
      const png = Buffer.from(
        await a.page.evaluate(() => {
          const cv = document.createElement('canvas');
          cv.width = 400;
          cv.height = 300;
          const g = cv.getContext('2d');
          g.fillStyle = '#b5452f';
          g.fillRect(0, 0, 400, 300);
          return cv.toDataURL('image/png').split(',')[1];
        }),
        'base64',
      );
      const chooser = a.page.waitForEvent('filechooser');
      await button(a.page, 'アイコンを変更').click();
      await (await chooser).setFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: png });
      await a.page.getByTestId('avatar-img').last().waitFor({ timeout: 15000 });
      await button(a.page, 'アイコンを削除').waitFor({ timeout: 5000 });
      await shot(a.page, 'settings-avatar-set', '設定の画面のアイコン（設定した後）');

      await b.page.getByTestId('avatar-img').first().waitFor({ timeout: 15000 });
      await b.page.waitForFunction(() => {
        const i = document.querySelector('[data-testid="avatar-img"]');
        return i && i.tagName === 'IMG' && i.complete && i.naturalWidth === 256 && i.naturalHeight === 256;
      }, null, { timeout: 15000 });
      await button(b.page, '友だち').click();
      await waitText(b.page, '友だち（1）');
      await b.page.getByTestId('avatar-img').first().waitFor({ timeout: 15000 });
      await shot(b.page, 'friends-tab', '友だちタブの一覧（自分の行と友だちのアイコン）');
      await button(b.page, 'トーク').click();
      await b.page.getByTestId('avatar-img').first().waitFor({ timeout: 15000 });

      const avatar = await b.page.evaluate(() => JSON.parse(localStorage.getItem('tegami.contacts'))[0]?.avatar);
      assert(avatar && avatar.url, 'no avatar ref on contact');
      const stored = Buffer.from(await (await fetch(avatar.url)).arrayBuffer());
      const head = stored.subarray(0, 4).toString('hex');
      assert(stored.length > 0 && !head.startsWith('ffd8ff') && head !== '89504e47', 'the server holds an unencrypted avatar');

      // Stranger C never receives A's profile card and keeps the initial placeholder.
      await c.page.waitForTimeout(1000);
      assert((await c.page.getByTestId('avatar-img').count()) === 0, 'stranger C saw the avatar');
      assert(await c.page.getByTestId('avatar-initial').last().isVisible(), 'stranger C lost the initial placeholder');
      assert((await envelopesFor(c.hex)).length === cOwn, 'stranger C received a profile card');

      await button(a.page, 'アイコンを削除').click();
      await a.page.getByTestId('avatar-initial').last().waitFor({ timeout: 10000 });
      await b.page.getByTestId('avatar-initial').last().waitFor({ timeout: 15000 });
      assert((await b.page.getByTestId('avatar-img').count()) === 0, 'avatar still shown after removal');
      for (const u of [a, b, c]) await u.context.close();
    });

    await test('Photo viewer: a tapped photo opens full screen; Escape closes it', async () => {
      const a = await person(browser, 'あゆみ');
      const b = await person(browser, 'ばんり');
      await befriend(b, a);
      await befriend(a, b);
      const png = Buffer.from(
        await a.page.evaluate(() => {
          const c = document.createElement('canvas');
          c.width = 400;
          c.height = 300;
          const g = c.getContext('2d');
          g.fillStyle = '#b5452f';
          g.fillRect(0, 0, 400, 300);
          return c.toDataURL('image/png').split(',')[1];
        }),
        'base64',
      );
      const chooser = a.page.waitForEvent('filechooser');
      await button(a.page, '写真').click();
      await (await chooser).setFiles({ name: 'test.png', mimeType: 'image/png', buffer: png });
      const img = a.page.locator('img[alt="写真"]').first();
      await img.waitFor({ timeout: 15000 });
      await img.click();
      await button(a.page, '閉じる').waitFor({ timeout: 5000 });
      assert(!(await button(a.page, '保存').count()), 'save button shown before long press');
      await shot(a.page, 'photo-viewer', '写真を押した時の全画面');
      await a.page.getByTestId('viewer-photo').click({ button: 'right' });
      await button(a.page, '保存').waitFor({ timeout: 5000 });
      assert(await button(a.page, '閉じる').isVisible(), 'close button not visible in viewer menu');
      await a.page.keyboard.press('Escape');
      await button(a.page, '閉じる').waitFor({ state: 'detached', timeout: 5000 });
      assert(!(await button(a.page, '保存').count()), 'viewer still visible after Escape');
      for (const u of [a, b]) await u.context.close();
    });

    await test('Invite QR: the add screen shows a QR code of the invite link', async () => {
      const u = await person(browser, 'あゆみ');
      await u.page.goto(ORIGIN + '/');
      await waitOpen(u.page);
      await button(u.page, '友だち追加').click();
      await waitText(u.page, 'マイQRコード');
      const qr = u.page.getByTestId('invite-qr');
      await qr.waitFor({ timeout: 5000 });
      assert(await qr.isVisible(), 'invite QR not visible');
      await shot(u.page, 'my-qr', '友だち追加の画面の「マイQRコード」タブ');
      await button(u.page, 'QRコードスキャン').click();
      await waitText(u.page, 'QRコードを読み取ると、友だち追加の画面が開きます。');
      assert(await button(u.page, '画像から読み取る').isVisible(), 'no QR image picker button');
      await shot(u.page, 'qr-scan', '友だち追加の画面の「QRコードスキャン」タブ');
      await button(u.page, NARROW ? '戻る' : 'トーク').click();
      await waitOpen(u.page);
      await u.context.close();
    });

    await test('Copy and forward: a text and a photo go to another friend as my own messages', async () => {
      const a = await person(browser, 'あゆみ');
      const b = await person(browser, 'ばんり');
      const c = await person(browser, 'ちえ');
      await a.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
      await befriend(b, a);
      await befriend(c, a);
      await befriend(a, c);
      await befriend(a, b);

      await b.page.getByPlaceholder('メッセージ').fill('転送するテキスト');
      await button(b.page, '送る').click();
      await waitText(a.page, '転送するテキスト');

      const msg = a.page.getByText('転送するテキスト', { exact: true });
      await msg.click({ button: 'right' });
      await shot(a.page, 'message-menu', 'メッセージにマウスを当てた時（スマホでは長押し）に出るボタン');
      await button(a.page, 'コピー').click();
      await waitText(a.page, 'コピーしました');
      await shot(a.page, 'copied', '「コピー」を押した後');
      assert((await a.page.evaluate(() => navigator.clipboard.readText())) === '転送するテキスト', 'clipboard text mismatch');
      await msg.click({ button: 'right' });
      await button(a.page, '転送').click();
      await waitText(a.page, '転送先を選ぶ');
      await shot(a.page, 'forward-pick', '「転送」を押した時に出る、送り先を選ぶ画面');
      await button(a.page, 'ちえ').click();
      await waitText(c.page, '転送するテキスト');
      assert(!(await text(c.page)).includes('ばんり'), 'forwarded message mentions original author');

      const png = Buffer.from(
        await b.page.evaluate(() => {
          const cv = document.createElement('canvas');
          cv.width = 400;
          cv.height = 300;
          const g = cv.getContext('2d');
          g.fillStyle = '#b5452f';
          g.fillRect(0, 0, 400, 300);
          return cv.toDataURL('image/png').split(',')[1];
        }),
        'base64',
      );
      const chooser = b.page.waitForEvent('filechooser');
      await button(b.page, '写真').click();
      await (await chooser).setFiles({ name: 'test.png', mimeType: 'image/png', buffer: png });

      await a.page.goto(`${ORIGIN}/chat/${b.hex}`);
      const aImg = a.page.locator('img[alt="写真"]').first();
      await aImg.waitFor({ timeout: 15000 });
      await aImg.click({ button: 'right' });
      await button(a.page, '転送').click();
      await waitText(a.page, '転送先を選ぶ');
      await button(a.page, 'ちえ').click();

      await c.page.locator('img[alt="写真"]').first().waitFor({ timeout: 15000 });
      await c.page.waitForFunction(() => {
        const i = document.querySelector('img[alt="写真"]');
        return i && i.complete && i.naturalWidth === 400;
      }, null, { timeout: 15000 });
      for (const u of [a, b, c]) await u.context.close();
    });

    await test('Delete a chat and a friend: messages leave this device; the friend stays until deleted; a deleted friend writes again as a stranger', async () => {
      const a = await person(browser, 'あゆみ');
      const b = await person(browser, 'ばんり');
      await befriend(b, a);
      await befriend(a, b);
      await b.page.getByPlaceholder('メッセージ').fill('消す前の手紙');
      await button(b.page, '送る').click();
      await waitText(a.page, '消す前の手紙');
      await a.page.getByPlaceholder('メッセージ').fill('こちらからも');
      await button(a.page, '送る').click();
      await waitText(b.page, 'こちらからも');

      await button(a.page, 'メニュー').click();
      await button(a.page, 'トークを削除').click();
      await waitText(a.page, 'ばんりとのトークを削除しますか？この端末から消えます。');
      await shot(a.page, 'delete-chat-confirm', '「トークを削除」を押した時に出る確認');
      await button(a.page, '削除').click();
      await waitOpen(a.page);
      await waitText(a.page, 'ばんり');
      assert(!(await text(a.page)).includes('消す前の手紙'), 'old preview still on chat list');
      await a.page.getByText('ばんり').first().click();
      await a.page.getByPlaceholder('メッセージ').waitFor();
      await noText(a.page, '消す前の手紙', 500);
      assert(!(await text(a.page)).includes('こちらからも'), 'own message still in chat');
      // Opening the app again receives the envelopes from the relay again: they stay deleted.
      await a.page.goto(ORIGIN + '/');
      await waitOpen(a.page);
      await a.page.getByText('ばんり').first().click();
      await a.page.getByPlaceholder('メッセージ').waitFor();
      await noText(a.page, '消す前の手紙', 2500);
      assert(!(await text(a.page)).includes('こちらからも'), 'own message came back after reopening');

      await a.page.goto(ORIGIN + '/');
      await waitOpen(a.page);
      await button(a.page, '友だち').click();
      await waitText(a.page, '友だち（1）');
      await waitText(a.page, 'ばんり');
      await a.page.getByText('ばんり').first().click({ button: 'right' });
      await waitText(a.page, '音声通話');
      await button(a.page, '削除').click();
      await waitText(a.page, 'ばんりを友だちから削除しますか？');
      await button(a.page, '削除').click();
      await waitText(a.page, '友だち（0）');
      await noText(a.page, 'ばんり', 500);

      await button(a.page, 'トーク').click();
      assert(!(await text(a.page)).includes('ばんり'), 'deleted friend still in chat list');
      await b.page.getByPlaceholder('メッセージ').fill('もう一度こんにちは');
      await button(b.page, '送る').click();
      await waitText(a.page, '知らない人から');
      await a.page.getByText('知らない人から').click();
      await waitText(a.page, 'もう一度こんにちは');
      for (const u of [a, b]) await u.context.close();
    });

    await test('Friends tab: friends and groups listed with counts; long press 削除 asks and removes the friend; long press on a chat row deletes the chat', async () => {
      const a = await person(browser, 'あゆみ');
      const b = await person(browser, 'ばんり');
      const c = await person(browser, 'ちえ');
      await befriend(a, b);
      await befriend(a, c);
      await befriend(b, a);
      await befriend(c, a);

      await a.page.goto(ORIGIN + '/');
      await button(a.page, '友だち').click();
      await a.page.getByText('グループを作る').click();
      await a.page.getByPlaceholder('グループの名前').fill('家族');
      await a.page.getByRole('checkbox', { name: 'ばんり' }).click();
      await a.page.getByRole('checkbox', { name: 'ちえ' }).click();
      await button(a.page, '作る').click();
      await a.page.getByPlaceholder('メッセージ').fill('みんなへ');
      await button(a.page, '送る').click();

      await b.page.getByPlaceholder('メッセージ').fill('ばんりからの手紙');
      await button(b.page, '送る').click();

      await a.page.goto(ORIGIN + '/');
      await waitOpen(a.page);
      await waitText(a.page, 'ばんりからの手紙');

      await button(a.page, '友だち').click();
      await waitText(a.page, '友だち（2）');
      await waitText(a.page, 'グループ（1）');
      const ft = await text(a.page);
      assert(ft.includes('あゆみ') && ft.includes('ばんり') && ft.includes('ちえ') && ft.includes('家族'), `friends tab: ${ft.slice(0, 200)}`);

      // Tapping my own row opens settings.
      await a.page.getByText('あゆみ', { exact: true }).first().click();
      await waitText(a.page, '名前とアイコン');
      await a.page.goBack();
      await waitText(a.page, '友だち（2）');

      // Long press (right click) on a friend row opens the menu sheet; 削除 asks and removes the friend.
      await a.page.getByText('ちえ', { exact: true }).first().click({ button: 'right' });
      await waitText(a.page, '音声通話');
      await shot(a.page, 'friend-menu', '友だちの行を長押しした時に出るメニュー');
      await button(a.page, '削除').click();
      await waitText(a.page, 'ちえを友だちから削除しますか？');
      await shot(a.page, 'friend-delete-dialog', '友だちのメニューで「削除」を押した時に出る確認');
      await button(a.page, '削除').click();
      await waitText(a.page, '友だち（1）');
      await noText(a.page, 'ちえ', 500);

      // Long press (right click) on a chat row opens the chat menu sheet; 削除 asks and deletes the chat.
      await button(a.page, 'トーク').click();
      await waitText(a.page, 'ばんりからの手紙');
      await a.page.getByText('ばんり').first().click({ button: 'right' });
      await button(a.page, '閉じる').waitFor({ timeout: 5000 });
      await shot(a.page, 'chat-menu', 'トーク一覧の行を長押しした時に出るメニュー');
      await button(a.page, '削除').click();
      await waitText(a.page, 'ばんりとのトークを削除しますか？この端末から消えます。');
      await shot(a.page, 'chat-delete-dialog', 'トーク一覧のメニューで「削除」を押した時に出る確認');
      await button(a.page, '削除').click();
      await noText(a.page, 'ばんりからの手紙', 500);
      assert((await text(a.page)).includes('ばんり'), 'friend row gone after deleting only the chat');
      for (const u of [a, b, c]) await u.context.close();
    });

    await test('QR scan: a QR of an invite link read by the camera opens the add form filled', async () => {
      const a = await person(browser, 'あゆみ');
      const b = await person(browser, 'ばんり');
      await a.page.goto(ORIGIN + '/add');
      await waitText(a.page, 'マイQRコード');

      const check = await a.page.evaluate((link) => {
        const qr = window.makeQr(0, 'M');
        qr.addData(link);
        qr.make();
        const count = qr.getModuleCount();
        const cell = 6;
        const margin = 12;
        const size = count * cell + margin * 2;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = '#000000';
        for (let r = 0; r < count; r++) {
          for (let c = 0; c < count; c++) {
            if (qr.isDark(r, c)) ctx.fillRect(margin + c * cell, margin + r * cell, cell, cell);
          }
        }
        const img = ctx.getImageData(0, 0, size, size);
        const decoded = window.decodeQrImage(img);
        const valid = decoded ? window.inviteFromQr(decoded) : null;
        const shortHost = window.inviteFromQr(link.replace('https://app.tegami.chat', 'https://tegami.chat'));
        const invalid = window.inviteFromQr('https://example.com/other');
        // Feed the drawn QR canvas into the next scanner frame on the QRコードスキャン tab.
        delete window.BarcodeDetector;
        const origDraw = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function (src, ...rest) {
          if (src instanceof HTMLVideoElement) {
            this.canvas.width = size;
            this.canvas.height = size;
            return origDraw.call(this, canvas, 0, 0, size, size);
          }
          return origDraw.call(this, src, ...rest);
        };
        return { decoded, valid, shortHost, invalid };
      }, b.link);

      assert(check.decoded === b.link, `decoded: ${check.decoded}`);
      assert(check.valid === b.link, `inviteFromQr: ${check.valid}`);
      assert(check.shortHost === b.link.replace('https://app.tegami.chat', 'https://tegami.chat'), `shortHost: ${check.shortHost}`);
      assert(check.invalid === null, `invalid did not return null: ${check.invalid}`);

      await button(a.page, 'QRコードスキャン').click();
      await a.page.getByTestId('invite-qr').waitFor({ timeout: 10000 });
      assert((await a.page.getByPlaceholder('https://app.tegami.chat/i#npub…').inputValue()) === b.link, 'invite link not filled from QR');
      assert((await a.page.getByPlaceholder('表示する名前').inputValue()) === 'ばんり', 'friend name not filled from QR');
      for (const u of [a, b]) await u.context.close();
    });

    await test('Stamps: make one from a picture, send it, the friend sees it without a bubble and adds it to their own stamps', async () => {
      const a = await person(browser, 'あゆみ');
      const b = await person(browser, 'ばんり');
      await befriend(b, a);
      await befriend(a, b); // a is now in the chat with b

      const png = Buffer.from(
        await a.page.evaluate(() => {
          const c = document.createElement('canvas');
          c.width = 400;
          c.height = 400;
          const g = c.getContext('2d');
          g.fillStyle = '#b5452f';
          g.fillRect(40, 40, 320, 320);
          return c.toDataURL('image/png').split(',')[1];
        }),
        'base64',
      );
      await button(a.page, 'スタンプ').click();
      const chooser = a.page.waitForEvent('filechooser');
      await button(a.page, 'スタンプを作る').click();
      await (await chooser).setFiles({ name: 'stamp.png', mimeType: 'image/png', buffer: png });
      const aItem = a.page.getByTestId('stamp-item').first();
      await aItem.waitFor({ timeout: 15000 });
      await shot(a.page, 'stamp-panel', '「スタンプ」を押して、スタンプを1つ作った後');

      const saved = await a.page.evaluate(() => JSON.parse(localStorage.getItem('tegami.stamps'))?.[0]);
      assert(saved && saved.dim === '320x320' && saved.type === 'image/png', `stamp not shrunk: ${JSON.stringify(saved)}`);
      const stored = Buffer.from(await (await fetch(saved.url)).arrayBuffer());
      const head = stored.subarray(0, 4).toString('hex');
      assert(stored.length > 0 && !head.startsWith('ffd8ff') && head !== '89504e47', 'the server holds an unencrypted stamp');

      await aItem.click();
      const bStamp = b.page.getByTestId('stamp-message').first();
      await bStamp.waitFor({ timeout: 15000 });
      const bg = await bStamp.evaluate((el) => getComputedStyle(el.parentElement.parentElement).backgroundColor);
      assert(bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent', `stamp has a bubble background: ${bg}`);

      await bStamp.click();
      await button(b.page, 'スタンプに追加').waitFor({ timeout: 5000 });
      await shot(b.page, 'stamp-add', '友達から届いたスタンプを押した時');
      await button(b.page, 'スタンプに追加').click();
      await button(b.page, 'スタンプ').click();
      const bItems = b.page.getByTestId('stamp-item');
      await bItems.first().waitFor({ timeout: 15000 });
      assert((await bItems.count()) === 1, `expected 1 stamp-item, got ${await bItems.count()}`);

      await bItems.first().click();
      await a.page.waitForFunction(() => document.querySelectorAll('[data-testid="stamp-message"]').length === 2, null, { timeout: 15000 });
      await shot(a.page, 'stamp-chat', 'スタンプのやり取りをしたトーク');
      for (const u of [a, b]) await u.context.close();
    });

    await test('Stamps move: the link and the recovery code bring my stamps (old ones moved into the stamp storage); a gone image can be removed; a backup from before stamps still restores', async () => {
      const DAY = 24 * 60 * 60;
      const a = await person(browser, 'あゆみ');
      const b = await person(browser, 'ばんり');
      await befriend(b, a);
      await befriend(a, b);

      // A makes a stamp, then it is made to look 25 days old, and a stamp whose image the
      // file server no longer has is added (as if it had been deleted after 30 days).
      const png = Buffer.from(
        await a.page.evaluate(() => {
          const c = document.createElement('canvas');
          c.width = 200;
          c.height = 200;
          const g = c.getContext('2d');
          g.fillStyle = '#1d6b4b';
          g.fillRect(20, 20, 160, 160);
          return c.toDataURL('image/png').split(',')[1];
        }),
        'base64',
      );
      await button(a.page, 'スタンプ').click();
      const chooser = a.page.waitForEvent('filechooser');
      await button(a.page, 'スタンプを作る').click();
      await (await chooser).setFiles({ name: 'stamp.png', mimeType: 'image/png', buffer: png });
      await a.page.getByTestId('stamp-item').first().waitFor({ timeout: 15000 });
      const made = await a.page.evaluate(() => JSON.parse(localStorage.getItem('tegami.stamps'))[0]);
      const ghostSha = 'e'.repeat(64);
      const ghost = { ...made, url: made.url.replace(made.sha256, ghostSha), sha256: ghostSha, uploadedAt: Math.floor(Date.now() / 1000) };
      // A stamp from before the stamp storage: on the 30-day file server (gone there by now),
      // with this device's copy still kept.
      const old = { ...made, url: made.url.replace('/stamp/', '/'), uploadedAt: Math.floor(Date.now() / 1000) - 25 * DAY };
      await a.page.evaluate((list) => localStorage.setItem('tegami.stamps', JSON.stringify(list)), [old, ghost]);

      // Opening the app moves the old stamp into the stamp storage, so the new device can fetch it.
      await a.page.goto(ORIGIN + '/settings/account');
      await a.page.getByText('別の端末でも使う').click();
      await waitText(a.page, 'まで使えます');
      const moveLink = (await text(a.page)).match(/http:\/\/localhost:\d+\/link#k=[A-Za-z0-9_-]+/)[0];
      const aList = await a.page.evaluate(() => JSON.parse(localStorage.getItem('tegami.stamps')));
      assert(aList.length === 2 && aList[0].url.endsWith(`/stamp/${made.sha256}`), `old stamp not moved into the stamp storage: ${JSON.stringify(aList)}`);
      assert(aList[1].sha256 === ghostSha, 'the gone stamp changed on the old device');

      const a2 = await newUser(browser, { prf: false });
      await a2.page.goto(moveLink);
      await waitText(a2.page, 'あゆみさんのアカウントを受け取りました');
      await button(a2.page, 'この端末で使う').click();
      await button(a2.page, 'パスキーを使わずに始める').click();
      await waitOpen(a2.page);
      const moved = await a2.page.evaluate(() => JSON.parse(localStorage.getItem('tegami.stamps') ?? '[]'));
      assert(moved.length === 2 && moved[0].sha256 === aList[0].sha256 && moved[1].sha256 === ghostSha, `stamps on the new device: ${JSON.stringify(moved)}`);
      await a2.page.goto(`${ORIGIN}/chat/${b.hex}`);
      await a2.page.getByPlaceholder('メッセージ').waitFor();
      await button(a2.page, 'スタンプ').click();
      await a2.page.getByTestId('stamp-item').first().waitFor({ timeout: 15000 });
      const gone = a2.page.getByTestId('stamp-item-unavailable');
      await gone.waitFor({ timeout: 15000 });
      await shot(a2.page, 'stamp-moved', '別の端末に移したスタンプ（右は置き場から消えたもの）');
      // The moved stamp is sent from the new device and reaches B.
      await a2.page.getByTestId('stamp-item').first().click();
      await b.page.getByTestId('stamp-message').first().waitFor({ timeout: 15000 });
      // The gone one is removed with a long press (right click on a computer).
      await button(a2.page, 'スタンプ').click();
      await gone.click({ button: 'right' });
      await button(a2.page, '削除').click();
      await a2.page.waitForFunction(() => JSON.parse(localStorage.getItem('tegami.stamps')).length === 1, null, { timeout: 5000 });
      await a2.context.close();

      // The recovery code: the backup holds the stamps, and a restored device gets them.
      await a.page.goto(ORIGIN + '/settings/account');
      await button(a.page, '復旧コードを作成').click();
      await waitText(a.page, 'このコードは今だけ表示されます');
      const code = (await a.page.getByTestId('recovery-code').innerText()).trim();
      await button(a.page, '保管しました').click();
      const r = await newUser(browser, { prf: false });
      await button(r.page, '復旧コードを使う').click();
      await r.page.getByPlaceholder('復旧コード').fill(code);
      await button(r.page, '復旧').click();
      await waitText(r.page, 'あゆみさんのアカウントを受け取りました');
      await button(r.page, 'この端末で使う').click();
      await button(r.page, 'パスキーを使わずに始める').click();
      await waitOpen(r.page);
      const restored = await r.page.evaluate(() => JSON.parse(localStorage.getItem('tegami.stamps') ?? '[]'));
      // The gone stamp removed on the second device was removed here too (my devices share one list).
      assert(restored.length === 1 && restored[0].sha256 === aList[0].sha256, `stamps after restoring: ${JSON.stringify(restored)}`);
      await r.page.goto(`${ORIGIN}/chat/${b.hex}`);
      await r.page.getByPlaceholder('メッセージ').waitFor();
      await button(r.page, 'スタンプ').click();
      await r.page.getByTestId('stamp-item').first().waitFor({ timeout: 15000 });
      await r.context.close();

      // A backup written before stamps existed (no "stamps", no "blocked") restores with no stamps.
      const SYMBOLS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
      const raw = [...crypto.getRandomValues(new Uint8Array(28))].map((x) => SYMBOLS[x & 31]).join('');
      const oldCode = raw.match(/.{4}/g).join('-');
      const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(raw), 'HKDF', false, ['deriveBits']);
      const bits = async (info) =>
        new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('tegami/recovery/v1'), info: new TextEncoder().encode(info) }, base, 256));
      const id = Buffer.from(await bits('backup id')).toString('hex');
      const signer = await bits('backup signer');
      const key = await crypto.subtle.importKey('raw', await bits('backup key'), 'AES-GCM', false, ['encrypt']);
      const json = JSON.stringify({ v: 1, secretHex: Buffer.from(generateSecretKey()).toString('hex'), myName: 'むかし', contacts: [{ pubkey: b.hex, name: 'ばんり' }], groups: [] });
      const padded = json + ' '.repeat(1024 - (Buffer.byteLength(json) % 1024));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(id) }, key, new TextEncoder().encode(padded));
      const body = JSON.stringify({ v: 1, iv: Buffer.from(iv).toString('base64url'), ct: Buffer.from(ct).toString('base64url') });
      const url = `http://localhost:${RELAY_PORT}/backup/${id}`;
      const payload = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))).toString('hex');
      const auth = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['u', url], ['method', 'PUT'], ['payload', payload]] }, signer);
      const put = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Nostr ${btoa(JSON.stringify(auth))}` }, body });
      assert(put.ok, `old backup upload: ${put.status}`);
      const o = await newUser(browser, { prf: false });
      await button(o.page, '復旧コードを使う').click();
      await o.page.getByPlaceholder('復旧コード').fill(oldCode);
      await button(o.page, '復旧').click();
      await waitText(o.page, 'むかしさんのアカウントを受け取りました');
      await button(o.page, 'この端末で使う').click();
      await button(o.page, 'パスキーを使わずに始める').click();
      await waitOpen(o.page);
      await waitText(o.page, 'ばんり');
      const none = await o.page.evaluate(() => localStorage.getItem('tegami.stamps'));
      assert(JSON.parse(none ?? '[]').length === 0, `stamps from an old backup: ${none}`);
      await o.page.goto(`${ORIGIN}/chat/${b.hex}`);
      await o.page.getByPlaceholder('メッセージ').waitFor();
      await button(o.page, 'スタンプ').click();
      await button(o.page, 'スタンプを作る').waitFor({ timeout: 5000 });
      assert((await o.page.getByTestId('stamp-item').count()) === 0, 'stamps shown from an old backup');
      for (const u of [a, b, o]) await u.context.close();
    });

    await test('Stamps everywhere: kept until removed, the same list on all my devices, recently used first, moved to the front; a friend keeps their own copy', async () => {
      const a = await person(browser, 'あゆみ');
      const b = await person(browser, 'ばんり');
      await befriend(b, a);
      await befriend(a, b);
      const relayStamps = async () => (await fetch(`http://localhost:${RELAY_PORT}/_stamps`)).json();
      const list = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('tegami.stamps') ?? '[]').map((s) => s.sha256));
      const until = async (cond, what) => {
        for (let i = 0; i < 100; i++) {
          if (await cond()) return;
          await new Promise((r) => setTimeout(r, 150));
        }
        throw new Error(`timed out: ${what}`);
      };
      const picture = (color) =>
        a.page
          .evaluate((col) => {
            const c = document.createElement('canvas');
            c.width = 160;
            c.height = 160;
            const g = c.getContext('2d');
            g.fillStyle = col;
            g.fillRect(10, 10, 140, 140);
            return c.toDataURL('image/png').split(',')[1];
          }, color)
          .then((b64) => Buffer.from(b64, 'base64'));
      const make = async (u, color) => {
        const png = await picture(color);
        if (!(await u.page.getByText('スタンプを作る').isVisible())) await button(u.page, 'スタンプ').click();
        const chooser = u.page.waitForEvent('filechooser');
        await button(u.page, 'スタンプを作る').click();
        await (await chooser).setFiles({ name: 'stamp.png', mimeType: 'image/png', buffer: png });
      };

      // A second device for A, through the link.
      await a.page.goto(ORIGIN + '/settings/account');
      await a.page.getByText('別の端末でも使う').click();
      await waitText(a.page, 'まで使えます');
      const moveLink = (await text(a.page)).match(/http:\/\/localhost:\d+\/link#k=[A-Za-z0-9_-]+/)[0];
      const a2 = await newUser(browser, { prf: false });
      await a2.page.goto(moveLink);
      await button(a2.page, 'この端末で使う').click();
      await button(a2.page, 'パスキーを使わずに始める').click();
      await waitOpen(a2.page);
      for (const u of [a, a2]) {
        await u.page.goto(`${ORIGIN}/chat/${b.hex}`);
        await u.page.getByPlaceholder('メッセージ').waitFor();
      }

      // A stamp made on the second device shows up on the first, and lives in the stamp storage.
      await make(a2, '#b5452f');
      await until(async () => (await list(a2.page)).length === 1, 'the stamp was not made');
      const [red] = await list(a2.page);
      await until(async () => (await list(a.page)).join() === red, 'the stamp did not reach my other device');
      const kept = await relayStamps();
      assert(kept.some((s) => s.sha === red && s.keepers.length === 1), `stamp storage: ${JSON.stringify(kept)}`);

      // A second one on the first device; the second device follows.
      await make(a, '#2f6db5');
      await until(async () => (await list(a.page)).length === 2, 'the second stamp was not made');
      const [, blue] = await list(a.page);
      await until(async () => (await list(a2.page)).join() === [red, blue].join(), 'the second stamp did not reach my other device');

      // Sending puts the stamp in the recently used row.
      if (!(await a.page.getByTestId('stamp-item').first().isVisible())) await button(a.page, 'スタンプ').click();
      assert((await a.page.getByTestId('stamp-recent').count()) === 0, 'a recently used row before any stamp was sent');
      await a.page.getByTestId('stamp-item').nth(1).click();
      await b.page.getByTestId('stamp-message').first().waitFor({ timeout: 15000 });
      await button(a.page, 'スタンプ').click();
      await a.page.getByTestId('stamp-recent').first().waitFor({ timeout: 5000 });
      assert((await a.page.getByTestId('stamp-recent').count()) === 1, 'the recently used row');

      // Long press: 先頭へ moves it to the front, on both devices.
      await a.page.getByTestId('stamp-item').nth(1).click({ button: 'right' });
      await shot(a.page, 'stamp-menu', 'スタンプを長押しした時（上の段は最近使ったスタンプ）');
      await button(a.page, '先頭へ').click();
      await until(async () => (await list(a.page)).join() === [blue, red].join(), 'not moved to the front');
      await until(async () => (await list(a2.page)).join() === [blue, red].join(), 'the order did not reach my other device');
      // The first one has no 先頭へ.
      await a.page.getByTestId('stamp-item').first().click({ button: 'right' });
      await button(a.page, '削除').waitFor({ timeout: 5000 });
      assert(!(await a.page.getByText('先頭へ').isVisible()), '先頭へ on the first stamp');

      // The friend adds my stamp: their copy is a different file (the relay cannot match them).
      const bStamp = b.page.getByTestId('stamp-message').first();
      await bStamp.click();
      await button(b.page, 'スタンプに追加').click();
      await until(async () => (await list(b.page)).length === 1, 'the friend did not add it');
      const [bBlue] = await list(b.page);
      assert(bBlue !== blue, 'the friend\'s copy is the same file as mine');
      await until(async () => (await relayStamps()).some((s) => s.sha === bBlue), 'the friend\'s copy is not in the stamp storage');

      // Removing on the second device: gone on the first device and from the stamp storage.
      if (!(await a2.page.getByText('スタンプを作る').isVisible())) await button(a2.page, 'スタンプ').click();
      await a2.page.getByTestId('stamp-item').nth(1).waitFor({ timeout: 15000 });
      await a2.page.getByTestId('stamp-item').nth(1).click({ button: 'right' });
      await button(a2.page, '削除').click();
      await until(async () => (await list(a.page)).join() === blue, 'the removal did not reach my other device');
      await until(async () => !(await relayStamps()).some((s) => s.sha === red), 'the removed stamp is still in the stamp storage');
      assert((await relayStamps()).some((s) => s.sha === bBlue), 'the friend\'s copy went with mine');

      // A device that was closed gets the newest list when it opens again.
      await a2.page.goto('about:blank');
      await make(a, '#d9a400');
      await until(async () => (await list(a.page)).length === 2, 'the third stamp was not made');
      const newest = await list(a.page);
      await a2.page.goto(`${ORIGIN}/`);
      await waitOpen(a2.page);
      await until(async () => (await list(a2.page)).join() === newest.join(), 'a reopened device did not get the newest list');
      for (const u of [a, a2, b]) await u.context.close();
    });

    await test('Video and file: sent encrypted, the friend can play the video and save the file with its name', async () => {
      const a = await person(browser, 'あゆみ');
      const b = await person(browser, 'ばんり');
      await befriend(b, a);
      await befriend(a, b);

      const webm = Buffer.from(
        await a.page.evaluate(async () => {
          const c = document.createElement('canvas');
          c.width = 160;
          c.height = 120;
          const g = c.getContext('2d');
          g.fillStyle = '#2f6db5';
          g.fillRect(0, 0, 160, 120);
          const stream = c.captureStream(10);
          const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
          const chunks = [];
          rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
          rec.start();
          await new Promise((r) => setTimeout(r, 400));
          rec.stop();
          await new Promise((r) => (rec.onstop = r));
          stream.getTracks().forEach((t) => t.stop());
          const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
          let bin = '';
          for (const b of bytes) bin += String.fromCharCode(b);
          return btoa(bin);
        }),
        'base64',
      );
      const videoChooser = a.page.waitForEvent('filechooser');
      await button(a.page, '写真').click();
      await (await videoChooser).setFiles({ name: 'clip.webm', mimeType: 'video/webm', buffer: webm });
      await a.page.getByTestId('video-message').first().waitFor({ timeout: 15000 });
      const bVideo = b.page.getByTestId('video-message').first();
      await bVideo.waitFor({ timeout: 15000 });
      await b.page.waitForFunction(() => {
        const video = document.querySelector('[data-testid="video-message"]');
        return video instanceof HTMLVideoElement && video.muted && !video.paused;
      }, null, { timeout: 10000 });
      await shot(b.page, 'video-chat', '動画が届いたトーク');

      const plainText = '合計 120,000円\nよろしくお願いします。';
      await button(a.page, 'その他').click();
      await a.page.getByTestId('plus-panel').waitFor();
      await shot(a.page, 'plus-panel', '下の段の「＋」を押した時に出るパネル（ファイル）');
      const fileChooser = a.page.waitForEvent('filechooser');
      await button(a.page, 'ファイル').click();
      await (await fileChooser).setFiles({ name: '見積書.txt', mimeType: 'text/plain', buffer: Buffer.from(plainText, 'utf8') });
      const bFile = b.page.getByTestId('file-message').first();
      await bFile.waitFor({ timeout: 15000 });
      const fileText = await bFile.innerText();
      assert(fileText.includes('見積書.txt'), `file message text: ${fileText}`);
      assert(fileText.includes('有効期間：'), `file message missing expiry: ${fileText}`);
      assert(fileText.includes('サイズ：'), `file message missing size: ${fileText}`);
      await shot(b.page, 'video-file', '動画とファイルが届いたトーク');

      const sentFiles = await a.page.evaluate(() => JSON.parse(localStorage.getItem('tegami.messages')).filter((m) => m.file).map((m) => m.file));
      assert(sentFiles.length === 2, `expected 2 sent files, got ${sentFiles.length}`);
      for (const f of sentFiles) {
        const stored = Buffer.from(await (await fetch(f.url)).arrayBuffer());
        assert(
          stored.length > 0 && !stored.includes(Buffer.from('合計 120,000円')) && stored.subarray(0, 4).toString('hex') !== '1a45dfa3',
          'the server holds unencrypted file content',
        );
      }

      const dlPromise = b.page.waitForEvent('download');
      await bFile.click();
      const dl = await dlPromise;
      assert(dl.suggestedFilename() === '見積書.txt', `filename: ${dl.suggestedFilename()}`);
      const downloaded = readFileSync(await dl.path(), 'utf8');
      assert(downloaded === plainText, `downloaded content: ${downloaded}`);
      for (const u of [a, b]) await u.context.close();
    });

    await test('Voice message: record, send, the friend gets an audio player', async () => {
      const a = await person(browser, 'あゆみ');
      const b = await person(browser, 'ばんり');
      await befriend(b, a);
      await befriend(a, b);

      await button(a.page, '録音').click();
      await waitText(a.page, 'ボタンをタップして録音してください');
      await button(a.page, '録音を開始').waitFor({ timeout: 5000 });
      await shot(a.page, 'record-panel', '「録音」を押した時に出るパネル（録音する前）');
      await button(a.page, '録音を開始').click();
      await button(a.page, '停止').waitFor({ timeout: 5000 });
      await button(a.page, '削除').waitFor({ timeout: 5000 });
      await a.page.waitForTimeout(1500);
      await shot(a.page, 'recording', '「録音を開始」を押して録音している時');
      await button(a.page, '送る').click();

      await a.page.getByTestId('voice-message').first().waitFor({ timeout: 15000 });
      const bVoice = b.page.getByTestId('voice-message').first();
      await bVoice.waitFor({ timeout: 15000 });
      const waveform = bVoice.getByTestId('voice-waveform');
      await waveform.waitFor({ timeout: 5000 });
      const barCount = await waveform.evaluate((el) => el.children.length);
      assert(barCount >= 20, `expected waveform bars, got ${barCount}`);
      await shot(b.page, 'voice', '音声メッセージが届いたトーク');
      for (const u of [a, b]) await u.context.close();
    });

    await test('Too large: a file over 10 MB is not sent', async () => {
      const a = await person(browser, 'あゆみ');
      const b = await person(browser, 'ばんり');
      await befriend(b, a);
      await befriend(a, b);

      const big = Buffer.alloc(11 * 1024 * 1024, 0x61);
      await button(a.page, 'その他').click();
      const chooser = a.page.waitForEvent('filechooser');
      await button(a.page, 'ファイル').click();
      await (await chooser).setFiles({ name: 'huge.bin', mimeType: 'application/octet-stream', buffer: big });
      await waitText(a.page, '10MBを超えるファイルは送れません');
      await shot(a.page, 'too-large', '10MBを超えるファイルを選んだ時');
      const count = await a.page.evaluate(() => JSON.parse(localStorage.getItem('tegami.messages') ?? '[]').length);
      assert(count === 0, `expected 0 messages in chat, got ${count}`);
      for (const u of [a, b]) await u.context.close();
    });

    await test('Chat layout at phone width: the name and header buttons do not overlap, the input is at least 150 px wide', async () => {
      const a = await person(browser, 'あゆみ');
      const b = await person(browser, 'とても長い名前のともだちテスト用のアカウント');
      await a.page.setViewportSize({ width: 390, height: 760 });
      await befriend(b, a);
      await befriend(a, b);

      const title = a.page.getByTestId('chat-title');
      const callBtn = button(a.page, '通話');
      const menuBtn = button(a.page, 'メニュー');
      const input = a.page.getByPlaceholder('メッセージ');
      const photoBtn = button(a.page, '写真');
      const micBtn = button(a.page, '録音');

      await title.waitFor();
      await callBtn.waitFor();
      await menuBtn.waitFor();
      await input.waitFor();

      const titleBox = await title.boundingBox();
      const callBox = await callBtn.boundingBox();
      const menuBox = await menuBtn.boundingBox();
      const inputBox = await input.boundingBox();
      const photoBox = await photoBtn.boundingBox();
      const micBox = await micBtn.boundingBox();

      assert(titleBox && callBox && menuBox && inputBox && photoBox && micBox, 'missing bounding box');
      assert(titleBox.width > 0 && titleBox.x + titleBox.width <= callBox.x + 1, `title overlaps call button: ${JSON.stringify({ titleBox, callBox })}`);
      assert(callBox.x + callBox.width <= menuBox.x + 1, `call button overlaps menu button: ${JSON.stringify({ callBox, menuBox })}`);
      assert(menuBox.x + menuBox.width <= 390.5, `menu button overflows 390px viewport: ${JSON.stringify(menuBox)}`);
      assert(inputBox.width >= 150, `input width ${inputBox.width} < 150`);
      assert(photoBox.x + photoBox.width <= inputBox.x + 1, `photo button overlaps input: ${JSON.stringify({ photoBox, inputBox })}`);
      assert(inputBox.x + inputBox.width <= micBox.x + 1, `input overlaps mic button: ${JSON.stringify({ inputBox, micBox })}`);
      for (const u of [a, b]) await u.context.close();
    });

    await test('Message panel: long press shows コピー/リプライ/転送/削除/通報; 削除 removes the message on this device only and it stays removed after reopening', async () => {
      const a = await person(browser, 'あゆみ');
      const b = await person(browser, 'ばんり');
      await befriend(b, a);
      await befriend(a, b);

      await b.page.getByPlaceholder('メッセージ').fill('長押しで消す手紙');
      await button(b.page, '送る').click();
      await b.page.getByPlaceholder('メッセージ').fill('残る手紙');
      await button(b.page, '送る').click();
      await a.page.getByPlaceholder('メッセージ').fill('自分の手紙');
      await button(a.page, '送る').click();
      await waitText(a.page, '長押しで消す手紙');
      await waitText(a.page, '残る手紙');
      await waitText(a.page, '自分の手紙');

      const longPress = async (locator) => {
        const box = await locator.boundingBox();
        assert(box, 'message not visible for long press');
        await a.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await a.page.mouse.down();
        await a.page.waitForTimeout(550);
        await a.page.mouse.up();
        // The tap that ends the press is ignored for a moment; a person cannot tap again faster.
        await a.page.waitForTimeout(350);
      };

      const target = a.page.getByText('長押しで消す手紙', { exact: true });
      await longPress(target);
      const panel = a.page.getByTestId('message-panel');
      await panel.waitFor();
      for (const label of ['コピー', 'リプライ', '転送', '削除', '通報']) {
        assert(await panel.getByRole('button', { name: label, exact: true }).isVisible(), `missing ${label} in message panel`);
      }
      await shot(a.page, 'message-panel', 'メッセージを長押しした時に出るパネル（コピー・リプライ・転送・削除・通報）');

      // Tapping outside closes the panel.
      await a.page.getByPlaceholder('メッセージ').click();
      await panel.waitFor({ state: 'detached' });

      // Own message shows コピー/リプライ/転送/削除, without 通報.
      const own = a.page.getByText('自分の手紙', { exact: true });
      await longPress(own);
      await panel.waitFor();
      assert((await panel.getByRole('button', { name: '通報', exact: true }).count()) === 0, '通報 shown on own message');
      await a.page.getByPlaceholder('メッセージ').click();
      await panel.waitFor({ state: 'detached' });

      // Report from the message panel attaches the selected message and surrounding messages when chosen.
      await longPress(target);
      await panel.waitFor();
      await panel.getByRole('button', { name: '通報', exact: true }).click();
      await waitText(a.page, 'オンにすると、選んだメッセージと前後のメッセージ（2件）を送ります');
      await a.page.getByRole('radio', { name: 'なりすまし', exact: true }).click();
      await a.page.getByRole('switch', { name: 'メッセージを添える' }).click();
      await waitText(a.page, '選んだメッセージと前後のメッセージ（2件）を送ります');
      assert(!(await text(a.page)).includes('オンにすると、'), 'report line still shows off prefix when switch is on');
      await button(a.page, '同意して送信').click();
      await waitText(a.page, '通報しました');
      await button(a.page, '閉じる').click();
      const reports = await (await fetch(`http://localhost:${RELAY_PORT}/_reports`)).json();
      const imp = reports.find((r) => r.reported === b.hex && r.reason === 'impersonation');
      assert(imp && Array.isArray(imp.messages) && imp.messages.length === 2, `impersonation report: ${JSON.stringify(imp)}`);

      // 削除 removes the message on this device only and it stays removed after reopening.
      await longPress(target);
      await panel.waitFor();
      await panel.getByRole('button', { name: '削除', exact: true }).click();
      await waitText(a.page, 'このメッセージはこの端末でのみ削除されます。相手の端末からは削除されません。');
      await shot(a.page, 'delete-message-dialog', 'メッセージのパネルで「削除」を押した時に出る確認のダイアログ');
      await button(a.page, 'この端末でのみ削除').click();
      await noText(a.page, '長押しで消す手紙', 500);
      assert((await text(a.page)).includes('残る手紙'), 'other message disappeared');
      assert((await text(b.page)).includes('長押しで消す手紙'), "deleted message disappeared from friend's device");

      await a.page.goto(ORIGIN + '/');
      await waitOpen(a.page);
      await a.page.getByText('ばんり').first().click();
      await waitText(a.page, '残る手紙');
      await noText(a.page, '長押しで消す手紙', 2500);
      for (const u of [a, b]) await u.context.close();
    });

    await test('Swipe right starts a reply', async () => {
      const a = await person(browser, 'あゆみ');
      const b = await person(browser, 'ばんり');
      await befriend(b, a);
      await befriend(a, b);

      await b.page.getByPlaceholder('メッセージ').fill('右スワイプする手紙');
      await button(b.page, '送る').click();
      await waitText(a.page, '右スワイプする手紙');

      const msg = a.page.getByText('右スワイプする手紙', { exact: true });
      const box = await msg.boundingBox();
      assert(box, 'message not visible for swipe');
      const startX = box.x + 20;
      const startY = box.y + box.height / 2;
      await a.page.mouse.move(startX, startY);
      await a.page.mouse.down();
      await a.page.mouse.move(startX + 80, startY, { steps: 8 });
      await a.page.getByTestId('swipe-reply-icon').waitFor();
      await shot(a.page, 'swipe-reply', 'メッセージを右にスワイプしてリプライを始める時');
      await a.page.mouse.up();

      const replying = a.page.getByTestId('replying');
      await replying.waitFor();
      assert((await replying.innerText()).replace(/\s+/g, ' ').includes('ばんり 右スワイプする手紙'), `reply bar: ${await replying.innerText()}`);
      await a.page.getByPlaceholder('メッセージ').fill('スワイプからの返信');
      await button(a.page, '送る').click();
      await waitText(b.page, 'スワイプからの返信');
      assert((await b.page.getByTestId('quote').innerText()).replace(/\s+/g, ' ').includes('ばんり 右スワイプする手紙'), 'quote not received');
      for (const u of [a, b]) await u.context.close();
    });
    await test('First screen as on tegami.chat; light and dark switch there and in settings, kept after reloading', async () => {
      const { context, page } = await newUser(browser);
      await waitText(page, 'あなたのもの。');
      await waitText(page, '持ち込み自由。');
      // The color of the first heading: dark text on light, light text on dark.
      const ink = () => page.getByRole('heading').first().evaluate((e) => getComputedStyle(e).color);
      await button(page, 'ダーク').click();
      assert((await ink()) === 'rgb(222, 228, 222)', `dark ink: ${await ink()}`);
      assert((await button(page, 'ダーク').getAttribute('aria-pressed')) === 'true', 'dark is shown as chosen');
      await page.reload();
      await waitText(page, 'あなたのもの。');
      assert((await ink()) === 'rgb(222, 228, 222)', 'dark kept after reloading');
      await button(page, 'ライト').click();
      assert((await ink()) === 'rgb(23, 29, 25)', `light ink: ${await ink()}`);
      // After starting, the same switch is in the settings.
      await button(page, 'はじめる').click();
      await openSettings(page);
      await waitText(page, 'ライトとダーク');
      await button(page, 'ダーク').click();
      const bg = await page.evaluate(() => localStorage.getItem('tegami.theme'));
      assert(bg === 'dark', `stored: ${bg}`);
      await context.close();
    });

    if (!NARROW) await test('Desktop layout: rail, list and chat side by side; Alt+arrows, Ctrl+K, Esc, hover actions, Shift+Enter, dropping a file', async () => {
      const a = await person(browser, 'あゆみ');
      const b = await person(browser, 'ばんり');
      const c = await person(browser, 'ちあき');
      await befriend(b, a);
      await befriend(c, a);
      await befriend(a, b);
      await befriend(a, c);
      await b.page.getByPlaceholder('メッセージ').fill('ばんりからの手紙');
      await button(b.page, '送る').click();
      await waitText(a.page, 'ばんりからの手紙');

      // The list stays beside the open chat, with the open chat marked.
      await a.page.goto(ORIGIN + '/');
      await waitOpen(a.page);
      for (const name of ['トーク', '友だち', '友だち追加', '設定']) assert(await button(a.page, name).isVisible(), `no ${name} on the rail`);
      await a.page.getByText('ばんり', { exact: true }).first().click();
      await a.page.getByPlaceholder('メッセージ').waitFor();
      const marked = a.page.locator('[aria-current="page"]', { hasText: 'ばんり' });
      assert(await marked.count(), 'the open chat is not marked in the list');
      const listBox = await a.page.getByRole('navigation').boundingBox();
      const inputBox = await a.page.getByPlaceholder('メッセージ').boundingBox();
      assert(listBox && inputBox && listBox.x + listBox.width <= inputBox.x, `list and chat overlap: ${JSON.stringify({ listBox, inputBox })}`);
      assert(!(await button(a.page, '戻る').count()), 'a back button in the desktop chat');

      // Alt+↑ and Alt+↓ move between chats; Ctrl+K goes to the search field.
      const titleNow = () => a.page.getByTestId('chat-title').innerText();
      const before = await titleNow();
      await a.page.keyboard.press('Alt+ArrowDown');
      await a.page.waitForFunction((t) => document.querySelector('[data-testid="chat-title"]')?.textContent !== t, before);
      const after = await titleNow();
      assert(['ばんり', 'ちあき'].includes(after) && after !== before, `Alt+↓ went to ${after}`);
      await a.page.keyboard.press('Alt+ArrowUp');
      await a.page.waitForFunction((t) => document.querySelector('[data-testid="chat-title"]')?.textContent === t, before);
      await a.page.keyboard.press('Control+k');
      assert(await a.page.getByRole('searchbox').evaluate((el) => el === document.activeElement), 'Ctrl+K did not focus the search field');

      // The details open beside the chat and Esc closes them.
      await button(a.page, 'メニュー').click();
      await infoArea(a.page).getByText('トークを削除').waitFor();
      assert(await a.page.getByPlaceholder('メッセージ').isVisible(), 'the chat is hidden by the details');
      await a.page.keyboard.press('Escape');
      await a.page.getByRole('complementary').waitFor({ state: 'detached', timeout: 5000 });

      // The mouse over a message shows its quick actions; リプライ starts a reply, Esc cancels it.
      await a.page.getByText('ばんりからの手紙', { exact: true }).hover();
      await a.page.getByTestId('hover-tools').waitFor();
      await a.page.getByTestId('hover-tools').getByRole('button', { name: 'リプライ' }).click();
      await a.page.getByTestId('replying').waitFor();
      await a.page.keyboard.press('Escape');
      await a.page.getByTestId('replying').waitFor({ state: 'detached', timeout: 5000 });

      // Enter sends, Shift+Enter starts a new line.
      const box = a.page.getByPlaceholder('メッセージ');
      await box.click();
      await a.page.keyboard.type('一行目');
      await a.page.keyboard.press('Shift+Enter');
      await a.page.keyboard.type('二行目');
      assert((await box.inputValue()) === '一行目\n二行目', `Shift+Enter: ${JSON.stringify(await box.inputValue())}`);
      await a.page.keyboard.press('Enter');
      await waitText(b.page, '二行目');

      // A file dropped on the chat asks first, then goes out as a file.
      await box.evaluate((el) => {
        const dt = new DataTransfer();
        dt.items.add(new File(['hello'], 'メモ.txt', { type: 'text/plain' }));
        for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      });
      await waitText(a.page, 'ばんりに送りますか？');
      await waitText(a.page, 'メモ.txt');
      await a.page.getByTestId('dialog').getByRole('button', { name: '送る', exact: true }).click();
      await waitText(b.page, 'メモ.txt');
      await shot(a.page, 'desktop', 'PC の広い画面');
      for (const u of [a, b, c]) await u.context.close();
    });

    await test('Call button: the header offers voice and video, as LINE', async () => {
      const a = await person(browser, 'あん');
      const b = await person(browser, 'べん');
      await befriend(b, a);
      await befriend(a, b);
      await button(a.page, '通話').click();
      await a.page.getByTestId('call-menu').waitFor();
      assert(await button(a.page, '音声通話').isVisible(), 'no voice call in the menu');
      assert(await button(a.page, 'ビデオ通話').isVisible(), 'no video call in the menu');
      await shot(a.page, 'call-menu', 'トークの画面の電話のボタンを押した時（音声通話とビデオ通話を選ぶ）');
      await button(a.page, 'ビデオ通話').click();
      await waitText(b.page, 'ビデオ通話');
      await button(b.page, '拒否').click();
      await waitText(a.page, '応答がありません');
      for (const u of [a, b]) await u.context.close();
    });

    await test('Remove from this device: one of two accounts goes with its storage, the other stays; the last one leaves the first screen', async () => {
      const u = await person(browser, 'いち');
      const x = generateSecretKey();
      await befriend(u, `https://app.tegami.chat/i#${nip19.npubEncode(getPublicKey(x))}&n=${encodeURIComponent('えっくす')}`);
      await relaySend(x, wrapTo(x, u.hex, rumorTo(x, u.hex, 'いちさんへの手紙')));
      await u.page.goto(ORIGIN + '/');
      await waitText(u.page, 'いちさんへの手紙');
      // With one account, the list offers no removing (settings has "この端末から削除").
      await openSettings(u.page, 'アカウント');
      await waitText(u.page, '使用中');
      assert((await u.page.getByRole('button', { name: /^この端末から削除（/ }).count()) === 0, 'removing offered in the list with one account');
      await button(u.page, 'アカウントを追加').click();
      await button(u.page, 'はじめる').click();
      await button(u.page, 'パスキーを使わずに始める').click();
      await waitOpen(u.page);
      await u.page.goto(ORIGIN + '/add');
      await waitText(u.page, 'マイQRコード');
      await u.page.getByPlaceholder('自分の名前').fill('に');
      await u.page.goto(ORIGIN + '/settings/account');
      await waitText(u.page, '使用中');
      await shot(u.page, 'account-list-remove', '設定のアカウントの一覧（2つある時は、それぞれに「削除」）');
      const before = await storage(u.page);
      assert(before['tegami.messages'] && Object.keys(before).some((k) => k.startsWith('tegami@')), 'setup: both accounts keep storage');
      // Remove the first account (not the open one) from the list.
      await button(u.page, 'この端末から削除（いち）').click();
      await waitText(u.page, 'いちをこの端末から削除しますか？');
      await shot(u.page, 'account-remove-dialog', '一覧の「削除」を押した時の確認');
      await u.page.getByTestId('dialog').getByRole('button', { name: 'キャンセル', exact: true }).click();
      assert((await storage(u.page))['tegami.messages'], 'cancel removed the account');
      await button(u.page, 'この端末から削除（いち）').click();
      await u.page.getByTestId('dialog').getByRole('button', { name: '削除', exact: true }).click();
      await u.page.waitForFunction(() => !localStorage.getItem('tegami.messages'), null, { timeout: 5000 }).catch(() => {
        throw new Error('the removed account kept its messages');
      });
      let s = await storage(u.page);
      const left = Object.keys(s).filter((k) => k.startsWith('tegami.') && !['tegami.accounts', 'tegami.theme', 'tegami.crashReports'].includes(k));
      assert(left.length === 0, `the first account left storage behind: ${left}`);
      assert(JSON.parse(s['tegami.accounts']).list.length === 1, `account list: ${s['tegami.accounts']}`);
      assert(Object.keys(s).some((k) => k.startsWith('tegami@') && k.endsWith('.device')), 'the open account lost its key');
      await waitText(u.page, '使用中');
      assert(!(await text(u.page)).includes('いち'), 'the removed account is still listed');
      // The one left is removed from settings: the first screen, with nothing kept.
      await button(u.page, 'この端末から削除').click();
      await waitText(u.page, 'をこの端末から削除しますか？');
      await shot(u.page, 'remove-here-dialog', '設定の「この端末から削除」を押した時の確認');
      await u.page.getByTestId('dialog').getByRole('button', { name: '削除', exact: true }).click();
      await button(u.page, 'はじめる').waitFor({ timeout: 10000 });
      s = await storage(u.page);
      assert(!Object.keys(s).some((k) => k.endsWith('.device') || k.endsWith('.messages') || k.endsWith('.contacts')), `storage left: ${Object.keys(s)}`);
      assert(JSON.parse(s['tegami.accounts']).list.length === 1, 'the new empty account is not alone');
      // The account itself is still on the relay (only this device forgot it).
      const members = await (await fetch(`http://localhost:${RELAY_PORT}/_members`)).json();
      assert(members.some((m) => m.pubkey === u.hex), 'removing from this device deleted the account on the relay');
      await u.context.close();
    });

    await test('Delete account: the relay forgets the key, its backup and its mailbox; another device of it is told; messages to it are not kept', async () => {
      const sk = generateSecretKey();
      const hex = getPublicKey(sk);
      const device = async () => {
        const u = await newUser(browser, { authenticator: false });
        await u.page.evaluate((h) => localStorage.setItem('tegami.account', JSON.stringify({ secretHex: h })), Buffer.from(sk).toString('hex'));
        await u.page.reload();
        await waitOpen(u.page);
        return u;
      };
      const a = await device();
      const a2 = await device();
      const b = await person(browser, 'ともだち');
      await befriend(b, `https://app.tegami.chat/i#${nip19.npubEncode(hex)}&n=${encodeURIComponent('けすひと')}`);
      await b.page.getByPlaceholder('メッセージ').fill('まだ読んでいない手紙');
      await b.page.keyboard.press('Enter');
      for (let i = 0; i < 50 && !(await envelopesFor(hex)).length; i++) await new Promise((r) => setTimeout(r, 100));
      assert((await envelopesFor(hex)).length > 0, 'setup: no envelope waiting');
      // A recovery code (its backup is signed with a key from the code, not the account key).
      await a.page.goto(ORIGIN + '/settings/account');
      await button(a.page, '復旧コードを作成').click();
      await button(a.page, '保管しました').click();
      const backups = async () => (await (await fetch(`http://localhost:${RELAY_PORT}/_backups`)).json()).length;
      const backupsBefore = await backups();
      assert(backupsBefore >= 1, 'setup: no backup');
      await button(a.page, '戻る').click();
      await a.page.getByRole('button', { name: 'プロフィール', exact: true }).last().click();
      await a.page.getByPlaceholder('相手に表示される名前').fill('けすひと');
      await button(a.page, '戻る').click();
      await a.page.getByRole('button', { name: 'アカウント', exact: true }).last().click();
      await button(a.page, 'アカウントを削除').click();
      await waitText(a.page, 'けすひとのアカウントを削除しますか？');
      await shot(a.page, 'delete-account-dialog', '設定の「アカウントを削除」を押した時の確認（元に戻せない）');
      await a.page.getByTestId('dialog').getByRole('button', { name: '削除', exact: true }).click();
      await button(a.page, 'はじめる').waitFor({ timeout: 15000 });
      const deleted = await (await fetch(`http://localhost:${RELAY_PORT}/_deleted`)).json();
      assert(deleted.includes(hex), 'the relay did not delete the account');
      const members = await (await fetch(`http://localhost:${RELAY_PORT}/_members`)).json();
      assert(!members.some((m) => m.pubkey === hex), 'still registered');
      assert((await envelopesFor(hex)).length === 0, 'envelopes for the deleted account are still kept');
      assert((await backups()) === backupsBefore - 1, 'the recovery backup is still on the relay');
      const s = await storage(a.page);
      assert(!Object.keys(s).some((k) => k.endsWith('.device') || k.endsWith('.messages') || k.endsWith('.recovery')), `storage left: ${Object.keys(s)}`);
      // A message sent now is not kept for it.
      await b.page.getByPlaceholder('メッセージ').fill('もう届かない手紙');
      await b.page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 800));
      assert((await envelopesFor(hex)).length === 0, 'a message to a deleted account was kept');
      // The other device learns it when it asks the relay, and can remove it there.
      await a2.page.reload();
      await waitText(a2.page, 'このアカウントは削除されました。');
      await shot(a2.page, 'deleted-elsewhere', 'ほかの端末でアカウントが削除された時');
      await button(a2.page, 'この端末から削除').click();
      await button(a2.page, 'はじめる').waitFor({ timeout: 10000 });
      for (const u of [a, a2, b]) await u.context.close();
    });

    await test('Feedback: Tegamiへの意見 in settings opens a chat with the official account; listed only once opened; the operator reads it and replies', async () => {
      const u = await person(browser, 'いけん');
      await u.page.goto(ORIGIN + '/');
      await waitOpen(u.page);
      assert(!(await text(u.page)).includes('Tegamiへの意見'), 'listed before it was opened');
      await openSettings(u.page);
      await button(u.page, 'Tegamiへの意見').click();
      await u.page.getByPlaceholder('メッセージ').waitFor();
      assert((await u.page.getByTestId('chat-title').last().innerText()) === 'Tegamiへの意見', 'the chat title is not Tegamiへの意見');
      assert(!(await text(u.page)).includes('友だちに追加'), 'the official account is offered as a friend to add');
      await u.page.getByPlaceholder('メッセージ').fill('通知の音を選べるようにしてほしいです');
      await u.page.keyboard.press('Enter');
      const got = await inboxOf(FEEDBACK_SK, (ms) => ms.some((m) => m.content === '通知の音を選べるようにしてほしいです'));
      assert(got.some((m) => m.pubkey === u.hex), 'the message did not come from the account');
      await shot(u.page, 'feedback-chat', '設定の「Tegamiへの意見」から開いたトーク');
      // The operator answers with the official key: it shows in the same chat, not with strangers.
      await relaySend(FEEDBACK_SK, wrapTo(FEEDBACK_SK, u.hex, rumorTo(FEEDBACK_SK, u.hex, 'ご意見ありがとうございます')));
      await waitText(u.page, 'ご意見ありがとうございます');
      await u.page.goto(ORIGIN + '/');
      await waitText(u.page, 'Tegamiへの意見');
      assert(!(await text(u.page)).includes('知らない人から'), 'the official account went to strangers');
      await shot(u.page, 'feedback-in-list', 'トーク一覧（開いた後に「Tegamiへの意見」が並ぶ）');
      // Another account that never opened it does not list it.
      const v = await person(browser, 'ほか');
      await v.page.goto(ORIGIN + '/');
      await waitOpen(v.page);
      assert(!(await text(v.page)).includes('Tegamiへの意見'), 'listed for an account that never opened it');
      for (const w of [u, v]) await w.context.close();
    });

  } finally {
    await browser.close();
    server.close();
    relay?.kill();
  }

  if (SHOTS) writeFileSync(join(SHOTS, 'shots.json'), JSON.stringify(shotList, null, 2));
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
