#!/usr/bin/env sh
set -eu
rm -rf build
mkdir -p build
javac -Xlint:all -Werror -d build $(find src/main/java src/test/java -name '*.java' -print)
java -ea -cp build com.oresoftware.nextloggers.NextLoggersTest
java -ea -cp build com.oresoftware.nextloggers.NextLoggersAdversarialTest
