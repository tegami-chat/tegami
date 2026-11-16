// Stands in for `claude -p` in tests: writes down how it was called and answers like Claude Code.
import { appendFileSync, readFileSync } from 'node:fs';

const prompt = readFileSync(0, 'utf8');
const argv = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv, prompt }) + '\n');
if (process.env.FAKE_CLAUDE_DELAY) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLAUDE_DELAY)));
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: `fake: ${prompt}`, session_id: 'session-1' }));
