# next-loggers for Go

Native Go implementation of the shared `next-loggers/v1` contract.

```go
package main

import (
	nextloggers "github.com/ORESoftware/next-loggers.ts/sdk/go"
)

func main() {
	log := nextloggers.NewLogger(nextloggers.Options{
		AppName:    "payments",
		Runtime:    "go",
		Transports: []nextloggers.Transport{&nextloggers.MemoryTransport{}},
	})

	_ = log.Info("charged order").
		AddFields(map[string]any{"orderId": "order-42"}).
		Send()
	_ = log.Close()
}
```

`Logger`, `Event`, `LogRecord`, `Options`, `Transport`, and lifecycle
interfaces are public. Go applications can extend behavior through embedding
and transport composition.

Use `NewOpenTelemetryTransport` with an application-owned OTEL emitter and
`NewSupabaseTransport` with an authenticated sender. Both satisfy `Transport`,
have no SDK dependency, and never install global instrumentation:

```go
otel := nextloggers.NewOpenTelemetryTransport(func(record nextloggers.OpenTelemetryLogRecord) error {
	return otelLogger.Emit(record)
})
supabase := nextloggers.NewSupabaseTransport(sendToSupabase)
```

<<<<<<< HEAD
## OpenTelemetry on or off, per event

`OpenTelemetryTransport` reports `IsOtel() == true`, so a single record can opt
in or out without touching the OTEL SDK:

```go
logger.Info("charged").UseOtel().Send()
logger.Warn("noisy poll").NotOtel().Send()   // other transports still receive it
logger.Error("failed").WithOtel(exportErrors).Send()
```

`Options.Otel` sets the default those events fall back to: leave it `nil` for
"export everything" or point it at `false` to make OpenTelemetry opt-in.
`logger.UseOtel()` / `logger.NotOtel()` flip it later. Any transport can join
the routing by implementing `IsOtel() bool`.

## Missing `Send()`

`Event` is only delivered by `Send()`. Run the bundled checker in CI:

```sh
go run github.com/ORESoftware/next-loggers.ts/sdk/go/cmd/nextloggerslint ./...
```

It reports `file:line:col` for every statement that builds an event and drops
it, and exits 1 when it finds one. Only files importing this SDK are inspected;
`-logger name` adds application-specific logger variables.
=======
## Per-event OpenTelemetry routing

OpenTelemetry is enabled by default. Use `Options.Otel` when the default must
be explicit (a pointer distinguishes `false` from an omitted option), and use
the event chain for one-record overrides:

```go
disabled := false
log := nextloggers.NewLogger(nextloggers.Options{
	Otel: &disabled,
	Transports: []nextloggers.Transport{otel, supabase},
})
_ = log.Info("sampled in").UseOtel().Send()
_ = log.Warn("OTEL excluded").NotOtel().Send()
_ = log.Info("computed").WithOtel(routeToOtel).Send()
```

`ResetOtel` restores the logger default and `IsOtelEnabled(fallback)` resolves
it. `SetOtelEnabled`, `UseOtel`, and `NotOtel` update the logger default. OTEL
routing never suppresses non-OTEL transports.
>>>>>>> 0b2ae1c6cf9be0147ff386f3659a554c3853e666
