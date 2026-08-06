#!/usr/bin/env bash
# Phase 1: build libmariadbd natively as the behavioural reference.
#
# This is the control for the whole project. Every semantic the wasm build is
# expected to reproduce is first demonstrated here, on a target where nothing
# is emulated. The plugin set deliberately mirrors 03-configure-wasm.sh so the
# differential suite compares like with like.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib/platform.sh"
require_bison_3


BUILD="$ROOT/build/native"
mkdir -p "$BUILD"
cd "$BUILD"

# See 02-build-host-tools.sh for why bundled zlib is load-bearing on macOS.
cmake "$ROOT/mariadb" \
  -G Ninja \
  -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  "${HOST_CMAKE_ARGS[@]}" \
  -DWITH_EMBEDDED_SERVER=ON \
  -DWITH_UNIT_TESTS=OFF \
  -DCONC_WITH_UNITTEST=OFF \
  -DWITH_MARIABACKUP=OFF \
  -DWITH_WSREP=OFF \
  -DWITH_ZLIB=bundled \
  -DWITH_SSL=bundled \
  -DWITH_PCRE=bundled \
  -DPLUGIN_COLUMNSTORE=NO \
  -DPLUGIN_ROCKSDB=NO \
  -DPLUGIN_MROONGA=NO \
  -DPLUGIN_SPIDER=NO \
  -DPLUGIN_CONNECT=NO \
  -DPLUGIN_OQGRAPH=NO \
  -DPLUGIN_SPHINX=NO \
  -DPLUGIN_S3=NO \
  -DPLUGIN_AUTH_PAM=NO \
  -DPLUGIN_AUTH_GSSAPI=NO \
  -DPLUGIN_CRACKLIB_PASSWORD_CHECK=NO \
  2>&1 | tee "$BUILD/configure.log"

ninja mysqlserver

echo "--- libmariadbd ---"
find "$BUILD" -name 'libmariadbd*' -o -name 'libmysqlserver*' | sort
echo "NATIVE_REFERENCE_DONE"
