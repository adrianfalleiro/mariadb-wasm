#!/usr/bin/env bash
# Step 1 of MariaDB's official cross-compile flow: build the build-time helper
# tools (comp_err, gen_lex_hash, gen_lex_token, ...) natively for macOS/arm64.
# These generate source files consumed by the wasm build, so they must run on
# the host. Produces build/host/import_executables.cmake.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export PATH="/opt/homebrew/opt/bison/bin:$PATH"

BUILD="$ROOT/build/host"
mkdir -p "$BUILD"
cd "$BUILD"

cmake "$ROOT/mariadb" \
  -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DWITH_UNIT_TESTS=OFF

ninja import_executables

echo "--- import_executables.cmake ---"
cat "$BUILD/import_executables.cmake"
echo "HOST_TOOLS_DONE"
