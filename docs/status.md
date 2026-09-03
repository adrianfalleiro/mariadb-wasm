# Status

Running log. Newest entries at the bottom of each section.

## Phase state

| Phase | State | Exit condition |
|---|---|---|
| 0 — inspect and pin | done | Revision pinned, embedded target and merge set identified — `docs/source-inventory.md` |
| 1 — native `libmariadbd` | done | Builds; smoke test passes the InnoDB transaction scenario |
| 2 — C ABI | done | 63 assertions pass natively through the wrapper |
| 3 — host generators | done | 6 host-native tools imported; no wasm generator is executed |
| 4 — Emscripten toolchain | done | Ninja graph generated with `CMAKE_C_COMPILER=emcc`, asserted by the script |
| 5 — plugin surface | done | `docs/plugin-matrix.md`; no dynamic plugins produced |
| 6 — compile-fix loop | done | 0 of 829 targets failing |
| 7 — first linkable module | done | `dist/mariadb.mjs` + `mariadb.wasm`; Node instantiates and calls exports |
| 8 — datadir bootstrap | done | 620 KB reproducible template with the `mysql.*` system tables, cloned into MEMFS per instance — `scripts/06-build-datadir-template.sh` |
| 9 — init under wasm | done | Initialises, queries, shuts down cleanly; 25/25 consecutive runs |
| 10 — InnoDB under wasm | done | Full transaction scenario, deterministic |
| 11 — TypeScript API | done | The brief's worked example runs verbatim; 25 package tests |
| 12 — worker ownership | done | Direct and inside `worker_threads`; both green, public API unchanged |
| 13 — differential suite | done | 97 statements across 14 cases agree, with a negative control |
| 14 — runner integration | done | Four concurrent servers isolated; helpers added |
| 15 — performance | partial | Shutdown fixed properly (23–45×, thread identified); plugin trimming not done, and the async statement path costs parameterised throughput — `docs/performance.md` |
| 16 — CI | **portable, still unverified** | The macOS assumptions are gone — `scripts/lib/platform.sh` selects compiler, link libraries and SDK flags per host, and both branches are exercised. The workflow has still never executed |

## Remaining gaps

Honest list of what an acceptance review would still find:

- **Named time zones.** `mysql.time_zone*` exist but are empty; loading
  zoneinfo needs `mysql_tzinfo_to_sql` and the host OS database. Numeric
  offsets work. `CONVERT_TZ` with a named zone returns NULL, which is
  MariaDB's own behaviour for an unknown zone.
- **Grants are inert.** The privilege tables exist, but the server runs with
  `--skip-grant-tables`, so `GRANT`/`REVOKE` parse and store without being
  enforced.
- **Locking is verified, but only against InnoDB's documented contract, not
  differentially.** `SELECT ... FOR UPDATE`, lock waits that resolve, 1205
  timeouts, 1213/40001 deadlock detection with a single victim, REPEATABLE
  READ vs READ COMMITTED, and four concurrent writers all pass under wasm —
  see `package/test/concurrency.test.ts`. The differential runner is
  single-connection, so none of it is compared byte-for-byte against native.
- ~~One MariaDB thread never exits at shutdown.~~ **Closed.** It was the
  thread running `mdb_runtime_init_async`: `mysql_server_init` registers its
  caller with mysys, and that thread exited without calling `my_thread_end`.
  It now does, `THR_thread_count` reaches zero, and MariaDB's default wait is
  back in place instead of being forced to 0. See the failure log below.
- ~~Blocking ABI calls exposed to the filesystem-proxying deadlock.~~
  **Closed.** Query, prepare and execute all run on a worker thread with the
  package polling from the event loop, so nothing that reaches MariaDB runs on
  the thread that owns the filesystem. The cost is real and measured:
  parameterised statements went from ~43 µs to ~215 µs per call, because each
  now makes two threaded round trips instead of two blocking ones. See
  `docs/performance.md` for the two ways to get it back.
- **Memory is not returned on close.** Closing four instances gives back only
  ~85 MB of 1.2 GB. Per-instance cost is down 53% (see `docs/performance.md`),
  but a long-lived runner creating and destroying many servers will still
  accumulate.
- ~~`dist/` ships no licence notices.~~ **Closed.** `dist/licenses/` now
  carries the GPLv2, LGPL 2.1, wolfSSL and zlib texts plus MariaDB's
  THIRDPARTY, with a README naming each component. The *review* in
  `docs/licensing.md` is still outstanding — the notices are the mechanical
  part of the obligation, not the legal one.
- **CI has never been executed.** The macOS assumptions are gone — host
  differences live in `scripts/lib/platform.sh` and both branches are
  exercised — but the workflow itself has still never run, so every result
  quoted in this repository comes from a single macOS arm64 host.

## Verified behaviour (wasm)

`node tests/wasm/smoke.mjs` — 37 assertions, all passing, in ~0.5s wall
clock, 15/15 consecutive runs (plus 10/10 inside a `worker_threads` worker):

`SELECT 1`, `CREATE DATABASE`, `CREATE TABLE ... ENGINE=InnoDB` (engine
confirmed via `information_schema`), `INSERT`, exact `DECIMAL(20,4)`,
`VARBINARY` with an embedded NUL, `DATETIME(6)` microseconds,
`START TRANSACTION` / `ROLLBACK` restoring the prior value,
`START TRANSACTION` / `COMMIT` persisting it, duplicate key as `1062`/`23000`,
prepared statements through both the synchronous and the threaded ABI with
identical values, a second call on a busy connection refused with
`MDB_ERR_BAD_STATE`, `mysql_server_end` with MariaDB's thread wait left at its
default and no straggler reported, and Node exiting on its own with status 0 —
no leftover pthread worker holding the event loop open (criterion 3.2.9).

