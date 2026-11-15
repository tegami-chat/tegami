# Tegami for Windows and Mac

A small [Electron](https://www.electronjs.org/) window around the web app at https://app.tegami.chat.

## Why it opens app.tegami.chat instead of bundling the web app

- Passkeys belong to the page's origin. A bundled copy (file:// or a custom scheme) could not use the
  passkeys people made in the browser, and WebAuthn refuses such origins.
- The web app updates itself on every reload, so the shell rarely needs a new release.
- The page keeps its own CSP and the `/i#…` invite links work as they do in the browser.

The window only ever shows app.tegami.chat. Links to other sites open in the default browser.

## What the shell adds

- Closing the window keeps Tegami in the tray (Windows) or Dock (Mac), so messages keep arriving.
  "Quit" in the tray menu ends it. "Open at login" starts it hidden in the tray.
- Electron has no Web Push (Chromium's push service is not part of Electron). While Tegami runs, the
  shell watches the unread count the page puts in its title, "(3) Tegami", and shows a desktop
  notification ("You have a new message", no sender or text) and a badge on the taskbar or Dock.
- Camera and microphone (calls) and notifications are allowed for app.tegami.chat only.

## Run and test

```
npm install
npm start                     # opens https://app.tegami.chat
TEGAMI_URL=http://localhost:8081/ npm start   # another copy of the web app
npm test                      # needs ../client/dist-test, see test/desktop.test.mjs
```

## Build

```
npm run dist:win              # dist/Tegami-Setup-<version>-<arch>.exe (unsigned)
npm run dist:mac              # on a Mac: dist/Tegami-<version>-universal.dmg (unsigned)
```

Unsigned builds work but Windows SmartScreen and macOS Gatekeeper warn before the first start.

### Mac: not tried yet

- Touch ID passkeys need Electron's `app.configureWebAuthn` with a keychain access group, which
  needs a signed app with a Team ID (Apple Developer Program). Start with
  `TEGAMI_KEYCHAIN_GROUP=<TEAMID>.chat.tegami.desktop` and add `keychain-access-groups` to
  `build/entitlements.mac.plist`. Without it, people choose "start without a passkey".
- Notarization (needed so Gatekeeper opens the app without a warning) also needs that account.
