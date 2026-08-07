# oresoftware-next-loggers-wasm

WASM-safe Rust implementation of the shared `next-loggers/v1` structured
logging contract. Context and telemetry sinks are injected explicitly; the
crate does not install global OpenTelemetry providers or patch a host runtime.

The crate is suitable for `wasm32-unknown-unknown` and native conformance tests.

## OpenTelemetry on or off, per call

`OpenTelemetryTransport` returns `true` from `Transport::is_otel`, so a record
can skip it without touching the OTEL SDK:

```rust
logger.log_with(LogLevel::Warn, "noisy poll", None, fields, Some(false))?;
```

`Logger::use_otel()` / `not_otel()` set the default for calls that pass `None`.
This core delivers inside `log`, so there is no deferred event to forget to
send.
