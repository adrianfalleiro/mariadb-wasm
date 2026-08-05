# Build

Two independent tracks. The `0x` series produces the wasm artifact; the `1x`
series produces the native reference the wasm build is validated against.
Neither is optional — the native reference is what makes a wasm failure
diagnosable.

## Prerequisites

```bash
brew install bison ninja cmake
```

Bison must be 3.x. macOS ships 2.3, which cannot build the SQL parser; the
scripts prepend `/opt/homebrew/opt/bison/bin` to `PATH` themselves.

## One-time fetch

```bash
bash scripts/00-fetch-emsdk.sh      # emsdk, ~1.7 GB
bash scripts/01-fetch-mariadb.sh    # MariaDB 11.4.4 + Connector/C, ~430 MB
bash scripts/02b-patch-mariadb.sh   # idempotent source patches
```

`02b` is safe to re-run and reports which patches were already applied. Re-run
it after any change to the pinned revision.

## Native reference track

```bash
bash scripts/10-build-native-reference.sh   # libmariadbd.a  (~15 min)
bash scripts/11-run-native-smoke.sh         # 22 assertions, direct libmariadbd
bash scripts/12-run-abi-smoke.sh            # 39 assertions, through the C ABI
```

Both smoke tests create and destroy their own datadir under `build/native/`.

## Wasm track

```bash
bash scripts/02-build-host-tools.sh   # native comp_err, gen_lex_hash, ...
bash scripts/03-configure-wasm.sh     # emcmake configure  (~10 min)
bash scripts/04-build-wasm.sh         # ninja mysqlserver
bash scripts/05-link-wasm-module.sh   # em++ link -> dist/mariadb.mjs
node tests/wasm/smoke.mjs
```

`03` deletes and recreates `build/wasm` every time. That is deliberate: a
half-configured directory can end up naming the host compiler while
`CMAKE_SYSTEM_NAME` still says `Emscripten`, which then builds with
`/usr/bin/cc` against the wasm `my_config.h` and reports missing headers that
look like real porting work. The script asserts, after configuring, that
`emcc` was used and that nothing in `build.ninja` invokes the host compiler.

The configure is slow because Emscripten links a real `.js` for every
`CHECK_FUNCTION_EXISTS`. That is worth keeping — it is what makes the detection
results honest, rather than the false positives a compile-only
`CMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY` would produce.

## Do not run two builds at once

`build/` and the in-place-patched `mariadb/` checkout are shared mutable state
with no locking. Two concurrent builds corrupt each other in ways that surface
as impossible compiler errors. See the failure log in `docs/status.md`.

## Why the two extra link inputs

`libmariadbd.a` is not self-contained. `libtpool.a` must be linked alongside it
— see `docs/source-inventory.md`. Both smoke-test scripts and the wasm link do
this explicitly.

## Exports

`scripts/gen-exports.sh` derives the Emscripten `EXPORTED_FUNCTIONS` list from
`native/include/mariadb_wasm.h`. It is never maintained by hand: a stale list
fails at runtime inside a test worker rather than at build time.
