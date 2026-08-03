import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { createLogger } from '@oresoftware/next-loggers/base';
import {
  createOpenTelemetryContextProvider,
  createOpenTelemetryTransport,
  logRecordToOtelAttributes,
} from '@oresoftware/next-loggers/otel';

test('logger calls explicitly fan out to OTEL logs, span events, exceptions, and metrics', async () => {
  const emitted = [];
  const events = [];
  const exceptions = [];
  const statuses = [];
  const metrics = [];
  const span = {
    spanContext() {
      return {
        traceId: '0123456789abcdef0123456789abcdef',
        spanId: '0123456789abcdef',
        traceFlags: 1,
        traceState: { serialize: () => 'vendor=value' },
      };
    },
    isRecording: () => true,
    addEvent(name, attributes, time) {
      events.push({ name, attributes, time });
    },
    recordException(error, time) {
      exceptions.push({ error, time });
    },
    setStatus(status) {
      statuses.push(status);
    },
  };
  const activeSpan = () => span;
  const transport = createOpenTelemetryTransport({
    logger: { emit: (record) => emitted.push(record) },
    activeSpan,
    activeContext: () => ({ request: 'context-owned-by-the-app' }),
    attributes: { 'deployment.environment': 'test' },
    includeValues: true,
    recordMetric: (name, value, attributes) => metrics.push({ name, value, attributes }),
  });
  const logger = createLogger({
    appName: 'otel-test',
    name: 'request',
    console: false,
    clock: () => new Date('2026-08-03T03:00:00.000Z'),
    idFactory: () => 'record-1',
    contextProvider: createOpenTelemetryContextProvider(activeSpan),
    transports: transport,
  });

  await logger
    .error('request failed', new Error('boom'))
    .addFields({ route: '/v1/items', attempts: 2, nested: { safe: true } })
    .send();

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].body, 'request failed boom');
  assert.equal(emitted[0].severityNumber, 17);
  assert.equal(emitted[0].severityText, 'ERROR');
  assert.equal(emitted[0].attributes['service.name'], 'otel-test');
  assert.equal(emitted[0].attributes['logger.name'], 'request');
  assert.equal(emitted[0].attributes['trace.id'], '0123456789abcdef0123456789abcdef');
  assert.equal(emitted[0].attributes['span.id'], '0123456789abcdef');
  assert.equal(emitted[0].attributes['otel.trace_state'], 'vendor=value');
  assert.equal(emitted[0].attributes['next_logger.field.route'], '/v1/items');
  assert.equal(emitted[0].attributes['next_logger.field.nested'], '{"safe":true}');
  assert.deepEqual(emitted[0].context, { request: 'context-owned-by-the-app' });

  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'log.error');
  assert.equal(exceptions.length, 1);
  assert.equal(exceptions[0].error.message, 'boom');
  assert.deepEqual(statuses, [{ code: 2, message: 'request failed boom' }]);
  assert.deepEqual(
    metrics.map(({ name, value }) => ({ name, value })),
    [
      { name: 'next_loggers.records', value: 1 },
      { name: 'next_loggers.errors', value: 1 },
    ],
  );
});

test('the OTEL context provider does not synthesize context without a recording span', () => {
  assert.equal(createOpenTelemetryContextProvider(() => undefined)(), undefined);
  assert.equal(
    createOpenTelemetryContextProvider(() => ({
      spanContext: () => ({ traceId: 'trace', spanId: 'span', traceFlags: 0 }),
      isRecording: () => false,
      addEvent() {},
    }))(),
    undefined,
  );
});

test('record conversion keeps OTEL attributes scalar and bounded', () => {
  const attributes = logRecordToOtelAttributes({
    schema: 'next-loggers/v1',
    id: '1',
    timestamp: '2026-08-03T03:00:00.000Z',
    level: 'INFO',
    runtime: 'browser',
    appName: 'web',
    message: 'ready',
    values: [],
    fields: {
      booleans: [true, false],
      mixed: [true, 'value'],
      object: { answer: 42 },
    },
  });
  assert.deepEqual(attributes['next_logger.field.booleans'], [true, false]);
  assert.deepEqual(attributes['next_logger.field.mixed'], [true, 'value']);
  assert.equal(attributes['next_logger.field.object'], '{"answer":42}');
});

test('OTEL integration is explicit and contains no automatic instrumentation hooks', async () => {
  const source = await readFile(new URL('../src/otel.ts', import.meta.url), 'utf8');
  for (const forbidden of [
    '@opentelemetry/instrumentation',
    'registerInstrumentations',
    'require-in-the-middle',
    'shimmer',
  ]) {
    assert.equal(source.includes(forbidden), false, `forbidden automatic instrumentation hook: ${forbidden}`);
  }
  assert.equal(/\.\s*prototype\s*\./u.test(source), false, 'prototype mutation is forbidden');
  assert.equal(source.includes('node:async_hooks'), false, 'the browser-safe adapter must not import Node ALS');
});
