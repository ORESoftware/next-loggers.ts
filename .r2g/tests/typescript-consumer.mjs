#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(testDirectory, '..');
const consumerDirectory = path.join(projectDirectory, 'fixtures', 'typescript-consumer');

const run = (label, command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}.\n${output}`);
  }
  return output;
};

run(
  'installing the TypeScript compiler',
  'npm',
  [
    'install',
    '--no-save',
    '--package-lock=false',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    'typescript@5.9.3',
  ],
  projectDirectory,
);

const tsc = path.join(projectDirectory, 'node_modules', '.bin', 'tsc');
run('compiling the dummy TypeScript project', tsc, ['-p', 'tsconfig.json'], consumerDirectory);
const output = run(
  'running the compiled dummy TypeScript project',
  process.execPath,
  [path.join('dist', 'consumer.mjs')],
  consumerDirectory,
);

if (!output.includes('next-loggers dummy TypeScript consumer passed')) {
  throw new Error(`the dummy consumer did not print its success marker.\n${output}`);
}

console.log('phase-T dummy TypeScript dependency test passed');
