# Unsupported features

Stated explicitly, as the brief requires. Anything here either cannot work in
this environment or has not been built yet — the two are marked differently,
because "we chose not to" and "it cannot" are not the same claim.

## Not supported by design

| Feature | Note |
|---|---|
| Crash durability | **The most important entry here.** `--innodb-flush-log-at-trx-commit=0` and `--innodb-doublewrite=0` are set by default. With MEMFS there is nothing to be durable to. Nothing in this project validates crash recovery or power-loss behaviour, and it must not be used to host data you care about |
| Production hosting | Not a server. No listener, no auth, no access control |
| Sharing a datadir with a native server | MariaDB warns against this for `mariadb-embedded` generally. Do not point a wasm runtime at a datadir a real server may touch |
| TCP or Unix-socket access | `--skip-networking`; no wire protocol. Clients like `mysql2` cannot connect — the API is in-process |
| Authentication and grants | `--skip-grant-tables`. `GRANT`/`REVOKE` are meaningless; there is one implicit superuser |
| Replication, binary logging, Galera/wsrep | Explicit non-goals |
| MariaBackup | Explicit non-goal |
| PAM, GSSAPI, Unix-socket, OS-account auth | Explicit non-goals; plugins disabled |
| Dynamically loaded plugins, UDFs, storage engines | `WITHOUT_DYNAMIC_PLUGINS=ON`. Everything is statically linked |
| Browsers | `-sENVIRONMENT=node`. No cross-origin isolation work has been done |
| Two initialised servers in one wasm instance | MariaDB's init is process-global. Use separate instances — which is also the isolation mechanism |
| Large pages | `MAP_HUGETLB` is unavailable; MariaDB falls back to ordinary `mmap` |
| DTrace probes | Not compiled in |
| TLS | Client and server are the same process; nothing is put on a socket |

## Not yet built

| Feature | What is missing |
|---|---|
| A packaged datadir template | The datadir starts empty and InnoDB bootstraps its own tablespace. The `mysql.*` system tables are **absent** |
| Grants, stored routines, triggers, events, named time zones | All need `mysql.*` system tables. `CONVERT_TZ` with named zones will not work; offsets do |
| Persistent index statistics | `mysql.innodb_table_stats` is absent — this is the warning at startup. The optimizer falls back to sampled estimates |
| `storage: { type: "node" }` beyond the basics | Wired up and mountable, but restart-and-reopen is untested |
| Differential coverage of locking | The behaviour itself works and is tested (`package/test/concurrency.test.ts`), but against InnoDB's documented contract rather than against the native build — the differential runner is single-connection |
| `SELECT ... FOR UPDATE` under `storage: node` | Only exercised on MEMFS |
| `LOAD DATA INFILE` | Untested; would read from the virtual filesystem |
| FULLTEXT, spatial | Compiled in but untested |
| Multi-statement queries | The text protocol may accept them; not tested, and the result API returns only the first result set |
| Streaming large results | Results are fully materialised in memory |
| Cancellation | No way to interrupt a running query |

## Known warnings at startup

Benign, and expected until a datadir template exists:

```
Can't open and lock privilege tables: Table 'mysql.servers' doesn't exist
InnoDB: Table mysql.innodb_table_stats not found.
feedback plugin: failed to retrieve the MAC address
warning: unsupported syscall: __syscall_prlimit64
warning: unsupported syscall: __syscall_madvise   (x21)
```
