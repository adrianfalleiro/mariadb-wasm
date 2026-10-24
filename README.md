# mariadb-wasm

MariaDB's embedded server (`libmariadbd`) compiled to WebAssembly, so a Node
test suite can run real MariaDB — InnoDB, transactions, foreign keys, the
actual optimizer — with no daemon, no port, no socket and no Docker.

```ts
import { createEmbeddedMariaDb } from "@adrianfalleiro/mariadb-wasm";

const server = await createEmbeddedMariaDb({ storage: { type: "memory" } });
const connection = await server.connect();

await connection.query(`
  CREATE TABLE users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    email VARCHAR(255) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_email (email)
  ) ENGINE=InnoDB
`);

await connection.execute("INSERT INTO users(email) VALUES (?)", ["person@example.com"]);

const [rows] = await connection.query("SELECT id, email FROM users");

await connection.close();
await server.close();
```

Roughly 180 ms to start a server, 0.1 ms to connect, ~35 ms for a thousand
queries, ~110–220 ms to shut down. Parameterised statements cost more than
plain ones — see `docs/performance.md`.

## What it is

The SQL parser, optimizer, execution engine, metadata locking, transaction
manager, handler API and InnoDB are MariaDB's, unmodified. Only the
external-daemon boundary is bypassed — listener, wire protocol, network
authentication, daemon lifecycle. Nothing falls back to another database.

```
your test
    ↓  TypeScript, async, one server per wasm instance
  package/src
    ↓  opaque integer handles, length-delimited values
  native/src — the C ABI
    ↓
  libmariadbd.a (+ libtpool.a on some platforms; MariaDB 11.8.9)
```

The same C ABI is also compiled natively, so every behaviour can be diffed
against a build where nothing is emulated. `scripts/13-run-differential.sh`
does exactly that and currently agrees on 97 statements across 14 cases.

## Status

Working, with real gaps. All five suites pass:

| Suite                          | Coverage                                                          |
| ------------------------------ | ----------------------------------------------------------------- |
| `11-run-native-smoke.sh`       | 22 assertions, `libmariadbd` direct                               |
| `12-run-abi-smoke.sh`          | 63 assertions, the C ABI natively                                 |
| `tests/wasm/smoke.mjs`         | 37 assertions under wasm                                          |
| `06-build-datadir-template.sh` | 132 bootstrap statements, 0 failures                              |
| `13-run-differential.sh`       | 97 statements, native vs wasm, with a negative control            |
| `package/test`                 | 43 tests, 3.9 s — including InnoDB locking under real concurrency |

Concurrency is real: every call that reaches the server — query, prepare,
execute — runs on its own thread, so two connections genuinely contend, through
parameterised SQL as much as through text. Lock waits resolve when the holder
commits, time out with `1205` when it does not, and a deadlock produces
`1213`/`40001` with exactly one victim.

Stored routines, functions, triggers and views work: a 620 KB datadir template
carrying the `mysql.*` system tables is cloned into each instance
(`scripts/06-build-datadir-template.sh`).

Read `docs/status.md` before relying on this. The short version: privileges are
present but not enforced (`--skip-grant-tables`), named time zones need
zoneinfo that is not shipped, and durability is explicitly not provided —
`innodb-flush-log-at-trx-commit=0` is a default here and nothing validates
crash recovery. CI is written and portable but has never actually run.

## Why Emscripten, not wasi-sdk

`wasm32-wasip1` has no threads. InnoDB and the server core spawn background
threads unconditionally during startup — log writer, log flusher, page cleaner,
purge coordinator — and `innodb_purge_threads` has a minimum of 1. There is no
single-threaded build mode to fall back on.

The interesting consequence is in `docs/architecture.md`: Emscripten keeps the
filesystem in the main thread's JavaScript heap and proxies syscalls to it from
pthreads, so initialising MariaDB _on_ the main thread deadlocks it against the
InnoDB threads it is waiting for. That made startup a coin flip until it was
diagnosed. Initialisation now runs on its own thread.

## Why MariaDB, not MySQL

