#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")" && pwd)
out="$root/.build"
rm -rf "$out"
mkdir -p "$out"

find "$root/src/main/java" "$root/src/test/java" -name '*.java' -print0 \
  | xargs -0 javac --release 17 -Werror -Xlint:all -d "$out"
java -ea -cp "$out" cloud.oresoftware.nextloggers.NextLoggersTest
java -ea -cp "$out" cloud.oresoftware.nextloggers.NextLoggersAdversarialTest
