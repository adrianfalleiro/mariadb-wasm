#!/usr/bin/env bash
# Phase 7: link the C ABI wrapper against the wasm libmariadbd into a Node
# loadable module.
#
# Done with a direct em++ invocation rather than by adding a target to
# MariaDB's CMake. The wrapper is ours, MariaDB's build system is not, and
# keeping our target outside the vendored tree means the patch series stays
# reviewable and `git diff mariadb/` stays about portability rather than about
# our packaging.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

source "$ROOT/emsdk/emsdk_env.sh" >/dev/null 2>&1

BUILD="$ROOT/build/wasm"
OUT="$ROOT/dist"
LIB="$BUILD/libmysqld/libmariadbd.a"

if [ ! -f "$LIB" ]; then
  echo "missing $LIB — run 04-build-wasm.sh first" >&2
  exit 1
fi

mkdir -p "$OUT"

EXPORTS="$(bash "$ROOT/scripts/gen-exports.sh")"

# ccall/cwrap for the calls themselves; HEAPU8 to read length-delimited values
# without copying twice; FS to stage the datadir; UTF8ToString for the error
# strings and column names.
#
# NODEFS is linked in (-lnodefs.js) so the server's static data — errmsg.sys
# and the charset XML — can be mounted read-only from the host instead of
# baked into a .data bundle with --preload-file. Same mechanism the eventual
# `storage: { type: "node" }` mode needs, and it keeps the artifact set to
# .mjs + .wasm + worker.
RUNTIME_METHODS='["ccall","cwrap","HEAPU8","HEAPU32","UTF8ToString","stringToUTF8","lengthBytesUTF8","FS","NODEFS"]'

# Development profile. Deliberately not tuned for size yet: the brief's
# performance work comes after the differential suite passes, and a stripped
# build would make the first InnoDB failures much harder to read.
#
# EXIT_RUNTIME=0 because this is a library, not a program. There is no main(),
# so with EXIT_RUNTIME=1 Emscripten tears the runtime down the moment control
# returns to the event loop, and the next exported call aborts with "native
# function called after runtime exit". Initialisation deliberately yields to
# the event loop (see mdb_runtime_init_async), so the runtime has to outlive
# it. Node still exits on its own once the pthread workers are gone.
#
# PTHREAD_POOL_SIZE_STRICT=2 turns pool exhaustion into a visible error rather
# than a silent deadlock. InnoDB starts its background threads during
# srv_start, before any query runs, so an undersized pool would otherwise hang
# at init with no output.
#
# Memory is set explicitly, not left to defaults. MariaDB's static data alone
# is ~19.8 MB, over Emscripten's 16 MB default, so the link fails outright
# without this. 128 MB initial is a starting point chosen to cover static data
# plus a 16 MB InnoDB buffer pool without growing during startup - growth is
# comparatively expensive with -pthread, since the heap is a SharedArrayBuffer
# that every worker must re-acquire. Phase 15 measures and tunes it.
em++ -g -O2 -std=c++17 \
  -pthread \
  -DEMBEDDED_LIBRARY -UMYSQL_CLIENT \
  -I "$ROOT/native/include" \
  -I "$ROOT/native/src" \
  -I "$ROOT/mariadb/include" \
  -I "$BUILD/include" \
  "$ROOT/native/src/runtime.cc" \
  "$ROOT/native/src/connection.cc" \
  "$ROOT/native/src/result.cc" \
  "$ROOT/native/src/statement.cc" \
  "$LIB" \
  "$BUILD/tpool/libtpool.a" \
  -sENVIRONMENT=node \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=512MB \
  -sMAXIMUM_MEMORY=2GB \
  -sPTHREAD_POOL_SIZE=16 \
  -sPTHREAD_POOL_SIZE_STRICT=2 \
  -sEXIT_RUNTIME=0 \
  -sFORCE_FILESYSTEM=1 \
  -sASSERTIONS=2 \
  -sSTACK_SIZE=4MB \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  -sEXPORTED_RUNTIME_METHODS="$RUNTIME_METHODS" \
  -lnodefs.js \
  -o "$OUT/mariadb.mjs"

echo "--- artifacts ---"
ls -la "$OUT"
echo "WASM_LINK_DONE"
