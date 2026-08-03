#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const suites = [
  {
    name: 'Python',
    command: process.env.PYTHON || 'python3',
    args: ['-m', 'unittest', 'discover', '-s', 'tests', '-v'],
    cwd: path.join(root, 'sdk', 'python'),
    env: { PYTHONPATH: 'src' },
  },
  {
    name: 'Go',
    command: 'go',
    args: ['test', './...'],
    cwd: path.join(root, 'sdk', 'go'),
  },
  {
    name: 'Rust',
    command: 'cargo',
    args: ['test', '--locked'],
    cwd: path.join(root, 'sdk', 'rust'),
  },
  {
    name: 'Rust OpenTelemetry companion',
    command: 'cargo',
    args: ['test'],
    cwd: path.join(root, 'sdk', 'rust-otel'),
  },
  {
    name: 'Gleam',
    command: 'gleam',
    args: ['test'],
    cwd: path.join(root, 'sdk', 'gleam'),
  },
  {
    name: 'Java',
    command: 'bash',
    args: ['test.sh'],
    cwd: path.join(root, 'sdk', 'java'),
  },
  {
    name: 'Dart/Flutter conformance',
    command: 'dart',
    args: ['run', 'test/conformance.dart'],
    cwd: path.join(root, 'sdk', 'dart'),
  },
  {
    name: 'Dart/Flutter adversarial',
    command: 'dart',
    args: ['run', 'test/adversarial.dart'],
    cwd: path.join(root, 'sdk', 'dart'),
  },
  {
    name: 'Erlang',
    command: 'bash',
    args: ['test.sh'],
    cwd: path.join(root, 'sdk', 'erlang'),
  },
  {
    name: 'Elixir',
    command: 'bash',
    args: ['test.sh'],
    cwd: path.join(root, 'sdk', 'elixir'),
  },
  {
    name: 'WASM',
    command: 'bash',
    args: ['test.sh'],
    cwd: path.join(root, 'sdk', 'wasm'),
  },
];

for (const suite of suites) {
  process.stdout.write(`\n=== ${suite.name} SDK ===\n`);
  const result = spawnSync(suite.command, suite.args, {
    cwd: suite.cwd,
    env: { ...process.env, ...suite.env },
    stdio: 'inherit',
  });
  if (result.error?.code === 'ENOENT') {
    process.stderr.write(`${suite.name} toolchain is not installed.\n`);
    process.exitCode = 127;
    break;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
