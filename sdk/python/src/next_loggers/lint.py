"""Detect next-loggers events that are constructed but never sent."""

from __future__ import annotations

import argparse
import ast
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator, Optional, Sequence

CODE = "NL100"
MESSAGE = "next-loggers event is only delivered when .send() is called"
LEVEL_METHODS = frozenset({"trace", "debug", "info", "log", "warn", "error", "fatal"})
TERMINAL_METHODS = frozenset({"send", "send_with_store"})
DEFAULT_LOGGER_NAMES = frozenset({"log", "logger", "ddlog"})
LOGGER_EXPORTS = frozenset(
    {
        "logger",
        "browser_logger",
        "edge_logger",
        "node_logger",
        "bun_logger",
        "deno_logger",
    }
)
FACTORY_EXPORTS = frozenset(
    {
        "create_logger",
        "create_browser_logger",
        "create_edge_logger",
        "create_node_logger",
        "create_bun_logger",
        "create_deno_logger",
    }
)
CLASS_EXPORTS = frozenset(
    {
        "Logger",
        "BaseLogger",
        "BrowserLogger",
        "EdgeLogger",
        "NodeLogger",
        "BunLogger",
        "DenoLogger",
    }
)
SKIPPED_DIRECTORIES = frozenset(
    {".git", ".vendor", ".zed", "build", "coverage", "dist", "node_modules", "target", "vendor"}
)


@dataclass(frozen=True)
class Finding:
    filename: str
    line: int
    column: int
    code: str = CODE
    message: str = MESSAGE

    def render(self) -> str:
        return f"{self.filename}:{self.line}:{self.column}: {self.code} {self.message}"


def _qualified_name(node: ast.AST) -> Optional[str]:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        owner = _qualified_name(node.value)
        return f"{owner}.{node.attr}" if owner else None
    return None


def _call_chain(node: ast.AST, methods: list[str]) -> Optional[str]:
    if isinstance(node, ast.Await):
        return _call_chain(node.value, methods)
    if isinstance(node, ast.Call):
        if isinstance(node.func, ast.Attribute):
            root = _call_chain(node.func.value, methods)
            methods.append(node.func.attr)
            return root
        return _qualified_name(node.func)
    return _qualified_name(node)


class _SendVisitor(ast.NodeVisitor):
    def __init__(self, filename: str, logger_names: Iterable[str]) -> None:
        self.filename = filename
        self.known_loggers = set(DEFAULT_LOGGER_NAMES)
        self.known_loggers.update(logger_names)
        self.known_factories: set[str] = set()
        self.known_classes: set[str] = set()
        self.findings: list[Finding] = []

    def visit_Import(self, node: ast.Import) -> None:  # noqa: N802 - ast visitor API
        for alias in node.names:
            if alias.name == "next_loggers" or alias.name.startswith("next_loggers."):
                local = alias.asname or alias.name.split(".", 1)[0]
                for name in LOGGER_EXPORTS:
                    self.known_loggers.add(f"{local}.{name}")
                for name in FACTORY_EXPORTS:
                    self.known_factories.add(f"{local}.{name}")
                for name in CLASS_EXPORTS:
                    self.known_classes.add(f"{local}.{name}")
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:  # noqa: N802 - ast visitor API
        module = node.module or ""
        if module == "next_loggers" or module.startswith("next_loggers."):
            for alias in node.names:
                local = alias.asname or alias.name
                if alias.name in LOGGER_EXPORTS:
                    self.known_loggers.add(local)
                if alias.name in FACTORY_EXPORTS:
                    self.known_factories.add(local)
                if alias.name in CLASS_EXPORTS:
                    self.known_classes.add(local)
        self.generic_visit(node)

    def _is_logger_producer(self, node: ast.AST) -> bool:
        direct = _qualified_name(node)
        if direct and direct in self.known_loggers:
            return True
        if isinstance(node, ast.Call):
            callee = _qualified_name(node.func)
            if callee and (callee in self.known_factories or callee in self.known_classes):
                return True
            if isinstance(node.func, ast.Attribute) and node.func.attr == "anew":
                owner = _qualified_name(node.func.value)
                return bool(owner and owner in self.known_loggers)
        return False

    def visit_Assign(self, node: ast.Assign) -> None:  # noqa: N802 - ast visitor API
        if self._is_logger_producer(node.value):
            for target in node.targets:
                name = _qualified_name(target)
                if name:
                    self.known_loggers.add(name)
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:  # noqa: N802 - ast visitor API
        if node.value is not None and self._is_logger_producer(node.value):
            name = _qualified_name(node.target)
            if name:
                self.known_loggers.add(name)
        self.generic_visit(node)

    def visit_Expr(self, node: ast.Expr) -> None:  # noqa: N802 - ast visitor API
        methods: list[str] = []
        root = _call_chain(node.value, methods)
        if root and root in self.known_loggers:
            level_index = next(
                (index for index, method in enumerate(methods) if method in LEVEL_METHODS),
                -1,
            )
            if level_index >= 0 and not any(
                method in TERMINAL_METHODS for method in methods[level_index + 1 :]
            ):
                self.findings.append(
                    Finding(
                        filename=self.filename,
                        line=node.lineno,
                        column=node.col_offset + 1,
                    )
                )
        self.generic_visit(node)


