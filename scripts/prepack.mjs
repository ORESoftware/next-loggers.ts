import { existsSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }
}

// Normal release worktrees keep the full historical prepack contract. Tools
// such as r2g intentionally copy a package into an isolated directory without
// `.git`; that copied-source path must remain packable without git-dependent
// lint/bootstrap hooks.
if (existsSync('.git')) {
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test']);
} else {
  const tsc = process.platform === 'win32'
    ? 'node_modules/.bin/tsc.cmd'
    : 'node_modules/.bin/tsc';
  run(tsc, ['-p', 'tsconfig.build.json']);
  chmodSync('dist/cli/main.js', 0o755);
  run(process.execPath, ['scripts/stage-nodejs-release.mjs']);
  run(process.execPath, ['--test', 'tests/*.test.mjs']);
}
