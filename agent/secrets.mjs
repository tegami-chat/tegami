// Keeps the AI's secret key and API keys encrypted by the operating system's own store,
// with no extra packages:
//   Windows: DPAPI (CurrentUser), through PowerShell. The file holds the encrypted text.
//   macOS:   the login Keychain, through `security`. The file holds only a reference.
//   Linux:   the Secret Service (GNOME Keyring, KWallet), through `secret-tool` (libsecret).
//            The file holds only a reference.
// Where none of these works, a new secret is refused: the owner has to choose to keep it
// unencrypted (--insecure-store, or TEGAMI_SECRET_STORE=plain). A secret that is already in
// plain text from before stays as it is, with a warning.
//
// This protects copies of the folder (a backup, a synced folder, a repair shop). A program
// running as the same user can still ask the store, as the agent itself does.
//
// TEGAMI_SECRET_STORE picks the store: plain, dpapi, keychain or libsecret (tests use plain
// and dpapi). TEGAMI_INSECURE_STORE=1 (what --insecure-store sets) allows plain text where
// the store does not work.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const SERVICE = 'chat.tegami.agent';

/** Which store to use on this computer. */
export function storeKind(env = process.env, platform = process.platform) {
  const forced = env.TEGAMI_SECRET_STORE;
  if (forced) return forced;
  if (platform === 'win32') return 'dpapi';
  if (platform === 'darwin') return 'keychain';
  // Linux and the rest: libsecret where secret-tool is installed. 'none': no store here.
  return has('secret-tool') ? 'libsecret' : 'none';
}

/** The program is installed (it starts at all: secret-tool with no arguments prints its usage). */
function has(program) {
  return spawnSync(program, [], { stdio: 'ignore' }).error?.code !== 'ENOENT';
}

/** A name for one secret in the store: the AI friend's folder and what the secret is. */
export function accountFor(dir, what) {
  return `${createHash('sha256').update(String(dir)).digest('hex').slice(0, 16)}-${what}`;
}

// A locked Keychain or keyring may ask for a password in a window. Run with no screen (a
// login item, ssh), nobody answers it: after 30 seconds the call fails, and the store counts
// as locked (nothing is written) instead of the program waiting forever.
const STORE_TIMEOUT_MS = 30_000;
const run = (cmd, args, input) =>
  execFileSync(cmd, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: STORE_TIMEOUT_MS });

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
      // `security -i` reads its commands on stdin, so the secret is not on a command line (other
      // programs can list command lines; `security add-generic-password -w <secret>` would put it
      // there). Every word on the line is letters, digits, '.', '-', or base64 (+ / =): nothing
      // that the way `security -i` splits a line (spaces, quotes, backslashes) could change.
      const b64 = Buffer.from(text, 'utf8').toString('base64');
      run('security', ['-i'], `add-generic-password -U -a ${account} -s ${SERVICE} -l tegami-agent -w ${b64}\n`);
      const record = { store: 'keychain', account, encoding: 'base64' };
      if (unprotect(record) !== text) return null;
      return record;
    }
    if (kind === 'libsecret') {
      // secret-tool reads the secret on stdin: it is never on a command line.
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
  if (record.store === 'keychain') {
    // -w prints the stored password and a newline. Stored as base64 since encoding was added.
    const out = run('security', ['find-generic-password', '-a', record.account, '-s', SERVICE, '-w'], '').replace(/\n$/, '');
    return record.encoding === 'base64' ? Buffer.from(out, 'base64').toString('utf8') : out;
  }
  // secret-tool prints a newline after the secret only on a terminal; none of the secrets ends with one.
  if (record.store === 'libsecret') return run('secret-tool', ['lookup', 'service', SERVICE, 'account', record.account], '').replace(/\n$/, '');
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

/** Throws unless the owner chose to keep secrets unencrypted where there is no store. */
export function refusePlain(what) {
  if (process.env.TEGAMI_INSECURE_STORE === '1') return;
  throw new Error(
    `This computer has no secret store Tegami can use, so ${what} would be kept unencrypted. ` +
      (process.platform === 'linux'
        ? 'Install and unlock a keyring (for example gnome-keyring and libsecret-tools, in a desktop or dbus session), '
        : 'Check the system keychain, ') +
      'or run again with --insecure-store to keep it unencrypted in this folder on purpose.',
  );
}
