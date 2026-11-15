// Unit tests for the weekly, rounded /stats. Runs the real src/stats.ts on Node's SQLite.
// Usage: node --experimental-transform-types test/stats.unit.test.mjs
import { DatabaseSync } from 'node:sqlite';
import { Stats, publishable, weekOf } from '../src/stats.ts';

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures++;
};

// A small stand-in for Cloudflare's SqlStorage: exec(sql, ...params) -> { toArray, one, rowsWritten }.
function sqlStorage() {
  const db = new DatabaseSync(':memory:');
  return {
    exec(sql, ...params) {
      const st = db.prepare(sql);
      if (/^\s*(SELECT)/i.test(sql)) {
        const rows = st.all(...params);
        return { toArray: () => rows, one: () => rows[0], rowsWritten: 0 };
      }
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) {
        const r = st.run(...params);
        return { toArray: () => [], one: () => undefined, rowsWritten: Number(r.changes) };
      }
      db.exec(sql);
      return { toArray: () => [], one: () => undefined, rowsWritten: 0 };
    },
  };
}

const day = (offset) => new Date(Date.now() + offset * 86400e3).toISOString().slice(0, 10);

// weekOf: weeks start on Monday (UTC).
check('weekOf: a Sunday belongs to the Monday before', weekOf('2026-11-15') === '2026-11-09');
check('weekOf: a Monday starts its own week', weekOf('2026-11-16') === '2026-11-16');
check('weekOf: across a month', weekOf('2026-12-02') === '2026-11-30');

// publishable: 0 to 9 are 0, the rest rounded up to 10.
check('publishable: 0 and 9 both become 0', publishable(0) === 0 && publishable(9) === 0);
check('publishable: 10 stays 10, 11 becomes 20, 86 becomes 90', publishable(10) === 10 && publishable(11) === 20 && publishable(86) === 90);

// weekly(): seed exact daily rows, then read what would be published.
const sql = sqlStorage();
const stats = new Stats(sql);
const reg = (pairs) => {
  const r = new Uint8Array(1024);
  for (const [i, v] of pairs) r[i] = v;
  return r;
};
const insert = (d, e, f, b, l, hll) =>
  sql.exec('INSERT INTO stats (day, envelopes, files, file_bytes, logins, hll) VALUES (?, ?, ?, ?, ?, ?)', d, e, f, b, l, hll);

const thisWeek = weekOf(day(0));
const lastWeek = weekOf(day(-7));
const twoWeeksAgo = weekOf(day(-14));
// Last week: two days. Envelopes 50 + 36 = 86, files 1 + 2 = 3, 5 MB + 10 MB, logins 4 + 5 = 9.
// The same 12 keys on both days (identical counters): the week has about 12 keys, not 24.
const three = reg(Array.from({ length: 12 }, (_, i) => [i * 5 + 1, 1]));
insert(lastWeek, 50, 1, 5 * 1048576, 4, three);
insert(day(-7 - ((new Date(day(-7) + 'T00:00:00Z').getUTCDay() + 6) % 7) + 1), 36, 2, 10 * 1048576, 5, three);
// Two weeks ago: 12 of everything, and 12 different keys.
insert(twoWeeksAgo, 12, 12, 12 * 1048576, 12, reg(Array.from({ length: 12 }, (_, i) => [i * 7, 1])));
// This week (not over): must not be published.
insert(day(0), 999, 999, 999 * 1048576, 999, reg([[5, 1]]));

const weeks = stats.weekly();
const by = Object.fromEntries(weeks.map((w) => [w.week, w]));
check('the week that is not over is not published', !by[thisWeek]);
check('newest week first', weeks[0]?.week === lastWeek && weeks[1]?.week === twoWeeksAgo);
check(`last week: envelopes 86 -> 90 (${by[lastWeek]?.envelopes})`, by[lastWeek]?.envelopes === 90);
check(`last week: 3 files -> 0 (${by[lastWeek]?.files})`, by[lastWeek]?.files === 0);
check(`last week: 15 MB -> 20 (${by[lastWeek]?.file_mb})`, by[lastWeek]?.file_mb === 20);
check(`last week: 9 logins -> 0 (${by[lastWeek]?.logins})`, by[lastWeek]?.logins === 0);
check(`last week: the same 12 keys on two days count once -> 20, not 30 (${by[lastWeek]?.keys})`, by[lastWeek]?.keys === 20);
check(`two weeks ago: 12 -> 20 everywhere (${JSON.stringify(by[twoWeeksAgo])})`,
  by[twoWeeksAgo]?.envelopes === 20 && by[twoWeeksAgo]?.files === 20 && by[twoWeeksAgo]?.file_mb === 20 && by[twoWeeksAgo]?.logins === 20 && by[twoWeeksAgo]?.keys === 20);
check('every published number is a multiple of 10', weeks.every((w) => ['envelopes', 'files', 'file_mb', 'logins', 'keys'].every((k) => w[k] % 10 === 0)));
check('the exact daily rows are still there for the operator', stats.recent(400).some((d) => d.envelopes === 50));

// Six months: a daily row older than 183 days is deleted when a new day starts.
const sql2 = sqlStorage();
const stats2 = new Stats(sql2);
const ins2 = (d) => sql2.exec('INSERT INTO stats (day, envelopes, files, file_bytes, logins, hll) VALUES (?, 20, 0, 0, 20, ?)', d, new Uint8Array(1024));
ins2(day(-190));
ins2(day(-170));
for (let w = 1; w <= 30; w++) ins2(day(-7 * w));
stats2.add('logins'); // makes today's row, which forgets old rows
const days2 = stats2.recent(1000).map((d) => d.day);
check('a daily row older than six months is deleted', !days2.includes(day(-190)));
check('a daily row within six months is kept', days2.includes(day(-170)));
check(`at most 24 weeks are published (${stats2.weekly().length})`, stats2.weekly().length === 24);

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
