#!/bin/sh
set -eu

test -f "$ZED_PKG_TEST_TARGET/.zpkg.toml"
test -f "$ZED_PKG_TEST_TARGET/pubspec.yaml"
test -f "$ZED_PKG_TEST_TARGET/lib/next_loggers.dart"
grep -q '^name: oresoftware_next_loggers$' "$ZED_PKG_TEST_TARGET/pubspec.yaml"
