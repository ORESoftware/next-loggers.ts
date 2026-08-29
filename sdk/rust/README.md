# oresoftware-next-loggers

Rust implementation of the repository's
[`next-loggers/v1`](../../contracts/README.md) structured logging contract.

```rust
use next_loggers::{Logger, MemoryTransport, Options};
use std::sync::Arc;

let transport = Arc::new(MemoryTransport::default());
let logger = Logger::new(Options::default().with_transport(transport.clone()));
logger.info(vec!["hello".into()]).send()?;
logger.close()?;
# Ok::<(), next_loggers::LoggerError>(())
```

`OpenTelemetryTransport` emits the shared OTEL bridge record through an
application-owned closure; `SupabaseTransport` sends the complete
`next-loggers/v1` record through an injected authenticated client. Both are
dependency-free `Transport` implementations and install no global providers.

```rust
let otel = Arc::new(next_loggers::OpenTelemetryTransport::new(|record| {
    otel_logger.emit(record)
}));
let supabase = Arc::new(next_loggers::SupabaseTransport::new(send_to_supabase));
```

<<<<<<< HEAD
## OpenTelemetry on or off, per event

`OpenTelemetryTransport` returns `true` from `Transport::is_otel`, so a single
record can opt in or out without touching the OTEL SDK:

```rust
logger.info(values).use_otel().send()?;
logger.warn(values).not_otel().send()?;   // other transports still receive it
logger.error(values).with_otel(export_errors).send()?;
```

`Options::otel` sets the default those events fall back to (`false` makes
OpenTelemetry opt-in), and `logger.use_otel()` / `logger.not_otel()` flip it
later. Any transport can join the routing by overriding `is_otel`.

## Missing `send()`

`Event` is `#[must_use]`, so dropping one is a compiler warning:

```
warning: unused `Event` that must be used
  = note: a next-loggers event is only delivered when .send() is called
```
=======
## Per-event OpenTelemetry routing

`Options::default().otel` is `true`. Set it to `false` for opt-in telemetry,
then use the chain on any `Event`:

```rust
let logger = Logger::new(Options { otel: false, ..Options::default() });
logger.info(vec![json!("sampled in")]).use_otel().send()?;
logger.warn(vec![json!("OTEL excluded")]).not_otel().send()?;
logger.info(vec![json!("computed")]).with_otel(route_to_otel).send()?;
```

`reset_otel()` restores the logger default and
`is_otel_enabled(fallback)` resolves it. Logger-level `set_otel_enabled`,
`use_otel`, and `not_otel` update the inherited default. Non-OTEL transports
always retain the record.
>>>>>>> 0b2ae1c6cf9be0147ff386f3659a554c3853e666
