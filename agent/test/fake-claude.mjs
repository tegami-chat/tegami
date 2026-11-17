// Stands in for `claude -p` in tests: writes down how it was called and answers like Claude Code.
// Called as the AI check (check.mjs: its instructions name "Tegami AI check"), it answers with
// FAKE_CHECK: a verdict line ("SAFE: ok", "ASK_OWNER: why", anything), "fail" (exits with an
// error and no JSON) or "hang" (never answers). Without FAKE_CHECK the check answers "SAFE: fake".
import { appendFileSync, readFileSync } from 'node:fs';

const prompt = readFileSync(0, 'utf8');
const argv = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv, prompt }) + '\n');
if (process.env.FAKE_CLAUDE_DELAY) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLAUDE_DELAY)));
const isCheck = argv.join(' ').includes('Tegami AI check');
const verdict = process.env.FAKE_CHECK ?? 'SAFE: fake';
if (isCheck && verdict === 'fail') {
  process.stderr.write('fake failure');
  process.exit(1);
}
if (isCheck && verdict === 'hang') await new Promise((r) => setTimeout(r, 600_000));
const result = isCheck ? verdict : `fake: ${prompt}`;
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result, session_id: 'session-1', modelUsage: { 'claude-fake-1': { outputTokens: 3 } } }));
