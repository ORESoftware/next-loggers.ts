import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { parseToml, TomlError } from '../dist/cli/toml.js';
import { collectDeclared, compare, compareSource } from '../dist/cli/drift.js';
import { COMMANDS, GLOBAL_FLAGS, LIBRARY_CONTRACT_FLAGS } from '../dist/cli/spec.js';

const CONTRACT_PATH = new URL('../.cli-flags.toml', import.meta.url);
const source = await readFile(CONTRACT_PATH, 'utf8');

test('.cli-flags.toml matches the compiled spec in both directions', () => {
  const report = compareSource(source);
  assert.deepEqual(report.missing, [], 'flags in the spec but not declared in .cli-flags.toml');
  assert.deepEqual(report.stale, [], 'flags declared in .cli-flags.toml but absent from the spec');
  assert.deepEqual(report.mismatched, []);
  assert.deepEqual(report.missingCommands, []);
  assert.deepEqual(report.staleCommands, []);
  assert.deepEqual(report.policyViolations, []);
  assert.equal(report.ok, true);
});

test('every declared env var is NEXT_LOGGER_-prefixed and unique', () => {
  // Uses the structure-aware collector rather than walking for any key named
  // "flags" — one of the commands IS called `flags`, so its table path is
  // [commands.flags.flags.check] and a name-based walk mistakes the command
  // for a flag table.
  const { flags } = collectDeclared(parseToml(source));
  const seen = new Set();
  for (const flag of flags) {
    assert.match(
      flag.env,
      /^NEXT_LOGGER_[A-Z0-9_]+$/,
      `${flag.scope}.${flag.key} declares a non-conforming env "${flag.env}"`,
    );
    assert.equal(seen.has(flag.env), false, `${flag.env} is declared twice`);
    seen.add(flag.env);
  }
  assert.equal(seen.size, flags.length);
  assert.equal(flags.length > 0, true);
});

test('the drift check fails when the contract loses a flag', () => {
  // Remove a whole flag table from the TOML; the spec still declares it.
  const withoutQuiet = source.replace(
    /\[flags\.quiet\][\s\S]*?(?=\n\[)/,
    '',
  );
  const report = compareSource(withoutQuiet);
  assert.equal(report.ok, false, 'a removed flag must be detected');
  assert.equal(
    report.missing.some((entry) => entry.includes('global.quiet')),
    true,
    `expected global.quiet in missing, got ${JSON.stringify(report.missing)}`,
  );
});

test('the drift check fails when the contract invents a flag', () => {
  const extra = `${source}\n[flags.bogus]\nenv = "NEXT_LOGGER_BOGUS"\naliases = ["bogus"]\ntype = "string"\nhelp = "nope"\n`;
  const report = compareSource(extra);
  assert.equal(report.ok, false);
  assert.equal(
    report.stale.some((entry) => entry.includes('global.bogus')),
    true,
  );
});

test('the drift check fails on a changed env var, type, or short', () => {
  const changedEnv = source.replace(
    'env = "NEXT_LOGGER_APP_NAME"',
    'env = "NEXT_LOGGER_APPNAME"',
  );
  assert.equal(compareSource(changedEnv).ok, false);

  const changedType = source.replace(
    '[flags.quiet]\nenv = "NEXT_LOGGER_CLI_QUIET"\naliases = ["quiet"]\nshort = "q"\ntype = "bool"',
    '[flags.quiet]\nenv = "NEXT_LOGGER_CLI_QUIET"\naliases = ["quiet"]\nshort = "q"\ntype = "string"',
  );
  assert.equal(compareSource(changedType).ok, false);
});

test('the drift check fails when a command is undeclared', () => {
  const withoutResolve = source.replace(/\[commands\.resolve\.flags\.[\s\S]*?(?=\n\[commands\.pretty)/, '');
  const report = compareSource(withoutResolve);
  assert.equal(report.ok, false);
  assert.equal(report.missingCommands.includes('resolve'), true);
});

test('no library-contract flag declares a default', () => {
  // A default that outranked the environment would fabricate configuration
  // the user never wrote — see the deviation note in .cli-flags.toml.
  for (const flag of LIBRARY_CONTRACT_FLAGS) {
    assert.equal(
      flag.default,
      undefined,
      `${flag.key} writes ${flag.env}, which envToLoggerOptions() reads, so it must not have a default`,
    );
  }
});

test('every NEXT_LOGGER_* var read by config.ts is exposed as a flag', async () => {
  const configSource = await readFile(new URL('../src/config.ts', import.meta.url), 'utf8');
  const used = new Set(
    [...configSource.matchAll(/env\.(NEXT_LOGGER_[A-Z0-9_]+)/g)].map((match) => match[1]),
  );
  const declared = new Set(GLOBAL_FLAGS.map((flag) => flag.env));
  const undeclared = [...used].filter((name) => !declared.has(name));
  assert.deepEqual(
    undeclared,
    [],
    'config.ts reads env vars the CLI does not expose; the two contracts have diverged',
  );
});

test('shorts are unique within every scope', () => {
  const scopes = [
    ['global', GLOBAL_FLAGS],
    ...COMMANDS.map((command) => [command.name, [...command.flags, ...GLOBAL_FLAGS]]),
  ];
  for (const [name, flags] of scopes) {
    const shorts = flags.map((flag) => flag.short).filter(Boolean);
    assert.equal(
      new Set(shorts).size,
      shorts.length,
      `scope "${name}" has duplicate short flags: ${shorts.join(', ')}`,
    );
  }
});

test('the TOML reader fails closed on constructs it cannot represent', () => {
  assert.throws(() => parseToml('[[array_of_tables]]\nx = 1\n'), TomlError);
  assert.throws(() => parseToml('a = { inline = true }\n'), TomlError);
  assert.throws(() => parseToml('a = [\n"unterminated",\n'), TomlError);
  assert.throws(() => parseToml('novalue\n'), TomlError);
  assert.throws(() => parseToml('a = 1\na = 2\n'), TomlError);
  assert.throws(() => parseToml('a = nonsense\n'), TomlError);
});

test('the TOML reader handles multi-line arrays, as .zpkg.toml uses', () => {
  const document = parseToml(
    ['[publish]', 'exclude = [', '  "docs/**",  # a comment', '  "*.tgz",', ']'].join('\n'),
  );
  assert.deepEqual(document.publish.exclude, ['docs/**', '*.tgz']);
});

test('the TOML reader handles the constructs the contract does use', () => {
  const document = parseToml(
    [
      '# comment',
      '[parse]',
      'command_env = "X" # trailing comment',
      'allow_unknown = false',
      '',
      '[flags.a]',
      'aliases = ["one", "two"]',
      'type = "string"',
      'quoted = "a # not a comment"',
      '[commands.c.flags.b]',
      'env = "Y"',
    ].join('\n'),
  );
  assert.equal(document.parse.command_env, 'X');
  assert.equal(document.parse.allow_unknown, false);
  assert.deepEqual(document.flags.a.aliases, ['one', 'two']);
  assert.equal(document.flags.a.quoted, 'a # not a comment');
  assert.equal(document.commands.c.flags.b.env, 'Y');
});

test('an unknown key inside a flag table is rejected', () => {
  const document = parseToml(
    '[flags.a]\nenv = "NEXT_LOGGER_A"\naliases = ["a"]\ntype = "string"\nalias = "typo"\n',
  );
  assert.throws(() => compare(document), /unknown key "alias"/);
});
