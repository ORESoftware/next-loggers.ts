# Polyglot logger contract

Every next-loggers SDK emits the `next-loggers/v1` record defined by
[`log-record.schema.json`](log-record.schema.json). Field names and level values
are wire-compatible across languages; public method names follow each
language's naming conventions.

## Required interfaces

`Logger` exposes `trace`, `debug`, `info`, `warn`, `error`, and `fatal`. Each
method creates an unsent `LogEvent`. The event supports fields, users, traces,
routine IDs, tags, context, and metadata, then an idempotent `send`.

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

## Conformance

Each SDK creates the deterministic record in
[`fixtures/conformance-record.json`](fixtures/conformance-record.json) by
injecting the ID generator and clock. Tests compare decoded JSON values so
object key order is irrelevant while array order remains part of the contract.

Language packages live under `sdk/`:

| Language | Package/module |
| --- | --- |
| TypeScript/JavaScript | `@oresoftware/next-loggers` |
| Python | `oresoftware-next-loggers` / `next_loggers` |
| Go | `github.com/ORESoftware/next-loggers.ts/sdk/go` |
| Rust | `oresoftware-next-loggers` / `next_loggers` |
| Gleam | `oresoftware_next_loggers` |
