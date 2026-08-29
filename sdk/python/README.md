# oresoftware-next-loggers

Python implementation of the repository's
[`next-loggers/v1`](../../contracts/README.md) structured logging contract.

```python
from next_loggers import Logger, MemoryTransport

transport = MemoryTransport()
log = Logger(app_name="payments", transports=[transport])
log.error("payment failed").add_tags("payments").send()
log.close()
```

`OpenTelemetryTransport` (`OtelTransport` is an alias) converts each record to
the shared OTEL bridge shape and calls an application-owned emitter.
`SupabaseTransport` calls an injected authenticated sender with the complete
`next-loggers/v1` dictionary. Neither adapter installs a global client.

```python
from next_loggers import Logger, OpenTelemetryTransport, SupabaseTransport

log = Logger(
    app_name="payments",
    transports=[
        OpenTelemetryTransport(otel_logger.emit),
        SupabaseTransport(send_to_supabase),
    ],
)
```

## Per-event OpenTelemetry routing

`otel=True` is the logger default. Set `otel=False` to make OTEL opt-in, then
override individual events without suppressing Memory, Supabase, or other
transports:

```python
log = Logger(otel=False, transports=[otel_transport, supabase_transport])
log.info("sampled in").use_otel().send()
log.warn("OTEL excluded").not_otel().send()
log.info("computed").with_otel(route_to_otel).send()
```

`reset_otel()` returns an event to the logger default, while
`is_otel_enabled(fallback)` exposes the resolved decision. Logger-level
`set_otel_enabled()`, `use_otel()`, and `not_otel()` update the default.

## Missing `send()`

An event is only delivered by `send()`. The package ships a checker for the
mistake, usable as a command or as a flake8 plugin:

```sh
next-loggers-lint src/            # exits 1 on findings
flake8 --select NL1 src/          # NL100 diagnostics inline
```

Files that never import next-loggers are skipped, so another library's
`logger.info()` is never flagged; `--logger-name` adds your own names.
