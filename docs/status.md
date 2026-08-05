# Status

Running log. Newest entries at the bottom of each section.

## Phase state

| Phase | State | Exit condition |
|---|---|---|
| 0 — inspect and pin | done | Revision pinned, embedded target and its merge set identified — `docs/source-inventory.md` |
| 1 — native `libmariadbd` | done | `libmariadbd.a` builds; native smoke test passes the InnoDB transaction scenario |
| 2 — C ABI | not started | Same wrapper builds and passes the native smoke test |
| 3 — host generators | done | `import_executables.cmake` exports 6 host-native tools; target configure resolves them without running wasm |
| 4 — Emscripten toolchain | done | CMake generates a Ninja graph for `mysqlserver` with `CMAKE_C_COMPILER=emcc` |
| 5 — plugin surface | partial | Unrelated engines disabled at configure; `docs/plugin-matrix.md` not yet written |
| 6 — compile-fix loop | in progress | `mysqlserver` links for wasm32-emscripten |
| 7+ | not started | |

## Verified behaviour (native reference)

`scripts/11-run-native-smoke.sh`, 22 assertions, all passing:

- `mysql_server_init` / `mysql_real_connect` (embedded) / `mysql_close` / `mysql_server_end`
- `CREATE DATABASE`, `CREATE TABLE ... ENGINE=InnoDB`, engine verified via `information_schema`
- `affected_rows`, `insert_id`
- `DECIMAL(20,4)` exact round-trip; `VARBINARY` with an embedded NUL; `DATETIME(6)` microseconds
- `START TRANSACTION` / `UPDATE` / `ROLLBACK` restoring the prior value
- `START TRANSACTION` / `UPDATE` / `COMMIT` persisting the new value
- duplicate key surfaces as errno `1062`, SQLSTATE `23000`

This is the behavioural reference for the differential suite in Phase 13.

---

## Failure log

### 2026-08-05 — tpool missing from the embedded archive

```
Date:        2026-08-05
Phase:       1 (native reference)
Command:     bash scripts/11-run-native-smoke.sh
Error:       ld: symbol(s) not found for architecture arm64
             ~15 undefined tpool:: symbols, referenced from srv0srv.cc.o,
             buf0buf.cc.o, buf0flu.cc.o, os0file.cc.o, row0merge.cc.o
Subsystem:   build packaging (InnoDB background tasks)
Root cause:  libmysqld/CMakeLists.txt attaches tpool to sql_embedded with
             LINK_PRIVATE. MERGE_LIBRARIES only folds in the libraries named
             in LIBS, so tpool is never merged into libmariadbd.a and every
             consumer must link tpool/libtpool.a itself. Confirmed by reading
             the POST_BUILD `libtool -static` rule in the generated ninja file:
             libtpool.a is an order-only dep, absent from the merge list.
Correction:  Link tpool/libtpool.a alongside libmariadbd.a. No source change.
Semantics:   None — a link-line fix, nothing narrowed.
Category:    BUILD_DETECTION
Test:        scripts/11-run-native-smoke.sh links and runs
Commit:      (native reference commit)
```

### 2026-08-05 — phantom `crypt.h` failure from a contaminated build dir

```
Date:        2026-08-05
Phase:       6 (wasm compile-fix loop)
Command:     ninja -k 0 mysqlserver   (in build/wasm)
Error:       mariadb/include/my_global.h:337: fatal error: 'crypt.h' file not
             found — in 13 translation units across strings/, sql/, vio/, tpool/
Subsystem:   toolchain, not MariaDB
Root cause:  Not a portability problem. The compile lines showed
             /Library/Developer/CommandLineTools/usr/bin/cc with
             -arch arm64 -isysroot MacOSX26.4.sdk — the *host* compiler, being
             fed the *wasm* my_config.h. That config has HAVE_CRYPT_H=1 because
             the emscripten sysroot does ship crypt.h; the macOS SDK does not.
             build/wasm held a CMakeCache.txt naming the host compiler while
             CMAKE_SYSTEM_NAME still said Emscripten — a state left behind by a
             second process configuring the same directory concurrently.
             CMakeFiles/<ver>/CMakeCCompiler.cmake said emcc while
             CMakeCache.txt said cc, so the two disagreed.
Ruled out:   cmake_minimum_required(2.8.12) vs 3.10 — minimal reproducer picks
             emcc for both. Our -D flag set — bisected in two groups, both pick
             emcc. A bare `emcmake cmake mariadb` also picks emcc.
Correction:  scripts/03-configure-wasm.sh now (a) rm -rf's the build dir before
             configuring and (b) asserts CMAKE_C_COMPILER in CMakeCache.txt is
             emcc, CMAKE_SYSTEM_NAME is Emscripten, and build.ninja exists.
             CMakeCache.txt is the authority — it is what build.ninja is
             generated from — so the cache check is not interchangeable with
             the CMakeCCompiler.cmake one.
Semantics:   None.
Category:    BUILD_DETECTION
Test:        The three assertions at the end of scripts/03-configure-wasm.sh
Commit:      (wasm configure hardening commit)
```

**Process note.** Two sessions were editing this tree at once, which produced
the contaminated build directory above, logs whose contents changed between
reads, and a `build.ninja` that vanished mid-inspection. Resolved by moving to
a single writer. `build/` and the in-place-patched `mariadb/` checkout are both
shared mutable state with no locking; concurrent builds are not safe.
