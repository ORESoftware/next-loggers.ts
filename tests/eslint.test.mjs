import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Linter } from 'eslint';
import eslintPlugin from '@oresoftware/next-loggers/eslint';

function lint(code, ruleOptions, sourceType = 'module') {
  const linter = new Linter();
  return linter.verify(
    code,
    [
      {
        languageOptions: { ecmaVersion: 'latest', sourceType },
        plugins: { 'next-loggers': eslintPlugin },
        rules: {
          'next-loggers/require-send': ['warn', ...(ruleOptions ? [ruleOptions] : [])],
        },
      },
    ],
    { filename: sourceType === 'commonjs' ? 'consumer.cjs' : 'consumer.mjs' },
  );
}

function lintObservability(code, ruleOptions, sourceType = 'module') {
  const linter = new Linter();
  return linter.verify(
    code,
    [
      {
        languageOptions: { ecmaVersion: 'latest', sourceType },
        plugins: { 'next-loggers': eslintPlugin },
        rules: {
          'next-loggers/require-observability-chain': [
            'error',
            ...(ruleOptions ? [ruleOptions] : []),
          ],
        },
      },
    ],
    { filename: sourceType === 'commonjs' ? 'consumer.cjs' : 'consumer.mjs' },
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
  const messages = lint(`
    import { createLogger } from 'some-other-lib';
    const telemetry = createLogger();
    telemetry.info('not ours');
  `);
  assert.deepEqual(messages, []);
});

test('require-send tracks CommonJS namespace and destructured consumers', () => {
  const messages = lint(`
    const logging = require('@oresoftware/next-loggers');
    const { createLogger: makeLogger, logger: singleton } = require('@oresoftware/next-loggers');
    const audit = makeLogger();
    logging.logger.info('namespace missing');
    singleton.warn('singleton sent').send();
    audit.error('factory missing');
  `, undefined, 'commonjs');
  assert.equal(messages.length, 2);
  assert.equal(messages.every((message) => message.ruleId === 'next-loggers/require-send'), true);
});

test('observability rule accepts inline ores trace and routine markers plus send', () => {
  const messages = lintObservability(`
    import { createLogger } from '@oresoftware/next-loggers';
    const log = createLogger();
    const routineId = 'ores-routine-V1StGXR8_Z5jdHi6B-myT';
    log.info('complete')
      .addTraceId('ores-trace-cW7Kq3_nR9fX2mP8AzL4H')
      .addRoutineId(routineId)
      .send();
    log.error('literal routine')
      .addTrace('ores-trace-Yp6dT0K_vN2xR7QmC9sJb')
      .addRoutine('ores-routine-AbC123_xYz890Qwerty')
      .send();
  `);
  assert.deepEqual(messages, []);
});

test('observability rule follows aliased imports and derived loggers', () => {
  const messages = lintObservability(`
    import { createLogger as makeLogger } from '@oresoftware/next-loggers';
    const audit = makeLogger();
    const child = audit.anew({ appName: 'child' });
    const routineId = 'ores-routine-AliasChild_12345';
    child?.info('complete child')
      .addTraceId('ores-trace-AliasChild_12345')
      .addRoutineId(routineId)
      .send();
    child.error('missing markers');
  `);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, 'next-loggers/require-observability-chain');
  assert.match(messages[0].message, /\.send\(\)/);
  assert.match(messages[0].message, /ores-trace/);
});

test('observability rule tracks CommonJS aliases and namespaces', () => {
  const messages = lintObservability(`
    const logging = require('@oresoftware/next-loggers');
    const { createLogger: makeLogger } = require('@oresoftware/next-loggers');
    const audit = makeLogger();
    const routineId = 'ores-routine-CommonJS_123456';
    logging.logger.info('namespace complete')
      .addTraceId('ores-trace-CommonJS_123456')
      .addRoutineId(routineId)
      .send();
    audit.warn('factory incomplete').send();
  `, undefined, 'commonjs');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, 'next-loggers/require-observability-chain');
  assert.match(messages[0].message, /ores-trace/);
  assert.match(messages[0].message, /routineId/);
});

test('observability rule reports one actionable finding for incomplete chains', () => {
  const messages = lintObservability(`
    import { createLogger } from '@oresoftware/next-loggers';
    const log = createLogger();
    log.error('missing everything');
    log.warn('dynamic marker').addTraceId(traceId).addRoutineId(otherRoutine).send();
  `);
  assert.equal(messages.length, 2);
  assert.equal(
    messages.every((message) => message.ruleId === 'next-loggers/require-observability-chain'),
    true,
  );
  assert.match(messages[0].message, /\.send\(\)/);
  assert.match(messages[0].message, /ores-trace/);
  assert.match(messages[0].message, /routineId/);
  assert.match(messages[1].message, /ores-trace/);
  assert.match(messages[1].message, /routineId/);
});

test('observability rule honors native eslint disable-next-line annotation', () => {
  const messages = lintObservability(`
    import { logger } from '@oresoftware/next-loggers';
    // eslint-disable-next-line next-loggers/require-observability-chain -- legacy bridge
    logger.info('intentionally incomplete');
  `);
  assert.deepEqual(messages, []);
});

test('recommended flat config enables the complete observability-chain warning', () => {
  const recommended = eslintPlugin.configs.recommended;
  const linter = new Linter();
  const messages = linter.verify("log.info('missing');", [recommended]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].severity, 1);
  assert.equal(messages[0].ruleId, 'next-loggers/require-observability-chain');
});
