# Explicit OpenTelemetry integration

`@oresoftware/next-loggers/otel` adapts the stable `next-loggers/v1` record to
application-owned OpenTelemetry log, trace, and metric objects. Application code
continues to call `logger.info(...)`, `logger.error(...)`, and related methods;
OpenTelemetry is downstream of those calls as a normal logger transport.

## Non-negotiable runtime boundary

This package does **not**:

- register a global tracer, meter, logger, propagator, or context manager;
- install OpenTelemetry automatic instrumentation;
- patch Node.js modules, prototypes, fetch, HTTP clients, database drivers, or
  framework internals;
- use `require-in-the-middle`, `shimmer`, or equivalent hooks;
- import `node:async_hooks` from the browser-safe OTEL adapter.

The application owns SDK startup and passes structural adapters explicitly.
That keeps Node.js, Bun, Deno, workerd, browser, WASM, Flutter, BEAM, Java, Go,
and Rust runtimes consistent and testable.

## TypeScript example

```ts
import { logs, metrics, trace, context } from '@opentelemetry/api';
import { createNodeLogger } from '@oresoftware/next-loggers/node';
import {
  createOpenTelemetryContextProvider,
  createOpenTelemetryTransport,
} from '@oresoftware/next-loggers/otel';

const otelLogger = logs.getLogger('my-service');
const meter = metrics.getMeter('my-service');
const records = meter.createCounter('next_loggers.records');
const errors = meter.createCounter('next_loggers.errors');
const activeSpan = () => trace.getSpan(context.active());

const logger = createNodeLogger({
  appName: 'my-service',
  console: false,
  contextProvider: createOpenTelemetryContextProvider(activeSpan),
  transports: createOpenTelemetryTransport({
    logger: otelLogger,
    activeSpan,
    activeContext: () => context.active(),
    recordMetric(name, value, attributes) {
      (name === 'next_loggers.errors' ? errors : records).add(value, attributes);
    },
  }),
});
```

The OpenTelemetry packages shown above belong to the application, not this
library. This package intentionally has no dependency on an OTEL SDK.

## Context model

- Node.js, Bun, and Deno may use the package's explicit `AsyncLocalStorage`
  context API from `@oresoftware/next-loggers/context`.
- Rust, Go, Java, Dart, Erlang, Elixir, Gleam, and WASM SDKs use their native
  task/thread/process context facilities or explicit context values.
- Browser and workerd builds use explicit request/task context; browser log
  delivery continues through the Supabase transport where configured.
- `createOpenTelemetryContextProvider` reads only the active span callback the
  application supplies and maps its W3C identifiers into `traceId` plus
  `otel.span_id`, `otel.trace_flags`, and `otel.trace_state` fields.

## Cluster flow

The supported production flow is:

1. application logger call;
2. explicit OTEL adapter and/or Supabase client transport;
3. OTLP gRPC/HTTP to the cluster collector;
4. traces to Tempo, logs to Loki, metrics and span metrics to Prometheus;
5. correlation and dashboards in Grafana.

All exporters must be bounded with queues, retry limits, memory limits, and
network policies. Telemetry failure must not crash the application or silently
change business behavior.
