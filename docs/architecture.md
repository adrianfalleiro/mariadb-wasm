# Architecture

## Why `libmariadbd`

MariaDB already contains an embedded-server build. `libmysqld/CMakeLists.txt`
compiles the SQL layer with `-DEMBEDDED_LIBRARY`, merges it with the support
libraries and statically selected plugins, and emits `libmariadbd.a`. The
client entry points — `mysql_real_connect`, `mysql_real_query`, the statement
API — are all there; `lib_sql.cc` dispatches them in-process instead of onto a
socket.

So the parser, optimizer, execution engine, metadata locking, transaction
manager, handler API and InnoDB are all used unmodified. Nothing in this
project reimplements SQL semantics, and nothing substitutes another database.

MySQL is not an option: its embedded library was deprecated in 5.7 and removed
in 8.0.1. MariaDB is the documented migration path and the only one of the two
with a supported cross-compilation flow (`IMPORT_EXECUTABLES`).

## What is bypassed

Only the external-daemon boundary:

```
socket listener        removed by --skip-networking
wire protocol          never reached; the client half dispatches in-process
network authentication removed by --skip-grant-tables
daemon lifecycle       there is no daemon; the library is the server
```

No TCP listener, Unix socket, or child process is created. `vio` is still
linked because the connector references it, but the embedded path never puts a
byte on a socket.

## Layers

```
node:test / vitest / jest worker
        │
        ▼  package/src — TypeScript, async, one server per wasm instance
   server.ts ── connection.ts ── result-decoder.ts
        │
        ▼  runtime.ts: ccall marshalling, pointers and heap views
   dist/mariadb.mjs (Emscripten loader) + mariadb.wasm
        │
        ▼  native/src — the C ABI, opaque integer handles
   runtime.cc  connection.cc  result.cc  statement.cc
        │
        ▼  libmariadbd.a + libtpool.a
   SQL parser, optimizer, execution, MDL, transactions, handler API, InnoDB
```

The same C ABI sources are compiled into the native reference build, so any
behaviour can be compared against a target where nothing is emulated. That is
what `scripts/13-run-differential.sh` does.

## The C ABI

`native/include/mariadb_wasm.h`. Design points that are load-bearing rather
than stylistic:

- **Opaque generation-tagged handles.** JavaScript holds these across async
  boundaries and will use one after closing it. A bare index would alias
  whatever later reused the slot — a use-after-free that surfaces as a wrong
  answer from the database. The generation tag makes it a deterministic
  `MDB_ERR_BAD_HANDLE`.
- **Length-delimited values everywhere.** Nothing is NUL-terminated, so binary
  columns survive. `NULL` is a null pointer; zero-length is a non-null pointer
  with length 0.
- **Buffered results.** `mysql_store_result`, not `use_result`, so `row_count`
  is available and abandoning iteration mid-loop — which any test that throws
  will do — cannot wedge the connection.
- **No exception crosses the boundary.** Under wasm an escaping exception
  aborts the module and takes the test worker with it, reporting nothing.
- **Column flags and `charsetnr` are exposed.** Type alone cannot distinguish
  `BIGINT` from `BIGINT UNSIGNED`, or `BLOB` from `TEXT`.

## Threading

MariaDB and InnoDB spawn background threads unconditionally — log writer, log
flusher, page cleaner, purge coordinator — and `innodb_purge_threads` has a
minimum of 1. There is no single-threaded build mode, which is why the target
is Emscripten (pthreads over `worker_threads` + `SharedArrayBuffer`) rather
than `wasm32-wasip1`, which has no threads at all.

A build with `PTHREADS_DEBUG` shows 11 workers and 13 thread ids for a normal
startup, so `PTHREAD_POOL_SIZE=16` covers it without on-demand creation.

### The filesystem constraint, and why init is async

Emscripten keeps the filesystem in the **main thread's JavaScript heap**. MEMFS
nodes are plain JS objects and a worker's heap is separate, so a threaded build
proxies syscalls to the main thread when a pthread makes them — 54 of them in
this build.

InnoDB creates and writes its system tablespace and redo logs from background
threads during `srv_start`. Calling `mysql_server_init` on the main thread
therefore blocks the one thread that has to service those proxied calls,
against the very threads it is waiting for. That deadlocked roughly half of all
startups until it was diagnosed.

Hence `mdb_runtime_init_async` plus `mdb_runtime_init_poll`: initialisation
runs on its own pthread and JavaScript polls from the event loop, leaving the
main thread free. `EXIT_RUNTIME=0` goes with it, because with no `main()`
Emscripten would otherwise tear the runtime down the moment control returns to
the event loop.

The same exposure exists for any call that blocks while background threads do
I/O, so every ABI call that reaches the server now takes that route:
`mdb_connection_query_async`, `mdb_statement_prepare_async` and
`mdb_statement_execute_async`, each with a matching poll. Nothing that touches
MariaDB runs on the thread that owns the filesystem.

The three share one pending slot per connection, because they all run against
one `MYSQL` and the client API does not support concurrent calls on it. A
second submission while one is in flight is refused with `MDB_ERR_BAD_STATE`
rather than corrupting the protocol state. That the slot is per *connection*
and not per statement is the part worth remembering: two statements prepared on
the same connection contend with each other.

The bind calls stay synchronous. They only copy into the statement's own
buffers and never reach the server, so there is nothing for them to block on —
but they must all be issued before the execute is submitted, since the worker
thread reads those buffers.

### Every thread must unregister

A thread that calls into the client API is registered with mysys, and one that
exits without calling `my_thread_end` is never unregistered:
`my_thread_global_end` then waits `my_thread_end_wait_time` seconds at shutdown
for a count that will never reach zero, and gives up with
`N threads didn't exit`.

`mysql_server_init` registers *its caller*, which is why the initialisation
thread counted — it is the one case where the registration is implicit rather
than from an explicit `mysql_thread_init`. Every worker this wrapper starts now
pairs the two, and `tests/wasm/smoke.mjs` fails if MariaDB ever reports a
straggler again.

## Filesystem design

```
/mariadb/share      NODEFS, read-only   errmsg.sys
/mariadb/charsets   NODEFS, read-only   charset XML
/runtime/instance-N MEMFS or NODEFS     the datadir
```

The static data is mounted from `dist/` rather than bundled with
`--preload-file`, so rebuilding `errmsg.sys` does not require relinking and the
artifact set stays `.mjs` + `.wasm`.

The datadir starts **empty**. InnoDB bootstraps its own system tablespace, as
the native reference demonstrated first, so no packaged template is needed for
the ephemeral-test case. `mysql.*` system tables are absent, which is why
`mysql.servers` and `mysql.innodb_table_stats` warn at startup. Anything
needing those tables — grants, stored routines, time zones, persistent index
statistics — needs a real template, which is not yet built.

## Isolation between test workers

One wasm instance, one initialised MariaDB runtime. MariaDB's server init is
process-global *within an instance*, so isolation cannot come from anything
this package enforces — it comes from the instance boundary. Each call to the
Emscripten factory builds a module with its own linear memory and its own
filesystem, so two servers share no datadir, no buffer pool and no MariaDB
globals.

`package/test/isolation.test.ts` runs four concurrent servers that each build
the same schema under the same name, and asserts none sees another's rows.

Shutdown terminates the Emscripten pthread workers explicitly. They are Node
`worker_threads` and hold the event loop open by themselves; without that, a
test run finishes and Node simply never exits. `process.exit()` would hide the
problem rather than fix it.