MySQL's embedded server library was
[deprecated in 5.7 and removed in 8.0.1](https://dev.mysql.com/blog-archive/mysql-8-0-retiring-support-for-libmysqld/).
MariaDB still ships `libmariadbd`, is the documented migration path off
`libmysqld`, and is the only one of the two with an upstream-supported
cross-compilation flow (`IMPORT_EXECUTABLES`).

## npm package

Install with `npm install @adrianfalleiro/mariadb-wasm`. The package includes
compiled JavaScript, TypeScript declarations, Node and browser WASM engines,
the system-table template and license notices. No native build is needed.

Browser applications must serve the files in `dist/browser/` together and
provide COOP/COEP headers as described below. Pass `workerUrl` when your bundler
does not preserve the worker assets beside the browser entrypoint.

To prepare a release after building both engine targets:

```sh
npm run build:browser --prefix package
npm run pack:npm --prefix package
npm run test:package --prefix package
npm run publish:npm --prefix package
```

The source-development package stays private to prevent accidentally publishing
an incomplete checkout; publishing uses the self-contained `build/npm` directory.
Bump `package/package.json` and its lockfile for each release.

## Build

Pinned to MariaDB 11.8.9 (LTS) and emsdk 6.0.5. Requires `bison` 3.x (macOS
ships 2.3, too old for the SQL parser), `ninja` and `cmake`.

```bash
brew install bison ninja cmake

bash scripts/00-fetch-emsdk.sh        # ~1.7 GB
bash scripts/01-fetch-mariadb.sh      # ~430 MB
bash scripts/02b-patch-mariadb.sh     # idempotent source patches
bash scripts/02-build-host-tools.sh   # native codegen tools
bash scripts/03-configure-wasm.sh
bash scripts/04-build-wasm.sh
bash scripts/05-link-wasm-module.sh release
```

Full instructions, including the native reference track, in `docs/build.md`.
Do not run two builds against this tree at once — `build/` and the
in-place-patched `mariadb/` checkout are shared mutable state.

## Docs

|                                |                                                               |
| ------------------------------ | ------------------------------------------------------------- |
| `docs/architecture.md`         | Layers, the C ABI, threading, the filesystem constraint       |
| `docs/status.md`               | Phase state, the failure log, remaining gaps                  |
| `docs/build.md`                | Clean-build commands                                          |
| `docs/portability-matrix.md`   | Every OS facility that differs, and what was done             |
| `docs/plugin-matrix.md`        | What is statically linked and why                             |
| `docs/unsupported-features.md` | What does not work, split from what is not built yet          |
| `docs/debugging.md`            | Debug builds, VFS inspection, isolating a failure to a layer  |
| `docs/upgrading-mariadb.md`    | Changing the pinned revision                                  |
| `docs/performance.md`          | Measurements and what is not optimised                        |
| `docs/licensing.md`            | GPLv2 checkpoint — internal-only, not cleared for publication |

## Licence

MariaDB Server is GPLv2, and the wasm artifact is statically linked from it.
This repository is internal-only and `package/package.json` is `private`.
See `docs/licensing.md` before that changes.

## Browser workers and driver adapters

The browser target runs the embedded engine in a dedicated worker, with
additional pthread workers for MariaDB background work. It uses memory storage;
closing the worker discards the database. This is intended for isolated tests,
not durable application storage.

Build from the existing engine archives and datadir template:

```bash
npm ci --prefix package
bash scripts/05-link-wasm-module.sh release browser
npm run build:browser --prefix package
```

Serve `dist/browser/` from your origin with `Cross-Origin-Opener-Policy:
same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Serve `.wasm` as
`application/wasm`. Keep the generated modules and chunks together.

```js
import mysql from "./dist/browser/mysql2-driver.mjs";

const connection = await mysql.createConnection({ dateStrings: true });
await connection.query("CREATE DATABASE test");
await connection.query("USE test");
await connection.query("CREATE TABLE notes (id INT PRIMARY KEY, body TEXT) ENGINE=InnoDB");
await connection.execute("INSERT INTO notes VALUES (?, ?)", [1, "hello"]);
const [rows] = await connection.query("SELECT * FROM notes");
await connection.end(); // closes the owned engine worker as well
```

For several connections sharing a database, create a server with
`createDatabaseWorker()` from `dist/browser/browser.mjs` and pass `{ server }`
to each adapter. End each connection and then call `server.close()`.
`mariadb-driver.mjs` returns row arrays with `meta`, rather than MySQL2's
`[rows, fields]`. Node consumers use `package/src/mysql2.ts` or
`package/src/mariadb.ts`; they reuse the Node engine without launching a browser.

Callback entrypoints are `@adrianfalleiro/mariadb-wasm/mysql2` and
`@adrianfalleiro/mariadb-wasm/mariadb/callback`. Their browser bundles are
`mysql2-callback-driver.mjs` and `mariadb-callback-driver.mjs`.
They return the connection immediately; queries wait for startup. They share
binding, type conversion and error handling with the Promise adapters.

```js
import mysql from "@adrianfalleiro/mariadb-wasm/mysql2";

const connection = mysql.createConnection({ server });
connection.execute("SELECT ? AS answer", [42], (error, rows, fields) => {
  if (error) throw error;
  console.log(rows[0].answer); // 42
  connection.end();
});
```

Both callback adapters support `connect`, `query`, `execute`, transaction methods
and `end`, with Node-style error-first callbacks. Query objects accept `sql` and
`values`. Without a callback, queries return an emitter with buffered `fields`,
`result`, `end` and `error` events; this is not a streaming/backpressure API.
`end` drains accepted operations. Knex can own pooling over these connections;
the adapters do not provide `createPool` or a `.promise()` wrapper.

These are **initial Promise and callback API adapters**, not drop-in replacements for every
feature of the drivers. Supported operations are `createConnection`, `query`
(with positional values), `execute`, `beginTransaction`, `commit`, `rollback`,
and `end`. DML results include `affectedRows`, `insertId`, and `warningStatus`.
Metadata currently includes column name, type, charset, flags and decimals;
it does not reproduce the complete native field/OK packet classes. Pools,
streaming, prepared-statement objects, named placeholders,
multiple result sets, authentication, and wire-protocol transport are not
implemented. Unknown connection options are rejected. Date handling is
currently UTC-only; prefer `dateStrings: true` when exact SQL dates matter.
MariaDB engine semantics remain MariaDB semantics, including type differences
from MySQL 8 for some expressions.

Correctness checks (no benchmarks):

```bash
npm test --prefix package
npm run typecheck --prefix package
# Starts its own disposable MariaDB 11.8.9 container and removes it afterwards.
npm run test:contract --prefix package
# Install once, or set CHROMIUM_PATH to an existing Chromium executable.
cd package && npx playwright install chromium && cd ..
npm run test:browser --prefix package
```

The contract suite executes the same inputs against the adapters and the
official MySQL2/MariaDB drivers connected to native MariaDB. Browser tests
exercise real InnoDB, parameter binding, transactions, errors, worker isolation,
startup failure and shutdown. Local benchmarks are available below; production CI
savings still depend on the workload and runner limits.

## Shared-engine test workers

Shared mode is opt-in. One dedicated database worker owns MariaDB, and each
transferred client port gets a fresh database and its own connection handles.
The existing per-worker engine mode remains available for full server isolation.

In Node, create the host once in the suite coordinator:

```js
import { Worker } from "node:worker_threads";
import { createSharedDatabaseWorker } from "./package/src/shared.ts";

const host = await createSharedDatabaseWorker();
const port = await host.createClientPort();
const worker = new Worker(new URL("./test-worker.mjs", import.meta.url), {
  workerData: { port },
  transferList: [port],
});
// Wait for all test workers, then await host.close() in suite teardown.
```

Inside each Node test worker:

```js
import { workerData } from "node:worker_threads";
import { connectDatabasePort } from "./package/src/shared.ts";
import mysql from "./package/src/mysql2.ts";

const client = connectDatabasePort(workerData.port);
try {
  const connection = await mysql.createConnection({ server: client });
  // Its default database is already created and selected.
  await connection.query("CREATE TABLE example (id INT PRIMARY KEY)");
  await connection.execute("INSERT INTO example VALUES (?)", [1]);
  await connection.end();
} finally {
  await client.close();
}
```

In browsers, use `createDatabaseWorker()` as the host and
`connectDatabasePort()` from `dist/browser/browser.mjs` in each test Web Worker.
Transfer ports with `worker.postMessage({ port }, [port])`. A dedicated host and
explicit ports let the suite own startup and teardown; a named `SharedWorker`
is not required. COOP/COEP headers are still required.

`client.close()` drains accepted calls, closes that client's connections, and
drops its database. It does not close other clients or the host. Node also
reclaims a client whose worker terminates unexpectedly. Browser workers must
close their clients explicitly. Always close the host in suite teardown;
that closes all remaining clients and discards the entire engine.

Schemas are logical partitions, not a security boundary: SQL can reference
another schema, and server globals and resource limits are shared. Use isolated
engines for tests that require independent server settings or server restarts.

Compare fresh-process runs with the same workload:

```bash
BENCH_TESTS=1000 BENCH_WORKERS=4 node bench/run.mjs --shared
BENCH_TESTS=1000 BENCH_WORKERS=4 node bench/run.mjs --embedded
# After building dist/browser; set CHROMIUM_PATH if needed.
node bench/browser.mjs --shared
node bench/browser.mjs --isolated
```

Memory defaults use small autoextending tablespaces and a conservative WASM
background-worker scheduling policy. Larger fixtures can still grow their files
and the scheduler can still add workers; neither is a hard capacity cap. Native
MariaDB builds keep their original CPU-based scheduling policy.

Run `npm run test:memory --prefix package` to check initial tablespace sizes,
growth beyond those sizes, and worker-pool growth under repeated transactions.

The browser benchmark uses Chromium and Unix `ps`. Its memory figure is summed
browser process RSS, which can count shared pages more than once; compare it
between browser modes, not directly with Node's single-process RSS. Both
benchmarks include engine startup and teardown in wall time. Shared Node
worker setup excludes host startup, so use total wall time for comparisons.
