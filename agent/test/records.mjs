// Test helpers: read an AI friend's records the way the agent does (opened with its key), and
// look at what is on the disk as it is.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hexToBytes } from 'nostr-tools/utils';
import { unprotect } from '../secrets.mjs';
import { Vault, recordsKey } from '../vault.mjs';

/** read(file, fallback): a record of the AI friend in `home`, opened with the AI's key. */
export function records(home) {
  const vault = new Vault(home, () => {
    const rec = JSON.parse(readFileSync(join(home, 'key.json'), 'utf8'));
    return rec.secretHex ? null : recordsKey(hexToBytes(unprotect(rec).trim()));
  });
  return (file, fallback = null) => vault.read(file, fallback);
}

/** The files in `home` whose bytes contain `text` (as UTF-8). */
export function onDisk(home, text) {
  const hits = [];
  for (const f of readdirSync(home)) {
    const p = join(home, f);
    if (statSync(p).isFile() && readFileSync(p).includes(Buffer.from(text, 'utf8'))) hits.push(f);
  }
  return hits;
}
