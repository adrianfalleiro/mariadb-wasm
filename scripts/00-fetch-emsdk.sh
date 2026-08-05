#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -d emsdk/.git ]; then
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git emsdk
fi

cd emsdk
./emsdk install latest
./emsdk activate latest
echo "EMSDK_DONE"
