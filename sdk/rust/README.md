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
