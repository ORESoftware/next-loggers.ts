import { lstat, readFile, readdir } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';

import type { CommandContext, CommandResult } from '../context.js';

const SOURCE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
]);
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.vendor',
  '.zed',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);
const LEVEL_METHODS = new Set(['trace', 'debug', 'info', 'log', 'warn', 'error', 'fatal']);
const TERMINAL_METHODS = new Set(['send', 'sendWithStore']);
const LOGGER_EXPORTS = new Set([
  'logger',
  'browserLogger',
  'edgeLogger',
  'cloudflareWorkerLogger',
  'nodeLogger',
  'bunLogger',
  'denoLogger',
]);
const FACTORY_EXPORTS = new Set([
  'createLogger',
  'createBrowserLogger',
  'createEdgeLogger',
  'createCloudflareWorkerLogger',
  'createNodeLogger',
  'createBunLogger',
  'createDenoLogger',
]);
const CLASS_EXPORTS = new Set([
  'BaseLogger',
  'BrowserLogger',
  'EdgeLogger',
  'CloudflareWorkerLogger',
  'NodeLogger',
  'BunLogger',
  'DenoLogger',
]);
const MODULE_PATTERN = String.raw`@oresoftware\/next-loggers(?:\/[^'"\s]+)?`;
const MISSING_SEND_MESSAGE =
  'Call .send() on this log event so it is delivered before shutdown.';

export interface LintFinding {
  file: string;
  line: number;
  column: number;
  code: 'NL100';
  message: string;
}

export interface LintSourceOptions {
  all?: boolean;
  loggerNames?: readonly string[];
}

interface SourceLocation {
  line: number;
  column: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sourceLocation(source: string, index: number): SourceLocation {
  let line = 1;
  let lineStart = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === '\n') {
      line += 1;
      lineStart = cursor + 1;
    }
  }
  return { line, column: index - lineStart + 1 };
}

/** Replace comments and string/template contents with spaces while preserving offsets. */
function maskNonCode(source: string): string {
  const masked = source.split('');
  let state: 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template' =
    'code';
  let escaped = false;

  const mask = (index: number): void => {
    const value = masked[index];
    if (value !== '\n' && value !== '\r') masked[index] = ' ';
  };

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (state === 'line-comment') {
      if (current === '\n') {
        state = 'code';
      } else {
        mask(index);
      }
      continue;
    }
    if (state === 'block-comment') {
      mask(index);
      if (current === '*' && next === '/') {
        mask(index + 1);
        index += 1;
        state = 'code';
      }
      continue;
    }
    if (state !== 'code') {
      mask(index);
      if (escaped) {
        escaped = false;
        continue;
      }
      if (current === '\\') {
        escaped = true;
        continue;
      }
      if (
        (state === 'single' && current === "'") ||
        (state === 'double' && current === '"') ||
        (state === 'template' && current === '`')
      ) {
        state = 'code';
      }
      continue;
    }

    if (current === '/' && next === '/') {
      mask(index);
      mask(index + 1);
      index += 1;
      state = 'line-comment';
    } else if (current === '/' && next === '*') {
      mask(index);
      mask(index + 1);
      index += 1;
      state = 'block-comment';
    } else if (current === "'") {
      mask(index);
      state = 'single';
    } else if (current === '"') {
      mask(index);
      state = 'double';
    } else if (current === '`') {
      mask(index);
      state = 'template';
    }
  }
  return masked.join('');
}

function hasNextLoggersModule(source: string): boolean {
  return new RegExp(
    String.raw`(?:from\s*['"]${MODULE_PATTERN}['"]|require\s*\(\s*['"]${MODULE_PATTERN}['"]\s*\)|import\s*\(\s*['"]${MODULE_PATTERN}['"]\s*\))`,
  ).test(source);
}

