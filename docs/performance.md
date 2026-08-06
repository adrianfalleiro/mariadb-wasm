# Performance

Measured with `node tests/wasm/bench.mjs` on the development host
(macOS 26.5.2, arm64, Node 26.5.0), release profile. Numbers are indicative of
one machine, not a benchmark claim.

| Measurement | Value |
|---|---|
| `mariadb.wasm` | 12.1 MB |
| `mariadb.mjs` | 0.13 MB |
| server create (module load + MariaDB init) | ~180 ms |
| first connection | 0.5 ms |
| first query | ~11 ms |
| 1000 × `SELECT 1` | ~30–80 ms, run to run (async path) |
| 1000 prepared inserts (autocommit) | ~43 ms |
| 1000 inserts in one transaction | ~23 ms |
| read 2000 rows | ~7 ms |
| 1000 indexed point lookups | ~26 ms |
| connection close | 0.2 ms |
| **server close** | **~114 ms** (was 5119 ms) |
| full package suite (25 tests) | **3.1 s** (was 42.8 s) |

## A deliberate cost: queries run on their own thread

Every query goes through `mdb_connection_query_async` and is polled from the
event loop, which measures ~77 µs per round trip against ~20 µs for the
synchronous call. That is paid on purpose.

A blocking call owns the JavaScript thread. Two connections contending for a
row lock could therefore never resolve — the holder cannot reach its COMMIT
while the waiter blocks — so lock waits could only ever time out, and deadlock
cycles could not form at all. It also keeps the main thread free to service
MariaDB's proxied filesystem syscalls, which is the hazard that made startup a
coin flip.

`setImmediate`, not `setTimeout`: Node clamps even `setTimeout(0)` to about a
millisecond, which measured **1156 ms** for the same 1000 queries against 77 ms.

## The one optimisation made so far

Shutdown. It was 5.1 seconds, flat, and dwarfed everything else — a suite with
a server per file paid it once per file.

It was not InnoDB: `innodb-fast-shutdown` 0, 1 and 2 all measured 5.1 s.
Splitting `close()` showed `mysql_server_end` taking all of it and thread
termination taking 0 ms, and MariaDB names the cause itself once stderr is
visible:

```
Error in my_thread_global_end(): 1 threads didn't exit
```

`my_thread_global_end` waits `my_thread_end_wait_time` seconds — default 5 —
for `THR_thread_count` to reach zero. Under wasm exactly one
MariaDB-registered thread never calls `my_thread_end`, so the wait always runs
to completion. **Which thread that is has not been identified**, and finding it
is the honest fix; setting the wait to 0 is the pragmatic one, sound here only
because every Emscripten worker is terminated immediately afterwards and the
instance is discarded.

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
