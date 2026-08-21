import assert from 'node:assert/strict';
import test from 'node:test';

import { lintSource } from '../dist/cli/commands/lint.js';

const imported = `
  import { createLogger } from '@oresoftware/next-loggers';
  const log = createLogger({ appName: 'test' });
`;

test('flags a standalone event chain that never sends', () => {
  const findings = lintSource(`${imported}\nlog.info('started').withTag('boot');\n`, 'sample.ts');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'NL100');
  assert.equal(findings[0].line, 4);
});

test('accepts send and sendWithStore terminal calls', () => {
  assert.deepEqual(
    lintSource(
      `${imported}\nlog.info('sent').send();\nlog.warn('stored').sendWithStore();\n`,
      'sample.ts',
    ),
    [],
  );
});

test('ignores an event assigned for later completion', () => {
  assert.deepEqual(
    lintSource(`${imported}\nconst event = log.info('later');\n`, 'sample.ts'),
    [],
  );
});

test('tracks imported aliases and factory-created loggers', () => {
  const source = `
    import { createLogger as makeLogger } from '@oresoftware/next-loggers/node';
    const audit = makeLogger({ appName: 'audit' });
    audit.error('missing');
  `;
  assert.equal(lintSource(source, 'sample.mts').length, 1);
});

test('requires a package import unless --all or --logger-name is explicit', () => {
  const source = `logger.info('not necessarily next-loggers');`;
  assert.deepEqual(lintSource(source, 'plain.ts'), []);
  assert.equal(lintSource(source, 'plain.ts', { all: true }).length, 1);
  assert.equal(
    lintSource(`audit.info('missing');`, 'plain.ts', { loggerNames: ['audit'] }).length,
    1,
  );
});

test('ignores comments and string literals that resemble events', () => {
  const source = `${imported}
    // log.info('commented');
    const example = "log.info('inside a string');";
    log.info('real').send();
  `;
  assert.deepEqual(lintSource(source, 'sample.ts'), []);
});