function parseNamedImports(
  clause: string,
  knownLoggers: Set<string>,
  knownFactories: Set<string>,
  knownClasses: Set<string>,
): void {
  const body = clause.replace(/^\{/, '').replace(/\}$/, '');
  for (const rawEntry of body.split(',')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const parts = entry.split(/\s+as\s+/);
    const imported = parts[0]?.trim();
    const local = (parts[1] ?? parts[0])?.trim();
    if (!imported || !local) continue;
    if (LOGGER_EXPORTS.has(imported)) knownLoggers.add(local);
    if (FACTORY_EXPORTS.has(imported)) knownFactories.add(local);
    if (CLASS_EXPORTS.has(imported)) knownClasses.add(local);
  }
}

function discoverLoggerNames(source: string, masked: string, extras: readonly string[]): Set<string> {
  const knownLoggers = new Set(['log', 'logger', 'ddlog', ...extras]);
  const knownFactories = new Set<string>();
  const knownClasses = new Set<string>();
  const importPattern = new RegExp(
    String.raw`import\s+([\s\S]*?)\s+from\s*['"]${MODULE_PATTERN}['"]\s*;?`,
    'g',
  );

  for (const match of source.matchAll(importPattern)) {
    const clause = match[1]?.trim();
    if (!clause) continue;
    const namespace = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
    if (namespace?.[1]) {
      for (const name of LOGGER_EXPORTS) knownLoggers.add(`${namespace[1]}.${name}`);
      for (const name of FACTORY_EXPORTS) knownFactories.add(`${namespace[1]}.${name}`);
      for (const name of CLASS_EXPORTS) knownClasses.add(`${namespace[1]}.${name}`);
      continue;
    }
    const braceStart = clause.indexOf('{');
    if (braceStart >= 0) {
      const defaultImport = clause.slice(0, braceStart).replace(/,$/, '').trim();
      if (defaultImport) knownLoggers.add(defaultImport);
      const named = clause.slice(braceStart);
      parseNamedImports(named, knownLoggers, knownFactories, knownClasses);
    } else {
      knownLoggers.add(clause);
    }
  }

  const assignmentPattern =
    /(?:^|[;{}\n])\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
  let changed = true;
  while (changed) {
    changed = false;
    assignmentPattern.lastIndex = 0;
    for (const match of masked.matchAll(assignmentPattern)) {
      const local = match[1];
      const initializer = match[2]?.trim();
      if (!local || !initializer || knownLoggers.has(local)) continue;
      const call = initializer.match(
        /^(?:new\s+)?([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/,
      );
      const callee = call?.[1]?.replace(/\s+/g, '');
      const anew = initializer.match(
        /^([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*anew\s*\(/,
      );
      const owner = anew?.[1]?.replace(/\s+/g, '');
      if (
        (callee && (knownFactories.has(callee) || knownClasses.has(callee))) ||
        (owner && knownLoggers.has(owner))
      ) {
        knownLoggers.add(local);
        changed = true;
      }
    }
  }
  return knownLoggers;
}

function statementEnd(masked: string, start: number): number {
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let index = start; index < masked.length; index += 1) {
    const current = masked[index];
    if (current === '(') parentheses += 1;
    else if (current === ')') parentheses = Math.max(0, parentheses - 1);
    else if (current === '[') brackets += 1;
    else if (current === ']') brackets = Math.max(0, brackets - 1);
    else if (current === '{') braces += 1;
    else if (current === '}') {
      if (braces === 0 && parentheses === 0 && brackets === 0) return index;
      braces = Math.max(0, braces - 1);
    } else if (current === ';' && parentheses === 0 && brackets === 0 && braces === 0) {
      return index;
    } else if (current === '\n' && parentheses === 0 && brackets === 0 && braces === 0) {
      const before = masked.slice(start, index).trimEnd();
      let cursor = index + 1;
      while (cursor < masked.length && /[ \t\r]/.test(masked[cursor] ?? '')) cursor += 1;
      const after = masked.slice(cursor, cursor + 2);
      if (
        !before.endsWith('.') &&
        !before.endsWith('?.') &&
        !before.endsWith(',') &&
        after !== '?.' &&
        !after.startsWith('.')
      ) {
        return index;
      }
    }
  }
  return masked.length;
}

function methodChain(statement: string): string[] {
  const methods: string[] = [];
  const pattern = /(?:\?|)\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of statement.matchAll(pattern)) {
    if (match[1]) methods.push(match[1]);
  }
  return methods;
}

export function lintSource(
  source: string,
  file = '<source>',
  options: LintSourceOptions = {},
): LintFinding[] {
  const extras = options.loggerNames ?? [];
  if (!options.all && extras.length === 0 && !hasNextLoggersModule(source)) return [];

  const masked = maskNonCode(source);
  const knownLoggers = discoverLoggerNames(source, masked, extras);
  const roots = [...knownLoggers].sort((left, right) => right.length - left.length);
  if (roots.length === 0) return [];
  const rootAlternation = roots.map(escapeRegExp).join('|');
  const expressionPattern = new RegExp(
    String.raw`(?:^|[;{}\n])([ \t]*(?:(?:await|void)\s+)*)(${rootAlternation})\s*\.\s*(trace|debug|info|log|warn|error|fatal)\s*\(`,
    'gm',
  );
  const findings: LintFinding[] = [];

  for (const match of masked.matchAll(expressionPattern)) {
    const root = match[2];
    const level = match[3];
    if (!root || !level || !LEVEL_METHODS.has(level)) continue;
    const full = match[0];
    const rootOffset = full.lastIndexOf(root);
    const rootIndex = (match.index ?? 0) + rootOffset;
    const end = statementEnd(masked, rootIndex);
    const methods = methodChain(masked.slice(rootIndex, end));
    const levelIndex = methods.findIndex((method) => LEVEL_METHODS.has(method));
    if (
      levelIndex < 0 ||
      methods.slice(levelIndex + 1).some((method) => TERMINAL_METHODS.has(method))
    ) {
      continue;
    }
    const location = sourceLocation(source, rootIndex);
    findings.push({
      file,
      line: location.line,
      column: location.column,
      code: 'NL100',
      message: MISSING_SEND_MESSAGE,
    });
  }
  return findings;
}

async function collectSourceFiles(paths: readonly string[]): Promise<{
  files: string[];
  errors: string[];
}> {
  const files: string[] = [];
  const errors: string[] = [];

  const visit = async (path: string): Promise<void> => {
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      errors.push(`${path}: ${String(error)}`);
      return;
    }
    if (metadata.isSymbolicLink()) return;
    if (metadata.isFile()) {
      if (SOURCE_EXTENSIONS.has(extname(path).toLowerCase())) files.push(path);
      return;
    }
    if (!metadata.isDirectory()) return;

    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      errors.push(`${path}: ${String(error)}`);
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
      await visit(resolve(path, entry.name));
    }
  };

  for (const path of paths) await visit(resolve(path));
  files.sort();
  return { files, errors };
}

export async function runLint(ctx: CommandContext): Promise<CommandResult> {
  const targets = ctx.positionals.length > 0 ? ctx.positionals : ['.'];
  const collected = await collectSourceFiles(targets);
  const findings: LintFinding[] = [];
  for (const path of collected.files) {
    try {
      const source = await readFile(path, 'utf8');
      const displayPath = relative(process.cwd(), path) || path;
      findings.push(
        ...lintSource(source, displayPath, {
          all: ctx.bool('lint_all'),
          loggerNames: ctx.list('lint_logger_names'),
        }),
      );
    } catch (error) {
      collected.errors.push(`${path}: ${String(error)}`);
    }
  }

  if (ctx.json) {
    ctx.print(
      JSON.stringify({
        command: 'lint',
        scanned: collected.files.length,
        findings,
        errors: collected.errors,
      }),
    );
  } else {
    for (const finding of findings) {
      ctx.printErr(
        `${finding.file}:${finding.line}:${finding.column}: ${finding.code} ${finding.message}`,
      );
    }
    for (const error of collected.errors) ctx.printErr(`next-loggers lint: ${error}`);
    if (findings.length === 0 && collected.errors.length === 0 && !ctx.bool('quiet')) {
      ctx.print(`next-loggers lint: ${collected.files.length} source file(s) passed`);
    }
  }

  if (collected.errors.length > 0) return { exitCode: 2 };
  return { exitCode: findings.length > 0 ? 1 : 0 };
}
