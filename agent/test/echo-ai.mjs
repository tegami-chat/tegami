// A stand-in AI command for the tests: prints what it got on stdin and where it runs.
// Arguments: "fail" exits with code 3 (with a message on stderr), "empty" prints nothing.
import { readFileSync } from 'node:fs';

const input = readFileSync(0, 'utf8');
const mode = process.argv[2];
if (mode === 'fail') {
  console.error('boom');
  process.exit(3);
}
if (mode === 'empty') process.exit(0);
console.log(`${input}\nCWD:${process.cwd()}`);
