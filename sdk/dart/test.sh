#!/usr/bin/env sh
set -eu
dart pub get
dart format --output=none --set-exit-if-changed lib test
dart analyze --fatal-infos lib test/conformance.dart test/context_shutdown.dart test/adversarial.dart test/next_loggers_test.dart

dart run test/conformance.dart
dart run test/context_shutdown.dart
dart run test/adversarial.dart
dart run test/next_loggers_test.dart
