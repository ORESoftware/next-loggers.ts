import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensions = new Set(['.ts', '.js', '.mjs', '.rs', '.go', '.java', '.erl', '.ex', '.exs', '.dart', '.gleam']);
const ignored = new Set(['node_modules', 'dist', 'build', 'target', '.git']);

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...await sourceFiles(filename));
    } else if (extensions.has(path.extname(entry.name))) {
      results.push(filename);
    }
  }
  return results;
}

test('telemetry integrations contain no automatic instrumentation or runtime monkey patching', async () => {
  const roots = ['src', 'sdk'].map((directory) => path.join(root, directory));
  const files = (await Promise.all(roots.map(sourceFiles))).flat();
  const forbidden = [
    ['automatic instrumentation registration', /registerInstrumentations\s*\(/u],
    ['global tracer provider registration', /setGlobalTracerProvider\s*\(/u],
    ['global meter provider registration', /setGlobalMeterProvider\s*\(/u],
    ['global logger provider registration', /setGlobalLoggerProvider\s*\(/u],
    ['require-in-the-middle hook', /require-in-the-middle/u],
    ['shimmer hook', /(?:from|require\s*\()\s*['"]shimmer['"]/u],
    ['Node module loader interception', /Module\s*\.\s*_load\s*=/u],
    ['prototype replacement', /\.\s*prototype\s*\.[\w$]+\s*=/u],
    ['console replacement', /console\s*\.\s*(?:log|debug|info|warn|error)\s*=/u],
    ['global fetch replacement', /globalThis\s*\.\s*fetch\s*=/u],
  ];

  for (const filename of files) {
    const source = await readFile(filename, 'utf8');
    for (const [description, pattern] of forbidden) {
      assert.equal(
        pattern.test(source),
        false,
        `${description} is forbidden in ${path.relative(root, filename)}`,
      );
    }
  }
});
