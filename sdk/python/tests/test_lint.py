import ast
import unittest

from next_loggers.lint import NextLoggersSendChecker, lint_source


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
