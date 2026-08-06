#!/usr/bin/env bash
# Phase 7: link the C ABI wrapper against the wasm libmariadbd into a Node
# loadable module.
#
# Done with a direct em++ invocation rather than by adding a target to
# MariaDB's CMake. The wrapper is ours, MariaDB's build system is not, and
# keeping our target outside the vendored tree means the patch series stays
# reviewable and `git diff mariadb/` stays about portability rather than about
# our packaging.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

source "$ROOT/emsdk/emsdk_env.sh" >/dev/null 2>&1

BUILD="$ROOT/build/wasm"
PROFILE="${1:-release}"
OUT="${MARIADB_WASM_DIST:-$ROOT/dist}"
LIB="$BUILD/libmysqld/libmariadbd.a"

if [ ! -f "$LIB" ]; then
  echo "missing $LIB — run 04-build-wasm.sh first" >&2
  exit 1
fi

mkdir -p "$OUT"

EXPORTS="$(bash "$ROOT/scripts/gen-exports.sh")"

# ccall/cwrap for the calls themselves; HEAPU8 to read length-delimited values
# without copying twice; FS to stage the datadir; UTF8ToString for the error
# strings and column names.
#
# NODEFS is linked in (-lnodefs.js) so the server's static data — errmsg.sys
# and the charset XML — can be mounted read-only from the host instead of
# baked into a .data bundle with --preload-file. Same mechanism the eventual
# `storage: { type: "node" }` mode needs, and it keeps the artifact set to
# .mjs + .wasm + worker.
RUNTIME_METHODS='["ccall","cwrap","HEAPU8","HEAPU32","UTF8ToString","stringToUTF8","lengthBytesUTF8","FS","NODEFS","PThread"]'

# Two profiles. Release is the default because ASSERTIONS=2 logs every heap
# resize from every pthread, and those workers do not inherit the Module's
# printErr override — the lines land straight in a consumer's test output with
# no way to silence them from JavaScript.
#
#   release  -O2, no assertions      what the package ships
#   debug    -O1 -g, ASSERTIONS=2    readable stacks, thread and heap tracing
#
# EXIT_RUNTIME=0 because this is a library, not a program. There is no main(),
# so with EXIT_RUNTIME=1 Emscripten tears the runtime down the moment control
# returns to the event loop, and the next exported call aborts with "native
# function called after runtime exit". Initialisation deliberately yields to
# the event loop (see mdb_runtime_init_async), so the runtime has to outlive
# it. Node still exits on its own once the pthread workers are gone.
#
# PTHREAD_POOL_SIZE is a memory-versus-startup trade, measured rather than
# guessed. Each pooled worker is a Node worker_thread with its own V8 isolate,
# costing roughly 25 MB of RSS whether or not it is ever used; MariaDB needs
# about 11 threads to start, and any beyond the pool are created on demand,
# which costs an event-loop round trip each.
#
#   pool=4   305 MB RSS, 990 ms to create a server
#   pool=8   344 MB RSS, 260 ms
#   pool=16  592 MB RSS, 175 ms
#
# 8 takes nearly all of the memory saving for a fraction of the startup cost.
# Query throughput is unaffected at every size. Memory matters more here
# because test runners run several instances at once.
#
# STRICT is 0, not 2. It was 2 while the startup deadlock was being chased, to
# turn pool exhaustion into a visible error rather than a silent hang. That is
# now the wrong trade: every call that could exhaust the pool returns to the
# event loop first, so Emscripten can spawn another worker on demand, and
# aborting instead would turn a survivable moment of load into a crash.
#
# Memory is set explicitly, not left to defaults. MariaDB's static data alone
# is ~19.8 MB, over Emscripten's 16 MB default, so the link fails outright
# without this.
#
# 160 MB covers static data plus a 16 MB buffer pool with room to spare. It
# was briefly 512 MB while the startup deadlock was being chased, on the
# theory that heap growth was racing thread startup; that turned out to be
# wrong (the real cause was filesystem proxying - see docs/status.md), and
# carrying 512 MB per instance would have cost 2 GB for the four-instance
# isolation test. Verified at 15/15 runs after the real fix.
case "$PROFILE" in
  release)
    PROFILE_FLAGS=(-O2 -sASSERTIONS=0)
    ;;
  debug)
    # PTHREADS_DEBUG traces thread lifecycle; it is how the startup deadlock
    # was tracked down, so it stays one flag away.
    PROFILE_FLAGS=(-O1 -g -sASSERTIONS=2 -sPTHREADS_DEBUG=1 -sSTACK_OVERFLOW_CHECK=2)
    ;;
  *)
    echo "unknown profile '$PROFILE' (expected release or debug)" >&2
    exit 1
    ;;
esac

em++ -std=c++17 \
  "${PROFILE_FLAGS[@]}" \
  -pthread \
  -DEMBEDDED_LIBRARY -UMYSQL_CLIENT \
  -I "$ROOT/native/include" \
  -I "$ROOT/native/src" \
  -I "$ROOT/mariadb/include" \
  -I "$BUILD/include" \
  "$ROOT/native/src/runtime.cc" \
  "$ROOT/native/src/connection.cc" \
  "$ROOT/native/src/result.cc" \
  "$ROOT/native/src/statement.cc" \
  "$LIB" \
  "$BUILD/tpool/libtpool.a" \
  -sENVIRONMENT=node \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=160MB \
  -sMAXIMUM_MEMORY=2GB \
  -sPTHREAD_POOL_SIZE=8 \
  -sPTHREAD_POOL_SIZE_STRICT=0 \
  -sEXIT_RUNTIME=0 \
  -sFORCE_FILESYSTEM=1 \
  -sSTACK_SIZE=4MB \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  -sEXPORTED_RUNTIME_METHODS="$RUNTIME_METHODS" \
  -lnodefs.js \
  -o "$OUT/mariadb.mjs"

