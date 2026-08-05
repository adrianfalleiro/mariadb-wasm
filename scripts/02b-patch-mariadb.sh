#!/usr/bin/env bash
# Idempotently apply our MariaDB source patches. See patches/ for rationale.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CML="$ROOT/mariadb/CMakeLists.txt"

python3 - "$CML" <<'PY'
import sys, pathlib

path = pathlib.Path(sys.argv[1])
text = path.read_text()

subs = [
    (
        "IF(CMAKE_CROSSCOMPILING AND NOT DEFINED CMAKE_CROSSCOMPILING_EMULATOR)",
        "IF(CMAKE_CROSSCOMPILING AND (MARIADB_WASM_FORCE_IMPORT_EXECUTABLES OR NOT DEFINED CMAKE_CROSSCOMPILING_EMULATOR))",
    ),
    (
        "IF(NOT CMAKE_CROSSCOMPILING OR DEFINED CMAKE_CROSSCOMPILING_EMULATOR)",
        "IF(NOT CMAKE_CROSSCOMPILING OR (DEFINED CMAKE_CROSSCOMPILING_EMULATOR AND NOT MARIADB_WASM_FORCE_IMPORT_EXECUTABLES))",
    ),
]

for old, new in subs:
    if new in text:
        print(f"already applied: {old[:50]}...")
        continue
    if old not in text:
        sys.exit(f"PATCH FAILED - anchor not found: {old}")
    text = text.replace(old, new, 1)
    print(f"applied: {old[:50]}...")

path.write_text(text)
PY

echo "PATCH_DONE"
