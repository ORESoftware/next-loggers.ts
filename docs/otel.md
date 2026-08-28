# Explicit OpenTelemetry integration

`@oresoftware/next-loggers/otel` adapts the stable `next-loggers/v1` record to
application-owned OpenTelemetry log, trace, and metric objects. Application code
continues to call `logger.info(...)`, `logger.error(...)`, and related methods;
OpenTelemetry stays downstream of those calls as a normal logger transport.

## Non-negotiable runtime boundary

This package does **not**:

- register a global tracer, meter, logger, propagator, or context manager;
- install OpenTelemetry automatic instrumentation;
- patch Node.js modules, prototypes, `fetch`, HTTP clients, database drivers,
  console methods, or framework internals;
- use `require-in-the-middle`, `shimmer`, or equivalent hooks;
- import `node:async_hooks` from the browser-safe OTEL adapter.

The application owns SDK startup and passes structural adapters explicitly.
That keeps Node.js, Bun, Deno, workerd, browsers, WASM, Flutter, BEAM, Java, Go,
Rust, Python, and Gleam runtimes consistent and testable.

## TypeScript example

```ts
import { context, logs, metrics, trace } from '@opentelemetry/api';
import { createNodeLogger } from '@oresoftware/next-loggers/node';
import {
  createOpenTelemetryContextProvider,
  createOpenTelemetryTransport,
  withOpenTelemetry,
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
    metricAttributes: {
      'deployment.environment.name': 'production',
    },
    recordMetric(name, value, attributes) {
      (name === 'next_loggers.errors' ? errors : records).add(value, attributes);
    },
    onBridgeError(error, operation) {
      // Route this to an application-owned diagnostic sink. Do not feed it back
      // through the same failing OTEL transport.
      process.stderr.write(`[otel bridge:${operation}] ${String(error)}\n`);
    },
  }),
});
```

The OpenTelemetry packages shown above belong to the application, not this
library. `next-loggers` intentionally has no dependency on an OTEL SDK.

## Per-event routing and setup helper

The routing precedence is identical in all 11 SDKs:

1. an event set with `useOtel`/`use_otel` is sent to OTEL;
2. an event set with `notOtel`/`not_otel` is not sent to OTEL;
3. `resetOtel`/`reset_otel` removes that event decision;
4. otherwise the logger `otel` default applies, and defaults to `true`.

The computed form is `withOtel(enabled)` (or `with_otel`) and the resolver is
`isOtelEnabled(fallback)` (or `is_otel_enabled`). Some native SDKs retain their
existing immediate level methods and expose `event`/`event_use_otel` for this
chain; their README contains the exact language-native spelling.

Routing recognizes the built-in OTEL bridge marker and the transport name
`opentelemetry`, so a hand-written bridge can opt into the same behavior. A
record excluded from OTEL continues through every non-OTEL transport.

TypeScript can compose transport and context setup in one call:

```ts
const logger = createNodeLogger(withOpenTelemetry(
  { appName: 'my-service', transports: existingTransports },
  { logger: otelLogger, activeSpan, activeContext: () => context.active() },
));
```

`withOpenTelemetry` appends rather than replaces transports. It derives an OTEL
context provider from `activeSpan` by default, but never replaces an explicitly
supplied `contextProvider`.

## Native SDK bridge contract

Every native SDK exposes an explicit OTEL transport backed by a callback owned
by the application. The callback receives the same logical record:

```json
{
  "body": "payment failed",
  "severityText": "ERROR",
  "severityNumber": 17,
  "timestamp": "2026-01-02T03:04:05.000Z",
  "attributes": {
    "service.name": "payments",
    "next_logger.schema": "next-loggers/v1",
    "next_logger.runtime": "python",
    "log.record.uid": "record-1",
    "trace.id": "0123456789abcdef0123456789abcdef"
  }
}
```

The idiomatic entry points are `OpenTelemetryTransport` in Python, Go, Rust,
Dart, and WASM; `OtelTransport` in Java and Ruby; and `otel_transport` in
Gleam, Erlang, and Elixir. Python also exports `OtelTransport` as an alias.
Each SDK has a matching injected-sender Supabase transport. These adapters do
not take ownership of application OTEL or Supabase clients, so provider startup,
authentication, retries, flush, and shutdown remain explicit at the application
boundary.

## Choosing OpenTelemetry per call

OTEL is a transport like any other, so a record can be routed around it without
touching the OTEL SDK. The choice is made on the event, so nothing else about
the call site changes:

```ts
log.info('charged').useOtel().send();   // force delivery to OTEL transports
log.warn('noisy poll').notOtel().send(); // every other transport still gets it
log.error('failed').withOtel(exportErrors).send(); // computed at runtime
log.info('x').useOtel().resetOtel().send(); // back to the logger default
```

The logger sets the default the events fall back to. `otel: true` (the default)
delivers everything and lets `notOtel()` opt out; `otel: false` makes
OpenTelemetry opt-in, so only `useOtel()` events are exported:

```ts
const logger = createNodeLogger(withOpenTelemetry(
  { appName: 'payments' },
  { logger: logs.getLogger('payments'), activeSpan, otel: false },
));
logger.useOtel();  // or logger.notOtel() — inherited by anew() children
```

`withOpenTelemetry(loggerOptions, bridge)` is a convenience that appends the
transport and, when `activeSpan` is supplied, installs the span-correlation
context provider. It composes with any runtime factory and keeps existing
transports and an explicitly supplied `contextProvider`.

