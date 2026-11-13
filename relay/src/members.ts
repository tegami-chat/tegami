// Who may write to this relay.
//
// Anyone can register a key, so modified apps work too. How a key registered decides how
// far its messages reach:
// - invite: registered with someone's invite code (the code sits in their invite link).
// - legacy: used Tegami before registration existed.
// - open:   registered without an invite (the web app proves a person with Cloudflare Turnstile).
// Envelopes written by an open key are marked, and a recipient's app shows them only from
// friends and known groups. So keys made in bulk cannot reach strangers, and they ring no
// notifications. An open key that later uses an invite code becomes an invite key.
//
// Invites: each invite or legacy key has one code. At most `per_day` keys (20 unless the
// operator changes it) can register with one code in 24 hours. Who invited whom is kept for
// 90 days, so the operator can stop a key and everyone it invited; then it is forgotten.

export type Via = 'invite' | 'open' | 'legacy';
export type Member = { pubkey: string; via: Via; invited_by: string | null; created_at: number; banned: number; no_invites: number };

export const INVITES_PER_DAY = 20;
export const INVITE_MEMORY_SECONDS = 90 * 24 * 60 * 60;
const CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

function now() {
  return Math.floor(Date.now() / 1000);
}

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => CODE_ALPHABET[b % 32]).join('');
}

export class Members {
  constructor(private sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS members (
      pubkey TEXT PRIMARY KEY, via TEXT, invited_by TEXT, created_at INTEGER,
      banned INTEGER DEFAULT 0, no_invites INTEGER DEFAULT 0)`);
    sql.exec('CREATE INDEX IF NOT EXISTS members_invited_by ON members (invited_by, created_at)');
    sql.exec(`CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY, issuer TEXT UNIQUE, per_day INTEGER, created_at INTEGER)`);
    sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
    // Registration started on 2026-11-13. Keys already in use then keep working: everyone
    // with an envelope waiting (senders keep a copy for their other devices, so senders too)
    // and everyone who turned on notifications.
    const seeded = sql.exec("SELECT v FROM meta WHERE k = 'members_seeded'").toArray()[0];
    if (!seeded) {
      const t = now();
      sql.exec("INSERT OR IGNORE INTO members (pubkey, via, created_at) SELECT DISTINCT p, 'legacy', ? FROM events", t);
      sql.exec("INSERT OR IGNORE INTO members (pubkey, via, created_at) SELECT DISTINCT pubkey, 'legacy', ? FROM push_devices", t);
      sql.exec("INSERT INTO meta (k, v) VALUES ('members_seeded', ?)", String(t));
    }
  }

  get(pubkey: string): Member | null {
    return (this.sql.exec('SELECT * FROM members WHERE pubkey = ?', pubkey).toArray()[0] as Member | undefined) ?? null;
  }

  /** Invite and legacy keys reach strangers and can invite others. */
  trusted(m: Member | null): boolean {
    return !!m && !m.banned && m.via !== 'open';
  }

  /** This key's invite code, made the first time it is asked for. Null if it may not invite. */
  code(m: Member | null): string | null {
    if (!this.trusted(m) || m!.no_invites) return null;
    const row = this.sql.exec('SELECT code FROM invites WHERE issuer = ?', m!.pubkey).toArray()[0];
    if (row) return row.code as string;
    const code = newCode();
    this.sql.exec('INSERT INTO invites (code, issuer, per_day, created_at) VALUES (?, ?, ?, ?)', code, m!.pubkey, INVITES_PER_DAY, now());
    return code;
  }

  /**
   * The key that issued this code, if it may still invite today. 'used-up' when 20 keys
   * already registered with it in the last 24 hours.
   */
  inviter(code: string): string | 'used-up' | null {
    const row = this.sql.exec('SELECT issuer, per_day FROM invites WHERE code = ?', code).toArray()[0];
    if (!row) return null;
    const issuer = this.get(row.issuer as string);
    if (!this.trusted(issuer) || issuer!.no_invites) return null;
    const today = this.sql
      .exec('SELECT COUNT(*) AS n FROM members WHERE invited_by = ? AND created_at > ?', issuer!.pubkey, now() - 86400)
      .one().n as number;
    return today >= (row.per_day as number) ? 'used-up' : issuer!.pubkey;
  }

  /** Registers (or upgrades an open key) with an invite. */
  joinWithInvite(pubkey: string, inviter: string) {
    const m = this.get(pubkey);
    if (m && (m.via !== 'open' || m.banned)) return;
    this.sql.exec(
      "INSERT OR REPLACE INTO members (pubkey, via, invited_by, created_at, banned, no_invites) VALUES (?, 'invite', ?, ?, 0, 0)",
      pubkey,
      inviter,
      now(),
    );
  }

  joinOpen(pubkey: string) {
    this.sql.exec("INSERT OR IGNORE INTO members (pubkey, via, created_at) VALUES (?, 'open', ?)", pubkey, now());
  }

  /** Forgets who invited whom after 90 days. */
  forgetOldInvites() {
    this.sql.exec('UPDATE members SET invited_by = NULL WHERE invited_by IS NOT NULL AND created_at < ?', now() - INVITE_MEMORY_SECONDS);
  }

  /** The operator's actions. Returns how many keys changed. */
  admin(action: string, pubkey: string, opts: { invitees?: boolean; per_day?: number }): number | null {
    const keys = [pubkey];
    if (opts.invitees) {
      for (const r of this.sql.exec('SELECT pubkey FROM members WHERE invited_by = ?', pubkey).toArray()) keys.push(r.pubkey as string);
    }
    let changed = 0;
    for (const k of keys) {
      switch (action) {
        case 'ban':
          // A key that never registered can be stopped too.
          this.sql.exec("INSERT OR IGNORE INTO members (pubkey, via, created_at) VALUES (?, 'open', ?)", k, now());
          changed += this.sql.exec('UPDATE members SET banned = 1 WHERE pubkey = ?', k).rowsWritten;
          break;
        case 'trust':
          // For keys the operator vouches for (the official account, tests): as if invited.
          this.sql.exec("INSERT OR IGNORE INTO members (pubkey, via, created_at) VALUES (?, 'invite', ?)", k, now());
          changed += this.sql.exec("UPDATE members SET via = 'invite' WHERE pubkey = ? AND via = 'open'", k).rowsWritten || 1;
          break;
        case 'unban':
          changed += this.sql.exec('UPDATE members SET banned = 0 WHERE pubkey = ?', k).rowsWritten;
          break;
        case 'stop-invites':
          changed += this.sql.exec('UPDATE members SET no_invites = 1 WHERE pubkey = ?', k).rowsWritten;
          break;
        case 'allow-invites':
          changed += this.sql.exec('UPDATE members SET no_invites = 0 WHERE pubkey = ?', k).rowsWritten;
          break;
        case 'set-limit': {
          const n = opts.per_day;
          if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 100_000) return null;
          this.code(this.get(k));
          changed += this.sql.exec('UPDATE invites SET per_day = ? WHERE issuer = ?', n, k).rowsWritten;
          break;
        }
        default:
          return null;
      }
    }
    return changed;
  }
}

/** Cloudflare Turnstile: did a person (not a script) solve the check on the web page? */
export async function turnstileOk(token: string, secret: string | undefined, ip: string, devLocal: boolean): Promise<boolean> {
  if (!secret) return devLocal && token === 'dev-pass';
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip !== 'unknown') form.append('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const out = (await res.json()) as { success?: boolean };
    return out.success === true;
  } catch {
    return false;
  }
}
