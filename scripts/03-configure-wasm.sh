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

export PATH="/opt/homebrew/opt/bison/bin:$PATH"
source "$ROOT/emsdk/emsdk_env.sh" >/dev/null 2>&1

HOST_TOOLS="$ROOT/build/host/import_executables.cmake"
if [ ! -f "$HOST_TOOLS" ]; then
  echo "missing $HOST_TOOLS — run 02-build-host-tools.sh first" >&2
  exit 1
fi

BUILD="$ROOT/build/wasm"
mkdir -p "$BUILD"
cd "$BUILD"

# -pthread must be on compile AND link for emscripten.
FLAGS="-pthread -O2 -fno-strict-aliasing"

emcmake cmake "$ROOT/mariadb" \
  -G Ninja \
  -DIMPORT_EXECUTABLES="$HOST_TOOLS" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="$FLAGS" \
  -DCMAKE_CXX_FLAGS="$FLAGS" \
  -DWITH_EMBEDDED_SERVER=ON \
  -DWITH_UNIT_TESTS=OFF \
  -DWITH_SSL=OFF \
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

echo "WASM_CONFIGURE_DONE"
