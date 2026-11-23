// Writes the secret key out as NIP-49 (ncryptsec1...): the key sealed with a password the person
// chooses, so another Nostr app can read it. The logic is here, apart from the screen, so a test
// can run it. Nothing is saved, logged or sent: the caller gets the text and shows it once.

import { decrypt, encrypt } from 'nostr-tools/nip49';

/** Amethyst asks for 12 or more characters when it makes a new key, so the same floor here. */
export const MIN_PASSWORD = 12;

export type KeyExportFailure = 'short' | 'mismatch' | 'unverified' | 'failed';

export class KeyExportError extends Error {
  reason: KeyExportFailure;
  constructor(reason: KeyExportFailure) {
    super(reason);
    this.reason = reason;
  }
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

export async function exportEncryptedKey(opts: {
  secret: Uint8Array;
  password: string;
  again: string;
  /** Asks the person to prove it is them (passkey, Face ID, device passcode). False or a throw stops the export. */
  verify: () => Promise<boolean>;
}): Promise<string> {
  const { secret, password, again, verify } = opts;
  if (password.length < MIN_PASSWORD) throw new KeyExportError('short');
  if (password !== again) throw new KeyExportError('mismatch');
  let ok = false;
  try {
    ok = await verify();
  } catch {
    ok = false;
  }
  if (!ok) throw new KeyExportError('unverified');
  // scrypt is heavy and runs on this thread: let the screen draw "encrypting" first.
  await new Promise((r) => setTimeout(r, 50));
  try {
    const text = encrypt(secret, password, 16, 0x02);
    if (!text.startsWith('ncryptsec1') || !same(decrypt(text, password), secret)) throw new Error('round trip');
    return text;
  } catch {
    throw new KeyExportError('failed');
  }
}