So the milestone in §29 of the brief is reached: *real MariaDB embedded server
with InnoDB executing inside WebAssembly*.

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
             configuring and (b) asserts the toolchain afterwards.
             Note on where to check, since the first attempt got this wrong:
             when a toolchain file sets the compiler, CMake does NOT write
             CMAKE_C_COMPILER to CMakeCache.txt at all - it goes to
             CMakeFiles/<ver>/CMakeCCompiler.cmake. A cached
             CMAKE_C_COMPILER:FILEPATH is itself the smell, since it means
             CMake ran its own search and found the host toolchain. The
             end-to-end assertion is that build.ninja contains no host
             compiler invocation, which is what ninja actually executes.
Semantics:   None.
Category:    BUILD_DETECTION
Test:        The three assertions at the end of scripts/03-configure-wasm.sh
Commit:      (wasm configure hardening commit)
```

### 2026-08-05 — RESOLVED: bistable startup deadlock in mysql_server_init

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
woken, joined. So the problem was specific to startup, not to threading itself.

**Root cause.** Emscripten keeps the filesystem in the *main thread's*
JavaScript heap. MEMFS nodes are ordinary JS objects, and a worker's JS heap is
separate, so a threaded build proxies syscalls to the main thread when a
pthread makes them — 54 of them in this build, `openat`, `write`, `fstat` and
the rest. InnoDB creates and writes its system tablespace and redo logs from
background threads during `srv_start`. Calling `mysql_server_init` on the main
thread therefore blocks the one thread that has to service those proxied calls,
against the very threads it is waiting for.

It was bistable rather than always-hung because Emscripten's main thread does
pump the proxy queue while parked in some futex waits, so whether it deadlocked
depended on which wait it happened to be in when InnoDB's first background I/O
arrived. That also explains why pool size, worker topology, memory growth and
InnoDB thread count all failed to move the needle: none of them changes the
fact that the main thread is blocked.

**Fix**, in two parts:

1. `mdb_runtime_init_async` + `mdb_runtime_init_poll` run initialisation on a
   dedicated pthread. JavaScript polls from its event loop, so the main thread
   stays free to service proxied filesystem calls. `mdb_runtime_init` is kept
   for native callers, which have no such constraint.
2. `-sEXIT_RUNTIME=0`. With no `main()`, `EXIT_RUNTIME=1` tears the runtime
   down as soon as control returns to the event loop, so the first poll aborted
   with "native function called after runtime exit". Yielding to the event loop
   is the entire point of the fix, so the runtime has to survive it.

Result: 25/25 consecutive runs direct, 10/10 inside a `worker_threads` worker,
against 4/10 before. Node still exits on its own, so the fix did not come at
the cost of criterion 3.2.9.

**Consequence for later phases.** Any ABI call that blocks while InnoDB
background threads do I/O has the same exposure. Initialisation is the worst
case by far, and queries have been stable in every run so far, but the durable
answer is the Phase 12 topology: run every MariaDB call on a dedicated thread
and never block the thread that owns the filesystem.

### 2026-08-15 — RESOLVED: the thread that never exited at shutdown

```
Date:        2026-08-15
Phase:       15 (performance) / 9 (init under wasm)
Command:     node tests/wasm/smoke.mjs, with the shutdown wait left at default
Symptom:     Every shutdown cost a flat ~5.1s and MariaDB printed
             "Error in my_thread_global_end(): 1 threads didn't exit".
             Worked around since Phase 15 by forcing the wait to 0.
Subsystem:   mysys thread registration
Category:    THREADING
```

**Isolating it.** The count is exactly 1, and a scenario that only initialises
and shuts down — no connection, no query — reports the same 1. That rules out
the query path and points at initialisation. The async query worker was already
pairing `mysql_thread_init` with `mysql_thread_end`, and adding a query to the
scenario did not add a second straggler, which confirms the pairing works and
that the leak predates any query.

**Root cause.** `my_thread_init` increments `THR_thread_count`, `my_thread_end`
decrements it, and `my_thread_global_end` waits for zero. `mysql_server_init`
registers *its calling thread* — the registration is implicit, not from an
explicit `mysql_thread_init`, which is why it was easy to miss. Under wasm that
call happens on the dedicated thread from `mdb_runtime_init_async`, which
returned and exited without ever unregistering.

Natively the same code leaks nothing: init runs on the thread that later calls
`mysql_server_end`, and `my_end` unregisters it there. The bug existed only in
the build where init was moved off the main thread — which was itself the fix
for the startup deadlock above.

```
Correction:  mysql_thread_end() at the end of async_init_entry, before the
             completion state is published. my_thread_end is guarded on the
             thread actually being registered, so it is a no-op on the path
             where mysql_server_init failed.
Semantics:   None. The wait is now left at MariaDB's default rather than
             forced to 0, so shutdown establishes that nothing is still
             running instead of merely declining to check.
Test:        tests/wasm/smoke.mjs asserts no "threads didn't exit" and that
             shutdown stays under 2.5s; package/test/shutdown.test.ts asserts
             the same through the TypeScript API, including after the async
             statement path has been exercised.
Measured:    shutdown 5216ms -> 110-220ms, with the wait enabled in both the
             before and after case.
```

---

**Process note.** Two sessions were editing this tree at once, which produced
the contaminated build directory above, logs whose contents changed between
reads, and a `build.ninja` that vanished mid-inspection. Resolved by moving to
a single writer. `build/` and the in-place-patched `mariadb/` checkout are both
shared mutable state with no locking; concurrent builds are not safe.
