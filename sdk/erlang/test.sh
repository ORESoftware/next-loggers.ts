#!/usr/bin/env sh
set -eu
rm -rf build
mkdir -p build
erlc -Werror -o build src/*.erl test/*.erl
erl -noshell -pa build -eval 'case eunit:test(next_loggers_tests, [verbose]) of ok -> halt(0); _ -> halt(1) end.'
