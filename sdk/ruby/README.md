# oresoftware-next-loggers

Ruby implementation of the shared `next-loggers/v1` structured logging contract.
It uses scoped thread-local context and never patches Ruby, OpenTelemetry, HTTP,
or application globals. Applications own the OTEL and Supabase sinks.

```ruby
require "oresoftware/next_loggers"

logger = ORESoftware::NextLoggers::Logger.new(app_name: "payments")
record = ORESoftware::NextLoggers.with_context(trace_id: "trace-1") do
  logger.info("charged order", orderId: "order-42")
end
```

## OpenTelemetry on or off

`OtelTransport` answers `otel? == true`, so records can be routed around it
without touching the OTEL SDK. Ruby level methods take a bare fields hash, so
the choice is made on the logger, which returns a derived instance:

```ruby
logger.not_otel.warn("noisy poll", region: "us-east-1")  # other transports still receive it
logger.use_otel.error("paged")
```

Pass `otel: false` to `Logger.new` to make OpenTelemetry opt-in. Records are
delivered as the call returns, so there is no unsent-event state to forget.
