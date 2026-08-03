#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function read(relativePath) {
  return readFile(join(root, relativePath), 'utf8');
}

async function fileExists(relativePath) {
  try {
    await stat(join(root, relativePath));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function expectMatch(source, pattern, message) {
  assert.match(source, pattern, message);
}

function expectNoMatch(source, pattern, message) {
  assert.doesNotMatch(source, pattern, message);
}

const requiredFiles = [
  'src/otel.ts',
  'src/prometheus.ts',
  'src/loki.ts',
  'src/wasm-logger.ts',
  'src/observability.ts',
  'sdk/go/context.go',
  'sdk/rust-otel/src/lib.rs',
  'sdk/java/src/main/java/cloud/oresoftware/nextloggers/NextLoggers.java',
  'sdk/dart/lib/next_loggers.dart',
  'sdk/erlang/src/next_loggers.erl',
  'sdk/elixir/lib/next_loggers.ex',
];

for (const relativePath of requiredFiles) {
  assert.equal(
    await fileExists(relativePath),
    true,
    `required observability file is missing: ${relativePath}`,
  );
}

const packageJson = JSON.parse(await read('package.json'));
for (const subpath of [
  './otel',
  './prometheus',
  './loki',
  './wasm',
  './observability',
]) {
  assert.ok(packageJson.exports[subpath], `missing package export ${subpath}`);
}
for (const packagedPath of ['sdk', 'contracts', 'docs']) {
  assert.ok(
    packageJson.files.includes(packagedPath),
    `npm package omits ${packagedPath}`,
  );
}
assert.equal(
  packageJson.scripts['test:contracts'],
  'node scripts/test-observability-contracts.mjs',
  'package test:contracts script drifted',
);

const observabilityBarrel = await read('src/observability.ts');
for (const moduleName of ['otel', 'prometheus', 'loki', 'wasm-logger']) {
  expectMatch(
    observabilityBarrel,
    new RegExp(`export \\* from './${moduleName}\\.js'`),
    `observability barrel omits ${moduleName}`,
  );
}

const schemaFiles = [
  'src/base-logger.ts',
  'sdk/go/logger.go',
  'sdk/rust/src/lib.rs',
  'sdk/java/src/main/java/cloud/oresoftware/nextloggers/NextLoggers.java',
  'sdk/dart/lib/next_loggers.dart',
  'sdk/erlang/src/next_loggers.erl',
  'sdk/elixir/lib/next_loggers.ex',
];
for (const relativePath of schemaFiles) {
  expectMatch(
    await read(relativePath),
    /next-loggers\/v1/,
    `${relativePath} drifted from the shared wire schema`,
  );
}

const contextContracts = [
  [
    'sdk/go/context.go',
    /context\.Context/,
    'Go must propagate request context explicitly',
  ],
  [
    'sdk/rust-otel/src/lib.rs',
    /thread_local!\s*\{/,
    'Rust must declare synchronous thread-local context explicitly',
  ],
  [
    'sdk/rust-otel/src/lib.rs',
    /PhantomData<Rc<\(\)>>/,
    'Rust context scopes must remain non-Send and non-Sync',
  ],
  [
    'sdk/java/src/main/java/cloud/oresoftware/nextloggers/NextLoggers.java',
    /ThreadLocal/,
    'Java must use application-owned thread-local context',
  ],
  [
    'sdk/dart/lib/next_loggers.dart',
    /runZoned\(/,
    'Dart and Flutter must propagate context with Zones',
  ],
  [
    'sdk/erlang/src/next_loggers.erl',
    /erlang:get\(/,
    'Erlang must use BEAM process-local context',
  ],
  [
    'sdk/elixir/lib/next_loggers.ex',
    /Process\.get\(/,
    'Elixir must use BEAM process-local context',
  ],
];
for (const [relativePath, pattern, message] of contextContracts) {
  expectMatch(await read(relativePath), pattern, message);
}

const inspectedSources = await Promise.all(
  requiredFiles.map(async (relativePath) => [relativePath, await read(relativePath)]),
);
const forbiddenInstrumentation = [
  [
    /\b(?:globalThis|global|window)\.(?:fetch|setTimeout|setInterval|Promise)\s*=/,
    'global runtime reassignment',
  ],
  [
    /\bconsole\.(?:log|warn|error|debug|info)\s*=/,
    'console method reassignment',
  ],
  [/\.prototype\.[A-Za-z_$][\w$]*\s*=/, 'prototype mutation'],
  [/\bModule\._load\s*=/, 'Node module loader mutation'],
  [/require-in-the-middle|\bshimmer\b/i, 'monkey-patching dependency'],
  [/registerInstrumentations\s*\(/, 'automatic instrumentation registration'],
  [/getNodeAutoInstrumentations\s*\(/, 'Node automatic instrumentation'],
];
for (const [relativePath, source] of inspectedSources) {
  for (const [pattern, label] of forbiddenInstrumentation) {
    expectNoMatch(source, pattern, `${relativePath} contains forbidden ${label}`);
  }
}

const otel = await read('src/otel.ts');
expectNoMatch(
  otel,
  /from\s+['"]@opentelemetry\//,
  'the core OTEL bridge must remain SDK-agnostic',
);
expectNoMatch(
  otel,
  /node:async_hooks/,
  'the OTEL bridge must not own Node AsyncLocalStorage',
);
expectMatch(otel, /failOnStartError/, 'explicit no-op span fallback is missing');
expectMatch(otel, /metricAttributeKeys/, 'metric attribute allowlisting is missing');
expectMatch(otel, /maxAttributeLength/, 'OTEL attribute bounds are missing');
expectMatch(otel, /failOpen/, 'OTEL exporter failure policy is missing');

const prometheus = await read('src/prometheus.ts');
expectMatch(
  prometheus,
  /maxSeriesPerMetric/,
  'Prometheus per-metric cardinality guard is missing',
);
expectMatch(
  prometheus,
  /dropped_series_total/,
  'Prometheus dropped-series self metric is missing',
);
expectMatch(
  prometheus,
  /unexpected Prometheus label/,
  'Prometheus label-schema validation is missing',
);
expectNoMatch(
  prometheus,
  /trace[_-]?id.*label/i,
  'Prometheus must not promote trace IDs to labels',
);

const loki = await read('src/loki.ts');
expectMatch(loki, /RESERVED_LABELS/, 'Loki protected stream labels are missing');
expectMatch(loki, /maxQueueSize/, 'Loki queue bounds are missing');
expectMatch(loki, /AbortController/, 'Loki request timeout cancellation is missing');
expectMatch(
  loki,
  /NonRetryableLokiError/,
  'Loki terminal client-error handling is missing',
);
expectMatch(
  loki,
  /Trace IDs stay in the structured JSON body/,
  'Loki trace-cardinality policy is undocumented in code',
);

const wasm = await read('src/wasm-logger.ts');
expectMatch(
  wasm,
  /TextDecoder\('utf-8', \{ fatal: true \}\)/,
  'WASM UTF-8 validation must be fatal',
);
expectMatch(wasm, /maximumPayloadBytes/, 'WASM payload bounds are missing');
expectMatch(wasm, /outside linear memory/, 'WASM memory bounds are missing');
expectMatch(
  wasm,
  /waitUntil\?\./,
  'WASM host lifecycle integration is missing',
);

const dart = await read('sdk/dart/lib/next_loggers.dart');
expectMatch(dart, /class SupabaseTransport/, 'Dart Supabase transport is missing');
expectMatch(dart, /_freezeMap\(/, 'Dart client records must be deeply frozen');
expectNoMatch(
  dart,
  /service_role|SUPABASE_SERVICE_ROLE/i,
  'client SDK must not embed a Supabase service-role credential',
);

const goContext = await read('sdk/go/context.go');
expectMatch(goContext, /noopSpan/, 'Go tracer-start fallback is missing');
expectMatch(
  goContext,
  /panic\(recovered\)/,
  'Go callback panic identity must be preserved',
);

const rustContext = await read('sdk/rust-otel/src/lib.rs');
expectMatch(
  rustContext,
  /resume_unwind\(payload\)/,
  'Rust callback panic identity must be preserved',
);
expectMatch(rustContext, /NoopSpan/, 'Rust tracer-start fallback is missing');

console.log(
  `observability contracts passed: ${requiredFiles.length} required files, ` +
    `${schemaFiles.length} schema implementations, ` +
    `${forbiddenInstrumentation.length} monkey-patch rules`,
);
