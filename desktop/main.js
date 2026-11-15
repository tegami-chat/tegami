// Tegami for Windows and Mac: a small Electron shell around the web app.
//
// The window opens https://app.tegami.chat itself instead of a bundled copy of the web app.
// Passkeys are tied to the page's origin (the WebAuthn RP ID), so a bundled copy served from
// file:// or a custom scheme could not open accounts made in the browser, and the web app's
// own updates, CSP and /i invite links keep working unchanged.
//
// Electron has no Web Push (Chromium's push service is a Google service that Electron does not
// ship), so the shell keeps the page running in the tray and turns the unread count the page
// already puts in its title, "(3) Tegami", into a desktop notification and a taskbar badge.

const { app, BrowserWindow, Menu, Notification, Tray, nativeImage, session, shell } = require('electron');
const path = require('node:path');

const APP_URL = new URL(process.env.TEGAMI_URL || 'https://app.tegami.chat/');
const ORIGIN = APP_URL.origin;
const JA = () => app.getLocale().startsWith('ja');
const T = {
  open: () => (JA() ? 'Tegamiを開く' : 'Open Tegami'),
  login: () => (JA() ? 'ログイン時に起動' : 'Open at login'),
  quit: () => (JA() ? '終了' : 'Quit'),
  newMessage: () => (JA() ? '新しいメッセージがあります' : 'You have a new message'),
};

/** Permissions the web app uses: camera and microphone for calls, notifications, copy. */
const ALLOWED = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen']);

let win = null;
let tray = null;
let quitting = false;
let unread = 0;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => show());
  app.whenReady().then(start);
}

app.setAppUserModelId('chat.tegami.desktop'); // Windows: notifications are shown under "Tegami".

function sameOrigin(url) {
  try {
    return new URL(url).origin === ORIGIN;
  } catch {
    return false;
  }
}

function openOutside(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') shell.openExternal(u.href);
  } catch {}
}

function start() {
  // macOS: Electron offers no platform passkeys until configureWebAuthn is called.
  // Touch ID needs a keychain access group from the signed app (Team ID), so an unsigned build
  // has no passkeys and people use "start without a passkey", as in a browser without passkeys.
  // Not platformPasskeys (iCloud Keychain): Electron's docs say it ignores the PRF extension,
  // and Tegami unlocks the key with PRF. Whether the Touch ID authenticator returns PRF is untested.
  if (process.platform === 'darwin' && typeof app.configureWebAuthn === 'function' && process.env.TEGAMI_KEYCHAIN_GROUP) {
    app.configureWebAuthn({ touchID: { keychainAccessGroup: process.env.TEGAMI_KEYCHAIN_GROUP } });
  }

  const ses = session.fromPartition('persist:tegami');
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(ALLOWED.has(permission) && sameOrigin(details.requestingUrl || wc.getURL()));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => ALLOWED.has(permission) && requestingOrigin === ORIGIN);

  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);

  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 360,
    minHeight: 480,
    title: 'Tegami',
    // Started at login: stay in the tray until opened.
    show: !process.argv.includes('--hidden'),
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#f5fbf4',
    autoHideMenuBar: true,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Keep the relay connection alive while the window is hidden in the tray.
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  const wc = win.webContents;
  // Links to other sites open in the default browser; the window only ever shows Tegami.
  wc.setWindowOpenHandler(({ url }) => {
    if (!sameOrigin(url)) openOutside(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!sameOrigin(url)) {
      e.preventDefault();
      openOutside(url);
    }
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());

  win.on('page-title-updated', (e, title) => {
    e.preventDefault();
    win.setTitle('Tegami');
    onUnread(countFrom(title));
  });
  win.on('focus', () => {
    win.flashFrame(false);
  });
  // Closing the window keeps Tegami in the tray so messages still arrive; Quit ends it.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });

  makeTray();
  win.loadURL(APP_URL.href);
}

function countFrom(title) {
  const m = /^\((\d+)(\+?)\)/.exec(title || '');
  return m ? Number(m[1]) + (m[2] ? 1 : 0) : 0;
}

/** Tests read what the shell did (TEGAMI_TEST=1 only). */
const seen = process.env.TEGAMI_TEST ? (globalThis.__tegami = { notes: 0, badge: 0 }) : null;

function onUnread(n) {
  const more = n > unread;
  unread = n;
  badge(n);
  if (more && win && !(win.isVisible() && win.isFocused())) {
    if (Notification.isSupported()) {
      // Like the web app's push: no sender and no text, only that something arrived.
      const note = new Notification({ title: 'Tegami', body: T.newMessage(), icon: path.join(__dirname, 'build', 'icon.png') });
      note.on('click', show);
      if (seen) seen.notes++; // tests count it instead of showing it on the real desktop
      else note.show();
    }
    if (process.platform === 'win32') win.flashFrame(true);
  }
}

function badge(n) {
  if (seen) seen.badge = n;
  if (process.platform === 'win32') {
    win?.setOverlayIcon(n ? dot() : null, n ? `${n}` : '');
  } else {
    app.setBadgeCount(n);
  }
  tray?.setToolTip(n ? `Tegami (${n})` : 'Tegami');
}

/** A 16x16 red dot for the Windows taskbar overlay. */
let dotImage = null;
function dot() {
  if (dotImage) return dotImage;
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
      const a = Math.max(0, Math.min(1, size / 2 - d)); // soft edge
      const i = (y * size + x) * 4; // BGRA, premultiplied
      buf[i] = Math.round(0x2e * a);
      buf[i + 1] = Math.round(0x2e * a);
      buf[i + 2] = Math.round(0xd9 * a);
      buf[i + 3] = Math.round(255 * a);
    }
  }
  dotImage = nativeImage.createFromBitmap(buf, { width: size, height: size });
  return dotImage;
}

function show() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function makeTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Tegami');
  const menu = () =>
    Menu.buildFromTemplate([
      { label: T.open(), click: show },
      {
        label: T.login(),
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
      },
      { type: 'separator' },
      { label: T.quit(), click: () => { quitting = true; app.quit(); } },
    ]);
  tray.setContextMenu(menu());
  tray.on('click', show);
  tray.on('right-click', () => tray.setContextMenu(menu()));
}

app.on('before-quit', () => {
  quitting = true;
});
app.on('activate', show); // macOS: clicking the Dock icon brings the window back.
app.on('window-all-closed', () => {}); // stay in the tray
