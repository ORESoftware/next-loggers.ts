#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")" && pwd)
cargo fmt --manifest-path "$root/Cargo.toml" -- --check
cargo test --manifest-path "$root/Cargo.toml" --locked
cargo build --manifest-path "$root/Cargo.toml" --target wasm32-unknown-unknown --locked
