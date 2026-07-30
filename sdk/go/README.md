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
