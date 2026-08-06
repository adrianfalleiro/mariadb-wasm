#!/usr/bin/env bash
# Step 1 of MariaDB's official cross-compile flow: build the build-time helper
# tools (comp_err, gen_lex_hash, gen_lex_token, ...) natively for macOS/arm64.
# These generate source files consumed by the wasm build, so they must run on
# the host. Produces build/host/import_executables.cmake.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib/platform.sh"
require_bison_3


BUILD="$ROOT/build/host"
mkdir -p "$BUILD"
cd "$BUILD"

# WITH_ZLIB=bundled is load-bearing, not an optimisation. The system zlib probe
# resolves via stale .pc files to SDKs/MacOSX26.sdk (a symlink to 26.1), and
# CMake then adds that whole usr/include as a plain -I. It lands ahead of the
# -isysroot 26.4 C++ headers, so libc++'s <cstddef> finds 26.1's stddef.h and
# the build dies with "didn't find libc++'s <stddef.h>".
cmake "$ROOT/mariadb" \
  -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  "${HOST_CMAKE_ARGS[@]}" \
  -DWITH_UNIT_TESTS=OFF \
  -DWITH_ZLIB=bundled \
  -DWITH_SSL=bundled

ninja import_executables

echo "--- import_executables.cmake ---"
cat "$BUILD/import_executables.cmake"
echo "HOST_TOOLS_DONE"
