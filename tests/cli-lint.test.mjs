import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { checkSource, lintSource } from '../dist/cli/commands/lint.js';
import { main } from '../dist/cli/main.js';

const lines = (findings) => findings.map((finding) => finding.line);

test('javascript and typescript chains are reported only when nothing sends them', () => {
  const source = `
import { createLogger } from '@oresoftware/next-loggers';

const logger = createLogger({ appName: 'checkout' });

logger.info('delivered').send();
logger.warn('delivered').useOtel().send();
await logger.error('awaited', error).notOtel().send();
logger.info('dropped');
logger.error('dropped').addFields({ a: 1 }).useOtel();
const event = logger.info('assigned');
event.send();
return logger.info('returned');
`;
  assert.deepEqual(lines(checkSource(source, 'typescript')), [9, 10]);
});

test('multi-line chains are treated as one statement', () => {
  const source = `
import logger from '@oresoftware/next-loggers';

logger
  .error('multi line')
  .addTags('a')
  .send();

logger
  .error('multi line, never sent')
  .addTags('a');
`;
  assert.deepEqual(lines(checkSource(source, 'javascript')), [9]);
});

test('gleam pipelines are understood, including the send at the end', () => {
  const source = `
import oresoftware_next_loggers as logging

pub fn handle(logger: logging.Logger) -> Nil {
  logging.info(logger, "sent", [])
  |> logging.add_tags(["a"])
  |> logging.send

  logging.warn(logger, "never sent", [])
  |> logging.add_tags(["a"])

  Nil
}
`;
  assert.deepEqual(lines(checkSource(source, 'gleam')), [9]);
});

test('go and rust and python chains use their own send spelling', () => {
  const go = `
package main

import nextloggers "github.com/ORESoftware/next-loggers.ts/sdk/go"

func run() {
	logger := nextloggers.NewLogger(nextloggers.Options{})
	logger.Info("sent").Send()
	logger.Warn("dropped").NotOtel()
}
`;
  assert.deepEqual(lines(checkSource(go, 'go')), [9]);

  const rust = `
use next_loggers::{Logger, Options};

fn run(logger: &Logger) {
    logger.info(vec![]).send().unwrap();
    logger.warn(vec![]).not_otel();
}
`;
  assert.deepEqual(lines(checkSource(rust, 'rust')), [6]);

  const python = `
from next_loggers import Logger

logger = Logger(app_name="checkout")
logger.info("sent").send()
logger.warn("dropped").not_otel()
`;
  assert.deepEqual(lines(checkSource(python, 'python')), [6]);
});

test('comments and string literals never produce findings', () => {
  const source = `
import { logger } from '@oresoftware/next-loggers';
// logger.info('in a comment');
/* logger.info('in a block comment'); */
const sample = "logger.info('in a string')";
logger.info('real').send();
`;
  assert.deepEqual(checkSource(source, 'typescript'), []);
});

test('files that never mention next-loggers are skipped unless a logger name is given', () => {
  const source = "const logger = pino();\nlogger.info('another library');\n";
  assert.deepEqual(checkSource(source, 'javascript'), []);
  assert.deepEqual(lines(checkSource(source, 'javascript', { loggerNames: ['logger'] })), [2]);
});

test('the lint command walks paths, prints findings, and exits 1', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'next-loggers-lint-'));
  try {
    await mkdir(path.join(directory, 'node_modules'), { recursive: true });
    await writeFile(
      path.join(directory, 'node_modules', 'ignored.js'),
      "import '@oresoftware/next-loggers';\nlogger.info('ignored');\n",
    );
    await writeFile(
      path.join(directory, 'clean.ts'),
      "import '@oresoftware/next-loggers';\nlogger.info('ok').send();\n",
    );
    await writeFile(
      path.join(directory, 'broken.ts'),
      "import '@oresoftware/next-loggers';\nlogger.info('missing');\n",
    );

    const printed = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      printed.push(String(chunk));
      return true;
    };
    let exitCode;
    try {
      exitCode = await main(['lint', directory]);
    } finally {
      process.stdout.write = originalWrite;
    }

    const output = printed.join('');
    assert.equal(exitCode, 1);
    assert.match(output, /broken\.ts:2:1: next-loggers event is never sent/);
    assert.doesNotMatch(output, /clean\.ts/);
    assert.doesNotMatch(output, /node_modules/);
    assert.match(output, /lint: 1 unsent event\(s\)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const imported = `
  import { createLogger } from '@oresoftware/next-loggers';
  const log = createLogger({ appName: 'test' });
`;

test('NL100 flags a standalone event chain that never sends', () => {
  const findings = lintSource(`${imported}\nlog.info('started').withTag('boot');\n`, 'sample.ts');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'NL100');
  assert.equal(findings[0].line, 5);
});

test('accepts send and sendWithStore terminal calls', () => {
  assert.deepEqual(
    lintSource(
      `${imported}\nlog.info('sent').send();\nlog.warn('stored').sendWithStore();\n`,
      'sample.ts',
    ).map((finding) => finding.line),
    [],
  );
});

test('tracks imported aliases and factory-created loggers', () => {
  const source = `
    import { createLogger as makeLogger } from '@oresoftware/next-loggers/node';
    const audit = makeLogger({ appName: 'audit' });
    audit.error('missing');
  `;
  assert.equal(lintSource(source, 'sample.mts').length, 1);
});
