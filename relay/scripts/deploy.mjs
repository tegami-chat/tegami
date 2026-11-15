#!/usr/bin/env node
// Deploys the relay and tells it which Git commit it runs (COMMIT), so /stats and the NIP-11
// document can show it and anyone can compare it with the public repository.
//
//   node scripts/deploy.mjs          (npm run deploy)
//
// It refuses when the relay folder has changes that are not committed, or when the commit is
// not on GitHub yet (origin/main), because then the number shown would not match any public code.
import { execFileSync, spawnSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const commit = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain', '--', '.');
if (dirty) {
  console.error('The relay folder has uncommitted changes. Commit them first:\n' + dirty);
  process.exit(1);
}
git('fetch', '--quiet', 'origin', 'main');
const pushed = spawnSync('git', ['merge-base', '--is-ancestor', commit, 'origin/main']).status === 0;
if (!pushed) {
  console.error(`Commit ${commit.slice(0, 12)} is not on origin/main. Push it first.`);
  process.exit(1);
}

console.log(`Deploying commit ${commit}`);
const res = spawnSync('npx', ['wrangler@4', 'deploy', '--var', `COMMIT:${commit}`], { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(res.status ?? 1);
