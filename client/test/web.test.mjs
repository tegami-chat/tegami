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
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
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
  }, null, { timeout: 15000 });
}
async function waitText(page, s) {
  await page.waitForFunction((s) => document.body.innerText.includes(s), s, { timeout: 15000 });
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
