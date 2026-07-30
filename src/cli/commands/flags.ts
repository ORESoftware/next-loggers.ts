import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { COMMANDS, GLOBAL_FLAGS } from '../spec.js';
import { compareSource } from '../drift.js';
import type { CommandContext, CommandResult } from '../context.js';

export async function runFlags(ctx: CommandContext): Promise<CommandResult> {
  if (ctx.bool('check')) {
    const path = join(ctx.packageRoot, '.cli-flags.toml');
    let source: string;
    try {
      source = await readFile(path, 'utf8');
    } catch (error) {
      ctx.printErr(`next-loggers flags: cannot read ${path} — ${String(error)}`);
      return { exitCode: 1 };
    }

    let report;
    try {
      report = compareSource(source);
    } catch (error) {
      ctx.printErr(`next-loggers flags: ${path} is invalid — ${String(error)}`);
      return { exitCode: 1 };
    }

    if (ctx.json) {
      ctx.print(JSON.stringify({ command: 'flags', check: true, ...report }));
      return { exitCode: report.ok ? 0 : 1 };
    }
    if (report.ok) {
      ctx.print('next-loggers flags: .cli-flags.toml matches the compiled spec');
      return { exitCode: 0 };
    }
    ctx.printErr('next-loggers flags: .cli-flags.toml has drifted');
    const section = (label: string, items: string[]): void => {
      for (const item of items) {
        ctx.printErr(`  ${label}: ${item}`);
      }
    };
    section('missing', report.missing);
    section('stale', report.stale);
    section('mismatch', report.mismatched);
    section('missing command', report.missingCommands);
    section('stale command', report.staleCommands);
    section('policy', report.policyViolations);
    return { exitCode: 1 };
  }

  const rows = [
    ...GLOBAL_FLAGS.map((flag) => ({ scope: 'global', flag })),
    ...COMMANDS.flatMap((command) => command.flags.map((flag) => ({ scope: command.name, flag }))),
  ];

  if (ctx.json) {
    ctx.print(
      JSON.stringify({
        command: 'flags',
        flags: rows.map(({ scope, flag }) => ({
          scope,
          key: flag.key,
          env: flag.env,
          aliases: flag.aliases,
          short: flag.short ?? null,
          type: flag.type,
          default: flag.default ?? null,
        })),
      }),
    );
    return { exitCode: 0 };
  }

  const scopeWidth = Math.max(...rows.map((row) => row.scope.length));
  const optionWidth = Math.max(...rows.map((row) => row.flag.aliases[0]?.length ?? 0)) + 2;
  const envWidth = Math.max(...rows.map((row) => row.flag.env.length));
  for (const { scope, flag } of rows) {
    ctx.print(
      `  ${scope.padEnd(scopeWidth)}  ${`--${flag.aliases[0]}`.padEnd(optionWidth)}  ` +
        `${flag.env.padEnd(envWidth)}  ${flag.type}`,
    );
  }
  return { exitCode: 0 };
}
