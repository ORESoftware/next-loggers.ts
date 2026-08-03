import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLogger } from '@oresoftware/next-loggers/base';
import {
  PrometheusRegistry,
  createLoggerPrometheusMetrics,
} from '@oresoftware/next-loggers/prometheus';

test('Prometheus registry renders counters, gauges and cumulative histograms', () => {
  const registry = new PrometheusRegistry({ prefix: 'app' });
  const counter = registry.counter({
    name: 'requests_total',
    help: 'Requests',
    labelNames: ['route'],
  });
  const gauge = registry.gauge({ name: 'inflight', help: 'Inflight', labelNames: ['route'] });
  const histogram = registry.histogram({
    name: 'latency_seconds',
    help: 'Latency',
    labelNames: ['route'],
    buckets: [0.1, 0.5, 1],
  });
  counter.add(2, { route: '/a"b' });
  gauge.set(3, { route: '/a"b' });
  gauge.dec({ route: '/a"b' });
  histogram.observe(0.2, { route: '/a"b' });
  histogram.observe(2, { route: '/a"b' });

  const text = registry.render();
  assert.match(text, /app_requests_total\{route="\/a\\"b"\} 2/);
  assert.match(text, /app_inflight\{route="\/a\\"b"\} 2/);
  assert.match(text, /app_latency_seconds_bucket\{route="\/a\\"b",le="0.5"\} 1/);
  assert.match(text, /app_latency_seconds_bucket\{route="\/a\\"b",le="\+Inf"\} 2/);
  assert.match(text, /app_latency_seconds_count\{route="\/a\\"b"\} 2/);
});

test('Prometheus registry enforces a bounded series cardinality', () => {
  const registry = new PrometheusRegistry({ maxSeriesPerMetric: 2 });
  const counter = registry.counter({
    name: 'bounded_total',
    help: 'Bounded',
    labelNames: ['key'],
  });
  counter.inc({ key: 'one' });
  counter.inc({ key: 'two' });
  counter.inc({ key: 'three' });
  const text = registry.render();
  assert.doesNotMatch(text, /key="three"/);
  assert.match(
    text,
    /next_loggers_prometheus_dropped_series_total\{metric="next_loggers_bounded_total"\} 1/,
  );
});

test('logger Prometheus transport exports stable low-cardinality metrics', async () => {
  const metrics = createLoggerPrometheusMetrics({ environment: 'test' });
  const logger = createLogger({
    appName: 'billing',
    console: false,
    transports: metrics.transport,
  });
  await logger.error('invoice failed').addTrace('trace-1').send();

  const text = metrics.registry.render();
  assert.match(
    text,
    /next_loggers_records_total\{app_name="billing",runtime="base",level="ERROR",environment="test"\} 1/,
  );
  assert.match(text, /next_loggers_error_records_total.* 1/);
  assert.match(text, /next_loggers_trace_correlated_records_total.* 1/);
  assert.doesNotMatch(text, /trace-1/);

  const response = metrics.registry.response();
  assert.match(response.headers.get('content-type'), /text\/plain/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('Prometheus registry rejects invalid names and label drift', () => {
  const registry = new PrometheusRegistry();
  assert.throws(() => registry.counter({ name: 'bad-name', help: 'bad' }), /identifier/);
  const counter = registry.counter({ name: 'good_total', help: 'good', labelNames: ['kind'] });
  assert.throws(() => counter.inc({ other: 'x' }), /unexpected/);
  assert.throws(() => counter.inc({}), /missing/);
});
