import asyncio
import concurrent.futures
import unittest

from next_loggers import Logger, MemoryTransport
from next_loggers.context import (
    LogContext,
    apply_log_context,
    capture_log_context_callable,
    get_log_context,
    log_context,
    merge_log_context,
    run_with_log_context_async,
    with_span,
)


class FakeSpan:
    def __init__(self, context, recording):
        self.context = context
        self.recording = recording
        self.recorded = None
        self.status = None
        self.ended = 0

    def log_context(self):
        return self.context

    def is_recording(self):
        return self.recording

    def record_exception(self, error):
        self.recorded = error

    def set_status(self, code, description=""):
        self.status = (code, description)

    def end(self):
        self.ended += 1


class FakeTracer:
    def __init__(self, span):
        self.span = span

    def start_span(self, _name, _attributes):
        return self.span


class ContextTests(unittest.TestCase):
    def test_merge_apply_and_restore(self):
        outer = LogContext(
            logged_in_user={"id": "user-1", "role": "viewer"},
            users=({"id": "outer"},),
            fields={"request": "outer", "keep": True},
            trace_id="trace-outer",
            trace_ids=("trace-outer",),
            tags=("outer",),
        )
        inner = LogContext(
            logged_in_user={"role": "admin"},
            users=({"id": "inner"},),
            fields={"request": "inner"},
            trace_id="trace-inner",
            trace_ids=("trace-outer", "trace-inner"),
            span_id="span-1",
            trace_flags=1,
            trace_state="vendor=value",
            routine_id="checkout",
            tags=("inner", "outer"),
            baggage={"tenant": "one"},
        )
        merged = merge_log_context(outer, inner)
        self.assertEqual(merged.logged_in_user, {"id": "user-1", "role": "admin"})
        self.assertEqual(len(merged.users), 2)
        self.assertEqual(merged.fields, {"request": "inner", "keep": True})
        self.assertEqual(merged.trace_ids, ("trace-outer", "trace-inner"))
        self.assertEqual(merged.tags, ("outer", "inner"))

        transport = MemoryTransport()
        logger = Logger(app_name="python-context", transports=[transport], console=False)
        with log_context(outer):
            with log_context(inner):
                apply_log_context(logger.info("inside")).send()
                self.assertEqual(get_log_context().trace_id, "trace-inner")
            self.assertEqual(get_log_context().trace_id, "trace-outer")
        self.assertEqual(get_log_context().trace_id, "")

        record = transport.records[0]
        self.assertEqual(record.trace_id, "trace-inner")
        self.assertEqual(record.fields["otel.span_id"], "span-1")
        self.assertEqual(record.logged_in_user["role"], "admin")
        self.assertEqual(len(record.users), 2)
        self.assertEqual(record.routine_id, "checkout")

    def test_executor_capture_is_explicit(self):
        with log_context(LogContext(trace_id="trace-thread")):
            callback = capture_log_context_callable(lambda: get_log_context().trace_id)
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            self.assertEqual(executor.submit(callback).result(), "trace-thread")
            self.assertEqual(executor.submit(lambda: get_log_context().trace_id).result(), "")

    def test_sampled_out_span_keeps_correlation_without_mutation(self):
        transport = MemoryTransport()
        logger = Logger(app_name="python-span", max_level="DEBUG", transports=[transport], console=False)
        span = FakeSpan(LogContext(trace_id="0123456789abcdef0123456789abcdef", span_id="0123456789abcdef"), False)
        result = with_span(logger, FakeTracer(span), "sampled-out", lambda _span: get_log_context().trace_id)
        self.assertEqual(result, span.context.trace_id)
        self.assertIsNone(span.recorded)
        self.assertIsNone(span.status)
        self.assertEqual(span.ended, 1)
        self.assertEqual([record.trace_id for record in transport.records], [span.context.trace_id, span.context.trace_id])

    def test_recording_span_records_error_and_reraises_identity(self):
        logger = Logger(app_name="python-span", transports=[MemoryTransport()], console=False)
        span = FakeSpan(LogContext(trace_id="trace-error", span_id="span-error"), True)
        expected = RuntimeError("boom")
        with self.assertRaises(RuntimeError) as caught:
            with_span(logger, FakeTracer(span), "failure", lambda _span: (_ for _ in ()).throw(expected))
        self.assertIs(caught.exception, expected)
        self.assertIs(span.recorded, expected)
        self.assertEqual(span.status, (2, "boom"))
        self.assertEqual(span.ended, 1)


class AsyncContextTests(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_task_isolation_and_restoration(self):
        async def worker(index):
            expected = f"trace-{index}"
            async def inside():
                await asyncio.sleep(0)
                return get_log_context().trace_id, get_log_context().fields["index"]
            return await run_with_log_context_async(
                LogContext(trace_id=expected, fields={"index": index}), inside
            )

        results = await asyncio.gather(*(worker(index) for index in range(64)))
        self.assertEqual(results, [(f"trace-{index}", index) for index in range(64)])
        self.assertEqual(get_log_context().trace_id, "")


if __name__ == "__main__":
    unittest.main()
