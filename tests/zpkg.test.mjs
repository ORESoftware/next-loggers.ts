import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { parseToml } from '../dist/cli/toml.js';

const manifest = parseToml(await readFile(new URL('../.zpkg.toml', import.meta.url), 'utf8'));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const lock = await readFile(new URL('../.zpkg.lock', import.meta.url), 'utf8');

test('.zpkg.toml and package.json agree on identity', () => {
  // Two manifests now describe one package; nothing but a test keeps them
  // honest.
  assert.equal(manifest.package.version, pkg.version);
  assert.equal(manifest.package.description, pkg.description);
  assert.equal(manifest.package.license, pkg.license);
  assert.deepEqual(manifest.package.keywords, pkg.keywords);
  assert.equal(
    `@${manifest.package.org}/${manifest.package.name}`,
    pkg.name,
    'the zpkg org/name must compose to the npm package name, so both registries yield the same import specifier',
  );
});

test('org and name satisfy the zpkg slug rule', () => {
  // is_slug(): lowercase alphanumerics and dashes, no leading/trailing dash.
  // This is why the package cannot be called "next-loggers.ts".
  const slug = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
  assert.match(manifest.package.org, slug);
  assert.match(manifest.package.name, slug);
});

test('the repository URL uses a scheme zed accepts', () => {
  // git+https:// — package.json's spelling — is rejected by the manifest
  // validator, so the two files legitimately differ here.
  const url = manifest.package.repository.url;
  assert.equal(
    ['https://', 'http://', 'ssh://', 'git://', 'git+ssh://'].some((scheme) =>
      url.startsWith(scheme),
    ),
    true,
    `repository.url "${url}" uses a scheme zed rejects`,
  );
  assert.equal(manifest.package.repository.vcs, 'git');
});

test('the declared bin matches package.json and is a safe relative path', () => {
  const binPath = manifest.bin['next-loggers'];
  assert.equal(`./${binPath}`, pkg.bin['next-loggers']);
  assert.equal(binPath.startsWith('/'), false);
  assert.equal(binPath.split('/').includes('..'), false);
});

test('the version is full semver, as the default version_scheme requires', () => {
  assert.match(manifest.package.version, /^\d+\.\d+\.\d+(?:[-+].*)?$/);
});

test('the lockfile is the canonical zero-dependency form', () => {
  // `version` has no serde default, so an empty file fails to parse; and
  // `packages` is skipped when empty, so this is a real lockfile, not a stub.
  assert.equal(lock.trim(), 'version = 1');
  assert.equal(parseToml(lock).version, 1);
});

test('no dependencies are declared on either registry', () => {
  const zpkgDeps = Object.keys(manifest.dependencies ?? {});
  assert.deepEqual(zpkgDeps, [], 'the zero-runtime-dependency guarantee must hold on zpkg too');
  assert.equal(pkg.dependencies, undefined);
});

test('publish keeps the README and strips development-only paths', () => {
  assert.equal(manifest.publish.include_readme, true, 'READMEs are stripped by default');
  assert.equal(manifest.publish.tag_format, 'v{version}');
  for (const pattern of ['docs/**', '.r2g/**', 'tsconfig*.json']) {
    assert.equal(
      manifest.publish.exclude.includes(pattern),
      true,
      `publish.exclude should strip ${pattern}`,
    );
  }
});

test('the smoke test invokes the published bin', () => {
  // zed r2g runs this from the mock consumer with ZED_PKG_TEST_TARGET set to
  // the installed package directory.
  const smoke = manifest.publish.smoke_test;
  assert.match(smoke, /ZED_PKG_TEST_TARGET/);
  assert.match(smoke, /dist\/cli\/main\.js/);
});

test('the eslint plugin version tracks package.json', async () => {
  const source = await readFile(new URL('../src/eslint-plugin.ts', import.meta.url), 'utf8');
  const declared = source.match(/version:\s*'([^']+)'/)?.[1];
  assert.equal(
    declared,
    pkg.version,
    'the eslint plugin hard-codes its version; bump it with package.json',
  );
});
