// Stand-in for an AI in tests: replies with what it was given.
let s = '';
process.stdin.on('data', (d) => (s += d)).on('end', () => process.stdout.write(`echo: ${s.trim()}`));
