# mariadb-wasm

MariaDB's embedded server (`libmariadbd`) compiled to WebAssembly, so a Node
test suite can run real MariaDB — InnoDB, transactions, foreign keys, the
actual optimizer — with no daemon, no port, no socket and no Docker.

```ts
import { createEmbeddedMariaDb } from "@mariadb-wasm/embedded";

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

await connection.execute(
  "INSERT INTO users(email) VALUES (?)",
  ["person@example.com"],
);

const [rows] = await connection.query("SELECT id, email FROM users");

await connection.close();
await server.close();
```

Roughly 175 ms to start a server, 0.5 ms to connect, ~43 ms for a thousand
queries, ~107 ms to shut down.

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
  libmariadbd.a + libtpool.a  (MariaDB 11.4.4)
```

The same C ABI is also compiled natively, so every behaviour can be diffed
against a build where nothing is emulated. `scripts/13-run-differential.sh`
does exactly that and currently agrees on 97 statements across 14 cases.

## Status

Working, with real gaps. All five suites pass:

| Suite | Coverage |
|---|---|
| `11-run-native-smoke.sh` | 22 assertions, `libmariadbd` direct |
| `12-run-abi-smoke.sh` | 63 assertions, the C ABI natively |
| `tests/wasm/smoke.mjs` | 32 assertions under wasm |
| `13-run-differential.sh` | 97 statements, native vs wasm, with a negative control |
| `package/test` | 31 tests, 4.6 s — including InnoDB locking under real concurrency |

Concurrency is real: queries run on their own thread, so two connections
genuinely contend. Lock waits resolve when the holder commits, time out with
`1205` when it does not, and a deadlock produces `1213`/`40001` with exactly
one victim.

Read `docs/status.md` before relying on this. The short version: there is **no
datadir template**, so the `mysql.*` system tables are absent and grants,
stored routines, triggers and named time zones do not work. And durability is
explicitly not provided — `innodb-flush-log-at-trx-commit=0` is a default here,
and nothing validates crash recovery.

## Why Emscripten, not wasi-sdk

`wasm32-wasip1` has no threads. InnoDB and the server core spawn background
threads unconditionally during startup — log writer, log flusher, page cleaner,
purge coordinator — and `innodb_purge_threads` has a minimum of 1. There is no
single-threaded build mode to fall back on.

The interesting consequence is in `docs/architecture.md`: Emscripten keeps the
filesystem in the main thread's JavaScript heap and proxies syscalls to it from
pthreads, so initialising MariaDB *on* the main thread deadlocks it against the
InnoDB threads it is waiting for. That made startup a coin flip until it was
diagnosed. Initialisation now runs on its own thread.

## Why MariaDB, not MySQL

MySQL's embedded server library was
[deprecated in 5.7 and removed in 8.0.1](https://dev.mysql.com/blog-archive/mysql-8-0-retiring-support-for-libmysqld/).
MariaDB still ships `libmariadbd`, is the documented migration path off
`libmysqld`, and is the only one of the two with an upstream-supported
cross-compilation flow (`IMPORT_EXECUTABLES`).

## Build

Pinned to MariaDB 11.4.4 (LTS) and emsdk 6.0.5. Requires `bison` 3.x (macOS
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

| | |
|---|---|
| `docs/architecture.md` | Layers, the C ABI, threading, the filesystem constraint |
| `docs/status.md` | Phase state, the failure log, remaining gaps |
| `docs/build.md` | Clean-build commands |
| `docs/portability-matrix.md` | Every OS facility that differs, and what was done |
| `docs/plugin-matrix.md` | What is statically linked and why |
| `docs/unsupported-features.md` | What does not work, split from what is not built yet |
| `docs/debugging.md` | Debug builds, VFS inspection, isolating a failure to a layer |
| `docs/upgrading-mariadb.md` | Changing the pinned revision |
| `docs/performance.md` | Measurements and what is not optimised |
| `docs/licensing.md` | GPLv2 checkpoint — internal-only, not cleared for publication |

## Licence

MariaDB Server is GPLv2, and the wasm artifact is statically linked from it.
This repository is internal-only and `package/package.json` is `private`.
See `docs/licensing.md` before that changes.
