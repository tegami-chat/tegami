// Tests for the desktop shell: start the dev relay and a test build of the web app on this PC,
// open the real Electron window on it, and check what the shell adds.
// Needs a test build first (in ../client):
//   EXPO_PUBLIC_TEGAMI_RELAYS=ws://localhost:7465 EXPO_PUBLIC_TEGAMI_FILES=http://localhost:7465 \
//   EXPO_PUBLIC_TURNSTILE_SITEKEY= npx expo export --platform web --output-dir dist-test --clear
// Run: npm test   (SHOTS=<folder> also saves pictures of the window; PASSKEY=1 also opens Windows Hello)
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLIENT = join(ROOT, '..', 'client');
const DIST = join(CLIENT, 'dist-test');
const RELAY_PORT = Number(process.env.RELAY_PORT || 7465);
const WEB_PORT = Number(process.env.WEB_PORT || 8825);
const ORIGIN = `http://localhost:${WEB_PORT}`;
const SHOTS = process.env.SHOTS;
const electronPath = createRequire(import.meta.url)('electron');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json' };
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

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, msg, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await wait(100);
  }
  throw new Error(msg);
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`ok   ${name}`);
  } catch (e) {
    results.push([false, name]);
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}

async function main() {
  assert(existsSync(join(DIST, 'index.html')), 'No test build in client/dist-test (see the top of this file).');
  const relay = spawn(process.execPath, ['dev/relay.mjs'], { cwd: CLIENT, env: { ...process.env, PORT: String(RELAY_PORT) }, stdio: 'ignore' });
  await until(async () => (await fetch(`http://localhost:${RELAY_PORT}/`).catch(() => null))?.ok, 'relay did not start', 10000);
  const server = await serve();
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [ROOT],
    env: { ...process.env, TEGAMI_URL: `${ORIGIN}/`, TEGAMI_TEST: '1' },
  });
  try {
    const page = await app.firstWindow();
    // Links to other sites must not open the real browser during the test.
    await app.evaluate(({ shell }) => {
      globalThis.__opened = [];
      shell.openExternal = async (u) => void globalThis.__opened.push(u);
    });
    const shot = async (name) => {
      if (!SHOTS) return;
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `${name}.png`) });
    };

    await test('the first screen of the web app opens in the window', async () => {
      await page.getByText('はじめる', { exact: true }).waitFor({ timeout: 20000 });
      assert(page.url().startsWith(ORIGIN), `url ${page.url()}`);
      const title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
      assert(title === 'Tegami', `window title ${title}`);
      await shot('01_最初の画面');
    });

    await test('passkeys: WebAuthn, a platform authenticator and the PRF extension are offered', async () => {
      const caps = await page.evaluate(async () => ({
        pkc: typeof PublicKeyCredential === 'function',
        platform: await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(),
        caps: PublicKeyCredential.getClientCapabilities ? await PublicKeyCredential.getClientCapabilities() : null,
      }));
      console.log(`     ${JSON.stringify(caps)}`);
      assert(caps.pkc && caps.platform, 'no platform authenticator');
      assert(!caps.caps || caps.caps['extension:prf'] !== false, 'PRF reported as unsupported');
    });

    await test('notifications are allowed for Tegami without a prompt', async () => {
      const p = await page.evaluate(() => Notification.requestPermission());
      assert(p === 'granted', `permission ${p}`);
    });

    await test('camera and microphone are allowed for calls', async () => {
      const r = await page.evaluate(async () => {
        const out = {};
        for (const kind of ['audio', 'video']) {
          try {
            const s = await navigator.mediaDevices.getUserMedia({ [kind]: true });
            s.getTracks().forEach((t) => t.stop());
            out[kind] = 'ok';
          } catch (e) {
            out[kind] = e.name;
          }
        }
        return out;
      });
      console.log(`     ${JSON.stringify(r)}`);
      // NotFoundError only means this PC has no such device; NotAllowedError would be the shell.
      for (const k of ['audio', 'video']) assert(r[k] === 'ok' || r[k] === 'NotFoundError', `${k}: ${r[k]}`);
    });

    await test('Web Push is not available in Electron (the shell notifies instead)', async () => {
      const r = await page.evaluate(async () => {
        if (!('PushManager' in window)) return 'no PushManager';
        const reg = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
        try {
          const key = new Uint8Array(65);
          key[0] = 4;
          await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
          return 'subscribed';
        } catch (e) {
          return `${e.name}: ${e.message}`;
        }
      });
      console.log(`     ${r}`);
      assert(r !== 'subscribed', 'push subscribed: the shell could use Web Push after all');
    });

    await test('links to other sites open in the browser, not in the window', async () => {
      await page.evaluate(() => window.open('https://example.com/a'));
      await page.evaluate(() => {
        const a = document.createElement('a');
        a.href = 'https://example.com/b';
        document.body.append(a);
        a.click();
      });
      await until(async () => (await app.evaluate(() => globalThis.__opened.length)) === 2, 'not handed to the browser');
      assert(page.url().startsWith(ORIGIN), `window left Tegami: ${page.url()}`);
      assert((await app.windows()).length === 1, 'a second window opened');
    });

    await test('closing the window keeps Tegami running in the tray', async () => {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      await wait(300);
      const r = await app.evaluate(({ BrowserWindow }) => ({ n: BrowserWindow.getAllWindows().length, visible: BrowserWindow.getAllWindows()[0]?.isVisible() }));
      assert(r.n === 1 && r.visible === false, JSON.stringify(r));
    });

    await test('unread messages while hidden: one notification and a badge, cleared at 0', async () => {
      await page.evaluate(() => (document.title = '(3) Tegami'));
      await until(async () => (await app.evaluate(() => globalThis.__tegami.badge)) === 3, 'badge not 3');
      assert((await app.evaluate(() => globalThis.__tegami.notes)) === 1, 'no notification');
      await page.evaluate(() => (document.title = '(2) Tegami')); // read one elsewhere: no new notification
      await until(async () => (await app.evaluate(() => globalThis.__tegami.badge)) === 2, 'badge not 2');
      assert((await app.evaluate(() => globalThis.__tegami.notes)) === 1, 'notified when the count went down');
      await page.evaluate(() => (document.title = '(99+) Tegami'));
      await until(async () => (await app.evaluate(() => globalThis.__tegami.notes)) === 2, 'no notification for 99+');
      await page.evaluate(() => (document.title = 'Tegami'));
      await until(async () => (await app.evaluate(() => globalThis.__tegami.badge)) === 0, 'badge not cleared');
      const title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
      assert(title === 'Tegami', `window title ${title}`);
    });

    await test('a second launch brings the running window back instead of starting again', async () => {
      const second = spawn(electronPath, [ROOT], { env: { ...process.env, TEGAMI_URL: `${ORIGIN}/`, TEGAMI_TEST: '1' }, stdio: 'ignore' });
      const code = await new Promise((r) => second.on('exit', r));
      assert(code === 0, `second exited ${code}`);
      await until(async () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), 'window not shown');
    });

    // Opt-in (PASSKEY=1): it opens the real Windows Hello window, which a person has to cancel.
    // Electron cannot close that window itself, and quitting while it is open hangs until it closes.
    if (process.env.PASSKEY) await test('the passkey prompt opens from "はじめる" (a person cancels the Windows Hello window)', async () => {
      // Clicking starts navigator.credentials.create with PRF. Windows shows its own
      // Windows Hello window, outside the page; the test only checks the page is waiting.
      await page.reload(); // the blocked link above leaves Playwright waiting for a navigation
      await page.getByText('はじめる', { exact: true }).click();
      await wait(Number(process.env.PASSKEY_WAIT || 2500)); // PASSKEY_WAIT=60000 leaves time to look at the Windows Hello window
      await shot('02_はじめるを押した後');
    });
  } finally {
    await app.close().catch(() => {});
    server.close();
    relay.kill();
  }
  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
