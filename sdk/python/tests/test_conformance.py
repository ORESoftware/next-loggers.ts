import json
import unittest
from pathlib import Path

from next_loggers import LogEvent, LogLevel, Logger, MemoryTransport


ROOT = Path(__file__).resolve().parents[3]
FIXTURE = json.loads(
    (ROOT / "contracts" / "fixtures" / "conformance-record.json").read_text()
)


class AuditEvent(LogEvent):
    def with_actor(self, actor: str) -> "AuditEvent":
        self.add_fields({"actor": actor})
        return self


class AuditLogger(Logger):
    def create_event(self, level: LogLevel, values):
        return AuditEvent(self, level, values)


class LoggerContractTests(unittest.TestCase):
    def test_matches_shared_record_fixture(self):
        transport = MemoryTransport()
        logger = Logger(
            app_name="payments",
            name="audit",
            runtime="contract-test",
            fields={"environment": "test"},
            transports=[transport],
            console=False,
            id_factory=lambda: "contract-record-1",
            clock=lambda: "2026-01-02T03:04:05.000Z",
        )

        event = (
            logger.error("payment failed", 42)
            .add_fields({"orderId": "order-42"})
            .add_logged_in_user_id("user-1")
            .add_user_info({"id": "user-2"})
            .add_trace("trace-1")
            .add_trace("trace-2")
            .add_routine_id("charge-card")
            .add_tags("payments", "critical", "payments")
            .add_context({"attempt": 2})
            .add_meta({"source": "fixture"})
        )
        first = event.send()
        second = event.send()

        self.assertIs(first, second)
        self.assertEqual(len(transport.records), 1)
        self.assertEqual(transport.records[0].to_dict(), FIXTURE)
        logger.close()

    def test_shutdown_recovers_unsent_events_and_closes_transports(self):
        transport = MemoryTransport()
        logger = Logger(transports=[transport], console=False)
        logger.warn("created but not explicitly sent")
        logger.close()

        self.assertEqual(len(transport.records), 1)
        self.assertEqual(transport.records[0].message, "created but not explicitly sent")
        self.assertEqual(len(transport.exit_records), 1)
        self.assertTrue(transport.closed)

    def test_levels_send_false_and_extensible_classes(self):
        transport = MemoryTransport()
        logger = AuditLogger(
            max_level="WARN",
            transports=[transport],
            console=False,
        )
        logger.info("filtered").send()
        logger.error("kept").with_actor("user-9").send(False)
        logger.fatal("stored").with_actor("user-9").send()

        self.assertEqual(len(transport.records), 1)
        self.assertEqual(transport.records[0].level, LogLevel.FATAL)
        self.assertEqual(transport.records[0].fields["actor"], "user-9")


if __name__ == "__main__":
    unittest.main()
