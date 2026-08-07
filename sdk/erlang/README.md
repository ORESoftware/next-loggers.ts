# oresoftware_next_loggers_erlang

Dependency-free Erlang implementation of the shared `next-loggers/v1`
structured logging contract. Context is process-local and restored after each
callback. OpenTelemetry and Supabase are injected transports; no global runtime
instrumentation is installed.

## OpenTelemetry on or off

`next_loggers:otel_transport/1` returns a tagged `{otel, Fun}` transport, so
routing can skip it without inspecting the closure; bare function transports
keep working unchanged.

```erlang
Quiet = next_loggers:not_otel(Logger),
next_loggers:warn(Quiet, <<"noisy poll">>, #{}),        %% other transports still receive it
next_loggers:log(Quiet, <<"ERROR">>, <<"paged">>, #{}, true).
```

`next_loggers:use_otel/1` and `not_otel/1` return a derived logger map;
`log/5` takes an explicit boolean for a single call. Records are delivered as
the call returns, so there is no unsent-event state to forget.
