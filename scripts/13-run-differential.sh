#!/usr/bin/env bash
# Phase 13: build the native differential runner and compare both backends.
#
# Requires the native reference (10-) and the wasm module (04-, 05-) to be
# built already; both are compared as they stand rather than rebuilt here, so
# a failure is never a stale-artifact artefact.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib/platform.sh"

BUILD="$ROOT/build/native"
tpool_link_args "$BUILD"
LIB="$BUILD/libmysqld/libmariadbd.a"
RUNNER="$BUILD/differential-runner"

if [ ! -f "$LIB" ]; then
  echo "missing $LIB — run 10-build-native-reference.sh first" >&2
  exit 1
fi
if [ ! -f "$ROOT/dist/mariadb.mjs" ]; then
  echo "missing dist/mariadb.mjs — run 05-link-wasm-module.sh first" >&2
  exit 1
fi

# Same wrapper sources as the wasm module links, so the two sides differ only
# in the target, never in the code under test.
"$HOST_CXX" -g -O1 -std=c++17 \
  -DEMBEDDED_LIBRARY -UMYSQL_CLIENT \
  -I "$ROOT/native/include" \
  -I "$ROOT/native/src" \
  -I "$ROOT/mariadb/include" \
  -I "$BUILD/include" \
  "$ROOT/native/src/runtime.cc" \
  "$ROOT/native/src/connection.cc" \
  "$ROOT/native/src/result.cc" \
  "$ROOT/native/src/statement.cc" \
  "$ROOT/tests/differential/runner.c" \
  "$LIB" \
  ${TPOOL_LINK_ARGS[@]+"${TPOOL_LINK_ARGS[@]}"} \
  "${HOST_LINK_LIBS[@]}" \
  -o "$RUNNER"

echo "--- built $RUNNER ---"

node "$ROOT/tests/differential/run.mjs"
