import unittest

from next_loggers.lint import CODE, NextLoggersSendChecker, Plugin, check_source, lint_source
import ast


SOURCE = '''
from next_loggers import Logger

logger = Logger(app_name="checkout")

logger.info("delivered").send()
logger.warn("delivered").not_otel().send()
logger.info("dropped")
logger.error("dropped").add_fields({"a": 1}).use_otel()
event = logger.info("assigned")
event.send()
'''


class LintTest(unittest.TestCase):
    def test_reports_only_chains_without_send(self):
        findings = check_source(SOURCE, "sample.py")
        self.assertEqual([finding.line for finding in findings], [8, 9])
        self.assertIn("call .send()", findings[0].message)
        self.assertTrue(str(findings[0]).startswith("sample.py:8:1: " + CODE))

    def test_files_that_do_not_import_next_loggers_are_skipped(self):
        source = 'import logging\nlogger = logging.getLogger("x")\nlogger.info("fine")\n'
        self.assertEqual(check_source(source, "other.py"), [])
        self.assertEqual(
            len(check_source(source, "other.py", logger_names=["logger"])), 1
        )

    def test_flake8_plugin_yields_positions(self):
        results = list(Plugin(ast.parse(SOURCE), "sample.py").run())
        self.assertEqual([line for line, _, _, _ in results], [8, 9])
        self.assertTrue(results[0][2].startswith(CODE))


class MissingSendLintTests(unittest.TestCase):
    def test_reports_standalone_unsent_chain(self) -> None:
        source = """
from next_loggers import Logger
logger = Logger(app_name="test")
logger.info("started").with_fields({"phase": "boot"})
"""
        findings = lint_source(source, "sample.py")
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].code, "NL100")
        self.assertEqual(findings[0].line, 4)

    def test_accepts_terminal_send_methods(self) -> None:
        source = """
from next_loggers import Logger
logger = Logger(app_name="test")
logger.info("sent").send()
logger.warn("stored").send_with_store()
"""
        self.assertEqual(lint_source(source, "sample.py"), [])

    def test_ignores_assigned_event(self) -> None:
        source = """
from next_loggers import Logger
logger = Logger(app_name="test")
event = logger.info("later")
"""
        self.assertEqual(lint_source(source, "sample.py"), [])

    def test_supports_explicit_logger_name(self) -> None:
        findings = lint_source('audit.error("missing")\n', "sample.py", ["audit"])
        self.assertEqual(len(findings), 1)

    def test_flake8_plugin_uses_nl1_family(self) -> None:
        tree = ast.parse('logger.info("missing")\n')
        diagnostics = list(NextLoggersSendChecker(tree, "sample.py").run())
        self.assertEqual(len(diagnostics), 1)
        self.assertTrue(diagnostics[0][2].startswith("NL100 "))


if __name__ == "__main__":
    unittest.main()
