// Stand-in for an AI in tests: replies with the new message it was given (the command
// backend wraps it in instructions, so only the part under the "new message" line is echoed).
let s = '';
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  const m = s.match(/--- 新しいメッセージ ---\n([\s\S]*?)\n\n上の指示に従い/);
  process.stdout.write(`echo: ${(m ? m[1] : s).trim()}`);
});
