# Rust HTTP/HTTPS graceful shutdown

The canonical Rust shutdown policy is split deliberately:

- `sdk/rust/src/shutdown.rs` owns the runtime-neutral lifecycle state machine and structured lifecycle logging.
- `sdk/rust/src/http_shutdown.rs` owns HTTP/HTTPS admission shutoff and the bounded drain deadline.
- `sdk/rust-context/src/lib.rs` owns runtime adapters such as TTY detection and Tokio SIGINT/SIGTERM/stdin-EOF observation.
- the application owns its concrete listener, Axum/Hyper/Actix server handle, task cancellation, force-close hooks, and OpenTelemetry/logger flush.

## Default policy

1. The process runs normally and accepts HTTP requests.
2. The first SIGINT/SIGTERM starts graceful drain.
3. Admission closes immediately. New HTTP requests are rejected with `429 Too Many Requests`, `Retry-After` set to the remaining grace interval, and HTTP/1.x adapters should add `Connection: close`.
4. Existing requests are allowed to finish for at most five seconds.
5. When the five-second deadline expires, the runtime force-closes remaining connections/tasks.
6. Logs/traces are flushed after graceful/forced drain and before the lifecycle is marked stopped.

For interactive terminals, SIGINT starts the same drain but also prints a warning telling the operator that Ctrl-D will force completion. Repeated SIGINT does not bypass the grace period. Ctrl-D/stdin EOF forces completion immediately. If Ctrl-D is never entered, the five-second deadline still forces shutdown.

## Adapter sketch

```rust
use next_loggers::http_shutdown::{
    HttpAdmission, HttpShutdownController,
};
use next_loggers::shutdown::ShutdownTrigger;
use std::sync::Arc;

let shutdown = Arc::new(HttpShutdownController::default());

// HTTP middleware, before expensive auth/body work:
match shutdown.admission() {
    HttpAdmission::Accept => {
        // continue request
    }
    HttpAdmission::Reject(rejection) => {
        // respond immediately with rejection.status_code (429),
        // Retry-After: rejection.retry_after_seconds,
        // and Connection: close for HTTP/1.x.
    }
}

// Signal adapter:
let outcome = shutdown.handle_signal(ShutdownTrigger::SigInt, true);
if let Some(warning) = outcome.terminal_warning {
    eprintln!("{warning}");
}

// Start the framework's graceful listener shutdown as soon as Drain is returned.
// Race the in-flight drain against shutdown.gate().grace_period(). On timeout:
shutdown.force_if_deadline_expired(true);
// abort remaining tasks/connections, flush application-owned OTEL/logger providers,
// then call shutdown.mark_stopped(...).
```

The admission gate belongs at the earliest reusable HTTP middleware boundary. It should run before authentication, request-body parsing, rate limiting that consumes external capacity, database work, or RPC fan-out, so a draining process rejects new work cheaply.
