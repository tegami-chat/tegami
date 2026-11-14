// Reports: a member tells the operator about a key (spam, a scam, harassment).
//
// POST /report is signed (NIP-98) by the reporter. The relay keeps the reporter's key, the
// reported key, the reason and, only when the reporter chose to attach them, the recent
// messages that key wrote to them (the relay cannot read envelopes, so the reporter's app
// sends the text itself). Nothing is sent to the reported key and nothing stops it
// automatically: the operator reads the reports (POST /admin) and decides. Reports are
// deleted after 90 days.

export const REPORT_REASONS = ['spam', 'scam', 'impersonation', 'harassment', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export type ReportMessage = { text: string; at: number };
export type Report = { id: number; reporter: string; reported: string; reason: ReportReason; messages: ReportMessage[] | null; created_at: number };

export const REPORT_MEMORY_SECONDS = 90 * 24 * 60 * 60;
// One reporter: 20 reports a day, and one a day about the same key, so one person cannot
// make a key look reported by many.
export const REPORTS_PER_DAY = 20;
export const MAX_REPORT_MESSAGES = 20;
export const MAX_REPORT_TEXT = 2000;
const LISTED = 200;
const LISTED_PER_KEY = 1000;

function now() {
  return Math.floor(Date.now() / 1000);
}

/** Checks a report body. Returns the cleaned report, or why it is invalid. */
export function parseReport(body: unknown): { pubkey: string; reason: ReportReason; messages: ReportMessage[] | null } | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'invalid: not an object';
  const r = body as { pubkey?: unknown; reason?: unknown; messages?: unknown };
  if (typeof r.pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(r.pubkey)) return 'invalid: pubkey';
  if (typeof r.reason !== 'string' || !(REPORT_REASONS as readonly string[]).includes(r.reason)) return 'invalid: reason';
  if (r.messages === undefined) return { pubkey: r.pubkey, reason: r.reason as ReportReason, messages: null };
  if (!Array.isArray(r.messages) || r.messages.length > MAX_REPORT_MESSAGES) return 'invalid: messages';
  const messages: ReportMessage[] = [];
  for (const m of r.messages as unknown[]) {
    const { text, at } = (m ?? {}) as { text?: unknown; at?: unknown };
    if (typeof text !== 'string' || text.length > MAX_REPORT_TEXT) return 'invalid: message text';
    if (typeof at !== 'number' || !Number.isInteger(at) || at < 0 || at > 2 ** 40) return 'invalid: message time';
    // Only these two fields are kept, whatever else the app sent.
    messages.push({ text, at });
  }
  return { pubkey: r.pubkey, reason: r.reason as ReportReason, messages: messages.length ? messages : null };
}

export class Reports {
  constructor(private sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, reporter TEXT, reported TEXT, reason TEXT, messages TEXT, created_at INTEGER)`);
    sql.exec('CREATE INDEX IF NOT EXISTS reports_reporter ON reports (reporter, created_at)');
    sql.exec('CREATE INDEX IF NOT EXISTS reports_reported ON reports (reported, created_at)');
  }

  /** Whether this reporter has used up today's reports, or already reported this key today. */
  limited(reporter: string, reported: string): boolean {
    const since = now() - 86400;
    const today = this.sql.exec('SELECT COUNT(*) AS n FROM reports WHERE reporter = ? AND created_at > ?', reporter, since).one().n as number;
    if (today >= REPORTS_PER_DAY) return true;
    const same = this.sql
      .exec('SELECT COUNT(*) AS n FROM reports WHERE reporter = ? AND reported = ? AND created_at > ?', reporter, reported, since)
      .one().n as number;
    return same > 0;
  }

  add(reporter: string, reported: string, reason: ReportReason, messages: ReportMessage[] | null) {
    this.sql.exec(
      'INSERT INTO reports (reporter, reported, reason, messages, created_at) VALUES (?, ?, ?, ?, ?)',
      reporter,
      reported,
      reason,
      messages ? JSON.stringify(messages) : null,
      now(),
    );
  }

  /** The latest reports, newest first, and how many different people reported each key in them. */
  latest(): { reports: Report[]; counts: Record<string, number> } {
    const reports = this.sql.exec('SELECT * FROM reports ORDER BY id DESC LIMIT ?', LISTED).toArray().map(row);
    const counts: Record<string, number> = {};
    for (const r of reports) {
      if (counts[r.reported] === undefined) counts[r.reported] = this.reporters(r.reported);
    }
    return { reports, counts };
  }

  /** The reports about one key, newest first. */
  about(pubkey: string): { reports: Report[]; reporters: number } {
    const reports = this.sql.exec('SELECT * FROM reports WHERE reported = ? ORDER BY id DESC LIMIT ?', pubkey, LISTED_PER_KEY).toArray().map(row);
    return { reports, reporters: this.reporters(pubkey) };
  }

  reporters(pubkey: string): number {
    return this.sql.exec('SELECT COUNT(DISTINCT reporter) AS n FROM reports WHERE reported = ?', pubkey).one().n as number;
  }

  /** Deletes reports after 90 days. */
  forgetOld() {
    this.sql.exec('DELETE FROM reports WHERE created_at < ?', now() - REPORT_MEMORY_SECONDS);
  }
}

function row(r: Record<string, SqlStorageValue>): Report {
  return {
    id: r.id as number,
    reporter: r.reporter as string,
    reported: r.reported as string,
    reason: r.reason as ReportReason,
    messages: r.messages ? (JSON.parse(r.messages as string) as ReportMessage[]) : null,
    created_at: r.created_at as number,
  };
}
