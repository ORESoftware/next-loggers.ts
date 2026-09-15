import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(fs.readFileSync(path.join(root, 'COMPATIBILITY.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'MIGRATION.md'), 'utf8');
const consumers = fs.readFileSync(path.join(root, 'CONSUMERS.md'), 'utf8');
const errors = [];
const require = (condition, message) => { if (!condition) errors.push(message); };

require(policy.repository === 'ORESoftware/next-loggers.ts', 'repository mismatch');
require(policy.status === 'compatibility_mirror', 'status must be compatibility_mirror');
require(policy.canonical_repository === 'ores-otel/ores.otel.log', 'canonical repository mismatch');
require(policy.canonical_development_here === false, 'canonical development must stay outside this mirror');
require(pkg.name === policy.root_package.name, 'root package identity drift');
require(pkg.version === policy.root_package.baseline_version, `root package version drift: ${pkg.version}`);
require(pkg.repository?.url === 'git+https://github.com/ores-otel/ores.otel.log.git', 'package repository must point at canonical source');
require(pkg.homepage === 'https://github.com/ores-otel/ores.otel.log#readme', 'package homepage must point at canonical source');
require(pkg.bugs?.url === 'https://github.com/ores-otel/ores.otel.log/issues', 'package bugs URL must point at canonical source');

const sdkRoot = path.join(root, 'sdk');
const sdkDirs = fs.readdirSync(sdkRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const allowed = [...policy.sdk_directories].sort();
require(JSON.stringify(sdkDirs) === JSON.stringify(allowed), `SDK family drift: actual=${sdkDirs.join(',')} allowed=${allowed.join(',')}`);
require(readme.includes('<!-- ores-otel-canonical -->'), 'canonical README marker missing');
require(readme.includes('ores-otel/ores.otel.log'), 'README canonical repository missing');
require(migration.includes('ores-otel/ores.otel.log.git'), 'migration guide canonical remote missing');
require(consumers.includes('ORESoftware/ores-middleware'), 'consumer inventory missing ores-middleware');
require(consumers.includes('github.com/ores-otel/ores.otel.log/sdk/go'), 'consumer inventory missing canonical Go identity');

if (errors.length) {
  for (const error of errors) console.error(`compatibility-remote: ${error}`);
  process.exit(1);
}
console.log('next-loggers compatibility remote: ok');