Skipping OTEL skips the whole bridge for that record: no `logger.emit`, no span
event, no `recordException`/`setStatus`, no metric increment. Correlation
fields already resolved by the context provider stay on the record, so the
trace ids remain visible to the transports that do receive it. Records are
unchanged on the wire: the choice is delivery routing, not a schema field.

A transport is recognized as an OTEL bridge when it reports it — the
`OpenTelemetryTransport` shipped here sets `otel = true`, and a hand-rolled
bridge should set the same flag (the transport name `opentelemetry` is also
accepted).

### The same control in every SDK

| SDK | Per-record choice | Logger default |
| --- | --- | --- |
| TypeScript/JavaScript | `event.useOtel()` / `.notOtel()` / `.withOtel(bool)` / `.resetOtel()` | `otel` option, `logger.useOtel()` / `.notOtel()` |
| Go | `event.UseOtel()` / `.NotOtel()` / `.WithOtel(bool)` / `.ResetOtel()` | `Options.Otel *bool`, `logger.UseOtel()` / `.NotOtel()` |
| Rust | `event.use_otel()` / `.not_otel()` / `.with_otel(bool)` / `.reset_otel()` | `Options.otel`, `logger.use_otel()` / `.not_otel()` |
| Python | `event.use_otel()` / `.not_otel()` / `.with_otel(bool)` / `.reset_otel()` | `otel=` argument, `logger.use_otel()` / `.not_otel()` |
| Gleam | `logging.use_otel` / `not_otel` / `with_otel` / `reset_otel` in the pipeline | `Options.otel` |
| Dart | `otel:` argument on `log`/`info`/`warn`/`error` | `otel:` constructor argument, `logger.useOtel()` / `.notOtel()` (derived logger) |
| Erlang | `next_loggers:log/5` with an explicit boolean | `next_loggers:use_otel/1` / `not_otel/1` (derived logger) |
| Elixir | `ORESoftware.NextLoggers.log/5` with an explicit boolean | `use_otel/1` / `not_otel/1` (derived logger) |
| Java | — | `logger.useOtel()` / `.notOtel()` (derived logger) |
| Ruby | — | `logger.use_otel` / `.not_otel` (derived logger) |
| WASM | `log_with(.., Some(bool))` | `Logger::use_otel()` / `not_otel()` |

Java, Ruby, and the WASM core deliver at the call site rather than through a
deferred event, so their routing choice is made on the logger or the call
itself. In Erlang and Elixir `otel_transport/1` returns a tagged transport
(`{otel, Fun}` / `{:otel, fun}`) so routing can skip it without inspecting the
closure; bare function transports keep working unchanged.

## Context and sampling semantics

- Node.js, Bun, and Deno can use the package's explicit `AsyncLocalStorage`
  context API from `@oresoftware/next-loggers/context`.
- Rust, Go, Java, Dart, Erlang, Elixir, Gleam, Python, and WASM SDKs use native
  task/thread/process context facilities or explicit context values.
- Browser and workerd builds use explicit request/task context; durable client
  delivery should use an authenticated Supabase ingestion endpoint.
- `createOpenTelemetryContextProvider` reads only the active-span callback the
  application supplies and maps a valid W3C tuple into `traceId`,
  `otel.span_id`, `otel.trace_flags`, `otel.trace_state`, and `otel.remote`.
- A valid **non-recording** span still contributes correlation by default.
  Sampling controls span export; it must not make correlated logs disappear.
  Pass `{ requireRecordingSpan: true }` only when that stricter behavior is
  intentionally required.
- Span events, exception recording, and status updates are performed only for a
  recording span.

The bridge rejects malformed and all-zero W3C trace/span IDs. Attribute count,
string length, primitive-array length, attribute-name length, and trace-state
length are bounded before data reaches an exporter.

## Metric-cardinality boundary

The log payload may contain record IDs, trace IDs, request IDs, users, routes,
and arbitrary fields. Those values are useful in logs but unsafe as metric
labels. `recordMetric` therefore receives only bounded dimensions:

- `service.name`;
- `next_logger.runtime`;
- `next_logger.level`;
- explicit static `metricAttributes` supplied by the application.

Known high-cardinality keys such as `trace.id`, `span.id`, `log.record.uid`, and
`next_logger.field.*` are discarded from `metricAttributes`. Applications must
still keep their remaining custom metric attributes low-cardinality.

## Failure ownership

`logger.emit()` is the primary OTEL log-delivery operation. If it fails, the
transport reports the failure to `next-loggers` in the normal transport path.
Optional bridge effects cannot replace that result:

- active-span/context lookup failures are isolated;
- trace-state serialization failures are isolated;
- span-event, exception, and status failures are isolated independently;
- metric-hook failures are isolated;
- diagnostic callback failures are swallowed to prevent recursive telemetry
  failure.

The application owns OTEL provider startup, flushing, and shutdown. A logger
transport must never shut down a shared provider unless an application-specific
wrapper explicitly grants that ownership.

## Cluster flow

The supported production flow is:

1. application logger call;
2. explicit OTEL adapter and/or authenticated Supabase client transport;
3. OTLP gRPC/HTTP to an OpenTelemetry Collector;
4. traces to Tempo, logs to Loki, metrics and span metrics to Prometheus;
5. correlation, alerts, and dashboards in Grafana.

Exporters should use bounded queues, retry limits, memory limits, and network
policies. Telemetry failure must not crash the application or silently change
business behavior.
