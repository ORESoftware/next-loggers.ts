/**
 * `next-loggers lint` — polyglot missing-send check.
 *
 * Every SDK whose level methods return a chainable event has the same hazard:
 * the event is registered as unsent and only reaches transports on send(), so
 * a statement that builds one and drops it logs nothing. Language-native tools
 * cover most runtimes — the ESLint rule for JS/TS, `#[must_use]` for Rust,
 * `nextloggerslint` for Go, `next_loggers.lint` for Python — and this command
 * covers the rest (notably Gleam, whose compiler has no must-use attribute)
 * plus mixed repositories that would rather run one check.
 *
 * The check is deliberately statement-local: comments and string literals are
 * blanked, source is split into statements, and a statement that calls a level
 * method on a known logger without a later send is reported. Events assigned
 * to a variable are not followed, matching the ESLint rule.
 */

import type { CommandContext, CommandResult } from '../context.js';

export interface LintFinding {
  file: string;
  line: number;
  column: number;
  language: Language;
  message: string;
  code?: 'NL100';
}

export interface LintSourceOptions {
  all?: boolean;
  loggerNames?: readonly string[];
}

export type Language = 'javascript' | 'typescript' | 'go' | 'rust' | 'python' | 'gleam';

const LEVEL_METHODS = ['trace', 'debug', 'info', 'log', 'warn', 'error', 'fatal'];
const DEFAULT_LOGGER_NAMES = ['log', 'logger', 'ddlog'];

const EXTENSIONS: ReadonlyMap<string, Language> = new Map<string, Language>([
  ['.js', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.jsx', 'javascript'],
  ['.ts', 'typescript'],
  ['.mts', 'typescript'],
  ['.cts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.go', 'go'],
  ['.rs', 'rust'],
  ['.py', 'python'],
  ['.gleam', 'gleam'],
]);

/** Markers proving a file actually uses next-loggers, keeping bare `logger.info()` from matching another library. */
const IMPORT_MARKERS = [
  'next-loggers',
  'next_loggers',
  'nextloggers',
  'oresoftware_next_loggers',
  '@oresoftware/next-loggers',
];

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'target',
  'vendor',
  '.git',
  '.vendor',
  '.zed',
  '_build',
  'deps',
]);

const MESSAGE = 'next-loggers event is never sent; call send() so it reaches transports';

/** Replaces comment and string content with spaces, preserving offsets. */
export function blankNonCode(source: string, language: Language): string {
  const characters = [...source];
  const blank = (start: number, end: number): void => {
    for (let index = start; index < end && index < characters.length; index += 1) {
      if (characters[index] !== '\n') {
        characters[index] = ' ';
      }
    }
  };
  const lineComment = language === 'python' ? '#' : '//';
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === undefined) {
      break;
    }
    if (source.startsWith(lineComment, index)) {
      const end = source.indexOf('\n', index);
      blank(index, end === -1 ? source.length : end);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (language !== 'python' && source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (source[cursor] === character) {
          break;
        }
        cursor += 1;
      }
      blank(index + 1, Math.min(cursor, source.length));
      index = Math.min(cursor + 1, source.length);
      continue;
    }
    index += 1;
  }
  return characters.join('');
}

/**
 * Where the statement beginning at `start` ends: at a `;`, or at a newline
 * outside any bracket that is not continued by the next line (a leading `.`,
 * `?.`, `|>`, or a closing bracket).
 */
function statementEnd(code: string, start: number): number {
  let depth = 0;
  for (let index = start; index < code.length; index += 1) {
    const character = code[index];
    if (character === '(' || character === '[' || character === '{') {
      depth += 1;
      continue;
    }
    if (character === ')' || character === ']' || character === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) {
      continue;
    }
    if (character === ';') {
      return index + 1;
    }
    if (character === '\n') {
      const nextBreak = code.indexOf('\n', index + 1);
      const nextLine = code.slice(index + 1, nextBreak === -1 ? undefined : nextBreak);
      if (!/^\s*(\.|\?\.|\|>|\)|\}|\])/.test(nextLine)) {
        return index;
      }
    }
  }
  return code.length;
}

/** The last non-blank line before `lineStart`, used to reject continuations. */
function previousLine(code: string, lineStart: number): string {
  let cursor = lineStart;
  while (cursor > 0) {
    const end = cursor - 1;
    const begin = code.lastIndexOf('\n', end - 1) + 1;
    const line = code.slice(begin, end);
    if (line.trim()) {
      return line.trim();
    }
    cursor = begin;
    if (begin === 0) {
      break;
    }
  }
  return '';
}

