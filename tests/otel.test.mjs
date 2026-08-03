import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLogger } from '@oresoftware/next-loggers/base';
import {
  createOtelBridge,
  createOtelContextProvider,
  createOtelLogTransport,
  withOtelSpan,
} from '@oresoftware/next-loggers/otel';

function createFakeOtel() {
  const emitted = [];
  const spans = [];
  let activeSpan;
  const tracer = {
    startActiveSpan(name, options, callback) {
      const index = spans.length + 1;
      const span = {
        name,
        options,
        status: [],
        exceptions: [],
        ended: 0,
        spanContext() {
          return {
            traceId: `trace-${index}`,
            spanId: `span-${index}`,
            traceFlags: 1,
            traceState: { serialize: () => 'vendor=value' },
          };
        },
        setStatus(status) {
          this.status.push(status);
          return this;
        },
        recordException(error) {
          this.exceptions.push(error);
          return this;
        },
        end() {
          this.ended += 1;
        },
      };
      spans.push(span);
      activeSpan = span;
      let result;
      try {
        result = callback(span);
      } catch (error) {
        activeSpan = undefined;
        throw error;
      }
      return Promise.resolve(result).finally(() => {
        activeSpan = undefined;
      });
    },
  };
  return {
    emitted,
    spans,
    trace: {
      getActiveSpan: () => activeSpan,
      getTracer: () => tracer,
    },
    logs: {
      getLogger: () => ({ emit: (record) => emitted.push(record) }),
    },
  };
}

test('OTel bridge correlates next-loggers records with the active explicit span', async () => {
  const fake = createFakeOtel();
  const bridge = createOtelBridge({
    trace: fake.trace,
    logs: fake.logs,
    instrumentationName: 'checkout-observability',
    resourceAttributes: { 'deployment.environment': 'test' },
  });
  const records = [];
  const logger = createLogger(
    bridge.loggerOptions({
      appName: 'checkout-api',
      console: false,
      transports: { name: 'memory', write: (record) => void records.push(record) },
    }),
  );

  const result = await bridge.withSpan(
    logger,
    'checkout.charge',
    async () => {
      await logger.info('charging order').addFields({ orderId: 'order-42' }).send();
      return 42;
    },
    { attributes: { 'checkout.method': 'card' }, tags: ['payments'] },
  );

  assert.equal(result, 42);
  assert.equal(fake.spans.length, 1);
  assert.equal(fake.spans[0].ended, 1);
  assert.deepEqual(fake.spans[0].status, [{ code: 1 }]);
  assert.equal(records.length, 3);
  const applicationRecord = records.find((record) => record.message === 'charging order');
  assert.equal(applicationRecord.traceId, 'trace-1');
  assert.equal(applicationRecord.fields['otel.span_id'], 'span-1');
  assert.equal(applicationRecord.fields['otel.trace_flags'], 1);
  assert.equal(applicationRecord.fields['otel.trace_state'], 'vendor=value');
  assert.deepEqual(applicationRecord.tags, ['otel']);

  const exported = fake.emitted.find((record) => record.body === 'charging order');
  assert.equal(exported.severityNumber, 9);
  assert.equal(exported.attributes['service.name'], 'checkout-api');
  assert.equal(exported.attributes['next_loggers.field.orderId'], 'order-42');
  assert.equal(exported.attributes['next_loggers.field.otel.span_id'], 'span-1');
  assert.equal(exported.attributes['deployment.environment'], 'test');
});

test('withOtelSpan records and rethrows failures through next-loggers', async () => {
  const fake = createFakeOtel();
  const records = [];
  const logger = createLogger({
    console: false,
    transports: { write: (record) => void records.push(record) },
    contextProvider: createOtelContextProvider({ trace: fake.trace }),
  });
  const error = new Error('declined');

  await assert.rejects(
    withOtelSpan(
      logger,
      fake.trace.getTracer(),
      'checkout.failure',
      async () => {
        throw error;
      },
      { lifecycleLevel: false },
    ),
    error,
  );

  assert.equal(fake.spans[0].ended, 1);
  assert.deepEqual(fake.spans[0].exceptions, [error]);
  assert.deepEqual(fake.spans[0].status, [{ code: 2, message: 'declined' }]);
  assert.equal(records.length, 1);
  assert.equal(records[0].level, 'ERROR');
  assert.equal(records[0].message.startsWith('span failed: checkout.failure'), true);
  assert.equal(records[0].traceId, 'trace-1');
});

test('OTel log transport bounds complex attributes and does not patch globals', () => {
  const emitted = [];
  const before = {
    fetch: globalThis.fetch,
    timeout: globalThis.setTimeout,
    console: console.log,
  };
  const transport = createOtelLogTransport({
    logs: { getLogger: () => ({ emit: (record) => emitted.push(record) }) },
    maxAttributeLength: 20,
  });
  transport.write({
    schema: 'next-loggers/v1',
    id: 'record-1',
    timestamp: '2026-01-02T03:04:05.000Z',
    level: 'WARN',
    runtime: 'node',
    appName: 'app',
    message: 'bounded',
    values: [],
    fields: { nested: { value: 'x'.repeat(100) } },
  });
  assert.equal(emitted[0].severityNumber, 13);
  assert.match(emitted[0].attributes['next_loggers.field.nested'], /truncated/);
  assert.equal(globalThis.fetch, before.fetch);
  assert.equal(globalThis.setTimeout, before.timeout);
  assert.equal(console.log, before.console);
});

test('OTel context provider fails open when active context access throws', () => {
  const provider = createOtelContextProvider({
    trace: {
      getActiveSpan() {
        throw new Error('broken context manager');
      },
      getTracer() {
        throw new Error('unused');
      },
    },
  });
  assert.equal(provider(), undefined);
});

test('withOtelSpan preserves application results when injected OTel lifecycle calls fail', async () => {
  const records = [];
  const logger = createLogger({
    appName: 'resilient-app',
    console: false,
    transports: { write: (record) => void records.push(record) },
  });
  const span = {
    spanContext: () => ({ traceId: 'trace-resilient', spanId: 'span-resilient', traceFlags: 1 }),
    setStatus() {
      throw new Error('status unavailable');
    },
    end() {
      throw new Error('end unavailable');
    },
  };
  const tracer = {
    startActiveSpan(_name, _options, callback) {
      return callback(span);
    },
  };

  const value = await withOtelSpan(logger, tracer, 'resilient.operation', async () => 7, {
    lifecycleLevel: 'INFO',
  });

  assert.equal(value, 7);
  assert.equal(
    records.some((record) =>
      record.message.startsWith('OpenTelemetry set success status failed'),
    ),
    true,
  );
  assert.equal(
    records.some((record) => record.message.startsWith('OpenTelemetry end span failed')),
    true,
  );
});
