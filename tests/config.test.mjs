import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createLogger, HttpTransport } from '@oresoftware/next-loggers/base';
import {
  createLoggerFromConfig,
  envToLoggerOptions,
  loadNextLoggerConfig,
} from '@oresoftware/next-loggers/config';

const withTempDir = async (run) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'next-logger-config-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const supportsTypeScriptImports = Boolean(process.features?.typescript);

test('error tracking posts only qualifying levels to the priority url', async () => {
  const posts = [];
  const logger = createLogger({ console: false }).setErrorTrackingUrl(
    'https://errors.example.test/collect',
    {
      fetch: async (url, init) => {
        posts.push({ url, body: JSON.parse(init.body) });
        return new Response(null, { status: 202 });
      },
    },
  );
  await logger.info('not an error').send();
  await logger.error('boom').send();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://errors.example.test/collect');
  assert.equal(posts[0].body.message, 'boom');
});

test('error tracking falls back to the secondary url when the priority fails', async () => {
  const attempts = [];
  const logger = createLogger({ console: false }).setErrorTracking({
    url: 'https://primary.example.test/collect',
    fallbackUrl: 'https://apps-script.example.test/exec',
    minLevel: 'warn',
    fetch: async (url) => {
      attempts.push(url);
      if (url.startsWith('https://primary')) {
        return new Response(null, { status: 500, statusText: 'down' });
      }
      return new Response(null, { status: 200 });
    },
  });
  const failures = [];
  const observed = logger.anew({ onTransportError: (error) => void failures.push(error) });
  await observed.warn('needs fallback').send();
  assert.deepEqual(attempts, [
    'https://primary.example.test/collect',
    'https://apps-script.example.test/exec',
  ]);
  assert.deepEqual(failures, []);
});

test('setErrorTracking validates urls and replaces prior destinations', async () => {
  const logger = createLogger({ console: false });
  assert.throws(() => logger.setErrorTrackingUrl('not-a-url'), /valid URL/);
  assert.throws(() => logger.setErrorTrackingUrl('ftp://example.test/x'), /http\(s\)/);

  const posts = [];
  logger.setErrorTrackingUrl('https://first.example.test/a', {
    fetch: async (url) => {
      posts.push(url);
      return new Response(null, { status: 200 });
    },
  });
  logger.setErrorTrackingUrl('https://second.example.test/b', {
    fetch: async (url) => {
      posts.push(url);
      return new Response(null, { status: 200 });
    },
  });
  await logger.error('replaced destination').send();
  assert.deepEqual(posts, ['https://second.example.test/b']);
});

test('HttpTransport writes to the fallback endpoint when the primary throws', async () => {
  const attempts = [];
  const transport = new HttpTransport({
    endpoint: 'https://one.example.test/logs',
    fallbackEndpoint: 'https://two.example.test/logs',
    method: 'PUT',
    fetch: async (url, init) => {
      attempts.push({ url, method: init.method });
      if (url.startsWith('https://one')) {
        throw new Error('connection refused');
      }
      return new Response(null, { status: 200 });
    },
  });
  const logger = createLogger({ console: false, transports: transport });
  await logger.info('takes the backup path').send();
  assert.deepEqual(attempts, [
    { url: 'https://one.example.test/logs', method: 'PUT' },
    { url: 'https://two.example.test/logs', method: 'PUT' },
  ]);
});

test('envToLoggerOptions maps NEXT_LOGGER_* variables (flags-2-env compatible)', () => {
  const options = envToLoggerOptions({
    NEXT_LOGGER_APP_NAME: 'checkout',
    NEXT_LOGGER_MAX_LEVEL: 'debug',
    NEXT_LOGGER_CONSOLE: 'off',
    NEXT_LOGGER_ERROR_TRACKING_URL: 'https://errors.example.test/collect',
    NEXT_LOGGER_ERROR_TRACKING_FALLBACK_URL: 'https://apps-script.example.test/exec',
    NEXT_LOGGER_SUPABASE_URL: 'https://project.supabase.co',
    NEXT_LOGGER_SUPABASE_ANON_KEY: 'anon',
    NEXT_LOGGER_SUPABASE_CHANNEL: 'logs',
  });
  assert.equal(options.appName, 'checkout');
  assert.equal(options.maxLevel, 'DEBUG');
  assert.equal(options.console, false);
  assert.equal(options.errorTracking.url, 'https://errors.example.test/collect');
  assert.equal(options.errorTracking.fallbackUrl, 'https://apps-script.example.test/exec');
  assert.equal(options.supabase.channel, 'logs');
});

test('loadNextLoggerConfig returns env-only options when no config file exists', async () => {
  await withTempDir(async (directory) => {
    const { options, filePath } = await loadNextLoggerConfig({
      cwd: directory,
      env: { NEXT_LOGGER_APP_NAME: 'env-only' },
    });
    assert.equal(filePath, null);
    assert.equal(options.appName, 'env-only');
  });
});

test('loadNextLoggerConfig loads .next-logger.mjs and lets env vars win', async () => {
  await withTempDir(async (directory) => {
    await writeFile(
      path.join(directory, '.next-logger.mjs'),
      `export default (env) => ({
        appName: 'from-file',
        maxLevel: 'warn',
        fields: { deployment: env.DEPLOY_ENV || 'unknown' },
      });`,
    );
    const { options, filePath } = await loadNextLoggerConfig({
      cwd: directory,
      env: { DEPLOY_ENV: 'staging', NEXT_LOGGER_APP_NAME: 'env-wins' },
    });
    assert.equal(filePath, path.join(directory, '.next-logger.mjs'));
    assert.equal(options.appName, 'env-wins');
    assert.equal(options.maxLevel, 'warn');
    assert.equal(options.fields.deployment, 'staging');
  });
});

test('loadNextLoggerConfig prefers .next-logger.ts when the runtime supports it', {
  skip: supportsTypeScriptImports ? false : 'Node lacks native TypeScript type stripping',
}, async () => {
  await withTempDir(async (directory) => {
    await writeFile(
      path.join(directory, '.next-logger.ts'),
      `import type { LoggerOptions } from '@oresoftware/next-loggers/base';
      const config: LoggerOptions = { appName: 'typescript-config', maxLevel: 'trace' };
      export default config;`,
    );
    await writeFile(path.join(directory, '.next-logger.mjs'), `export default { appName: 'loses' };`);
    const { options, filePath } = await loadNextLoggerConfig({ cwd: directory, env: {} });
    assert.equal(filePath, path.join(directory, '.next-logger.ts'));
    assert.equal(options.appName, 'typescript-config');
  });
});

test('a config file with a broken import surfaces the real error', async () => {
  await withTempDir(async (directory) => {
    await writeFile(
      path.join(directory, '.next-logger.mjs'),
      `import missing from './does-not-exist.mjs';
      export default { appName: String(missing) };`,
    );
    await assert.rejects(loadNextLoggerConfig({ cwd: directory, env: {} }), /does-not-exist/);
  });
});

test('createLoggerFromConfig builds a working logger with inline overrides', async () => {
  await withTempDir(async (directory) => {
    await writeFile(
      path.join(directory, '.next-logger.mjs'),
      `export default { appName: 'configured-app', console: false };`,
    );
    const records = [];
    const logger = await createLoggerFromConfig(
      { transports: { write: (record) => void records.push(record) } },
      { cwd: directory, env: {} },
    );
    await logger.info('configured hello').send();
    assert.equal(records[0].appName, 'configured-app');
  });
});