# Stage the server's static data next to the module so the published package
# is self-contained. errmsg.sys is generated by the host comp_err and lives in
# the build tree; the charset XML is source. Copying both means a consumer
# never has to point at a MariaDB checkout.
rm -rf "$OUT/share" "$OUT/charsets"
mkdir -p "$OUT/share/english"
cp "$BUILD/sql/share/english/errmsg.sys" "$OUT/share/english/errmsg.sys"
cp -R "$ROOT/mariadb/sql/share/charsets" "$OUT/charsets"

# Licence notices. The artifact is statically linked from GPLv2 MariaDB Server
# plus several bundled libraries under their own terms, so the texts travel
# with it. See docs/licensing.md - this satisfies the mechanical part of the
# obligation, not the review.
LICENSES="$OUT/licenses"
rm -rf "$LICENSES"
mkdir -p "$LICENSES"
cp "$ROOT/mariadb/COPYING"             "$LICENSES/MariaDB-COPYING-GPLv2.txt"
cp "$ROOT/mariadb/THIRDPARTY"          "$LICENSES/MariaDB-THIRDPARTY.txt"
cp "$ROOT/mariadb/libmariadb/COPYING.LIB" "$LICENSES/MariaDB-Connector-C-LGPL-2.1.txt"
cp "$ROOT/mariadb/zlib/LICENSE"        "$LICENSES/zlib-LICENSE.txt"
cp "$ROOT/mariadb/extra/wolfssl/wolfssl/COPYING" "$LICENSES/wolfSSL-COPYING-GPLv2.txt"

cat > "$LICENSES/README.md" <<'NOTICE'
# Licence notices

`mariadb.wasm` is statically linked from MariaDB Server and several libraries
bundled with it. Their licence texts are in this directory.

| Component | Licence | File |
|---|---|---|
| MariaDB Server (the embedded server, InnoDB, Aria, MyISAM) | GPLv2 | `MariaDB-COPYING-GPLv2.txt` |
| MariaDB Connector/C | LGPL 2.1 | `MariaDB-Connector-C-LGPL-2.1.txt` |
| wolfSSL | GPLv2 in this configuration | `wolfSSL-COPYING-GPLv2.txt` |
| zlib | zlib licence | `zlib-LICENSE.txt` |
| PCRE2 | BSD | see `MariaDB-THIRDPARTY.txt` |
| Third-party code inside MariaDB | various | `MariaDB-THIRDPARTY.txt` |

The wrapper in `native/`, the package in `package/`, and the build scripts are
original work in this repository.

Because the artifact contains GPLv2 code, distributing it carries source
obligations. MariaDB is fetched from upstream at a pinned tag and every
modification is a reviewable patch in `scripts/02b-patch-mariadb.sh`, so the
corresponding source is reconstructible from this repository — but how the
obligation is discharged for a statically linked WebAssembly artifact has not
been reviewed. See `docs/licensing.md`. Do not publish without doing that.
NOTICE

# Manifest, so an artifact can always be traced back to what produced it.
# Every input that changes the output is recorded; a cache keyed on this
# cannot serve a stale build.
python3 - "$OUT/build-manifest.json" <<MANIFEST
import hashlib, json, pathlib, subprocess, sys

root = pathlib.Path("$ROOT")
out = pathlib.Path(sys.argv[1])

def run(*args):
    try:
        return subprocess.run(args, capture_output=True, text=True,
                              cwd=root).stdout.strip()
    except Exception:
        return "unknown"

# The patch scripts are the portability work, so their content is part of the
# build identity just as much as the MariaDB revision is.
patch_hash = hashlib.sha256()
for name in sorted(["02b-patch-mariadb.sh", "03-configure-wasm.sh",
                    "05-link-wasm-module.sh"]):
    patch_hash.update((root / "scripts" / name).read_bytes())

artifacts = {}
for artifact in ("mariadb.mjs", "mariadb.wasm"):
    path = out.parent / artifact
    if path.exists():
        artifacts[artifact] = {
            "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }

out.write_text(json.dumps({
    "mariadbRevision": run("git", "-C", str(root / "mariadb"), "rev-parse", "HEAD"),
    "mariadbTag": run("git", "-C", str(root / "mariadb"), "describe", "--tags"),
    "emscriptenVersion": (root / "emsdk/upstream/emscripten/emscripten-version.txt")
        .read_text().strip().strip('"'),
    "nodeVersion": run("node", "--version"),
    "cmakeVersion": run("cmake", "--version").splitlines()[0] if run("cmake", "--version") else "unknown",
    "buildType": "$PROFILE",
    "scriptsSha256": patch_hash.hexdigest(),
    "artifacts": artifacts,
}, indent=2) + "\n")
print(f"wrote {out}")
MANIFEST

echo "--- artifacts ---"
ls -la "$OUT"
echo "WASM_LINK_DONE"
