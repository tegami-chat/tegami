// Keeps the AI's secret key and API keys encrypted by the operating system's own store,
// with no extra packages:
//   Windows: DPAPI (CurrentUser), through PowerShell. The file holds the encrypted text.
//   macOS:   the login Keychain, through `security`. The file holds only a reference.
//   Linux:   the Secret Service (GNOME Keyring, KWallet), through `secret-tool` (libsecret).
//            The file holds only a reference.
// Where none of these works, the secret stays in the file unencrypted and a warning is shown.
//
// This protects copies of the folder (a backup, a synced folder, a repair shop). A program
// running as the same user can still ask the store, as the agent itself does.
//
// TEGAMI_SECRET_STORE picks the store: plain, dpapi, keychain or libsecret (tests use plain
// and dpapi).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const SERVICE = 'chat.tegami.agent';

/** Which store to use on this computer. */
export function storeKind(env = process.env, platform = process.platform) {
  const forced = env.TEGAMI_SECRET_STORE;
  if (forced) return forced;
  if (platform === 'win32') return 'dpapi';
  if (platform === 'darwin') return 'keychain';
  if (platform === 'linux') return has('secret-tool') ? 'libsecret' : 'plain';
  return 'plain';
}

function has(program) {
  try {
    execFileSync('which', [program], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A name for one secret in the store: the AI friend's folder and what the secret is. */
export function accountFor(dir, what) {
  return `${createHash('sha256').update(String(dir)).digest('hex').slice(0, 16)}-${what}`;
}

const run = (cmd, args, input) => execFileSync(cmd, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

// DPAPI through Windows PowerShell. The secret goes in through an environment variable of
// that one process (never on a command line, which other programs can list) as base64, and
// comes out as base64: the console's code page would garble anything but ASCII.
const DPAPI = (fn) =>
  `Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${fn}([Convert]::FromBase64String($env:TEGAMI_SECRET_IN), $null, 'CurrentUser'))`;
function dpapi(fn, base64) {
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', DPAPI(fn)], {
    env: { ...process.env, TEGAMI_SECRET_IN: base64 },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return out.trim();
}

/**
 * Encrypts `text` with the store. Returns the record to write in the file:
 * { store: 'dpapi', data } or { store: 'keychain' | 'libsecret', account }.
 * Returns null when the store does not work here (then the caller keeps it in plain text).
 */
export function protect(text, account, kind = storeKind()) {
  try {
    if (kind === 'dpapi') {
      const data = dpapi('Protect', Buffer.from(text, 'utf8').toString('base64'));
      // Read it back once: a record that cannot be opened must never replace the plain one.
      if (!data || unprotect({ store: 'dpapi', data }) !== text) return null;
      return { store: 'dpapi', data };
    }
    if (kind === 'keychain') {
      // `security -i` reads commands on stdin, so the secret is not on a command line.
      const q = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;
      run('security', ['-i'], `add-generic-password -U -a ${q(account)} -s ${q(SERVICE)} -l ${q('Tegami AI friend')} -w ${q(text)}\n`);
      if (unprotect({ store: 'keychain', account }) !== text) return null;
      return { store: 'keychain', account };
    }
    if (kind === 'libsecret') {
      run('secret-tool', ['store', '--label=Tegami AI friend', 'service', SERVICE, 'account', account], text);
      if (unprotect({ store: 'libsecret', account }) !== text) return null;
      return { store: 'libsecret', account };
    }
  } catch {
    return null;
  }
  return null;
}

/** Opens a record made by protect. Throws when the store cannot open it. */
export function unprotect(record) {
  if (record.store === 'dpapi') return Buffer.from(dpapi('Unprotect', record.data), 'base64').toString('utf8');
  if (record.store === 'keychain') return run('security', ['find-generic-password', '-a', record.account, '-s', SERVICE, '-w'], '').replace(/\n$/, '');
  if (record.store === 'libsecret') return run('secret-tool', ['lookup', 'service', SERVICE, 'account', record.account], '');
  throw new Error(`Unknown secret store: ${record.store}`);
}

/** Removes a secret from the store (keychain and libsecret keep it outside the file). */
export function forget(record) {
  try {
    if (record?.store === 'keychain') run('security', ['delete-generic-password', '-a', record.account, '-s', SERVICE], '');
    if (record?.store === 'libsecret') run('secret-tool', ['clear', 'service', SERVICE, 'account', record.account], '');
  } catch {
    // already gone
  }
}

let warned = false;
/** Says once per run that secrets are kept unencrypted here. */
export function warnPlain(what) {
  // Someone who chose plain on purpose (TEGAMI_SECRET_STORE=plain) is not warned.
  if (warned || process.env.TEGAMI_SECRET_STORE === 'plain') return;
  warned = true;
  console.error(`Warning: this computer has no secret store Tegami can use, so ${what} is kept unencrypted. Keep the folder out of backups and shared drives.`);
}
