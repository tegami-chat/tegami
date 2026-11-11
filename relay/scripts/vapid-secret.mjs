// Makes the relay's Web Push (VAPID) key and stores it as the Worker secret VAPID_JWK.
// The private key goes straight from memory into wrangler's standard input; it is
// never printed or written to a file. Prints only the public key.
import { spawn } from 'node:child_process';

// Run from app/relay:  node scripts/vapid-secret.mjs   (once; running again replaces the key,
// and every device has to turn notifications off and on again)
const relayDir = new URL('..', import.meta.url);
const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const jwk = await crypto.subtle.exportKey('jwk', key.privateKey);
const p = spawn('npx wrangler@4 secret put VAPID_JWK', { cwd: relayDir, shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
p.stdin.end(JSON.stringify(jwk));
p.on('exit', (code) => {
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
  console.log(code === 0 ? `stored. public key: ${pub}` : `wrangler exited ${code}`);
  process.exit(code ?? 1);
});
