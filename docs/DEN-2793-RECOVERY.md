# DEN-2793 source recovery receipt

This draft pull request reconstructs the missing-send diagnostics whose original local working tree no longer survived the publication audit.

## Recovery controls

- The recovery branch was created from exact `main` commit `0b2ae1c6cf9be0147ff386f3659a554c3853e666`.
- A one-shot patcher required every upstream marker to match exactly once; drift failed closed.
- The transient patcher and write-enabled bootstrap workflow removed themselves before the source commit was pushed.
- No force-push was used.
- No credentials, environment files, dependency caches, build outputs, or unrelated archives were included.
- Existing `.zpkg.toml` and `.zpkg.lock` remain the package/dependency contract; no runtime dependency was added.

## Verified before publication

- strict TypeScript typecheck and full Node test suite
- Zed package manifest, frozen lock, and smoke contract
- Go formatting and complete module tests
- Python compilation, unit tests, CLI, and flake8 extension contract
- Rust formatting and SDK tests

The permanent pull-request workflow additionally proves that ignoring a Rust `Event` fails compilation under `-D unused-must-use`, while a terminal `.send()` chain compiles.
