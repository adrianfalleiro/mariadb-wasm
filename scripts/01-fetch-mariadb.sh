#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TAG="${MARIADB_TAG:-mariadb-11.4.4}"

if [ ! -d mariadb/.git ]; then
  git clone --depth 1 --branch "$TAG" https://github.com/MariaDB/server.git mariadb
fi

cd mariadb
# Only the submodules the embedded server actually needs; skip columnstore/rocksdb etc.
git submodule update --init --depth 1 libmariadb || true

echo "--- .gitmodules ---"
cat .gitmodules || true
echo "MARIADB_CLONE_DONE"
