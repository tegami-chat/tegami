// Totals across everyone, and nothing about any one person.
//
// What is counted, per UTC day (kept inside the relay):
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
// GET /stats publishes weekly totals, not the daily ones, because at a small scale an exact
// daily number can tell who was there:
// - only weeks that are over (a week starts on Monday, UTC), so a number never changes
//   while someone watches it;
// - every number rounded up to a multiple of 10, and 0 to 9 all reported as 0, so a quiet
//   week and an empty week look the same;
// - file sizes in MB, rounded the same way;
// - the key estimate merges the week's daily counters, so a key active on several days of
//   the week counts once.
// The exact daily rows are for the operator only (POST /admin {action: 'stats'}).

const P = 10;
const M = 1 << P; // 1024 registers
// Daily rows are kept for six months: enough to build the published weeks, and no more.
const KEEP_DAYS = 183;

export type DayTotals = { day: string; envelopes: number; files: number; file_bytes: number; logins: number; keys: number };
export type WeekTotals = { week: string; envelopes: number; files: number; file_mb: number; logins: number; keys: number };

// The last 24 weeks are published. 24 weeks plus the week in progress is 175 days, inside KEEP_DAYS.
const PUBLISH_WEEKS = 24;

/** Rounds up to a multiple of 10; 0 to 9 become 0. */
export function publishable(n: number): number {
  return n < 10 ? 0 : Math.ceil(n / 10) * 10;
}

/** The Monday (UTC) that starts the week of `day` (YYYY-MM-DD). */
export function weekOf(day: string): string {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

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

  /** Weeks that are over, newest first, rounded for publishing. */
  weekly(weeks = PUBLISH_WEEKS): WeekTotals[] {
    const current = weekOf(today());
    const rows = this.sql
      .exec('SELECT day, envelopes, files, file_bytes, logins, hll FROM stats ORDER BY day DESC LIMIT ?', (weeks + 1) * 7)
      .toArray();
    const byWeek = new Map<string, { envelopes: number; files: number; bytes: number; logins: number; hll: Uint8Array }>();
    for (const r of rows) {
      const w = weekOf(r.day as string);
      if (w >= current) continue;
      const cur = byWeek.get(w) ?? { envelopes: 0, files: 0, bytes: 0, logins: 0, hll: new Uint8Array(M) };
      cur.envelopes += r.envelopes as number;
      cur.files += r.files as number;
      cur.bytes += r.file_bytes as number;
      cur.logins += r.logins as number;
      const reg = new Uint8Array(r.hll as ArrayBuffer);
      for (let i = 0; i < M; i++) if (reg[i] > cur.hll[i]) cur.hll[i] = reg[i];
      byWeek.set(w, cur);
    }
    return [...byWeek.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .slice(0, weeks)
      .map(([week, c]) => ({
        week,
        envelopes: publishable(c.envelopes),
        files: publishable(c.files),
        file_mb: publishable(Math.ceil(c.bytes / 1048576)),
        logins: publishable(c.logins),
        keys: publishable(estimate(c.hll)),
      }));
  }

  /** The exact daily rows, for the operator only. */
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
  about:
    'Weekly totals across everyone, for the last 24 weeks that are over (weeks start on Monday, UTC). Every number is rounded up to a multiple of 10, and 0 to 9 are all reported as 0. There are no numbers for any one account.',
  counted: {
    envelopes: 'message envelopes accepted (a message to N people is N + 1 envelopes)',
    files: 'files accepted',
    file_mb: 'total size of accepted files, in MB',
    logins: 'successful logins',
    keys: 'about how many different keys logged in during the week (HyperLogLog; each day uses a salt deleted at the end of that day)',
  },
};
