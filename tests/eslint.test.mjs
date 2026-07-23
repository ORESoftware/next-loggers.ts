import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Linter } from 'eslint';
import eslintPlugin from '@oresoftware/next-loggers/eslint';

function lint(code, ruleOptions) {
  const linter = new Linter();
  return linter.verify(
    code,
    [
      {
        languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
        plugins: { 'next-loggers': eslintPlugin },
        rules: {
          'next-loggers/require-send': ['warn', ...(ruleOptions ? [ruleOptions] : [])],
        },
      },
    ],
    { filename: 'consumer.mjs' },
  );
}

test('require-send accepts delivered logger chains', () => {
  const messages = lint(`
    import { createLogger, logger } from '@oresoftware/next-loggers';
    const log = createLogger();
    logger.info('singleton').send();
    log.error('factory').addTrace('trace').send();
    await log.warn('awaited').send();
    log.debug('handled').send().catch(() => {});
    console.info('not a next-loggers event');
  `);
  assert.deepEqual(messages, []);
});

test('require-send warns for unfinished singleton and factory chains', () => {
  const messages = lint(`
    import nextLoggers, { createNodeLogger as makeLogger } from '@oresoftware/next-loggers/node';
    const audit = makeLogger();
    nextLoggers.info('missing');
    audit.error('also missing').addFields({ requestId: 'r1' });
  `);
  assert.equal(messages.length, 2);
  assert.equal(messages.every((message) => message.ruleId === 'next-loggers/require-send'), true);
  assert.match(messages[0].message, /Call \.send\(\)/);
});

test('require-send recognizes namespace imports and exported classes', () => {
  const messages = lint(`
    import * as logging from '@oresoftware/next-loggers/node';
    const first = logging.createNodeLogger();
    const second = new logging.NodeLogger();
    logging.nodeLogger.warn('one');
    first.warn('two');
    second.warn('three').send();
  `);
  assert.equal(messages.length, 2);
});

test('require-send supports configured custom logger names', () => {
  const messages = lint(`
    audit.info('missing');
    audit.info('sent').send();
  `, { loggerNames: ['audit'] });
  assert.equal(messages.length, 1);
});

test('require-send handles await, void, optional chaining, and anew children', () => {
  const messages = lint(`
    import { createLogger } from '@oresoftware/next-loggers';
    const log = createLogger();
    const child = log.anew({ appName: 'child' });
    void log.info('voided but sent').send();
    await log.warn('awaited').addTags('a').send();
    log?.error('optional chain missing');
    child.info('child missing');
    child.info('child sent').send();
  `);
  assert.equal(messages.length, 2);
});

test('require-send tracks loggers assigned to object properties', () => {
  const messages = lint(`
    import { createLogger } from '@oresoftware/next-loggers';
    const app = {};
    app.log = createLogger();
    app.log.info('missing on property');
    app.log.info('sent on property').send();
  `);
  assert.equal(messages.length, 1);
});

test('require-send honors configured extra module names', () => {
  const messages = lint(`
    import { createLogger } from '@acme/logging';
    const log = createLogger();
    log.info('missing');
  `, { moduleNames: ['@acme/logging'] });
  assert.equal(messages.length, 1);
});

test('require-send ignores unrelated modules with identical export names', () => {
  // Note: variables literally named log/logger/ddlog are always tracked, so
  // this deliberately uses a neutral name to isolate module detection.
  const messages = lint(`
    import { createLogger } from 'some-other-lib';
    const telemetry = createLogger();
    telemetry.info('not ours');
  `);
  assert.deepEqual(messages, []);
});

test('recommended flat config enables the warning', () => {
  const recommended = eslintPlugin.configs.recommended;
  const linter = new Linter();
  const messages = linter.verify("log.info('missing');", [recommended]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].severity, 1);
});
