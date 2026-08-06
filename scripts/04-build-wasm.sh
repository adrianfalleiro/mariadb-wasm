#!/usr/bin/env bash
# Build the embedded server static library for wasm.
#
# -k 0 (keep going) is deliberate for the spike. The useful question is not
# "what is the first error" but "how many distinct failure classes are there" —
# 5 broken translation units is an afternoon, 500 is a different project. Fail
# fast once the shape is known.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib/platform.sh"

source "$ROOT/emsdk/emsdk_env.sh" >/dev/null 2>&1

TARGET="${1:-mysqlserver}"
cd "$ROOT/build/wasm"

ninja -k 0 "$TARGET"
STATUS=$?

echo "BUILD_EXIT=$STATUS"
exit $STATUS
