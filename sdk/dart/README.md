# oresoftware_next_loggers

Dart and Flutter implementation of the shared `next-loggers/v1` structured
logging contract. It uses Dart Zones for scoped context and accepts explicit,
application-owned OpenTelemetry and Supabase transports. It does not register
or monkey-patch global runtime instrumentation.

```dart
import 'package:oresoftware_next_loggers/oresoftware_next_loggers.dart';

final logger = Logger(appName: 'payments');
final record = await withLogContext(
  const LogContext(traceId: 'trace-1', spanId: 'span-1'),
  () => logger.info('charged order', fields: const {'orderId': 'order-42'}),
);
```

## OpenTelemetry on or off, per call

`OpenTelemetryTransport` implements `OtelBridgeTransport`, so a record can skip
it without touching the OTEL SDK:

```dart
await logger.info('charged', otel: true);
await logger.warn('noisy poll', otel: false);  // other transports still receive it
await logger.notOtel().error('local only');    // derived logger
```

The `otel:` constructor argument sets the default; `useOtel()` / `notOtel()`
return a derived logger. Delivery happens at the call, so there is no unsent
event — but the call returns a `Future`, so enable the analyzer's
`unawaited_futures` lint to catch one that is never awaited.
