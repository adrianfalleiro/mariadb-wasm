#!/usr/bin/env bash
# Idempotently apply our MariaDB source patches. See patches/ for rationale.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/mariadb"

# ---------------------------------------------------------------------------
# 1. Force the IMPORT_EXECUTABLES cross-compile path under Emscripten.
#
# MariaDB decides how to obtain its build-time codegen tools (comp_err,
# gen_lex_hash, gen_lex_token, comp_sql, factorial, uca-dump) with two idioms:
#
#   IF(NOT CMAKE_CROSSCOMPILING OR DEFINED CMAKE_CROSSCOMPILING_EMULATOR)  -> build them
#   IF(CMAKE_CROSSCOMPILING AND NOT DEFINED CMAKE_CROSSCOMPILING_EMULATOR) -> import them
#
# Emscripten.cmake always sets CMAKE_CROSSCOMPILING_EMULATOR to node, so both
# resolve to "we can run target binaries" and MariaDB compiles the tools to
# wasm and runs them under node during the build. That cannot work: these tools
# generate source files, and Emscripten's default MEMFS is in-memory, so the
# writes never reach the build tree.
#
# -DCMAKE_CROSSCOMPILING_EMULATOR="" does not help - both sides test NOT
# DEFINED, and empty-but-defined still takes the wrong branch.
#
# The idioms appear at 8 sites (top-level plus strings/, dbug/, extra/,
# scripts/, sql/). Patching only the top-level ones is worse than patching
# none: import_executables.cmake then defines IMPORTED targets while the
# subdirectories still ADD_EXECUTABLE the same names, and CMake errors with
# 'cannot create target "factorial" because an imported target with the same
# name already exists'. So rewrite both idioms uniformly.
python3 - "$SRC" <<'PY'
import pathlib, sys

src = pathlib.Path(sys.argv[1])

SUBS = [
    ("NOT CMAKE_CROSSCOMPILING OR DEFINED CMAKE_CROSSCOMPILING_EMULATOR",
     "NOT CMAKE_CROSSCOMPILING OR (DEFINED CMAKE_CROSSCOMPILING_EMULATOR AND NOT MARIADB_WASM_FORCE_IMPORT_EXECUTABLES)"),
    ("CMAKE_CROSSCOMPILING AND NOT DEFINED CMAKE_CROSSCOMPILING_EMULATOR",
     "CMAKE_CROSSCOMPILING AND (MARIADB_WASM_FORCE_IMPORT_EXECUTABLES OR NOT DEFINED CMAKE_CROSSCOMPILING_EMULATOR)"),
]

# Vendored third-party trees belong to disabled plugins; leave them alone.
SKIP = ("storage/mroonga/vendor", "storage/rocksdb", "storage/columnstore")

patched = already = 0
for path in sorted(src.rglob("CMakeLists.txt")):
    rel = path.relative_to(src).as_posix()
    if any(rel.startswith(s) for s in SKIP):
        continue
    text = original = path.read_text()
    for old, new in SUBS:
        if old in text:
            text = text.replace(old, new)
    if text != original:
        path.write_text(text)
        print(f"  patched {rel}")
        patched += 1
    elif "MARIADB_WASM_FORCE_IMPORT_EXECUTABLES" in text:
        already += 1

print(f"import-executables guards: {patched} patched, {already} already applied")
if patched == 0 and already == 0:
    sys.exit("PATCH FAILED - no crosscompile guards found at all")
PY

# ---------------------------------------------------------------------------
# 2. Skip the unconditional Curses probe.
#
# MYSQL_CHECK_READLINE calls FIND_CURSES() unconditionally, and FIND_CURSES
# does FIND_PACKAGE(Curses REQUIRED). There is no ncurses for wasm and no flag
# to skip it. Curses is only needed by the mysql CLI client's line editing; the
# embedded server library does not use it. MYSQL_CHECK_MULTIBYTE() above it
# still runs, since it sets HAVE_* vars the server does use.
python3 - "$SRC/cmake/readline.cmake" <<'PY'
import pathlib, sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()

old = """    MYSQL_CHECK_MULTIBYTE()
    SET(WITH_READLINE OFF CACHE BOOL "Use bundled readline")
    FIND_CURSES()"""
new = """    MYSQL_CHECK_MULTIBYTE()
    SET(WITH_READLINE OFF CACHE BOOL "Use bundled readline")
    IF(NOT MARIADB_WASM_NO_CURSES)
      FIND_CURSES()
    ENDIF()"""

if new in text:
    print("already applied: FIND_CURSES guard")
elif old not in text:
    sys.exit("PATCH FAILED - anchor not found: FIND_CURSES call site")
else:
    path.write_text(text.replace(old, new, 1))
    print("applied: FIND_CURSES guard")
PY

# ---------------------------------------------------------------------------
# 3. Allow a no-TLS connector build.
#
# libmariadb's TLS selection is OPENSSL / GNUTLS / SCHANNEL, and anything else
# is a hard error - there is no "no TLS" option. Emscripten ships neither an
# OpenSSL nor a GnuTLS port, and the server's bundled wolfSSL is not something
# the connector can consume.
#
# TLS is meaningless for the embedded server anyway: client and server are the
# same process and lib_sql.cc dispatches in-process, so nothing is ever put on
# a socket. The connector's C sources already guard every TLS reference behind
# #ifdef HAVE_TLS (29 references, all conditional) - the code supports building
# without it and only the CMake chain refuses.
#
# Note the caller must pass -DCONC_WITH_SSL=NONE, not OFF: the connector glue
# guards with IF(NOT CONC_WITH_SSL), and CMake treats OFF as falsy, so OFF
# reads as unset and gets overwritten with GNUTLS.
python3 - "$SRC/libmariadb/CMakeLists.txt" <<'PY'
import pathlib, sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()

old = """ELSE()
  MESSAGE(FATAL_ERROR "Invalid TLS/SSL option '${WITH_SSL}'")
ENDIF()"""
new = """ELSEIF(WITH_SSL STREQUAL "OFF" OR WITH_SSL STREQUAL "NONE")
  # No TLS. Leaves HAVE_TLS undefined; SSL_SOURCES and SSL_LIBRARIES stay empty.
  SET(TLS_LIBRARY_VERSION "none (TLS disabled for embedded/wasm build)")
ELSE()
  MESSAGE(FATAL_ERROR "Invalid TLS/SSL option '${WITH_SSL}'")
ENDIF()"""

if new in text:
    print("already applied: no-TLS branch")
elif old not in text:
    sys.exit("PATCH FAILED - anchor not found: TLS else-branch")
else:
    path.write_text(text.replace(old, new, 1))
    print("applied: no-TLS branch")
PY

echo "PATCH_DONE"
