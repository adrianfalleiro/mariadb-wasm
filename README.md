# mariadb-wasm

MariaDB's embedded server (`libmariadbd`) compiled to WebAssembly, fronted by a
MySQL wire-protocol server in TypeScript so ordinary clients (`mysql2`, `knex`)
can connect over `node:net` without a MySQL daemon or Docker.

## Architecture

```
mysql2 / knex  →  :3306
                    ↓
  TS wire-protocol server (node:net)
  handshake, auth, COM_QUERY, COM_STMT_*, resultset packets
                    ↓
  wasm: libmariadbd  ← plain function call, no syscall bridging
```

This deliberately inverts the split used by
[valkey-wasm](https://github.com/michaelkremenetsky/valkey-wasm), which pushes
`node:net` _underneath_ the module as host functions backing
`read`/`write`/`accept` plus a stepped event loop.

That was necessary for Valkey because RESP handling lives inside its event loop.
MySQL's protocol layer is separable — that is exactly what the embedded server
library is — so `node:net` goes _above_ the module instead. No fd table, no
poll bridging, no reactor stepping, no linker `--wrap`. The wasm boundary is a
plain function call.

## Why Emscripten, not wasi-sdk

valkey-wasm targets `wasm32-wasip1`, which has no threads at all. That works for
Valkey (single-threaded by design; `bio` and `io_threads` can be excluded).

It does not work here. InnoDB and the MariaDB server core spawn background
threads unconditionally during startup — log writer, log flusher, page cleaner,
purge coordinator — and `innodb_purge_threads` has a minimum of 1. There is no
single-threaded build mode to fall back on.

Emscripten gives us pthreads backed by `worker_threads` + `SharedArrayBuffer`,
C++ exceptions, and a POSIX/FS emulation layer complete enough for a C++
codebase this size (NODEFS also gives real on-disk persistence). It is the same
toolchain DuckDB-wasm and PGlite use.

## Why MariaDB and not MySQL

MySQL's embedded server library was
[deprecated in 5.7 and removed in 8.0.1](https://dev.mysql.com/blog-archive/mysql-8-0-retiring-support-for-libmysqld/).
MariaDB still ships `libmariadbd` and is the documented migration path off
`libmysqld`. It is also the only one of the two with an upstream-supported
cross-compilation flow (`IMPORT_EXECUTABLES`).

## Build

Pinned to MariaDB 11.4.4 (LTS). MariaDB's build generates source files using
helper tools compiled during the build, so cross-compiling is a two-stage
process — build the tools natively, then point the wasm build at them.

```bash
bash scripts/00-fetch-emsdk.sh       # emsdk (~1.7G)
bash scripts/01-fetch-mariadb.sh     # MariaDB source (~430M)
bash scripts/02-build-host-tools.sh  # native comp_err, gen_lex_hash, ...
bash scripts/03-configure-wasm.sh    # emcmake configure
```

Requires `bison` 3.x (macOS ships 2.3, which is too old for the SQL parser) and
`ninja`:

```bash
brew install bison ninja
```

## Status

Spike. Nothing works end to end yet — see the git log for where the build
currently stops.
