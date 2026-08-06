#!/usr/bin/env bash
# Step 2 of the cross-compile flow: configure the embedded server (libmariadbd)
# for wasm32-emscripten, reusing the native helper tools from step 1.
#
# Toolchain note: Emscripten (not wasi-sdk). We need pthreads — InnoDB and the
# server core spawn background threads unconditionally, so a threadless target
# like wasm32-wasip1 is a non-starter. Emscripten backs pthreads with
# worker_threads + SharedArrayBuffer on Node.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib/platform.sh"
require_bison_3

source "$ROOT/emsdk/emsdk_env.sh" >/dev/null 2>&1

HOST_TOOLS="$ROOT/build/host/import_executables.cmake"
if [ ! -f "$HOST_TOOLS" ]; then
  echo "missing $HOST_TOOLS — run 02-build-host-tools.sh first" >&2
  exit 1
fi

BUILD="$ROOT/build/wasm"

# Always configure from scratch. A build dir left behind by an aborted
# configure can end up with a CMakeCache naming the *host* compiler while
# CMAKE_SYSTEM_NAME still says Emscripten. That state builds — with
# /usr/bin/cc against the wasm my_config.h — and the resulting errors
# (missing <crypt.h>, and other emscripten-only headers) read like genuine
# portability problems. Reconfiguring is cheap; the wild goose chase is not.
rm -rf "$BUILD"
mkdir -p "$BUILD"
cd "$BUILD"

# -pthread must be on compile AND link for emscripten.
FLAGS="-pthread -O2 -fno-strict-aliasing"

# _GNU_SOURCE: MariaDB sets this from cmake/os/Linux.cmake, which the Emscripten
# platform never reaches. It is not Linux-specific in practice — emscripten's
# musl-derived headers use it as the standard gate for the same extensions, and
# without it pthread_getattr_np is detected by the link test (the symbol does
# exist) but left undeclared by <pthread.h>, so mysys/my_stack.c fails to
# compile. Defining it keeps real thread stack bounds, which the SQL parser's
# recursion guard depends on, instead of MariaDB's approximate fallback.
#
# ENABLE_DTRACE: cmake/dtrace.cmake turns this on because the *host* has
# /usr/sbin/dtrace, then generates a Darwin-flavoured probes header whose
# `__asm__ volatile(".reference ...")` cannot be assembled for wasm. DTrace
# probes are observability only, so switching them off costs nothing here.

emcmake cmake "$ROOT/mariadb" \
  -G Ninja \
  -DMARIADB_WASM_FORCE_IMPORT_EXECUTABLES=ON \
  -DMARIADB_WASM_NO_CURSES=ON \
  -DIMPORT_EXECUTABLES="$HOST_TOOLS" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="$FLAGS" \
  -DCMAKE_CXX_FLAGS="$FLAGS" \
  -D_GNU_SOURCE=1 \
  -DENABLE_DTRACE=OFF \
  -DWITH_EMBEDDED_SERVER=ON \
  -DWITH_UNIT_TESTS=OFF \
  -DWITH_SSL=bundled \
  -DCONC_WITH_SSL=NONE \
  -DWITH_ZLIB=bundled \
  -DWITH_PCRE=bundled \
  -DWITHOUT_DYNAMIC_PLUGINS=ON \
  -DPLUGIN_COLUMNSTORE=NO \
  -DPLUGIN_ROCKSDB=NO \
  -DPLUGIN_MROONGA=NO \
  -DPLUGIN_SPIDER=NO \
  -DPLUGIN_CONNECT=NO \
  -DPLUGIN_OQGRAPH=NO \
  -DPLUGIN_SPHINX=NO \
  -DPLUGIN_TOKUDB=NO \
  -DPLUGIN_S3=NO \
  -DPLUGIN_AUTH_PAM=NO \
  -DPLUGIN_AUTH_GSSAPI=NO \
  -DPLUGIN_CRACKLIB_PASSWORD_CHECK=NO \
  2>&1 | tee "$BUILD/configure.log"

# Assert we actually cross-compiled. A configure that falls back to the host
# compiler still "succeeds", and then every later error is a lie: the host cc
# gets pointed at the wasm my_config.h, so it reports missing <crypt.h> and
# other headers that exist in the emscripten sysroot but not in the macOS SDK.
# Those read as genuine portability work and are not.
#
# Note on where to look: when a toolchain file sets CMAKE_C_COMPILER, CMake
# does *not* write it to CMakeCache.txt — it lands in
# CMakeFiles/<ver>/CMakeCCompiler.cmake instead. A cached
# CMAKE_C_COMPILER:FILEPATH is itself the smell, because it means CMake ran its
# own compiler search and found the host toolchain.
test -f "$BUILD/build.ninja" || {
  echo "FATAL: configure produced no build.ninja" >&2
  exit 1
}

DETECTED=$(grep -hE '^set\(CMAKE_C_COMPILER ' "$BUILD"/CMakeFiles/*/CMakeCCompiler.cmake 2>/dev/null | head -1)
case "$DETECTED" in
  *emsdk*emcc*) echo "toolchain OK: $DETECTED" ;;
  *)
    echo "FATAL: configure did not use emcc. Got: ${DETECTED:-<none>}" >&2
    echo "Delete $BUILD and re-run; do not run a second build concurrently." >&2
    exit 1 ;;
esac

# The end-to-end invariant, and the one that would have caught the contaminated
# build dir directly: nothing in the generated build may invoke the host
# compiler. Checked against build.ninja rather than against any intermediate,
# because build.ninja is what ninja actually executes.
if grep -q "CommandLineTools/usr/bin/cc \|/usr/bin/clang " "$BUILD/build.ninja"; then
  echo "FATAL: build.ninja invokes the host compiler" >&2
  grep -o "[^ ]*usr/bin/cc " "$BUILD/build.ninja" | sort -u | head >&2
  exit 1
fi

echo "WASM_CONFIGURE_DONE"
