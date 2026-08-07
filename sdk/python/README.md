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

## OpenTelemetry on or off, per event

`OpenTelemetryTransport` carries `otel = True`, so a single record can opt in or
out without touching the OTEL SDK:

```python
log.info("charged").use_otel().send()
log.warn("noisy poll").not_otel().send()   # other transports still receive it
log.error("failed").with_otel(export_errors).send()
```

`Logger(otel=False)` makes OpenTelemetry opt-in instead of the default
export-everything; `log.use_otel()` / `log.not_otel()` flip it later, and
`event.reset_otel()` returns an event to the logger default.

## Missing `send()`

An event is only delivered by `send()`. The package ships a checker for the
mistake, usable as a command or as a flake8 plugin:

```sh
next-loggers-lint src/            # exits 1 on findings
flake8 --select NL1 src/          # NL100 diagnostics inline
```

Files that never import next-loggers are skipped, so another library's
`logger.info()` is never flagged; `--logger-name` adds your own names.