function loggerNames(code: string, language: Language, extra: readonly string[]): Set<string> {
  const names = new Set<string>([...DEFAULT_LOGGER_NAMES, ...extra]);
  const factories = new Set<string>([
    'createLogger',
    'createBrowserLogger',
    'createEdgeLogger',
    'createCloudflareWorkerLogger',
    'createNodeLogger',
    'createBunLogger',
    'createDenoLogger',
  ]);
  if (language === 'javascript' || language === 'typescript') {
    for (const match of code.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*next-loggers[^'"]*['"]/g,
    )) {
      for (const entry of (match[1] ?? '').split(',')) {
        const parts = entry.trim().split(/\s+as\s+/);
        const imported = parts[0]?.trim();
        const local = (parts[1] ?? parts[0])?.trim();
        if (imported && local && factories.has(imported)) {
          factories.add(local);
        }
      }
    }
  }
  const factoryPattern = [...factories].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const patterns = [
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[\w.]*(?:create\w*Logger|NewLogger|Logger::new|Logger)\s*\(/g,
    new RegExp(
      String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:${factoryPattern.join('|')})\s*\(`,
      'g',
    ),
    /([A-Za-z_][\w]*)\s*:?=\s*[\w.]*(?:NewLogger|Logger::new|Logger)\s*\(/g,
    /let\s+([A-Za-z_][\w]*)\s*=\s*[\w.]*(?:new|logging\.new)\s*\(/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      if (match[1]) {
        names.add(match[1]);
      }
    }
  }
  if (language === 'gleam') {
    // Gleam calls are module-qualified: `logging.info(logger, ...)`.
    for (const match of code.matchAll(/import\s+[\w/]*next_loggers\S*\s+as\s+([a-z_][\w]*)/g)) {
      if (match[1]) {
        names.add(match[1]);
      }
    }
    names.add('logging');
    names.add('oresoftware_next_loggers');
  }
  return names;
}

function sendPattern(language: Language): RegExp {
  return language === 'go'
    ? /\.(Send|SendWithStore)\s*\(/
    : language === 'gleam'
      ? /(\.|\|>\s*[\w.]*)send(_with_store)?\b/
      : /\.send(_with_store|WithStore)?\s*\(/;
}

function levelPattern(names: Iterable<string>, language: Language): RegExp {
  const escaped = [...names].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const levels =
    language === 'go'
      ? LEVEL_METHODS.map((level) => level[0]!.toUpperCase() + level.slice(1))
      : LEVEL_METHODS;
  return new RegExp(`\\b(?:${escaped.join('|')})\\s*\\.\\s*(?:${levels.join('|')})\\s*\\(`);
}

export function checkSource(
  source: string,
  language: Language,
  options: { file?: string; loggerNames?: readonly string[]; requireImport?: boolean } = {},
): LintFinding[] {
  const file = options.file ?? '<source>';
  const extra = options.loggerNames ?? [];
  if ((options.requireImport ?? true) && extra.length === 0) {
    if (!IMPORT_MARKERS.some((marker) => source.includes(marker))) {
      return [];
    }
  }
  const code = blankNonCode(source, language);
  const names = loggerNames(code, language, extra);
  const level = levelPattern(names, language);
  const send = sendPattern(language);

  const findings: LintFinding[] = [];
  for (const match of code.matchAll(new RegExp(level.source, 'g'))) {
    const start = match.index ?? 0;
    const lineStart = code.lastIndexOf('\n', start - 1) + 1;
    // Only a bare expression statement is reported. A chain that is returned,
    // assigned, awaited, or passed as an argument is out of scope, exactly as
    // in the ESLint rule: the send may happen anywhere the value travels.
    if (code.slice(lineStart, start).trim() !== '') {
      continue;
    }
    if (/[,([=+&|:?]$|\|>$|->$|=>$|\.$/.test(previousLine(code, lineStart))) {
      continue;
    }
    if (send.test(code.slice(start, statementEnd(code, start)))) {
      continue;
    }
    const before = code.slice(0, start);
    findings.push({
      file,
      line: before.split('\n').length,
      column: start - (before.lastIndexOf('\n') + 1) + 1,
      language,
      message: MESSAGE,
      code: 'NL100',
    });
  }
  return findings;
}

/** JS/TS-focused wrapper used by missing-send unit tests (NL100). */
export function lintSource(
  source: string,
  file = '<source>',
  options: LintSourceOptions = {},
): LintFinding[] {
  const fromPath = languageForPath(file);
  const language =
    fromPath === 'javascript' || fromPath === 'typescript' ? fromPath : 'typescript';
  return checkSource(source, language, {
    file,
    loggerNames: options.loggerNames,
    requireImport: !options.all && (options.loggerNames?.length ?? 0) === 0,
  });
}

export function languageForPath(path: string): Language | undefined {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? undefined : EXTENSIONS.get(path.slice(dot).toLowerCase());
}

async function collectFiles(targets: readonly string[]): Promise<string[]> {
  const { readdir, stat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const files: string[] = [];
  const walk = async (path: string): Promise<void> => {
    const info = await stat(path);
    if (!info.isDirectory()) {
      if (languageForPath(path)) {
        files.push(path);
      }
      return;
    }
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        await walk(join(path, entry.name));
        continue;
      }
      const child = join(path, entry.name);
      if (languageForPath(child)) {
        files.push(child);
      }
    }
  };
  for (const target of targets) {
    await walk(target);
  }
  return files.sort();
}

export async function runLint(ctx: CommandContext): Promise<CommandResult> {
  const { readFile } = await import('node:fs/promises');
  const targets = ctx.positionals.length > 0 ? ctx.positionals : ['.'];
  const extra = ctx.list('logger_name');
  const requireImport = !ctx.bool('all');

  let files: string[];
  try {
    files = await collectFiles(targets);
  } catch (error) {
    ctx.printErr(`lint: ${String(error)}`);
    return { exitCode: 2 };
  }

  const findings: LintFinding[] = [];
  for (const file of files) {
    const language = languageForPath(file);
    if (!language) {
      continue;
    }
    const source = await readFile(file, 'utf8');
    findings.push(...checkSource(source, language, { file, loggerNames: extra, requireImport }));
  }

  for (const finding of findings) {
    ctx.print(`${finding.file}:${finding.line}:${finding.column}: ${finding.message}`);
  }
  ctx.print(
    findings.length === 0
      ? `lint: checked ${files.length} file(s); every next-loggers event is sent`
      : `lint: ${findings.length} unsent event(s) in ${files.length} checked file(s)`,
  );
  return { exitCode: findings.length > 0 ? 1 : 0 };
}
