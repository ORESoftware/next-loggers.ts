# Releasing next-loggers

`next-loggers.ts` is one source repository with independent package identities for Zed and each native ecosystem. A language release is selected only by its immutable tag prefix; pushing one language tag does not publish any other registry package.

## Package and tag matrix

| Target | Registry identity | Release tag |
| --- | --- | --- |
| Zed package family | `oresoftware/next-loggers` plus the target packages declared in `.zpkg.toml` | `vX.Y.Z` |
| JavaScript / TypeScript | npm `@oresoftware/next-loggers` | `sdk/nodejs/vX.Y.Z` |
| Python | PyPI `oresoftware-next-loggers` | `sdk/python/vX.Y.Z` |
| Go | `github.com/ORESoftware/next-loggers.ts/sdk/go` | `sdk/go/vX.Y.Z` |
| Rust | crates.io `oresoftware-next-loggers` | `sdk/rust/vX.Y.Z` |
| Rust / WASM | crates.io `oresoftware-next-loggers-wasm` | `sdk/wasm/vX.Y.Z` |
| Java | Maven Central `io.github.oresoftware:next-loggers` | `sdk/java/vX.Y.Z` |
| Dart / Flutter | pub.dev `oresoftware_next_loggers` | `sdk/dart/vX.Y.Z` |
| Ruby | RubyGems `oresoftware-next-loggers` | `sdk/ruby/vX.Y.Z` |
| Gleam | Hex `oresoftware_next_loggers` | `sdk/gleam/vX.Y.Z` |
| Erlang | Hex `oresoftware_next_loggers_erlang` | `sdk/erlang/vX.Y.Z` |
| Elixir | Hex `oresoftware_next_loggers_elixir` | `sdk/elixir/vX.Y.Z` |

The Go tag prefix is part of the Go module protocol for a module rooted in `sdk/go`; do not shorten it to `vX.Y.Z`.

## Version policy

All package metadata currently advances in lockstep even though publication is independent. Before tagging, update the same semantic version in:

- `package.json`, `sdk/nodejs/package.json`, and `.zpkg.toml`
- `sdk/python/pyproject.toml`
- `sdk/rust/Cargo.toml` and `sdk/wasm/Cargo.toml`
- `sdk/java/pom.xml`, including its SCM tag
- `sdk/dart/pubspec.yaml`
- `sdk/ruby/lib/oresoftware/next_loggers/version.rb` and the gemspec
- `sdk/gleam/gleam.toml`
- `sdk/erlang/src/oresoftware_next_loggers_erlang.app.src`
- `sdk/elixir/mix.exs`
- the version exposed by `src/eslint-plugin.ts`

Then run:

```sh
npm ci
npm run release:check
npm run test:polyglot
```

The packaging workflow adds native dry runs for npm, PyPI, Cargo, Maven, pub.dev, RubyGems, and all three Hex packages. It also runs `zed release preflight`, `zed pack`, and a full `zed r2g` consumer roundtrip.

## First-time registry setup

Repository automation cannot claim registry namespaces or create publisher credentials. Configure these once before pushing the first release tag:

### Trusted publishers (OIDC; no long-lived upload token)

Create matching GitHub trusted-publisher records for:

- npm package `@oresoftware/next-loggers`, workflow `release-native.yml`, environment `npm`
- PyPI project `oresoftware-next-loggers`, workflow `release-native.yml`, environment `pypi`
- pub.dev package `oresoftware_next_loggers`, workflow `release-native.yml`, environment `pub.dev`
- RubyGems package `oresoftware-next-loggers`, workflow `release-native.yml`, environment `rubygems`

The initial publication rules differ by registry. In particular, a new pub.dev package must be created and automated publishing must be configured before its OIDC workflow can publish subsequent versions.

### GitHub environments and secrets

Create the environments referenced by the workflows and add only the listed secrets:

| Environment | Secrets |
| --- | --- |
| `zed-pkg` | `ZED_PKG_TOKEN` |
| `crates-io` | `CARGO_REGISTRY_TOKEN` |
| `maven-central` | `CENTRAL_TOKEN_USERNAME`, `CENTRAL_TOKEN_PASSWORD`, `MAVEN_GPG_PRIVATE_KEY`, `MAVEN_GPG_PASSPHRASE` |
| `hex` | `HEX_PUBLISH_KEY` |
| `npm`, `pypi`, `pub.dev`, `rubygems` | no upload secret when trusted publishing is enabled |
| `go-modules` | no secret; publication is the pushed Git tag |

Use environment protection rules for all publishing environments. Limit the Maven and Hex credentials to release scope, and rotate them independently of repository access.

### Maven Central

Verify ownership of the `io.github.oresoftware` namespace in the Central Portal. The POM uses the Central Portal publishing plugin, source and Javadoc attachments, and GPG signing. The workflow imports the private signing key through `actions/setup-java` and uses a Central user token through Maven settings.

### Hex

Zed currently has no native Hex mirror adapter, so Gleam, Erlang, and Elixir remain first-class Zed targets while their Hex uploads are handled explicitly by the tag workflow. The three packages have different Hex names and can be released independently. `HEX_PUBLISH_KEY` must have write access to all three names.

## Creating a release

1. Merge a version bump whose normal CI and `Polyglot packaging` workflow are green.
2. Create only the tags for the registries intended for this release.
3. Push tags without moving or reusing an existing published tag.
4. Inspect the corresponding `Release native package` or `Release Zed packages` run.

Examples:

```sh
# npm only
git tag sdk/nodejs/v0.2.0
git push origin sdk/nodejs/v0.2.0

# Go module only
git tag sdk/go/v0.2.0
git push origin sdk/go/v0.2.0

# Zed package family only
git tag v0.2.0
git push origin v0.2.0
```

To release every registry at the same version, create all applicable tags on the exact same reviewed commit. The workflows serialize native uploads so two registry releases do not mutate shared release state concurrently.

## Failure handling

Never force-move a tag that has triggered a registry upload. Correct the problem, bump the version, rerun all preflight checks, and publish a new tag. A failed job before upload can be rerun after fixing environment configuration; a job that may have uploaded must be checked against the registry before rerunning.
