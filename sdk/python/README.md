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
