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
import { chromium } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist-test');
const RELAY_PORT = 7448;
const WEB_PORT = 8766;
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

async function newUser(browser, { prf = true, wrap = {}, authenticator = true } = {}) {
  const context = await browser.newContext();
  await context.addInitScript(wrapper(wrap));
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

// ---------- tests ----------

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push([name, true]);
    console.log(`  ok    ${name}`);
  } catch (e) {
    results.push([name, false]);
    console.log(`  FAIL  ${name}\n        ${e.message.split('\n')[0]}`);
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
    });
  }
  const relay = spawn(process.execPath, ['dev/relay.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(RELAY_PORT) }, stdio: 'ignore' });
  const server = await serve();
  const browser = await chromium.launch({ executablePath: CHROME, headless: !process.env.HEADED });

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

      // The same link on a device that already has an account replaces nothing.
      await b.page.goto(moveLink);
      await waitText(b.page, 'もう Tegami のアカウントを使っています');
      assert(await keyLeavesAddressBar(b.page), 'the key stayed in the address bar of a device with an account');

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
        PushManager.prototype.subscribe = async () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/test-device', unsubscribe: async () => true });
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
  } finally {
    await browser.close();
    server.close();
    relay.kill();
  }

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
