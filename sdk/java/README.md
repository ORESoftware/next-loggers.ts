# io.github.oresoftware:next-loggers

Java 17 implementation of the shared `next-loggers/v1` structured logging
contract. Context is scoped with `ThreadLocal` and restored after each callback.
OpenTelemetry and Supabase are explicit, application-owned transports; the
library does not install agents, providers, instrumentation, or runtime patches.

Maven coordinates:

```xml
<dependency>
  <groupId>io.github.oresoftware</groupId>
  <artifactId>next-loggers</artifactId>
  <version>0.1.0</version>
</dependency>
```

## OpenTelemetry on or off

`OtelTransport` overrides `isOtel()` to `true`, so records can be routed around
it without touching the OTEL SDK. `useOtel()` and `notOtel()` return a derived
logger sharing the same transports:

```java
logger.notOtel().warn("noisy poll", Map.of());  // other transports still receive it
logger.useOtel().error("paged", Map.of());
```

The `Logger(appName, name, runtime, fields, transports, otel)` constructor sets
the default. Records are delivered as the call returns, so there is no
unsent-event state to forget.
