"""Missing-``send()`` checker for next-loggers events.

Python has no compile step, so this module fills the same role as the
``next-loggers/require-send`` ESLint rule and the Go ``nextloggerslint``
command. It runs three ways:

* ``python -m next_loggers.lint path ...`` (or the ``next-loggers-lint``
  console script), exiting non-zero when something is reported;
* as a flake8 plugin, registered under the ``NL1`` code;
* programmatically through :func:`check_source` / :func:`check_path`.

A statement such as ``logger.info("started").add_fields(fields)`` builds an
event that is tracked as unsent and only reaches transports on ``send()``, so
it is reported. Chains ending in ``send()`` and events bound to a variable
(which this checker does not follow) are left alone.
"""

from __future__ import annotations

import argparse
import ast
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator, List, Optional, Sequence, Set, Tuple

CODE = "NL100"
MESSAGE = "next-loggers event is never sent; call .send() so it reaches transports"

LEVEL_METHODS = frozenset({"trace", "debug", "info", "log", "warn", "error", "fatal"})
SEND_METHODS = frozenset({"send", "send_with_store"})
DEFAULT_LOGGER_NAMES = frozenset({"log", "logger", "ddlog"})
LOGGER_FACTORIES = frozenset({"Logger", "create_logger", "createLogger"})
MODULE_NAMES = frozenset({"next_loggers", "oresoftware_next_loggers"})

__all__ = [
    "CODE",
    "MESSAGE",
    "Finding",
    "Plugin",
    "NextLoggersSendChecker",
    "check_path",
    "check_source",
    "lint_source",
    "main",
]


@dataclass(frozen=True)
class Finding:
    line: int
    column: int
    message: str
    filename: str = "<unknown>"
    code: str = CODE

    def __str__(self) -> str:
        return f"{self.filename}:{self.line}:{self.column + 1}: {self.code} {self.message}"

    def render(self) -> str:
        return str(self)


def _attribute_chain(node: ast.AST) -> Tuple[Optional[str], List[str]]:
    """Return the root name of a call chain plus each method called, outermost last."""
    methods: List[str] = []
    current = node
    while isinstance(current, ast.Call):
        function = current.func
        if isinstance(function, ast.Attribute):
            methods.append(function.attr)
            current = function.value
            continue
        return _dotted_name(function), list(reversed(methods))
    return _dotted_name(current), list(reversed(methods))


def _dotted_name(node: ast.AST) -> Optional[str]:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _dotted_name(node.value)
        return f"{parent}.{node.attr}" if parent else None
    return None


class _Collector(ast.NodeVisitor):
    """Finds names bound to a next-loggers logger, then flags unsent chains."""

    def __init__(self, loggers: Set[str]) -> None:
        self.loggers = loggers
        self.findings: List[Finding] = []

    # -- logger discovery -------------------------------------------------
    def visit_Assign(self, node: ast.Assign) -> None:
        if self._is_logger_factory(node.value):
            for target in node.targets:
                name = _dotted_name(target)
                if name:
                    self.loggers.add(name)
                    self.loggers.add(name.rsplit(".", 1)[-1])
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if node.value is not None and self._is_logger_factory(node.value):
            name = _dotted_name(node.target)
            if name:
                self.loggers.add(name)
        self.generic_visit(node)

    def _is_logger_factory(self, node: ast.AST) -> bool:
        if not isinstance(node, ast.Call):
            return False
        name = _dotted_name(node.func)
        if not name:
            return False
        return name.rsplit(".", 1)[-1] in LOGGER_FACTORIES

    # -- the check itself -------------------------------------------------
    def visit_Expr(self, node: ast.Expr) -> None:
        root, methods = _attribute_chain(node.value)
        if root and self._is_logger(root) and methods:
            level_index = next(
                (index for index, method in enumerate(methods) if method in LEVEL_METHODS),
                None,
            )
            if level_index is not None and not SEND_METHODS.intersection(
                methods[level_index + 1 :]
            ):
                self.findings.append(
                    Finding(node.lineno, node.col_offset, MESSAGE)
                )
        self.generic_visit(node)

    def _is_logger(self, root: str) -> bool:
        if root in self.loggers:
            return True
        return root.rsplit(".", 1)[-1] in self.loggers


