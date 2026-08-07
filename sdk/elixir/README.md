# oresoftware_next_loggers_elixir

Dependency-free Elixir implementation of the shared `next-loggers/v1`
structured logging contract. Context is scoped to the current BEAM process and
restored after each callback. OpenTelemetry and Supabase are injected
transports; the package installs no global instrumentation.

## OpenTelemetry on or off

`otel_transport/1` returns a tagged `{:otel, fun}` transport, so routing can
skip it without inspecting the closure; bare function transports keep working
unchanged.

```elixir
quiet = ORESoftware.NextLoggers.not_otel(logger)
ORESoftware.NextLoggers.warn(quiet, "noisy poll")           # other transports still receive it
ORESoftware.NextLoggers.log(quiet, "ERROR", "paged", %{}, true)
```

`use_otel/1` and `not_otel/1` return a derived logger map, `new/2` accepts
`otel: false` to make OpenTelemetry opt-in, and `log/5` takes an explicit
boolean for a single call.
