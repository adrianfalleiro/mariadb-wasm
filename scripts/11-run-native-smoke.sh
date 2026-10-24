#!/usr/bin/env bash
# Phase 1 exit condition: compile tests/native/smoke.c against the native
# libmariadbd.a and run the InnoDB transaction scenario end to end.
#
# Compiled by hand rather than through MariaDB's CMake so the link line stays
# visible — the set of libraries libmariadbd.a does *not* already contain is
# exactly the set the wasm link will have to account for.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib/platform.sh"

BUILD="$ROOT/build/native"
tpool_link_args "$BUILD"
# libmariadbd.a is NOT self-contained: libmysqld/CMakeLists.txt attaches tpool
# to sql_embedded with LINK_PRIVATE, so MERGE_LIBRARIES never folds it in and
# every consumer has to supply it. InnoDB's whole background-task layer
# (page cleaner, purge, simulated AIO) lives there, so the failure is ~15
# undefined tpool symbols rather than something that names the real cause.
LIB="$BUILD/libmysqld/libmariadbd.a"
BIN="$BUILD/native-smoke"
DATADIR="${SMOKE_DATADIR:-$BUILD/smoke-datadir}"

if [ ! -f "$LIB" ]; then
  echo "missing $LIB — run 04-build-native-reference.sh first" >&2
  exit 1
fi

# -DEMBEDDED_LIBRARY is what makes <mysql.h> expose the embedded connect path
# and mysql_server_init/end, matching libmysqld/examples/CMakeLists.txt.
"$HOST_CXX" -g -O1 -std=c++17 \
  -DEMBEDDED_LIBRARY -UMYSQL_CLIENT \
  -I "$ROOT/mariadb/include" \
  -I "$BUILD/include" \
  "$ROOT/tests/native/smoke.c" \
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
