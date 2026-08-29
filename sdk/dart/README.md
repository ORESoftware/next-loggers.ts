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

<<<<<<< HEAD
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
=======
## Per-event OpenTelemetry routing

`Logger(otel: true)` is the default. Existing immediate methods remain
unchanged; use `event` when a record needs an explicit OTEL decision:

```dart
final log = Logger(appName: 'app', otel: false, transports: transports);
await log.event(LogLevel.info, 'sampled in').useOtel().send();
await log.event(LogLevel.warn, 'OTEL excluded').notOtel().send();
await log.event(LogLevel.info, 'computed').withOtel(routeToOtel).send();
```

`resetOtel()` restores the logger default and `isOtelEnabled(fallback)`
resolves it. Logger `setOtelEnabled`, `useOtel`, and `notOtel` update the
default. Other transports still receive records excluded from OTEL.
>>>>>>> 0b2ae1c6cf9be0147ff386f3659a554c3853e666
