# Source inventory

Phase 0 output. Everything here is read off the pinned revision and the native
reference build — nothing is inferred from MariaDB documentation.

## Pinned revision

| | |
|---|---|
| MariaDB | `mariadb-11.4.4` (LTS) |
| Commit | `e9a502df08bad16aa8a354e854f3c014b1380e32` |
| Submodules | `libmariadb` only (Connector/C). Columnstore/RocksDB deliberately not fetched. |

## Toolchain (recorded 2026-08-05)

| | |
|---|---|
| OS | macOS 26.5.2, arm64 (Darwin 25.5.0) |
| Host compiler | Apple clang 17.0.0 (clang-1700.4.4.1) |
| Emscripten | 6.0.5 (emsdk checkout in `emsdk/`) |
| Node (host) | v26.5.0 |
| Node (emsdk) | 24.19.0 |
| CMake | 3.28.0 |
| Ninja | 1.13.2 |
| Bison | 3.8.2 (Homebrew — macOS system bison 2.3 cannot build the SQL parser) |

## Which target produces the embedded library

`libmysqld/CMakeLists.txt`:

1. `ADD_CONVENIENCE_LIBRARY(sql_embedded ...)` compiles ~190 `sql/` translation
   units with `-DMYSQL_SERVER -DEMBEDDED_LIBRARY`.
2. `MERGE_LIBRARIES(mysqlserver STATIC ${EMBEDDED_LIBS} OUTPUT_NAME mariadbd)`
   merges it with the support libraries and statically selected plugins.
3. On Unix the output name is `mariadbd`, so the archive is
   **`libmysqld/libmariadbd.a`** — not `libmysqlserver.a`.

Built size on this host: **425 MB, 869 object members** (RelWithDebInfo).

### `libmariadbd.a` is not self-contained

`MERGE_LIBRARIES` folds in only the libraries named in `LIBS`. `tpool` is
attached separately:

```cmake
TARGET_LINK_LIBRARIES(sql_embedded LINK_PRIVATE tpool ${CRC32_LIBRARY})
```

`LINK_PRIVATE` keeps it out of the merge, so every consumer must also link
`tpool/libtpool.a`. InnoDB's entire background-task layer lives there — page
cleaner, purge coordinator, simulated AIO — so omitting it produces ~15
undefined `tpool::` symbols that never mention InnoDB or tpool's absence from
the merge. This applies identically to the wasm link.

Confirmed by reading the generated `POST_BUILD` rule in `build/native/build.ninja`:
`libtpool.a` appears as an order-only dependency but not in the `libtool -static`
merge list.

## Libraries merged into `libmariadbd.a`

Read from the `POST_BUILD` `libtool -static` invocation, in link order:

```
dbug          strings       pcre2-8       vio           zlib
mysys         mysys_ssl     wolfssl
```

Storage engines (all `_embedded` variants):

```
innobase_embedded   aria_embedded      myisam_embedded
myisammrg_embedded  heap_embedded      perfschema_embedded
csv                 sequence
```

Plugins and type libraries:

```
auth_socket             feedback_embedded       type_geom_embedded
type_inet_embedded      type_uuid_embedded      user_variables_embedded
userstat                partition_embedded      sql_sequence_embedded
```

Then `sql_embedded` itself.

**InnoDB is present as `libinnobase_embedded.a`** — acceptance criterion 3.1.6
is a matter of keeping it, not adding it.

`auth_socket` is merged even though Unix-socket auth is an explicit non-goal;
it is inert under `--skip-grant-tables`. Removing it is Phase 5 work, tracked
in `docs/plugin-matrix.md`.

## Host generator executables

`build/host/import_executables.cmake` exports exactly:

```
comp_err   comp_sql   factorial   uca-dump   gen_lex_hash   gen_lex_token
```

These generate `errmsg.sys`, the lex hash, and lex tokens. They must be host
binaries; see `patches/` and `scripts/02b-patch-mariadb.sh` for why MariaDB
otherwise tries to build them as wasm and run them under Node.

## Datadir requirements (measured, not assumed)

The native smoke test runs the full InnoDB scenario against an **empty
directory**. InnoDB creates its own system tablespace and the server starts
with `--skip-grant-tables`. Two warnings are emitted and are non-fatal:

```
Can't open and lock privilege tables: Table 'mysql.servers' doesn't exist
InnoDB: Table mysql.innodb_table_stats not found.
```

So the first MEMFS milestone does not need a packaged datadir template — an
empty directory is enough. A real template is still required before anything
touches `mysql.*` system tables (stored routines, time zones, persistent
index statistics, grants).

Server arguments used, and reused verbatim by the wasm build so a behavioural
difference cannot be a configuration difference:

```
--no-defaults --skip-grant-tables --skip-networking
--performance-schema=OFF --max-connections=20 --innodb-buffer-pool-size=16M
--datadir=<dir> --lc-messages-dir=<build>/sql/share
--character-sets-dir=<src>/sql/share/charsets
```

`--lc-messages-dir` must point at the **build** tree (`errmsg.sys` is generated
by `comp_err`), while `--character-sets-dir` points at the **source** tree.

## Expected trouble spots under Emscripten

Not yet confirmed — this is the list to check against the compile-fix loop, not
a set of conclusions.

| Area | Why it is suspect |
|---|---|
| `tpool` | Chooses an event backend per OS; needs the generic/simulated path |
| InnoDB I/O | `os0file.cc` wants native AIO, `fcntl` locking, direct I/O |
| `mysys` | `my_thr_init`, signal setup, `dlopen`, process APIs |
| `vio` | Socket/listener code the embedded path never uses |
| wolfSSL | Pulled in by the merge although the embedded server needs no TLS |
| `perfschema` | Large, and disabled at runtime anyway — a Phase 5 removal candidate |
| Word size | wasm32: 32-bit pointers, `off_t` and file-offset assumptions |
