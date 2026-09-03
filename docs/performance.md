# Performance

Measured with `node tests/wasm/bench.mjs` on the development host
(macOS 26.5.2, arm64, Node 26.5.0), release profile. Numbers are indicative of
one machine, not a benchmark claim.

| Measurement | Value |
|---|---|
| `mariadb.wasm` | 12.1 MB |
| `mariadb.mjs` | 0.13 MB |
| server create (module load + MariaDB init) | ~180 ms |
| first connection | 0.1 ms |
| first query | ~6 ms |
| 1000 × `SELECT 1` | ~35 ms |
| 1000 prepared inserts (autocommit) | ~215 ms (was ~43 ms — see below) |
| 1000 inserts in one transaction | ~50 ms (was ~23 ms) |
| read 2000 rows | ~7 ms |
| 1000 indexed point lookups | ~60 ms (was ~26 ms) |
| connection close | 0.1 ms |
| **server close** | **~110–220 ms** (was 5119 ms) |
| full package suite (43 tests) | **3.9 s** (was 42.8 s) |

## A deliberate cost: everything that reaches the server runs on its own thread

Every call that reaches MariaDB — query, prepare, execute — is submitted to a
worker thread and polled from the event loop. A query round trip measures
~77 µs that way against ~20 µs synchronous. That is paid on purpose.

A blocking call owns the JavaScript thread. Two connections contending for a
row lock could therefore never resolve — the holder cannot reach its COMMIT
while the waiter blocks — so lock waits could only ever time out, and deadlock
cycles could not form at all. It also keeps the main thread free to service
MariaDB's proxied filesystem syscalls, which is the hazard that made startup a
coin flip.

`setImmediate`, not `setTimeout`: Node clamps even `setTimeout(0)` to about a
millisecond, which measured **1156 ms** for the same 1000 queries against 77 ms.

### What that cost is, for prepared statements

Prepared statements pay it twice. `execute()` with parameters prepares a fresh
statement, executes it, and closes it, so a call that used to be two blocking
round trips is now two threaded ones: ~215 µs against ~43 µs, and the same
factor shows up in point lookups and in transactional inserts.

That is a real regression on parameterised throughput and it is worth being
plain about. It buys the thing the row-locking tests in
`package/test/concurrency.test.ts` now demonstrate through `execute()` rather
than only through `query()` — two connections genuinely contending on
parameterised SQL, which is what most callers actually write.

The obvious way to get it back is a **persistent worker per connection** taking
work from a queue, instead of a fresh `pthread_create` per call. That would
help the plain query path by the same mechanism, and it is the only reason a
call costs tens of microseconds rather than a few. Not done, and not required
by anything yet.

A statement cache keyed on SQL text would remove the prepare round trip
entirely for repeated statements. It is the larger win of the two and the
larger change, since it has to decide when a cached statement is stale.

## Shutdown

It was 5.1 seconds, flat, and dwarfed everything else — a suite with a server
per file paid it once per file.

It was not InnoDB: `innodb-fast-shutdown` 0, 1 and 2 all measured 5.1 s.
Splitting `close()` showed `mysql_server_end` taking all of it and thread
termination taking 0 ms, and MariaDB names the cause itself once stderr is
visible:

```
Error in my_thread_global_end(): 1 threads didn't exit
```

`my_thread_global_end` waits `my_thread_end_wait_time` seconds — default 5 —
for `THR_thread_count` to reach zero.

**The thread was the one running `mdb_runtime_init_async`.** `mysql_server_init`
registers its calling thread with mysys via `my_thread_init`, and that thread
then exited without calling `my_thread_end`, so the count never reached zero.
Natively the same code is invisible: init runs on the thread that later calls
`mysql_server_end`, and `my_end` unregisters it there. Only the wasm build
moves init onto a thread of its own, which is what turned an implicit
registration into a leak.

Ending the thread properly costs nothing measurable — shutdown is ~110–220 ms
with the wait enabled, the same bimodal spread it had with the wait skipped, so
the wait itself is not on the critical path once the count reaches zero. The
workaround of forcing the wait to 0 has been removed, and MariaDB's default is
back in place: a shutdown that waits is the one that establishes there is
nothing still running, which matters because MariaDB deliberately skips
destroying its global mutexes when the wait times out.

`mdb_runtime_set_shutdown_wait_seconds` is kept so the wait can still be
bounded, and `tests/wasm/smoke.mjs` plus `package/test/shutdown.test.ts` fail if
a straggler ever comes back — otherwise the symptom is just five silent seconds
that read as "wasm is slow".

## Not yet done, in the brief's order

1. **Remove unused plugins.** Performance Schema is compiled in and disabled at
   runtime; wolfSSL, the feedback plugin and `auth_socket` are all inert. These
   are the obvious artifact-size wins and are listed in `docs/plugin-matrix.md`.
2. **Template datadir.** Not applicable yet — the datadir starts empty, which
   is why creation is already ~177 ms.
3. **Buffer pool and log sizes.** 16 MB buffer pool; log size left at MariaDB's
   default, which is worth measuring since redo logs live in MEMFS and so cost
   heap.
4. **Batch result transfer.** Each cell currently crosses the boundary with two
   `ccall`s plus a copy. Reading 2000 rows takes ~7 ms, so this is not yet
   where the time goes.
5. **Release optimisation.** Done — `-O2`, assertions off.

## Memory

Memory is the constraint that bites first when scaling test workers, so it was
measured rather than estimated. Two causes, both fixed, each found by
bisection rather than guesswork.

**MariaDB's cache defaults.** `key_buffer_size` and `aria_pagecache_buffer_size`
are 128 MB each — sized for a dedicated database host. Together they accounted
for ~290 MB of wasm heap before a single query ran. Setting them to 1 MB and
8 MB takes the heap after initialisation from 479 MB to 192 MB. Isolated one at
a time: each was worth ~147 MB, and the table caches were worth nothing.
They are pure caches, so this changes performance, not behaviour.

**Pooled pthread workers.** Each is a Node `worker_thread` with its own V8
isolate, costing ~25 MB of RSS whether used or not. MariaDB needs ~11 threads
to start; anything beyond the pool is created on demand at the cost of an
event-loop round trip.

| `PTHREAD_POOL_SIZE` | RSS after init | server create |
|---|---|---|
| 4 | 305 MB | 990 ms |
| **8** | **344 MB** | **260 ms** |
| 16 | 592 MB | 175 ms |

8 takes nearly all the memory saving for a fraction of the startup cost, and
query throughput is unaffected at every size.

Together:

| | before | after |
|---|---|---|
| first instance | 908 MB | 508 MB |
| each additional instance | ~550 MB | ~230 MB |
| four concurrent instances | 2574 MB | 1222 MB |

Still open: **memory is not returned on close** — closing four instances gives
back only ~85 MB. The `SharedArrayBuffer` and the worker isolates are probably
waiting on GC. It has not been chased, and it matters for a long-lived runner
that creates and destroys many servers in one process.
