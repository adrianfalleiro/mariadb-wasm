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

## Trimming: attempted, measured, reverted

Removing the inert plugins looked like the obvious artifact-size win. It was
tried and backed out.

Only two are big enough to matter: `perfschema` (1.3 MB of archive) and
`wolfSSL` (1.5 MB), against a 12.1 MB artifact — and the linker only pulls in
referenced objects, so the real saving is smaller still. `feedback`,
`auth_socket` and `userstat` are each under 0.05 MB.

wolfSSL cannot go: `mysys_ssl` uses it for SHA1 and AES, which the server needs
regardless of TLS.

`PLUGIN_PERFSCHEMA=NO` builds, and then every startup fails with:

```
unknown variable 'performance-schema=OFF'
```

The option ceases to exist when the plugin is not compiled in, and
`--performance-schema=OFF` is passed by the package defaults, both smoke tests,
the differential runner and the datadir bootstrap tool. Removing it from all of
them would also mean a user passing it through `serverOptions` gets a startup
failure instead of a no-op. That is a poor trade for about a megabyte, so
perfschema stays compiled in and disabled at runtime.

Worth recording rather than leaving as a standing TODO, so nobody re-derives
it: the reason to keep perfschema is not inertia.

One real bug came out of the attempt. `scripts/10-build-native-reference.sh`
and `02-build-host-tools.sh` reconfigured an existing build directory, and
CMake caches every `-D` — so *removing* a flag from the script did not unset
it, and the reverted change survived a rebuild. Both scripts now delete
`CMakeCache.txt` before configuring, which forces a full reconfigure while
letting ninja reuse object files.