def lint_tree(
    tree: ast.AST,
    filename: str = "<unknown>",
    logger_names: Iterable[str] = (),
) -> list[Finding]:
    visitor = _SendVisitor(filename, logger_names)
    visitor.visit(tree)
    return visitor.findings


def lint_source(
    source: str,
    filename: str = "<unknown>",
    logger_names: Iterable[str] = (),
) -> list[Finding]:
    return lint_tree(ast.parse(source, filename=filename), filename, logger_names)


class NextLoggersSendChecker:
    """Flake8 extension exposing the NL1 missing-send diagnostic family."""

    name = "next-loggers-require-send"
    version = "0.1.0"

    def __init__(self, tree: ast.AST, filename: str = "<unknown>") -> None:
        self.tree = tree
        self.filename = filename

    def run(self) -> Iterator[tuple[int, int, str, type["NextLoggersSendChecker"]]]:
        for finding in lint_tree(self.tree, self.filename):
            yield (
                finding.line,
                finding.column - 1,
                f"{finding.code} {finding.message}",
                type(self),
            )


def _source_files(paths: Sequence[str]) -> tuple[list[Path], list[str]]:
    if not paths:
        paths = (".",)
    files: set[Path] = set()
    errors: list[str] = []
    for raw_path in paths:
        path = Path(raw_path)
        try:
            if path.is_symlink():
                continue
            if path.is_file():
                if path.suffix == ".py":
                    files.add(path)
                continue
            if not path.is_dir():
                errors.append(f"{path}: path does not exist or is not a regular file/directory")
                continue
            for candidate in path.rglob("*.py"):
                if candidate.is_symlink():
                    continue
                if any(part in SKIPPED_DIRECTORIES for part in candidate.parts):
                    continue
                files.add(candidate)
        except OSError as error:
            errors.append(f"{path}: {error}")
    return sorted(files), errors


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="next-loggers-lint",
        description="report next-loggers event chains that never call send()",
    )
    parser.add_argument("paths", nargs="*", help="Python files or directories; defaults to .")
    parser.add_argument(
        "--logger-name",
        action="append",
        default=[],
        help="extra variable or property path holding a next-loggers logger; repeatable",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    arguments = build_parser().parse_args(argv)
    files, errors = _source_files(arguments.paths)
    finding_count = 0
    for path in files:
        try:
            source = path.read_text(encoding="utf-8")
            findings = lint_source(source, str(path), arguments.logger_name)
        except (OSError, SyntaxError) as error:
            errors.append(f"{path}: {error}")
            continue
        for finding in findings:
            finding_count += 1
            print(finding.render())
    for error in errors:
        print(f"next-loggers-lint: {error}", file=__import__("sys").stderr)
    if errors:
        return 2
    return 1 if finding_count else 0


if __name__ == "__main__":
    raise SystemExit(main())
