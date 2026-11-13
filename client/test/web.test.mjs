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
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
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

async function newUser(browser, { prf = true, wrap = {}, authenticator = true } = {}) {
  const context = await browser.newContext();
  await context.addInitScript(wrapper(wrap));
  await context.addInitScript(RECORDER);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  let authenticatorId = null;
  if (authenticator) ({ authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { ...AUTH, hasPrf: prf } }));
  page.on('pageerror', (e) => console.log('    page error:', e.message));
  await page.goto(ORIGIN + '/');
  return { context, page, cdp, authenticatorId };
}

const text = (page) => page.evaluate(() => document.body.innerText);
const storage = (page) => page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
const calls = (page) => page.evaluate(() => window.__calls);
const button = (page, name) => page.getByRole('button', { name, exact: true });

async function waitOpen(page) {
  await page.waitForFunction(() => {
    const t = document.body.innerText;
    return t.includes('＋') && !t.includes('はじめる') && !t.includes('ひらく');
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
  await waitText(u.page, '自分の招待リンク');
  await u.page.getByPlaceholder('相手に表示される名前').fill(name);
  u.link = (await text(u.page)).match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0];
  u.hex = nip19.decode(u.link.match(/npub1[0-9a-z]+/)[0]).data;
  return u;
}
/** u adds other (a person or an invite link) as a friend and ends up in the chat with them. */
async function befriend(u, other) {
  await u.page.goto(ORIGIN + '/add');
  await waitText(u.page, '自分の招待リンク');
  await u.page.getByPlaceholder('https://app.tegami.chat/i#npub…').fill(typeof other === 'string' ? other : other.link);
  await button(u.page, '追加').click();
  await u.page.getByPlaceholder('メッセージ').waitFor();
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
  if (!process.env.SKIP_BUILD) {
    await sh('npx', ['expo', 'export', '--platform', 'web', '--output-dir', 'dist-test', '--clear'], {
      EXPO_PUBLIC_TEGAMI_RELAYS: `ws://localhost:${RELAY_PORT}`,
      EXPO_PUBLIC_TEGAMI_FILES: `http://localhost:${RELAY_PORT}`,
      EXPO_PUBLIC_TURNSTILE_SITEKEY: '',
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
      assert(t.includes('ひらく') && !t.includes('自分の招待リンク'), `screen: ${t.slice(0, 80)}`);
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
      await waitText(u.page, '自分の招待リンク');
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
      await waitText(a.page, '自分の招待リンク');
      await a.page.getByPlaceholder('相手に表示される名前').fill('あ');
      const link = (await text(a.page)).match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0];
      const b = await newUser(browser, { prf: false });
      await b.page.goto(link.replace('https://app.tegami.chat', ORIGIN));
      await button(b.page, 'はじめる').click();
      await button(b.page, 'パスキーを使わずに始める').click();
      await waitText(b.page, '自分の招待リンク');
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
        await u.page.getByPlaceholder('相手に表示される名前').fill(name);
        u.link = (await text(u.page)).match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0];
        return u;
      }
      async function befriend(u, other) {
        await u.page.goto(ORIGIN + '/add');
        await waitText(u.page, '自分の招待リンク');
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
      await u.page.getByText('設定', { exact: true }).click();
      await waitText(u.page, 'パスキーで守っています');
      const crashes = async () => (await fetch(`http://localhost:${RELAY_PORT}/_crashes`)).json();
      const throwSoon = (tag) =>
        u.page.evaluate((tag) => setTimeout(() => { throw new Error(`boom-${tag} "my secret text" ${'ab'.repeat(32)}`); }), tag);

      // Off by default: nothing is sent.
      assert(!(await u.page.getByRole('switch', { name: 'Tegami に報告を送る' }).isChecked()), 'crash reports are on by default');
      await throwSoon('off');
      await u.page.waitForTimeout(800);
      assert(!(await crashes()).some((r) => r.message.includes('boom-off')), 'a report was sent while off');

      // On: sent, without the quoted text or the long hex.
      await u.page.getByRole('switch', { name: 'Tegami に報告を送る' }).click();
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
      await waitText(u.page, '鍵の守り方');
      assert(await u.page.getByRole('switch', { name: 'Tegami に報告を送る' }).isChecked(), 'the choice was not remembered');

      // Export: a JSON file with the chats, never the key.
      const dl = u.page.waitForEvent('download');
      await u.page.getByText('会話を書き出す').click();
      const file = await (await dl).path();
      const data = JSON.parse(readFileSync(file, 'utf8'));
      assert(data.app === 'Tegami' && Array.isArray(data.messages) && data.me.startsWith('npub1'), 'export shape');
      const vault = await u.page.evaluate(() => localStorage.getItem('tegami.vault'));
      assert(!readFileSync(file, 'utf8').includes(JSON.parse(vault).ciphertext), 'export contains the vault');
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
        await openIfLocked(page, '自分の招待リンク');
        await waitText(page, '自分の招待リンク');
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
      await waitText(b.page, '自分の招待リンク');
      await b.page.getByPlaceholder('相手に表示される名前').fill('びー');
      const bLink = (await text(b.page)).match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0];
      await a.page.goto(bLink.replace('https://app.tegami.chat', ORIGIN));
      await button(a.page, 'ひらく').click();
      await waitText(a.page, '自分の招待リンク');
      await a.page.getByPlaceholder('相手に表示される名前').fill('えー');
      await button(a.page, '追加').click();
      await waitText(a.page, 'びー');
      const aInvite = await inviteOf(a.page);
      const aHex = nip19.decode(aInvite.match(/npub1[0-9a-z]+/)[0]).data;

      // A makes the link in settings.
      await a.page.goto(ORIGIN + '/settings');
      await openIfLocked(a.page, '別の端末でも使う');
      await a.page.getByText('別の端末でも使う').click();
      await waitText(a.page, 'まで使えます');
      const moveLink = (await text(a.page)).match(/http:\/\/localhost:\d+\/link#k=[A-Za-z0-9_-]+/)?.[0];
      assert(moveLink, 'no link on the settings screen');
      assert(await a.page.getByLabel('別の端末で読み取る QR コード').isVisible(), 'no QR code');

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
      await waitText(b.page, 'この端末には、すでに Tegami のアカウントがあります');
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

    await test('Connection dropped (phone put the browser away): messages still arrive after reconnecting', async () => {
      const make = async (name) => {
        const u = await newUser(browser, { prf: false });
        await button(u.page, 'はじめる').click();
        await button(u.page, 'パスキーを使わずに始める').click();
        await waitOpen(u.page);
        await u.page.goto(ORIGIN + '/add');
        await waitText(u.page, '自分の招待リンク');
        await u.page.getByPlaceholder('相手に表示される名前').fill(name);
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
      await u.page.getByText('設定', { exact: true }).click();
      const sw = u.page.getByRole('switch', { name: '新しいメッセージを知らせる' });
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
      const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1' });
      await context.addInitScript(() => {
        delete window.PushManager;
        delete window.PublicKeyCredential; // start without a passkey, quickly
      });
      const page = await context.newPage();
      await page.goto(ORIGIN + '/');
      await button(page, 'はじめる').click();
      await button(page, 'パスキーを使わずに始める').click();
      await waitOpen(page);
      await page.getByText('設定', { exact: true }).click();
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
        await u.page.getByPlaceholder('相手に表示される名前').fill(name);
        u.link = (await text(u.page)).match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0];
        return u;
      }
      async function befriend(u, other) {
        await u.page.goto(ORIGIN + '/add');
        await waitText(u.page, '自分の招待リンク');
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

    await test('Voice call: B answers, both connect, hanging up ends it on both sides; signals expire', async () => {
      const a = await person(browser, 'あおい');
      const b = await person(browser, 'ばく');
      await befriend(b, a);
      await befriend(a, b);
      await b.page.goto(ORIGIN + '/'); // B is somewhere else in the app
      const before = await a.page.evaluate(() => window.__sent.length);
      await a.page.getByRole('button', { name: '音声通話' }).click();
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
      const sent = (await a.page.evaluate(() => window.__sent)).slice(before);
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
      await a.page.getByRole('button', { name: '音声通話' }).click();
      await button(b.page, '応答').click();
      await waitConnected(a.page);
      await button(a.page, '通話を終了').click();
      await waitText(b.page, '通話が終了しました');
      // B reopens within the minute the signals still live on the relay.
      await b.page.goto(ORIGIN + '/');
      await waitOpen(b.page);
      await noText(b.page, '応答', 3000);
      // A calls again: B rings for the new call, answers, and both connect.
      await a.page.getByRole('button', { name: '音声通話' }).click();
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
      await a.page.getByRole('button', { name: 'ビデオ通話' }).click();
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
      await c.page.getByRole('button', { name: '音声通話' }).click();
      await waitText(c.page, '呼び出し中');
      await noText(b.page, '応答', 5000);
      const t = await text(b.page);
      assert(!t.includes('不在着信') && !t.includes('知らない人から'), 'the stranger left a trace');
      await button(c.page, '通話を終了').click();
      for (const u of [b, c]) await u.context.close();
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
      await waitText(b.page, '自分の招待リンク');
      await b.page.getByPlaceholder('相手に表示される名前').fill('びー');
      const bLink = (await text(b.page)).match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0].replace('https://app.tegami.chat', ORIGIN);
      await a.page.goto(bLink);
      await button(a.page, 'ひらく').click();
      await waitText(a.page, '自分の招待リンク');
      await a.page.getByPlaceholder('相手に表示される名前').fill('えー');
      await button(a.page, '追加').click();
      await a.page.getByPlaceholder('メッセージ').waitFor();
      await a.page.goto(ORIGIN + '/add');
      await openIfLocked(a.page, '自分の招待リンク');
      await waitText(a.page, '自分の招待リンク');
      const aNpub = (await text(a.page)).match(/npub1[0-9a-z]+/)[0];
      const aHex = nip19.decode(aNpub).data;

      // Turn recovery on: the code is shown once.
      await a.page.goto(ORIGIN + '/settings');
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
      await openIfLocked(a.page, '自分の招待リンク');
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
      await a.page.goto(ORIGIN + '/settings');
      await openIfLocked(a.page, '復旧コードを削除');
      await waitText(a.page, '復旧コードを削除');
      await a.page.waitForTimeout(2500); // the refresh every app start makes, before the relay goes away
      let attempts = 0;
      await a.page.route('**/backup/**', (route) => {
        attempts++;
        return route.abort();
      });
      const nameBox = a.page.getByPlaceholder('相手に表示される名前');
      for (const n of ['え1', 'え2']) {
        const before = attempts;
        await nameBox.fill(n);
        await until(async () => attempts > before, 'no refresh was tried');
        assert(!(await text(a.page)).includes(BEHIND), `shown after ${attempts} failures`);
      }
      await nameBox.fill('え3');
      await waitText(a.page, BEHIND);
      await a.page.unroute('**/backup/**');
      await nameBox.fill('えーさん');
      await a.page.waitForFunction((t) => !document.body.innerText.includes(t), BEHIND, { timeout: 15000 }).catch(() => {
        throw new Error('the line stayed after the relay came back');
      });
      const [now] = await backups();
      assert((await decrypt(code1, now.data)).bundle.myName === 'えーさん', 'the backup after the relay came back');
      await nameBox.fill('えー');
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
      await waitText(r.u.page, '自分の招待リンク');
      assert((await text(r.u.page)).includes(aNpub), 'not the same account');
      assert((await r.u.page.getByPlaceholder('相手に表示される名前').inputValue()) === 'えー', 'name not restored');
      await r.u.page.goto(ORIGIN + '/settings');
      await waitText(r.u.page, '端末をすべて失っても、復旧コードで戻せます');

      // Wrong codes fail cleanly and leave the start screen as it was.
      for (const wrong of ['2222-3333-4444-5555-6666-7777-8888', 'hello']) {
        const w = await tryCode(wrong);
        assert(w.t.includes('コードが正しくありません') && w.t.includes('はじめる'), `wrong code screen: ${w.t.slice(0, 120)}`);
      }

      // A new code: the old one stops working, the new one works.
      await a.page.goto(ORIGIN + '/settings');
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
      await r.u.page.goto(ORIGIN + '/settings');
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
      await a.page.getByText('設定', { exact: true }).click();
      const sw = a.page.getByRole('switch', { name: '未読数を表示' });
      await sw.waitFor();
      assert(await sw.isChecked(), 'unread counts are off by default');
      await sw.click();
      assert((await a.page.title()) === 'Tegami', 'the tab still shows a number');
      await a.page.goto(ORIGIN + '/');
      await waitText(a.page, 'さん');
      assert((await unreadBadges(a.page).count()) === 0, 'counts shown while turned off');
      await a.page.goto(ORIGIN + '/settings');
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
      await a.page.goto(ORIGIN + '/settings');
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
      const bt = await text(b.page);
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
        await waitText(u.page, 'AI：Anthropic Claude');
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
      await original.hover();
      await button(a.page, 'リプライ').click();
      // The composer shows what the reply is to; キャンセル takes it away.
      const bar = () => a.page.getByRole('button', { name: 'キャンセル' });
      await bar().waitFor();
      await bar().click();
      await bar().waitFor({ state: 'detached' });
      await original.hover();
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
      await b.page.getByText('えっくすの一言', { exact: true }).hover();
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
      await b.page.locator('img[alt="写真"]').first().hover();
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
      await b.page.getByText(/みんなへ/).last().hover();
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
      await u.page.getByText('設定', { exact: true }).click();
      await waitText(u.page, '使用中');
      await button(u.page, 'アカウントを追加').click();
      await button(u.page, 'キャンセル').waitFor();
      await button(u.page, 'はじめる').click();
      await button(u.page, 'パスキーを使わずに始める').click();
      await waitOpen(u.page);
      let t = await text(u.page);
      assert(!t.includes('えっくす') && !t.includes('あいさんへの手紙'), `the first account's chats show in the second: ${t.slice(0, 200)}`);
      await u.page.goto(ORIGIN + '/add');
      await waitText(u.page, '自分の招待リンク');
      await u.page.getByPlaceholder('相手に表示される名前').fill('びい');
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
      await u.page.getByText('設定', { exact: true }).click();
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

      await u.page.getByText('設定', { exact: true }).click();
      await button(u.page, 'アカウントを追加').click();
      await button(u.page, 'キャンセル').click();
      await waitOpen(u.page);
      await waitText(u.page, '知らない人から');
      const left = await storage(u.page);
      assert(!Object.keys(left).some((k) => k.startsWith('tegami@')), `storage left behind: ${Object.keys(left)}`);
      assert(JSON.parse(left['tegami.accounts']).list.length === 1, `account list: ${left['tegami.accounts']}`);
      // Closing the app while adding: the empty account is gone next time, and the first one opens.
      await u.page.goto(ORIGIN + '/settings');
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
      const sw = () => u.page.getByRole('switch', { name: '新しいメッセージを知らせる' });
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
      await u.page.getByText('設定', { exact: true }).click();
      await sw().click();
      const [first] = await until(1);
      await button(u.page, 'アカウントを追加').click();
      await begin();
      await u.page.getByText('設定', { exact: true }).click();
      assert(!(await sw().isChecked()), 'the second account shows notifications on before turning them on');
      await sw().click();
      const both = await until(2);
      assert(new Set(both.map((d) => d.pubkey)).size === 2 && both.some((d) => d.pubkey === first.pubkey), 'not one registration per account');
      await sw().click();
      const [kept] = await until(1);
      assert(kept.pubkey === first.pubkey, 'the wrong account was removed');
      assert((await u.page.evaluate(() => window.__unsubscribed)) === 0, 'the shared subscription was stopped while the first account uses it');
      // The first account (no name: shown by its short id) still has notifications on.
      await u.page.getByRole('button', { name: /^npub1[^（]*$/ }).click();
      await waitOpen(u.page);
      await u.page.getByText('設定', { exact: true }).click();
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
        await u.page.goto(ORIGIN + '/settings');
        await u.page.getByPlaceholder('相手に表示される名前').fill(name);
        await u.page.waitForTimeout(300);
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
      await u.page.getByText('設定', { exact: true }).click();
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
      await u.page.getByText('設定', { exact: true }).click();
      await u.page.getByRole('button', { name: 'びー', exact: true }).click();
      await waitOpen(u.page);
      await u.page.getByText('設定', { exact: true }).click();
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
        await waitText(c.page, '自分の招待リンク');
        const cLink = (await text(c.page)).match(/https:\/\/app\.tegami\.chat\/i#\S+/)[0];
        const cHex = nip19.decode(cLink.match(/npub1[0-9a-z]+/)[0]).data;
        for (let i = 0; i < 30 && (await via(cHex)) !== 'invite'; i++) await c.page.waitForTimeout(200);
        const cRow = (await members()).find((m) => m.pubkey === cHex);
        assert(cRow?.via === 'invite' && cRow.invitedBy === a.hex, `C is ${JSON.stringify(cRow)}`);
        // B adds A with A's full link (with the code): B becomes invited too.
        // (A is already B's friend: the button renames, and the code still registers B.)
        await b.page.goto(ORIGIN + '/add');
        await waitText(b.page, '自分の招待リンク');
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

      let asked = '';
      a.page.once('dialog', (d) => {
        asked = d.message();
        return d.accept();
      });
      await button(a.page, 'ブロック').click();
      await waitText(a.page, 'ブロック中です');
      assert(asked === 'びーさんをブロックしますか？', `confirm: ${asked}`);

      await b.page.getByPlaceholder('メッセージ').fill('ブロック中の手紙');
      await button(b.page, '送る').click();
      await noText(a.page, 'ブロック中の手紙', 2000);
      await b.page.getByRole('button', { name: '音声通話' }).click();
      await waitText(b.page, '呼び出し中');
      await noText(a.page, '応答', 2000);
      await button(b.page, '通話を終了').click();

      await a.page.goBack();
      await noText(a.page, 'ブロック中の手紙', 1000);
      assert(!(await text(a.page)).includes('びー'), 'blocked chat still in the list');

      await a.page.getByText('設定', { exact: true }).click();
      await waitText(a.page, 'ブロックリスト');
      await waitText(a.page, 'びー');

      // Moving the account to another device brings the block list along.
      await a.page.getByText('別の端末でも使う').click();
      await waitText(a.page, 'まで使えます');
      const moveLink = (await text(a.page)).match(/http:\/\/localhost:\d+\/link#k=[A-Za-z0-9_-]+/)?.[0];
      assert(moveLink, 'no moving link');
      const a2 = await newUser(browser);
      await a2.page.goto(moveLink);
      await button(a2.page, 'この端末で使う').click();
      await waitOpen(a2.page);
      await a2.page.goto(ORIGIN + '/settings');
      await a2.page.waitForFunction(() => /ひらく|ブロックリスト/.test(document.body.innerText), null, { timeout: 15000 });
      if ((await text(a2.page)).includes('ひらく')) await button(a2.page, 'ひらく').click();
      await waitText(a2.page, 'ブロックリスト');
      assert(!(await text(a2.page)).includes('ブロックしている人はいません'), 'the block list did not move');
      await waitText(a2.page, 'びー');
      await a2.context.close();
      await a.page.getByText('閉じる').click().catch(() => {});

      await button(a.page, 'ブロック解除').click();
      await waitText(a.page, 'ブロックしている人はいません');

      await a.page.goBack();
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
      await b.page.waitForFunction(() => !document.body.innerText.includes('未送信'), null, { timeout: 10000 });
      const caution = '初めての相手からのお金やリンクの話です。気をつけてください。';
      assert(!(await text(b.page)).includes(caution), 'the caution shows under my own message');

      await a.page.goto(ORIGIN + '/');
      await waitOpen(a.page);
      await waitText(a.page, '知らない人から');
      await a.page.getByText('知らない人から').click();
      await a.page.getByText('この投資で必ず儲かります', { exact: false }).first().click();
      await waitText(a.page, caution);

      // Report: scam, without attaching messages.
      await button(a.page, '通報').click();
      await waitText(a.page, '通報する理由');
      await a.page.getByRole('radio', { name: '詐欺', exact: true }).click();
      await button(a.page, '通報する').click();
      await waitText(a.page, '通報しました');
      const reports = await (await fetch(`http://localhost:${RELAY_PORT}/_reports`)).json();
      const about = reports.filter((r) => r.reported === b.hex);
      assert(about.length === 1, `reports about B: ${JSON.stringify(about)}`);
      assert(about[0].reason === 'scam' && about[0].reporter === a.hex, `report: ${JSON.stringify(about[0])}`);
      assert(!about[0].messages, `messages went along without being attached: ${JSON.stringify(about[0].messages)}`);
      // (A second report about B today is refused by the relay; relay/test/report.test.mjs covers it.)

      // Then block, from the same panel.
      a.page.once('dialog', (d) => d.accept());
      await button(a.page, 'ブロックする').click();
      await waitText(a.page, 'ブロック中です');
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
      assert(await b.page.getByTestId('avatar-initial').isVisible(), 'expected initial placeholder before avatar');

      await a.page.goto(ORIGIN + '/settings');
      await waitText(a.page, 'アイコンを変更');
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
      await a.page.getByTestId('avatar-img').waitFor({ timeout: 15000 });
      await button(a.page, 'アイコンを削除').waitFor({ timeout: 5000 });

      await b.page.getByTestId('avatar-img').waitFor({ timeout: 15000 });
      await b.page.waitForFunction(() => {
        const i = document.querySelector('[data-testid="avatar-img"]');
        return i && i.tagName === 'IMG' && i.complete && i.naturalWidth === 256 && i.naturalHeight === 256;
      }, null, { timeout: 15000 });

      const avatar = await b.page.evaluate(() => JSON.parse(localStorage.getItem('tegami.contacts'))[0]?.avatar);
      assert(avatar && avatar.url, 'no avatar ref on contact');
      const stored = Buffer.from(await (await fetch(avatar.url)).arrayBuffer());
      const head = stored.subarray(0, 4).toString('hex');
      assert(stored.length > 0 && !head.startsWith('ffd8ff') && head !== '89504e47', 'the server holds an unencrypted avatar');

      // Stranger C never receives A's profile card and keeps the initial placeholder.
      await c.page.waitForTimeout(1000);
      assert((await c.page.getByTestId('avatar-img').count()) === 0, 'stranger C saw the avatar');
      assert(await c.page.getByTestId('avatar-initial').isVisible(), 'stranger C lost the initial placeholder');
      assert((await envelopesFor(c.hex)).length === 0, 'stranger C received a profile card');

      await button(a.page, 'アイコンを削除').click();
      await a.page.getByTestId('avatar-initial').waitFor({ timeout: 10000 });
      await b.page.getByTestId('avatar-initial').waitFor({ timeout: 15000 });
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
      assert(await button(a.page, '保存').isVisible(), 'save button not visible');
      await a.page.keyboard.press('Escape');
      await button(a.page, '閉じる').waitFor({ state: 'detached', timeout: 5000 });
      assert(!(await button(a.page, '保存').count()), 'viewer still visible after Escape');
      for (const u of [a, b]) await u.context.close();
    });

    await test('Invite QR: the add screen shows a QR code of the invite link', async () => {
      const u = await person(browser, 'あゆみ');
      await u.page.goto(ORIGIN + '/add');
      await waitText(u.page, '自分の招待リンク');
      await button(u.page, 'QRコードを表示').click();
      const qr = u.page.getByTestId('invite-qr');
      await qr.waitFor({ timeout: 5000 });
      assert(await qr.isVisible(), 'invite QR not visible');
      await button(u.page, '閉じる').click();
      await qr.waitFor({ state: 'detached', timeout: 5000 });
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
      await msg.hover();
      await button(a.page, 'コピー').click();
      await waitText(a.page, 'コピーしました');
      assert((await a.page.evaluate(() => navigator.clipboard.readText())) === '転送するテキスト', 'clipboard text mismatch');
      await msg.hover();
      await button(a.page, '転送').click();
      await waitText(a.page, '転送先を選ぶ');
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
      await aImg.hover();
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

      let askedChat = '';
      a.page.once('dialog', (d) => {
        askedChat = d.message();
        return d.accept();
      });
      await button(a.page, 'トークを削除').click();
      assert(askedChat === 'このトークを削除しますか？この端末から消えます。', `confirm chat: ${askedChat}`);
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

      await a.page.goto(ORIGIN + '/settings');
      await waitText(a.page, '友達');
      await waitText(a.page, 'ばんり');
      let askedFriend = '';
      a.page.once('dialog', (d) => {
        askedFriend = d.message();
        return d.accept();
      });
      await button(a.page, '削除').click();
      assert(askedFriend === 'ばんりさんを友達から削除しますか？', `confirm friend: ${askedFriend}`);
      await noText(a.page, 'ばんり', 500);

      await a.page.goto(ORIGIN + '/');
      await waitOpen(a.page);
      assert(!(await text(a.page)).includes('ばんり'), 'deleted friend still in chat list');
      await b.page.getByPlaceholder('メッセージ').fill('もう一度こんにちは');
      await button(b.page, '送る').click();
      await waitText(a.page, '知らない人から');
      await a.page.getByText('知らない人から').click();
      await waitText(a.page, 'もう一度こんにちは');
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
      await button(b.page, 'スタンプに追加').click();
      await button(b.page, 'スタンプ').click();
      const bItems = b.page.getByTestId('stamp-item');
      await bItems.first().waitFor({ timeout: 15000 });
      assert((await bItems.count()) === 1, `expected 1 stamp-item, got ${await bItems.count()}`);

      await bItems.first().click();
      await a.page.waitForFunction(() => document.querySelectorAll('[data-testid="stamp-message"]').length === 2, null, { timeout: 15000 });
      for (const u of [a, b]) await u.context.close();
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
      await b.page.getByTestId('video-message').first().waitFor({ timeout: 15000 });

      const plainText = '合計 120,000円\nよろしくお願いします。';
      const fileChooser = a.page.waitForEvent('filechooser');
      await button(a.page, 'ファイル').click();
      await (await fileChooser).setFiles({ name: '見積書.txt', mimeType: 'text/plain', buffer: Buffer.from(plainText, 'utf8') });
      const bFile = b.page.getByTestId('file-message').first();
      await bFile.waitFor({ timeout: 15000 });
      assert((await bFile.innerText()).includes('見積書.txt'), `file message text: ${await bFile.innerText()}`);

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
      await bFile.getByRole('button', { name: '保存', exact: true }).click();
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
      await button(a.page, 'キャンセル').waitFor({ timeout: 5000 });
      await a.page.waitForTimeout(1500);
      await button(a.page, '送る').click();

      await a.page.getByTestId('voice-message').first().waitFor({ timeout: 15000 });
      await b.page.getByTestId('voice-message').first().waitFor({ timeout: 15000 });
      for (const u of [a, b]) await u.context.close();
    });

    await test('Too large: a file over 10 MB is not sent', async () => {
      const a = await person(browser, 'あゆみ');
      const b = await person(browser, 'ばんり');
      await befriend(b, a);
      await befriend(a, b);

      const big = Buffer.alloc(11 * 1024 * 1024, 0x61);
      const chooser = a.page.waitForEvent('filechooser');
      await button(a.page, 'ファイル').click();
      await (await chooser).setFiles({ name: 'huge.bin', mimeType: 'application/octet-stream', buffer: big });
      await waitText(a.page, '10MBを超えるファイルは送れません');
      const count = await a.page.evaluate(() => JSON.parse(localStorage.getItem('tegami.messages') ?? '[]').length);
      assert(count === 0, `expected 0 messages in chat, got ${count}`);
      for (const u of [a, b]) await u.context.close();
    });
  } finally {
    await browser.close();
    server.close();
    relay?.kill();
  }

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
