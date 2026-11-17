// Keeps the AI friend's records encrypted on disk: what people wrote (messages.json,
// history.json) and who they are (contacts.json, state.json, which names other people's AIs).
//
// The files are sealed with AES-256-GCM. The key is derived (HKDF) from the AI's own secret
// key, which the operating system's store keeps (secrets.mjs): so the records open only where
// key.json opens, and a copy of the folder (a backup, a synced drive) shows no words and no names.
//
// Where there is no store (the key itself is unencrypted, by choice: --insecure-store or
// TEGAMI_SECRET_STORE=plain), message text is never written to disk: it stays in memory for
// the run, and one line says so. Contacts and state are written as they are then (the key
// that would protect them sits next to them anyway).
//
// When the store is there but does not open now (a locked keyring), nothing is written at all:
// a record written now in plain text would undo the encryption.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Files that hold what people wrote: never on disk unencrypted. */
export const TEXT_FILES = ['messages.json', 'history.json'];
/** Files that hold names of people (and their AIs): encrypted when there is a store. */
export const NAME_FILES = ['contacts.json', 'state.json'];
const SEALED = new Set([...TEXT_FILES, ...NAME_FILES]);

// Records kept in memory only (no store, or a locked one), by path. Shared by every Vault in
// this process, so two Agents for one folder (the tests make several) see the same records.
const memory = new Map();

/** The records key: 32 bytes from the AI's secret key, for this one purpose. */
export function recordsKey(secret) {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.from('tegami-agent'), Buffer.from('records v1'), 32));
}

/** Encrypts one record. The file's name is bound in (a sealed file cannot pass for another one). */
export function seal(key, file, value) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(file));
  const body = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return { tegamiSealed: 1, data: Buffer.concat([iv, body, c.getAuthTag()]).toString('base64') };
}

/** Opens a record made by seal. Throws when the key or the file does not match. */
export function unseal(key, file, record) {
  const raw = Buffer.from(record.data, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAAD(Buffer.from(file));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8'));
}

export const isSealed = (v) => !!v && typeof v === 'object' && v.tegamiSealed === 1 && typeof v.data === 'string';

export class Vault {
  /**
   * keyOf(): the records key (a Buffer); null when there is no store (the key is kept
   * unencrypted, or there is no key yet); throws when the store is there but does not open.
   */
  constructor(dir, keyOf) {
    this.dir = dir;
    this.keyOf = keyOf;
    this._key = null;
    this.noted = new Set();
    // Where the one-line notes go (the watcher points this at its log).
    this.say = (text) => console.error(text);
  }

  /** { key } when records can be sealed, { key: null } with no store, { locked: true } when the store does not open. */
  mode() {
    if (this._key) return { key: this._key };
    try {
      const key = this.keyOf();
      if (key) this._key = key;
      return { key: key ?? null };
    } catch {
      return { key: null, locked: true };
    }
  }

  /** How the records are kept, in words (for the watcher's "Records:" line). */
  describe() {
    const m = this.mode();
    if (m.key) return 'encrypted with this AI friend\'s key';
    if (m.locked) return 'the secret store does not open: nothing is written, messages stay in memory';
    return 'no secret store: message text stays in memory only, contacts are not encrypted';
  }

  note(kind, text) {
    if (this.noted.has(kind)) return;
    this.noted.add(kind);
    this.say(text);
  }

  read(file, fallback) {
    const path = join(this.dir, file);
    if (memory.has(path)) return JSON.parse(memory.get(path));
    let raw;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return fallback;
    }
    if (!SEALED.has(file)) return raw;
    const m = this.mode();
    if (isSealed(raw)) {
      if (!m.key) {
        this.note(`open-${file}`, `${file} is encrypted, and this AI friend's key does not open here (is the secret store unlocked?).`);
        return fallback;
      }
      try {
        return unseal(m.key, file, raw);
      } catch {
        this.note(`open-${file}`, `${file} could not be opened with this AI friend's key: it is left as it is.`);
        return fallback;
      }
    }
    // A plain file from before the records were encrypted: move it over now.
    if (m.key) this.writeSealed(file, raw, m.key);
    else if (TEXT_FILES.includes(file) || m.locked) {
      memory.set(path, JSON.stringify(raw));
      if (TEXT_FILES.includes(file)) {
        rmSync(path, { force: true });
        this.note('memory', `No secret store: ${file} was not encrypted, so it was taken off the disk. Message text stays in memory only while this runs.`);
      }
    }
    return raw;
  }

  write(file, value) {
    const path = join(this.dir, file);
    if (!SEALED.has(file)) return writePrivate(path, value);
    const m = this.mode();
    if (m.key) {
      memory.delete(path);
      return this.writeSealed(file, value, m.key);
    }
    if (m.locked) {
      memory.set(path, JSON.stringify(value));
      this.note('locked', `The secret store does not open now: ${file} and the other records stay in memory and are not written to disk.`);
      return;
    }
    if (TEXT_FILES.includes(file)) {
      memory.set(path, JSON.stringify(value));
      rmSync(path, { force: true });
      this.note('memory', 'No secret store: message text stays in memory only, and is gone when this program stops.');
      return;
    }
    writePrivate(path, value);
  }

  writeSealed(file, value, key) {
    writePrivate(join(this.dir, file), seal(key, file, value));
  }
}

function writePrivate(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2));
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows: the file sits in the user's own profile folder.
  }
}
