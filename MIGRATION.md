# Canonical repository migration

The canonical upstream is now `https://github.com/ores-otel/ores.otel.log.git`.

The preserved legacy remote is `https://github.com/ORESoftware/next-loggers.ts.git`.

For an existing clone:

```sh
git remote rename origin legacy
git remote add origin https://github.com/ores-otel/ores.otel.log.git
git fetch --all --prune --tags
git branch --set-upstream-to=origin/main main
```

The canonical repository was initialized from the complete legacy Git history, including branches and tags.

## TypeScript / JavaScript consumers

Existing consumers of `@oresoftware/next-loggers` may remain pinned while registry/release migration is completed, but new Git/development references and all new implementation work must use the canonical repository. Do not use the legacy GitHub remote as a source for a new branch, submodule, moving tag, or unreleased dependency.

When changing package/release plumbing, preserve the same logical logging/wire contracts and migrate the release source to `ores-otel/ores.otel.log`. Existing package identities are compatibility identities; they do not make this remote canonical.

## Polyglot consumers

Use each contract SDK manifest's `canonicalName` as the destination identity. For example, the legacy Go module identity `github.com/ORESoftware/next-loggers.ts/sdk/go` maps to `github.com/ores-otel/ores.otel.log/sdk/go`. Apply the same rule to Rust, Dart, Gleam, Erlang, Elixir, Python, Ruby, Java, WASM, and Node targets: move development and release authority to the canonical repository while retaining immutable compatibility pins when a registry/module migration cannot be atomic.

Do not create a new SDK language family or release channel in this compatibility mirror. Those additions belong in `ores-otel/ores.otel.log` and should arrive here, if needed at all, only as a reviewed compatibility backport.

## Compatibility fixes

This mirror may accept narrowly scoped security, reproducibility, or canonical-conformance fixes for already-supported consumers. It must not establish a new feature line, SDK family, or release authority. See `COMPATIBILITY.json` and run:

```sh
node scripts/validate-compatibility-remote.mjs
```
