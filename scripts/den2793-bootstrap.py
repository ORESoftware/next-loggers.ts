#!/usr/bin/env python3
"""One-shot, fail-closed reconstruction for DEN-2793.

This script contains no credentials and deletes itself after producing the
reviewable source diff. Every mutation checks an exact upstream marker first,
so drift causes a hard failure rather than a guessed rewrite.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    source = target.read_text(encoding="utf-8")
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one exact patch marker, found {count}")
    target.write_text(source.replace(old, new, 1), encoding="utf-8")


lint_command = """  {
    name: 'lint',
    summary: 'Report next-loggers event chains that never call send().',
    positionals: ['paths...'],
    flags: [
      {
        key: 'lint_logger_names',
        env: 'NEXT_LOGGER_CLI_LINT_LOGGER_NAMES',
        aliases: ['logger-name'],
        type: 'array',
        help: 'Extra variable or property path holding a next-loggers logger; repeatable.',
      },
      {
        key: 'lint_all',
        env: 'NEXT_LOGGER_CLI_LINT_ALL',
        aliases: ['all'],
        type: 'bool',
        default: 'false',
        help: 'Check every supported source file, including files without a next-loggers import.',
      },
    ],
  },
"""
replace_once(
    'src/cli/spec.ts',
    "  {\n    name: 'flags',",
    lint_command + "  {\n    name: 'flags',",
)

replace_once(
    'src/cli/main.ts',
    """    case 'flags':
      result = await (await import('./commands/flags.js')).runFlags(ctx);
      break;
""",
    """    case 'lint':
      result = await (await import('./commands/lint.js')).runLint(ctx);
      break;
    case 'flags':
      result = await (await import('./commands/flags.js')).runFlags(ctx);
      break;
""",
)

replace_once(
    'src/cli/node-builtins.d.ts',
    """declare module 'node:fs/promises' {
  export function readFile(path: string | URL, encoding: 'utf8'): Promise<string>;
  export function access(path: string | URL): Promise<void>;
}
""",
    """declare module 'node:fs/promises' {
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }
  export interface Stats {
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }
  export function readFile(path: string | URL, encoding: 'utf8'): Promise<string>;
  export function access(path: string | URL): Promise<void>;
  export function lstat(path: string | URL): Promise<Stats>;
  export function readdir(
    path: string | URL,
    options: { withFileTypes: true },
  ): Promise<Dirent[]>;
}
""",
)
replace_once(
    'src/cli/node-builtins.d.ts',
    """  export function resolve(...parts: string[]): string;
}
""",
    """  export function resolve(...parts: string[]): string;
  export function extname(path: string): string;
  export function relative(from: string, to: string): string;
}
""",
)

lint_toml = """[commands.lint]
help = "Report next-loggers event chains that never call send()."

[commands.lint.flags.lint_logger_names]
env = "NEXT_LOGGER_CLI_LINT_LOGGER_NAMES"
aliases = ["logger-name"]
type = "array"
help = "Extra variable or property path holding a next-loggers logger; repeatable."

[commands.lint.flags.lint_all]
env = "NEXT_LOGGER_CLI_LINT_ALL"
aliases = ["all"]
type = "bool"
default = "false"
help = "Check every supported source file, including files without a next-loggers import."

"""
replace_once('.cli-flags.toml', '[commands.flags]\n', lint_toml + '[commands.flags]\n')

replace_once(
    'sdk/python/pyproject.toml',
    '[project.urls]\n',
    """[project.scripts]
next-loggers-lint = "next_loggers.lint:main"

[project.entry-points."flake8.extension"]
NL1 = "next_loggers.lint:NextLoggersSendChecker"

[project.urls]
""",
)

replace_once(
    'sdk/rust/src/core.rs',
    '#[derive(Clone)]\npub struct Event {',
    '#[must_use = "a next-loggers event is only delivered when .send() is called"]\n#[derive(Clone)]\npub struct Event {',
)

replace_once(
    'docs/CLI.md',
    '| `flags` | Print the command/flag/environment contract or compare `.cli-flags.toml` with the compiled specification. |\n',
    '| `lint` | Report standalone next-loggers event chains that never call `.send()`. |\n'
    '| `flags` | Print the command/flag/environment contract or compare `.cli-flags.toml` with the compiled specification. |\n',
)
replace_once(
    'docs/CLI.md',
    '## Release-package catalog\n',
    """## Missing-send diagnostics

`next-loggers lint [paths...]` recursively checks JavaScript and TypeScript source files for standalone event chains that never terminate with `.send()` or `.sendWithStore()`. By default it checks files importing `@oresoftware/next-loggers`; `--all` checks every supported source file, and repeatable `--logger-name` values add project-specific logger variables or property paths.

```sh
next-loggers lint src test
next-loggers lint --logger-name audit --logger-name request.log services
NEXT_LOGGER_CLI_LINT_ALL=true next-loggers lint .
```

Findings use the stable `NL100` code and return exit status 1. Unreadable or invalid paths return 2. The equivalent native analyzers are `go run github.com/ORESoftware/next-loggers.ts/sdk/go/cmd/nextloggerslint@latest ./...` and the Python `next-loggers-lint` console script / flake8 `NL1` extension.

## Release-package catalog
""",
)

replace_once(
    'README.md',
    '## Shutdown delivery\n',
    """## Detect events that never send

An event is delivered only after its terminal send call. The repository ships the same missing-send diagnostic in every primary development path:

```sh
next-loggers lint src test
go run github.com/ORESoftware/next-loggers.ts/sdk/go/cmd/nextloggerslint@latest ./...
next-loggers-lint .
```

The JavaScript/TypeScript CLI uses the flags-2-env variables `NEXT_LOGGER_CLI_LINT_LOGGER_NAMES` and `NEXT_LOGGER_CLI_LINT_ALL`; the existing `next-loggers/require-send` ESLint rule remains the editor path. Python also exposes a flake8 `NL1` extension, and Rust marks `Event` as `#[must_use]`, so an ignored event is visible to the compiler.

## Shutdown delivery
""",
)


for transient in (
    ROOT / 'scripts/den2793-bootstrap.py',
    ROOT / '.github/workflows/den-2793-bootstrap.yml',
):
    transient.unlink(missing_ok=False)

print("DEN-2793 reconstruction patched 8 tracked files; source files were pre-staged on the branch")
