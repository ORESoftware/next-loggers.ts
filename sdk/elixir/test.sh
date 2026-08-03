#!/usr/bin/env sh
set -eu
mix format --check-formatted
mix compile --warnings-as-errors
mix test
