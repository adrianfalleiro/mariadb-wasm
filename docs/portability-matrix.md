# Portability matrix

Every OS-level facility MariaDB touches that behaves differently under
Emscripten, what was done about it, and what test covers it.

Categories are the ones in the brief: `BUILD_DETECTION`, `HOST_GENERATOR`,
`DAEMON_ONLY`, `FILESYSTEM`, `THREADING`, `PROCESS_API`, `SIGNAL_API`,
`DYNAMIC_LOADING`, `NETWORKING`, `INNODB_IO`, `THIRD_PARTY_LIBRARY`,
`WASM32_LIMIT`, `JS_ABI`.

## Applied changes

| Area | Native | Emscripten | What was done | Limitation | Test | Category |
|---|---|---|---|---|---|---|
| Build-time codegen | `comp_err`, `gen_lex_hash`, `gen_lex_token`, `comp_sql`, `factorial`, `uca-dump` run on the host | Emscripten sets `CMAKE_CROSSCOMPILING_EMULATOR=node`, so MariaDB builds them as wasm and runs them under Node, where MEMFS writes never reach the build tree | Patched both cross-compile idioms at all 6 sites to honour `MARIADB_WASM_FORCE_IMPORT_EXECUTABLES`; host tools imported via `IMPORT_EXECUTABLES` | None | Wasm build produces generated sources | `HOST_GENERATOR` |
| DTrace probes | `dtrace` present on the host, so `ENABLE_DTRACE` defaults on and a Darwin probe header is generated | `__asm__ volatile(".reference …")` cannot be assembled for wasm | `-DENABLE_DTRACE=OFF` | No DTrace probes; observability only | Wasm build compiles `mf_keycache.c`, `ha_tina.cc` | `BUILD_DETECTION` |
| `_GNU_SOURCE` | Set by `cmake/os/Linux.cmake` | Emscripten never reaches that file, so glibc-style extensions stay undeclared | `-D_GNU_SOURCE=1`, matching Linux | None — the symbols exist, only the declarations were hidden | `mysys/my_stack.c` compiles; real stack bounds retained | `BUILD_DETECTION` |
| `pthread_getattr_np` | glibc | Present in Emscripten's musl-derived libc, declared only under `_GNU_SOURCE` | Covered by `_GNU_SOURCE` above | None. Notably *not* disabled — MariaDB's fallback approximates stack bounds, and the parser's recursion guard depends on them | `my_stack.c` | `THREADING` |
| `<ctype.h>` | Pulled in transitively by glibc and macOS headers | Not transitively included | Added the include to `mysys/get_password.c` | None | Wasm build | `BUILD_DETECTION` |
| Large pages | `MAP_HUGETLB` implies Linux | `MAP_HUGETLB` is defined but `__linux__` is not, so `my_bit.h` was not included while `my_bit_log2_size_t` was used | Widened the include guard to match the use | Large pages remain unavailable; MariaDB falls back to ordinary `mmap` | Wasm build | `WASM32_LIMIT` |
| Bundled PCRE2 | ExternalProject inherits the host platform | Got `emcc` but not the toolchain file, so CMake's Darwin module appended `-arch arm64`, which `emcc` rejects | Forward `CMAKE_TOOLCHAIN_FILE` into the sub-build | None | Wasm build | `THIRD_PARTY_LIBRARY` |
| TLS in Connector/C | OpenSSL / GnuTLS / SchannelI | None available; the CMake chain hard-errors with no "off" branch | Added a no-TLS branch (`CONC_WITH_SSL=NONE`). All 29 TLS references in the C sources are already `#ifdef HAVE_TLS` | No TLS — meaningless here, since client and server are the same process | Wasm build | `NETWORKING` |
| Curses | `FIND_CURSES()` is unconditional in `MYSQL_CHECK_READLINE` | No ncurses for wasm | Guarded behind `MARIADB_WASM_NO_CURSES` | The `mysql` CLI is not built; the embedded library never used it | Wasm configure | `THIRD_PARTY_LIBRARY` |
| Filesystem from threads | Any thread calls the kernel directly | MEMFS lives in the main thread's JS heap; 54 syscalls are proxied to it from pthreads | Initialisation runs on its own pthread and JavaScript polls from the event loop | Any blocking ABI call is exposed to the same deadlock; see `docs/status.md` | 25/25 runs of `tests/wasm/smoke.mjs`; the whole package suite | `FILESYSTEM` |
| Runtime lifetime | A program has a `main()` | With `EXIT_RUNTIME=1` and no `main()`, the runtime tears down on the first return to the event loop | `-sEXIT_RUNTIME=0` | The caller must shut down explicitly; `server.close()` does | `close is idempotent` test | `JS_ABI` |
| Heap growth | `realloc` semantics | Growth replaces the `SharedArrayBuffer` and rebinds `HEAPU8`/`HEAPU32`, detaching any cached view | Heap views are read through getters, never cached | A caller reaching into wasm memory directly must do the same | Type-fidelity tests, which read after several growths | `JS_ABI` |
| `i64` across the JS boundary | Native 64-bit | Emscripten legalizes `i64` into two `i32`s; `ccall`'s `"number"` marshalling truncates | Integer parameters bound as text and parsed server-side | None — text is exact, and it is what the text protocol does | 2^53+1 round-trip test | `JS_ABI` |
| `madvise` | Advisory | Unsupported; returns `ENOSYS` and warns | Left alone — it is advisory, and MariaDB continues | None observed | Startup emits 21 warnings, all benign | `WASM32_LIMIT` |
| `prlimit64` | Resource limits | Unsupported | Left alone; daemon-only concern | MariaDB cannot raise its own limits, which is meaningless in wasm | Startup | `PROCESS_API` |
| Dynamic plugins | `dlopen` | No shared objects | `-DWITHOUT_DYNAMIC_PLUGINS=ON`; everything needed is static | Runtime plugin loading and dynamic UDFs unavailable | No `.so`/`.wasm` plugin artifacts produced | `DYNAMIC_LOADING` |
| MAC address lookup | `getifaddrs` | Unavailable | Left alone — the feedback plugin logs a failure and continues | Feedback plugin inert; it is a phone-home feature | Startup warning, non-fatal | `NETWORKING` |

## Deliberately unchanged

Nothing was stubbed to make the build pass. In particular no blanket
"return success for every unsupported syscall" shim exists — the two
unsupported syscalls seen at runtime (`madvise`, `prlimit64`) already return
`ENOSYS` from Emscripten's own stubs, and MariaDB already handles that.

Transactions, MVCC, row locking, foreign keys, metadata locking and redo
processing are all untouched.

## Not yet investigated

These have not appeared as failures, which is not the same as being verified.

| Area | Why it is still open |
|---|---|
| `fcntl` advisory locking | InnoDB uses it to detect a second server on one datadir. Untested under MEMFS; the safety rule against sharing a datadir stands regardless |
| `fsync` / `fdatasync` semantics | Called, but MEMFS has nothing to flush to. Durability is explicitly out of scope |
| Direct I/O | Not selected; InnoDB falls back |
| Timezone tables | `mysql.time_zone*` are absent from an empty datadir, so `CONVERT_TZ` with named zones is untested |
| `wasm32` file offsets | No file in these tests approaches 2 GB. `off_t` behaviour past that is unverified |
