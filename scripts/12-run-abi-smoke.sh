#!/usr/bin/env bash
# Phase 2 exit condition: build the C ABI wrapper against the native
# libmariadbd and run the same scenario as 11-run-native-smoke.sh through it.
#
# The wasm build links these exact sources, so anything failing here is a
# wrapper bug and anything failing only under wasm is a porting bug. Keeping
# those two distinguishable is the reason this test exists separately.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib/platform.sh"

BUILD="$ROOT/build/native"
tpool_link_args "$BUILD"
LIB="$BUILD/libmysqld/libmariadbd.a"
BIN="$BUILD/abi-smoke"
DATADIR="${SMOKE_DATADIR:-$BUILD/abi-smoke-datadir}"

if [ ! -f "$LIB" ]; then
  echo "missing $LIB — run 10-build-native-reference.sh first" >&2
  exit 1
fi

# Some platforms still require a separate tpool archive.
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
  "$ROOT/tests/native/abi_smoke.c" \
  "$LIB" \
  ${TPOOL_LINK_ARGS[@]+"${TPOOL_LINK_ARGS[@]}"} \
  "${HOST_LINK_LIBS[@]}" \
  -o "$BIN"

echo "--- built $BIN ---"

rm -rf "$DATADIR"
mkdir -p "$DATADIR"

"$BIN" \
  "$DATADIR" \
  "$BUILD/sql/share" \
  "$ROOT/mariadb/sql/share/charsets"
