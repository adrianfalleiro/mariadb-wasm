# Performance

Measured with `node tests/wasm/bench.mjs` on the development host
(macOS 26.5.2, arm64, Node 26.5.0), release profile. Numbers are indicative of
one machine, not a benchmark claim.

| Measurement | Value |
|---|---|
| `mariadb.wasm` | 12.1 MB |
| `mariadb.mjs` | 0.13 MB |
| server create (module load + MariaDB init) | ~177 ms |
| first connection | 0.5 ms |
| first query | ~11 ms |
| 1000 × `SELECT 1` | ~14 ms |
| 1000 prepared inserts (autocommit) | ~84 ms |
| 1000 inserts in one transaction | ~23 ms |
| read 2000 rows | ~7 ms |
| 1000 indexed point lookups | ~26 ms |
| connection close | 0.2 ms |
| **server close** | **~114 ms** (was 5119 ms) |
| full package suite (25 tests) | **3.1 s** (was 42.8 s) |

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

RSS after the benchmark workload is ~1 GB, which is high and not yet
investigated. `INITIAL_MEMORY` is 160 MB and the heap grows to ~500 MB during
a workload; Node's own overhead and the `SharedArrayBuffer` per instance
account for the rest. Four concurrent instances complete the isolation test on
this host, but memory is the constraint that will bite first when scaling test
workers, and it deserves measurement before anyone raises the worker count.
