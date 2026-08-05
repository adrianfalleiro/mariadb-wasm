#!/usr/bin/env bash
# Idempotently apply our MariaDB source patches. See patches/ for rationale.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CML="$ROOT/mariadb/CMakeLists.txt"
RDL="$ROOT/mariadb/cmake/readline.cmake"
CONC="$ROOT/mariadb/libmariadb/CMakeLists.txt"

python3 - "$CML" <<'PY'
import sys, pathlib

path = pathlib.Path(sys.argv[1])
text = path.read_text()

subs = [
    (
        "IF(CMAKE_CROSSCOMPILING AND NOT DEFINED CMAKE_CROSSCOMPILING_EMULATOR)",
        "IF(CMAKE_CROSSCOMPILING AND (MARIADB_WASM_FORCE_IMPORT_EXECUTABLES OR NOT DEFINED CMAKE_CROSSCOMPILING_EMULATOR))",
    ),
    (
        "IF(NOT CMAKE_CROSSCOMPILING OR DEFINED CMAKE_CROSSCOMPILING_EMULATOR)",
        "IF(NOT CMAKE_CROSSCOMPILING OR (DEFINED CMAKE_CROSSCOMPILING_EMULATOR AND NOT MARIADB_WASM_FORCE_IMPORT_EXECUTABLES))",
    ),
]

for old, new in subs:
    if new in text:
        print(f"already applied: {old[:50]}...")
        continue
    if old not in text:
        sys.exit(f"PATCH FAILED - anchor not found: {old}")
    text = text.replace(old, new, 1)
    print(f"applied: {old[:50]}...")

path.write_text(text)
PY

# MYSQL_CHECK_READLINE calls FIND_CURSES() unconditionally, and FIND_CURSES does
# FIND_PACKAGE(Curses REQUIRED). There is no ncurses for wasm and no flag to
# skip it. Curses is only needed by the mysql CLI client's line editing; the
# embedded server library does not use it. MYSQL_CHECK_MULTIBYTE() above it
# still runs, since it sets HAVE_* vars the server does use.
python3 - "$RDL" <<'PY'
import sys, pathlib

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

# libmariadb's TLS selection is OPENSSL / GNUTLS / SCHANNEL, and anything else
# is a hard error — there is no "no TLS" option. Emscripten ships neither an
# OpenSSL nor a GnuTLS port, and the server's bundled wolfSSL is not something
# the connector can consume.
#
# TLS is meaningless for the embedded server anyway: client and server are the
# same process and lib_sql.cc dispatches in-process, so nothing is ever put on
# a socket. The connector's C sources already guard every TLS reference behind
# #ifdef HAVE_TLS (29 references, all conditional) — the code supports building
# without it and only the CMake chain refuses. So add the missing branch.
python3 - "$CONC" <<'PY'
import sys, pathlib

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
