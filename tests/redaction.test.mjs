import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createLogger,
  DEFAULT_REDACTED_KEY_PATTERNS,
  serializeLogValueRedacted,
} from '@oresoftware/next-loggers/base';

const makeMemoryLogger = (options = {}) => {
  const records = [];
  const logger = createLogger({
    console: false,
    transports: { write: (record) => void records.push(record) },
    ...options,
  });
  return { logger, records };
};

test('sensitive keys are redacted by default in values, fields, and message', async () => {
  const { logger, records } = makeMemoryLogger();
  await logger
    .error('login failed', { password: 'hunter2', apiToken: 'tok-1', attempt: 3 })
    .addFields({ sessionSecret: 'sh', requestId: 'r-1' })
    .send();
  const record = records[0];
  assert.equal(record.values[1].password, '[REDACTED]');
  assert.equal(record.values[1].apiToken, '[REDACTED]');
  assert.equal(record.values[1].attempt, 3);
  assert.equal(record.fields.sessionSecret, '[REDACTED]');
  assert.equal(record.fields.requestId, 'r-1');
  assert.equal(record.message.includes('hunter2'), false);
  assert.equal(record.message.includes('[REDACTED]'), true);
});

test('loggedInUser identity block is exempt from redaction', async () => {
  const { logger, records } = makeMemoryLogger({
    loggedInUser: { id: 'u-1', email: 'person@example.test' },
  });
  await logger.error('who did it').send();
  assert.equal(records[0].loggedInUser.email, 'person@example.test');
});

test('redaction can be disabled or customized', async () => {
  const off = makeMemoryLogger({ redactKeys: false });
  await off.logger.error('raw', { password: 'visible' }).send();
  assert.equal(off.records[0].values[1].password, 'visible');

  const custom = makeMemoryLogger({ redactKeys: ['internalcode'] });
  await custom.logger.error('custom', { internalCode: 'x', password: 'kept' }).send();
  assert.equal(custom.records[0].values[1].internalCode, '[REDACTED]');
  assert.equal(custom.records[0].values[1].password, 'kept');
});

test('serializeLogValueRedacted redacts nested structures and error properties', () => {
  const error = new Error('with secrets');
  error.refreshToken = 'r-token';
  const result = serializeLogValueRedacted({
    nested: { list: [{ ssn: '123-45-6789' }] },
    error,
  });
  assert.equal(result.nested.list[0].ssn, '[REDACTED]');
  assert.equal(result.error.refreshToken, '[REDACTED]');
  assert.equal(result.error.message, 'with secrets');
  assert.equal(DEFAULT_REDACTED_KEY_PATTERNS.includes('password'), true);
});

test('error tracking dedupes identical records and retries after failure', async () => {
  const posts = [];
  let failNext = false;
  const logger = createLogger({
    console: false,
    clock: () => new Date('2026-01-01T00:00:00.000Z'),
    onTransportError: () => undefined,
  }).setErrorTrackingUrl('https://errors.example.test/collect', {
    fetch: async (url, init) => {
      if (failNext) {
        failNext = false;
        return new Response(null, { status: 500, statusText: 'flake' });
      }
      posts.push(JSON.parse(init.body).message);
      return new Response(null, { status: 200 });
    },
  });

  await logger.error('dup error').send();
  await logger.error('dup error').send();
  await logger.error('other error').send();
  assert.deepEqual(posts, ['dup error', 'other error']);

  failNext = true;
  await logger.error('flaky error').send();
  assert.deepEqual(posts, ['dup error', 'other error']);
  await logger.error('flaky error').send();
  assert.deepEqual(posts, ['dup error', 'other error', 'flaky error']);
});

test('error tracking dedupe can be disabled', async () => {
  const posts = [];
  const logger = createLogger({ console: false }).setErrorTracking({
    url: 'https://errors.example.test/collect',
    dedupe: false,
    fetch: async (url, init) => {
      posts.push(JSON.parse(init.body).message);
      return new Response(null, { status: 200 });
    },
  });
  await logger.error('same').send();
  await logger.error('same').send();
  assert.deepEqual(posts, ['same', 'same']);
});
