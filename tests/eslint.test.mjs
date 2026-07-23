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

test('recommended flat config enables the warning', () => {
  const recommended = eslintPlugin.configs.recommended;
  const linter = new Linter();
  const messages = linter.verify("log.info('missing');", [recommended]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].severity, 1);
});
