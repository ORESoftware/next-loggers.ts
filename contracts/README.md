# Polyglot logger contract

Every `ores.otel.log` SDK emits the stable `next-loggers/v1` record defined by
[`log-record.schema.json`](log-record.schema.json). The wire discriminator is
unchanged during the repository migration, while the schema ID is a
repository-independent URN.

The public API is defined separately by
[`logger-api.schema.json`](logger-api.schema.json) and
[`logger-api.json`](logger-api.json). That contract covers all current SDK
families and makes logger, event, transport, context, and explicit OpenTelemetry
semantics machine-checkable instead of relying on prose or one implementation.

## Required interfaces

`Logger` exposes `trace`, `debug`, `info`, `warn`, `error`, and `fatal`. Each
method creates an unsent `LogEvent`. The event supports fields, users, traces,
routine IDs, tags, context, metadata, normalized errors, and an idempotent
`send`.

`Transport` accepts one complete `LogRecord`. A language may model lifecycle
methods as optional interfaces or default trait methods, but the shared
operations are:

- `write(record)` delivers a record.
- `flush()` drains pending writes.
- `flush_on_exit(records)` gets the records active during shutdown.
- `close()` releases transport resources.

`Logger.flush()` drains writes already sent. `Logger.flush_on_exit()` first
sends every unsent event and then invokes transport shutdown hooks.
`Logger.close()` performs the shutdown flush before closing transports.

The minimum enabled level defaults to `INFO`, matching the TypeScript
`maxLevel` behavior. `send(false)` may write locally but must not invoke remote
transports.

## Context and OpenTelemetry

Every implementation declares either context-local storage or explicit context
propagation. Context is scoped to the current request, task, thread, isolate,
process, or goroutine; it is never stored in unbounded global mutable state.

OpenTelemetry adapters are explicit and application-owned. SDKs extract and
inject context through explicit carriers, correlate valid trace/span IDs, do
not shut down providers they do not own, and never patch console, HTTP, fetch,
module loading, or runtime internals.

## Conformance

Each SDK creates the deterministic record in
[`fixtures/conformance-record.json`](fixtures/conformance-record.json) by
injecting the ID generator and clock. Tests compare decoded JSON values so
object key order is irrelevant while array order remains part of the contract.

Run the dependency-free validator with:

```bash
node scripts/validate-contracts.mjs
```

It validates both JSON Schemas, all 39 canonical operations, every SDK binding,
and the isolated test-fleet declaration.

Language packages live under `sdk/`:

| SDK binding | Language | Package/module |
| --- | --- | --- |
| `nodejs` | TypeScript/JavaScript | `@oresoftware/next-loggers` |
| `python` | Python | `oresoftware-next-loggers` / `next_loggers` |
| `go` | Go | `github.com/ores-otel/ores.otel.log/sdk/go` after cutover |
| `rust` | Rust | `oresoftware-next-loggers` / `next_loggers` |
| `gleam` | Gleam | `oresoftware_next_loggers` |
| `java` | Java | `io.github.oresoftware:next-loggers` |
| `dart` | Dart/Flutter | `oresoftware_next_loggers` |
| `ruby` | Ruby | `oresoftware-next-loggers` / `ORESoftware::NextLoggers` |
| `erlang` | Erlang | `oresoftware_next_loggers_erlang` / `next_loggers` |
| `elixir` | Elixir | `oresoftware_next_loggers` / `NextLoggers` |
| `wasm` | Rust/WebAssembly | `oresoftware-next-loggers-wasm` / `next_loggers_wasm` |

All packages expose the same transport boundary: a transport receives one
complete `next-loggers/v1` record and owns delivery. Each native SDK includes
an explicit OpenTelemetry adapter and an authenticated-sender Supabase adapter;
neither adapter installs global instrumentation.

## Isolated old/new consumer fleet

[`test-org-matrix.schema.json`](test-org-matrix.schema.json) and
[`test-org-matrix.json`](test-org-matrix.json) declare 22 private repositories
in `ores-otel-test`: a legacy and canonical consumer for each of the 11 SDK
bindings. Live application is blocked until both source repositories have exact
commit refs. Production writes are forbidden by contract.

See [`../docs/REPOSITORY-MIGRATION.md`](../docs/REPOSITORY-MIGRATION.md) for the
history-preserving cutover and promotion gates.
