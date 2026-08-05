#!/usr/bin/env bash
# Derive the Emscripten EXPORTED_FUNCTIONS list from the C ABI header.
#
# Generated rather than maintained by hand: a manually kept list drifts, and
# the failure mode is a runtime "function not exported" from inside a test
# worker rather than a build error. The header is the single source of truth.
#
# Prints a JSON array on stdout, e.g. ["_mdb_runtime_init","_mdb_..."].
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HEADER="${1:-$ROOT/native/include/mariadb_wasm.h}"

python3 - "$HEADER" <<'PY'
import json, pathlib, re, sys

text = pathlib.Path(sys.argv[1]).read_text()

# Strip block comments so prose mentioning a function name cannot become an
# export, and so commented-out declarations stay out.
text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)

# Declarations are "<type> mdb_name(" possibly spread over lines.
names = sorted(set(re.findall(r"\b(mdb_[a-z0-9_]+)\s*\(", text)))
if not names:
    sys.exit("no mdb_* declarations found in the ABI header")

# malloc/free are needed to hand strings and argv into the module.
exports = [f"_{name}" for name in names] + ["_malloc", "_free"]
print(json.dumps(exports, separators=(",", ":")))
PY
