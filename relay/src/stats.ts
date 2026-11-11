// Daily totals, and nothing about any one person.
//
// What is counted, per UTC day:
//   envelopes   message envelopes accepted (one message to N people is N + 1 envelopes)
//   files       files accepted, and file_bytes their total size
//   logins      successful logins (NIP-42)
//   keys        about how many different keys logged in (HyperLogLog estimate)
//
// The key estimate never stores a key. Each key is mixed with a random salt made for
// that day, and only the position of the first set bit of the result is kept in one of
// 1024 small counters. The salt is deleted when the day is over, so even the relay
// cannot later test whether a given key was active that day.
//
// GET /stats publishes these totals for the last 90 days.

const P = 10;
const M = 1 << P; // 1024 registers
const KEEP_DAYS = 400;

export type DayTotals = { day: string; envelopes: number; files: number; file_bytes: number; logins: number; keys: number };

function today() {
  return new Date().toISOString().slice(0, 10);
}

function estimate(reg: Uint8Array): number {
  let sum = 0;
  let zeros = 0;
  for (const r of reg) {
    sum += 2 ** -r;
    if (r === 0) zeros++;
  }
  const alpha = 0.7213 / (1 + 1.079 / M);
  const e = (alpha * M * M) / sum;
  // Small range correction (linear counting): exact enough for small numbers.
  if (e <= 2.5 * M && zeros > 0) return Math.round(M * Math.log(M / zeros));
  return Math.round(e);
}

export class Stats {
  constructor(private sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS stats (
      day TEXT PRIMARY KEY, envelopes INTEGER DEFAULT 0, files INTEGER DEFAULT 0, file_bytes INTEGER DEFAULT 0,
      logins INTEGER DEFAULT 0, hll BLOB, salt BLOB)`);
  }

  /** Makes today's row (with a fresh salt) and forgets the salts of earlier days. */
  private row(): string {
    const day = today();
    const has = this.sql.exec('SELECT 1 FROM stats WHERE day = ?', day).toArray().length > 0;
    if (!has) {
      this.sql.exec(
        'INSERT INTO stats (day, hll, salt) VALUES (?, ?, ?)',
        day,
        new Uint8Array(M),
        crypto.getRandomValues(new Uint8Array(32)),
      );
      this.sql.exec('UPDATE stats SET salt = NULL WHERE day < ?', day);
      const cutoff = new Date(Date.now() - KEEP_DAYS * 86400e3).toISOString().slice(0, 10);
      this.sql.exec('DELETE FROM stats WHERE day < ?', cutoff);
    }
    return day;
  }

  add(field: 'envelopes' | 'files' | 'logins', n = 1) {
    const day = this.row();
    this.sql.exec(`UPDATE stats SET ${field} = ${field} + ? WHERE day = ?`, n, day);
  }

  addBytes(n: number) {
    const day = this.row();
    this.sql.exec('UPDATE stats SET file_bytes = file_bytes + ? WHERE day = ?', n, day);
  }

  /** Counts a key towards today's "about how many keys" without storing it. */
  async addKey(pubkey: string) {
    const day = this.row();
    const r = this.sql.exec('SELECT hll, salt FROM stats WHERE day = ?', day).one();
    const salt = new Uint8Array(r.salt as ArrayBuffer);
    const hll = new Uint8Array(r.hll as ArrayBuffer);
    const input = new Uint8Array(salt.length + pubkey.length);
    input.set(salt);
    input.set(new TextEncoder().encode(pubkey), salt.length);
    const h = new DataView(await crypto.subtle.digest('SHA-256', input));
    const idx = h.getUint16(0) >>> (16 - P);
    // Rank: position of the first 1 bit in the next 32 bits (1-based).
    const w = h.getUint32(4);
    const rank = w === 0 ? 33 : Math.clz32(w) + 1;
    if (rank > hll[idx]) {
      hll[idx] = rank;
      this.sql.exec('UPDATE stats SET hll = ? WHERE day = ?', hll, day);
    }
  }

  recent(days = 90): DayTotals[] {
    return this.sql
      .exec('SELECT day, envelopes, files, file_bytes, logins, hll FROM stats ORDER BY day DESC LIMIT ?', days)
      .toArray()
      .map((r) => ({
        day: r.day as string,
        envelopes: r.envelopes as number,
        files: r.files as number,
        file_bytes: r.file_bytes as number,
        logins: r.logins as number,
        keys: estimate(new Uint8Array(r.hll as ArrayBuffer)),
      }));
  }
}

export const STATS_DESCRIPTION = {
  about: 'Daily totals only. Nothing about any one person is stored.',
  counted: {
    envelopes: 'message envelopes accepted (a message to N people is N + 1 envelopes)',
    files: 'files accepted',
    file_bytes: 'total size of accepted files',
    logins: 'successful logins',
    keys: 'about how many different keys logged in (HyperLogLog with a salt deleted at the end of the day)',
  },
};
