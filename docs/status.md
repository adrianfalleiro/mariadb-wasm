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
| 6 — compile-fix loop | done | `mysqlserver` builds for wasm32-emscripten, 0 of 829 targets failing |
| 7 — first linkable module | done | `dist/mariadb.mjs` + `mariadb.wasm`; Node instantiates and calls exports |
| 8 — datadir bootstrap | partial | Empty MEMFS datadir suffices; no packaged template yet |
| 9 — init under wasm | **blocked** | `SELECT 1` passes, but startup deadlocks ~50% of runs |
| 10 — InnoDB under wasm | done, gated on 9 | Full transaction scenario passes when startup wins the race |
| 11+ | not started | |

## Verified behaviour (wasm)

`node tests/wasm/smoke.mjs` — 22 assertions, all passing **on runs where
startup succeeds**, in ~0.5s wall clock:

`SELECT 1`, `CREATE DATABASE`, `CREATE TABLE ... ENGINE=InnoDB` (engine
confirmed via `information_schema`), `INSERT`, exact `DECIMAL(20,4)`,
`VARBINARY` with an embedded NUL, `DATETIME(6)` microseconds,
`START TRANSACTION` / `ROLLBACK` restoring the prior value,
`START TRANSACTION` / `COMMIT` persisting it, duplicate key as `1062`/`23000`,
`mysql_server_end`, and Node exiting on its own with status 0 — no leftover
pthread worker holding the event loop open (criterion 3.2.9).

So the milestone in §29 of the brief is reached: *real MariaDB embedded server
with InnoDB executing inside WebAssembly*. It is not yet dependable.

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

### 2026-08-05 — OPEN: bistable startup deadlock in mysql_server_init

```
Date:        2026-08-05
Phase:       9 (initialise MariaDB under wasm)
Command:     node tests/wasm/smoke.mjs
Symptom:     ~50% of runs never return from mdb_runtime_init. The process
             spins at 99% CPU indefinitely (observed to 180s; killed).
             Successful runs complete the entire scenario in ~0.5s, so this
             is bistable, not slow.
Subsystem:   Emscripten pthreads / MariaDB + InnoDB startup
Category:    THREADING
```

Last event before the stall, from a `-sPTHREADS_DEBUG=1` build, is a worker
handling `updateMemoryViews` or sitting just after `invokeEntryPoint`, with no
further output from any thread.

**Ruled out, each by measurement:**

| Hypothesis | Test | Result |
|---|---|---|
| pthread pool exhaustion | `PTHREAD_POOL_SIZE` 8 → 16 → 32 | Still hangs. Trace shows 11 workers/13 tids needed; `PTHREAD_POOL_SIZE_STRICT=2` never fires, so the pool is not the limit |
| Main thread cannot block (`Atomics.wait` restriction) | Ran the whole module inside a `node:worker_threads` worker (`tests/wasm/smoke-in-worker.mjs`) | 5/10, statistically identical to 4/10 direct |
| Memory growth racing thread startup (em++ warns about `-pthread` + `ALLOW_MEMORY_GROWTH`; heap grew 128→412 MB during init) | `INITIAL_MEMORY=512MB`, verified **0** heap resizes | Still 8/12. Growth eliminated, deadlock remains |
| Slow startup mistaken for a hang | 600s timeout | Successful runs take 0.5s; hung runs never finish |
| Race probability scales with InnoDB's startup thread count | `--innodb-read-io-threads=1 --innodb-write-io-threads=1 --innodb-purge-threads=1` | 6/10, indistinguishable from the baseline |

`INITIAL_MEMORY=512MB` was kept regardless: it removes all startup growth, and
growth under `-pthread` is something em++ explicitly warns about.

**Not yet tried** — in the order worth trying:

1. `-sPROXY_TO_PTHREAD`, the standard remedy for a blocking main thread. Needs
   a `main()` and proxied entry points, since exports called from JS otherwise
   still run on the real main thread. The largest change, and the most likely
   to be correct.
2. Narrow which thread is stuck by instrumenting `tpool`'s
   `create_thread_pool_generic` and InnoDB's `srv_start` directly, rather than
   inferring from Emscripten's trace.
3. Minimal reproducer: N threads spawned from a blocking main thread with the
   same synchronisation shape, to determine whether this is an Emscripten bug
   worth reporting upstream.

`spike/pthread-probe.c` already showed the *steady-state* InnoDB threading
shape works under Emscripten — four workers parked on `pthread_cond_timedwait`,
woken, joined. So the problem is specific to startup, not to threading itself.

---

**Process note.** Two sessions were editing this tree at once, which produced
the contaminated build directory above, logs whose contents changed between
reads, and a `build.ninja` that vanished mid-inspection. Resolved by moving to
a single writer. `build/` and the in-place-patched `mariadb/` checkout are both
shared mutable state with no locking; concurrent builds are not safe.