def _imports_next_loggers(tree: ast.AST) -> bool:
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] in MODULE_NAMES:
                    return True
        elif isinstance(node, ast.ImportFrom):
            module = (node.module or "").split(".")[0]
            if module in MODULE_NAMES:
                return True
    return False


def check_source(
    source: str,
    filename: str = "<unknown>",
    logger_names: Iterable[str] = (),
    require_import: bool = True,
) -> List[Finding]:
    """Report events built from a next-loggers logger without a ``send()`` call.

    ``require_import`` keeps bare names such as ``logger`` from matching an
    unrelated logging library: files that never import next-loggers are skipped
    unless an explicit ``logger_names`` entry is supplied.
    """
    tree = ast.parse(source, filename=filename)
    explicit = {name for name in logger_names}
    if require_import and not explicit and not _imports_next_loggers(tree):
        return []
    loggers = set(DEFAULT_LOGGER_NAMES) | explicit
    collector = _Collector(loggers)
    collector.visit(tree)
    return [
        Finding(item.line, item.column, item.message, filename)
        for item in collector.findings
    ]


def lint_source(
    source: str,
    filename: str = "<unknown>",
    logger_names: Iterable[str] = (),
) -> List[Finding]:
    """Missing-send check that always inspects the file (explicit logger names or defaults)."""
    return check_source(source, filename, logger_names, require_import=False)


def check_path(path: Path, logger_names: Iterable[str] = ()) -> List[Finding]:
    return check_source(
        path.read_text(encoding="utf-8"), str(path), logger_names=logger_names
    )


def _python_files(targets: Sequence[str]) -> Iterator[Path]:
    for target in targets:
        path = Path(target)
        if path.is_dir():
            for child in sorted(path.rglob("*.py")):
                if any(part.startswith(".") for part in child.parts):
                    continue
                yield child
        else:
            yield path


class NextLoggersSendChecker:
    """Flake8 extension exposing the NL1 missing-send diagnostic family."""

    name = "next-loggers-require-send"
    version = "0.1.0"

    def __init__(self, tree: ast.AST, filename: str = "<unknown>") -> None:
        self.tree = tree
        self.filename = filename

    def run(self) -> Iterator[Tuple[int, int, str, type]]:
        collector = _Collector(set(DEFAULT_LOGGER_NAMES))
        collector.visit(self.tree)
        for finding in collector.findings:
            yield finding.line, finding.column, f"{CODE} {MESSAGE}", type(self)


class Plugin:
    """flake8 entry point; registered as ``NL1`` in pyproject.toml."""

    name = "next-loggers"
    version = "0.1.0"

    def __init__(self, tree: ast.AST, filename: str = "<unknown>") -> None:
        self._tree = tree
        self._filename = filename

    def run(self) -> Iterator[Tuple[int, int, str, type]]:
        if not _imports_next_loggers(self._tree):
            return
        collector = _Collector(set(DEFAULT_LOGGER_NAMES))
        collector.visit(self._tree)
        for finding in collector.findings:
            yield finding.line, finding.column, f"{CODE} {MESSAGE}", type(self)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="next-loggers-lint",
        description="Report next-loggers events that are never sent.",
    )
    parser.add_argument("paths", nargs="*", default=["."], help="files or directories")
    parser.add_argument(
        "--logger-name",
        action="append",
        default=[],
        dest="logger_names",
        help="extra variable name holding a logger (repeatable)",
    )
    arguments = parser.parse_args(argv)

    findings: List[Finding] = []
    for path in _python_files(arguments.paths or ["."]):
        try:
            findings.extend(check_path(path, arguments.logger_names))
        except (OSError, SyntaxError) as error:
            print(f"next-loggers-lint: {path}: {error}", file=sys.stderr)
            return 2
    for finding in findings:
        print(finding)
    return 1 if findings else 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
