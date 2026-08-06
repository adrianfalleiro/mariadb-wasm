# Plugin matrix

Read from the wasm build: the merge list in `build/wasm/build.ninja`, and the
absence of any `.so`/`.wasm` plugin artifact.

`-DWITHOUT_DYNAMIC_PLUGINS=ON` means everything present is statically linked,
satisfying criteria 3.1.5 and 3.1.6.

## Statically linked

| Plugin / engine | Static | Required by | Reason | Test coverage |
|---|---|---|---|---|
| InnoDB (`innobase_embedded`) | yes | The supported feature set | Transactions, MVCC, row locks, foreign keys. Mandatory | Differential suite, package suite |
| Aria (`aria_embedded`) | yes | The server itself | Internal temporary tables; the server will not start without it | Indirect — every query |
| MyISAM (`myisam_embedded`) | yes | System tables | MariaDB still uses it for parts of `mysql.*` | Indirect |
| MyISAM MERGE | yes | MyISAM | Comes with MyISAM | None |
| MEMORY (`heap_embedded`) | yes | The optimizer | In-memory temporary tables | Indirect — GROUP BY, DISTINCT |
| CSV (`csv_embedded`) | yes | `mysql.slow_log` | MariaDB requires it for log tables | None |
| SEQUENCE (`sequence_embedded`) | yes | Built-in | `seq_1_to_N` table function | None |
| Performance Schema | yes (linked) | — | Compiled in but disabled at runtime with `--performance-schema=OFF`. A Phase 15 removal candidate: it is large and unused | Disabled |
| `partition_embedded` | yes | Built-in | Partitioning | None |
| `sql_sequence_embedded` | yes | Built-in | `CREATE SEQUENCE` | None |
| `type_geom`, `type_inet`, `type_uuid` | yes | Built-in data types | Cheap; removing them would narrow SQL compatibility | None |
| `user_variables`, `userstat` | yes | Information-schema tables | Small | None |
| `feedback_embedded` | yes | — | Inert. Tries to read a MAC address at startup, fails, logs, continues. A removal candidate | Startup warning only |
| `auth_socket_embedded` | yes | — | Merged by MariaDB's own list. Inert under `--skip-grant-tables`, and Unix-socket auth is an explicit non-goal. A removal candidate | None |
| wolfSSL | yes | `mysys_ssl` | Pulled in by the merge although the embedded server needs no TLS. A removal candidate | None |

## Disabled at configure

| Plugin | Setting | Reason |
|---|---|---|
| ColumnStore | `PLUGIN_COLUMNSTORE=NO` | Huge; needs its own toolchain |
| RocksDB | `PLUGIN_ROCKSDB=NO` | Separate storage engine, not needed |
| Mroonga | `PLUGIN_MROONGA=NO` | Full-text engine, vendored third-party tree |
| Spider | `PLUGIN_SPIDER=NO` | Sharding over the network — a non-goal |
| CONNECT | `PLUGIN_CONNECT=NO` | External data sources |
| OQGraph | `PLUGIN_OQGRAPH=NO` | Needs Boost |
| Sphinx | `PLUGIN_SPHINX=NO` | Network search daemon |
| S3 | `PLUGIN_S3=NO` | Network storage |
| PAM auth | `PLUGIN_AUTH_PAM=NO` | OS-account auth — an explicit non-goal |
| GSSAPI auth | `PLUGIN_AUTH_GSSAPI=NO` | Kerberos — an explicit non-goal |
| cracklib | `PLUGIN_CRACKLIB_PASSWORD_CHECK=NO` | Needs a system dictionary |
| Galera / wsrep | `WITH_WSREP=OFF` (native ref) | Replication — an explicit non-goal |
| MariaBackup | `WITH_MARIABACKUP=OFF` (native ref) | Backup tooling — an explicit non-goal |

## Notes

The `WITH_WSREP=OFF` and `WITH_MARIABACKUP=OFF` flags are currently only on the
native reference build; the wasm build inherits their defaults and links
`wsrep_dummy.cc` regardless, which is the no-op implementation. Aligning the
two is tidy-up, not a correctness issue.

Removing perfschema, wolfSSL, feedback and auth_socket is the obvious artifact-
size work, and belongs in Phase 15 — after the differential suite passes, which
it now does, but measured rather than guessed.
