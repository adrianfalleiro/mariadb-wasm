#!/usr/bin/env bash
# The wasm benchmark's workload against the native libmariadbd, through the
# same C ABI. Pair with `node tests/wasm/bench.mjs` to see what wasm costs.
#
# Takes a mode argument, default both:
#   sync   the natural native path
#   async  the threaded path the TypeScript package drives, so the two modes
#          separate the cost of wasm from the cost of our own threading
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib/platform.sh"

BUILD="$ROOT/build/native"
tpool_link_args "$BUILD"
LIB="$BUILD/libmysqld/libmariadbd.a"
BIN="$BUILD/bench"
MODES="${1:-sync async}"

if [ ! -f "$LIB" ]; then
  echo "missing $LIB — run 10-build-native-reference.sh first" >&2
  exit 1
fi

# -O2, matching the wasm release profile. The abi-smoke build uses -O1 because
# it is a correctness test and wants readable stacks; measuring at -O1 would
# understate the native side.
"$HOST_CXX" -g -O2 -std=c++17 \
  -DEMBEDDED_LIBRARY -UMYSQL_CLIENT \
  -I "$ROOT/native/include" \
  -I "$ROOT/native/src" \
  -I "$ROOT/mariadb/include" \
  -I "$BUILD/include" \
  "$ROOT/native/src/runtime.cc" \
  "$ROOT/native/src/connection.cc" \
  "$ROOT/native/src/result.cc" \
  "$ROOT/native/src/statement.cc" \
  "$ROOT/tests/native/bench.c" \
  "$LIB" \
  ${TPOOL_LINK_ARGS[@]+"${TPOOL_LINK_ARGS[@]}"} \
  "${HOST_LINK_LIBS[@]}" \
  -o "$BIN"

echo "--- built $BIN ---"

for mode in $MODES; do
  DATADIR="$BUILD/bench-datadir-$mode"
  rm -rf "$DATADIR"
  mkdir -p "$DATADIR"
  "$BIN" "$DATADIR" "$BUILD/sql/share" "$ROOT/mariadb/sql/share/charsets" "$mode"
  echo
done
