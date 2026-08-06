/*
  Stable C ABI over libmariadbd.

  This is the only surface JavaScript sees. Nothing here exposes a C++ type, a
  MYSQL*, or a pointer that JavaScript is expected to keep — handles are opaque
  integers validated on every call, so a stale handle from a closed connection
  is a deterministic error rather than a wild pointer dereference inside the
  server.

  The same header backs the native build and the wasm build. Divergence between
  the two is the one thing the differential suite cannot detect, so there is no
  #ifdef __EMSCRIPTEN__ anywhere in this file.
*/
#ifndef MARIADB_WASM_H
#define MARIADB_WASM_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Handles are generation-tagged: reusing a slot bumps its generation, so a
   handle held past its free is rejected instead of aliasing a new object.
   0 is never valid and is what the open/create calls return on failure. */
typedef uint32_t mdb_connection_handle;
typedef uint32_t mdb_result_handle;
typedef uint32_t mdb_statement_handle;

#define MDB_INVALID_HANDLE ((uint32_t) 0)

/* Return codes. Anything non-zero is a failure; the specific value tells the
   caller whether to look for a MariaDB error or a wrapper-level one. */
typedef enum {
  MDB_OK = 0,
  MDB_ERR_MYSQL = 1,        /* MariaDB reported an error; query mdb_*_last_error */
  MDB_ERR_BAD_HANDLE = 2,   /* unknown, stale, or wrong-type handle */
  MDB_ERR_BAD_STATE = 3,    /* e.g. query before mdb_runtime_init */
  MDB_ERR_NO_MEMORY = 4,
  MDB_ERR_INTERNAL = 5      /* a C++ exception reached the ABI boundary */
} mdb_status;

/*
  Error detail. `sql_state` and `message` point into storage owned by the
  wrapper and stay valid until the next call that touches the same connection
  (or, for mdb_last_global_error, until the next global-error-producing call).
  Copy them out before doing anything else.
*/
typedef struct {
  uint32_t code;            /* MariaDB errno, e.g. 1062 */
  const char *sql_state;    /* e.g. "23000"; never NULL, "" when unknown */
  const char *message;      /* never NULL, "" when unknown */
} mdb_error;

/* ---------------------------------------------------------------- runtime */

/*
  Initialise the embedded server. Process-global in MariaDB, so this may be
  called once per module instance; a second call while initialised returns
  MDB_ERR_BAD_STATE rather than corrupting server state.

  argv is the server argument vector *without* argv[0]; the wrapper prepends a
  program name itself.
*/
int mdb_runtime_init(int argc, const char *const *argv);

/*
  Non-blocking variant of mdb_runtime_init: runs the initialisation on a
  dedicated thread and returns immediately, leaving the caller free to return
  to its event loop. Poll mdb_runtime_init_poll for completion.

  This exists because of how Emscripten implements the filesystem. MEMFS lives
  in the JavaScript heap of the main thread, so 54 of the syscalls in a
  threaded build are proxied to the main thread when a pthread makes them.
  InnoDB does a lot of file I/O from background threads while starting up, so
  calling mdb_runtime_init directly from the main thread deadlocks: the main
  thread blocks inside mysql_server_init waiting for InnoDB, and InnoDB's
  threads wait for the main thread to service their proxied opens and writes.

  Native builds have no such constraint and can keep using mdb_runtime_init.
*/
int mdb_runtime_init_async(int argc, const char *const *argv);

/* 0 = still running, 1 = finished successfully, negative = -mdb_status. */
int mdb_runtime_init_poll(void);

int mdb_runtime_shutdown(void);

/* 1 once init has succeeded and shutdown has not run. */
int mdb_runtime_is_ready(void);

/*
  Failures before any connection exists (bad datadir, unparseable server
  option) have nowhere connection-scoped to report to, so they land here.
*/
int mdb_last_global_error(mdb_error *out_error);

/*
  Live handle counts, for leak detection at shutdown and for tests. Returns the
  number of currently-open objects of each kind.
*/
uint32_t mdb_live_connections(void);
uint32_t mdb_live_results(void);
uint32_t mdb_live_statements(void);

/* ------------------------------------------------------------- connection */

/* database_name may be NULL for "no default database". */
mdb_connection_handle mdb_connection_open(const char *database_name);

int mdb_connection_close(mdb_connection_handle connection);

/*
  sql is length-delimited and may contain NUL bytes. On success *result is set
  to a result handle, or MDB_INVALID_HANDLE for statements that return no rows
  (INSERT, DDL) — that is not an error, so check the handle, not the status.
*/
int mdb_connection_query(mdb_connection_handle connection,
                         const uint8_t *sql,
                         size_t sql_length,
                         mdb_result_handle *result);

uint64_t mdb_connection_affected_rows(mdb_connection_handle connection);
uint64_t mdb_connection_insert_id(mdb_connection_handle connection);
uint32_t mdb_connection_warning_count(mdb_connection_handle connection);

int mdb_connection_last_error(mdb_connection_handle connection,
                              mdb_error *out_error);

/* ----------------------------------------------------------------- result */

uint32_t mdb_result_column_count(mdb_result_handle result);
uint64_t mdb_result_row_count(mdb_result_handle result);

/*
  Advance to the next row. Returns 1 when a row is available, 0 at end of
  results, negative on error. Values fetched from the previous row are
  invalidated by this call.
*/
int mdb_result_next(mdb_result_handle result);

/*
  Current-row cell access. Valid only between a successful mdb_result_next and
  the next mdb_result_next or mdb_result_free.

  NULL is distinct from a zero-length value: mdb_result_value_is_null returns
  1, and value_data returns NULL. A zero-length non-NULL value returns a
  non-NULL pointer with length 0. Data is never NUL-terminated — always pair
  the pointer with its length.
*/
const uint8_t *mdb_result_value_data(mdb_result_handle result, uint32_t column);
size_t mdb_result_value_length(mdb_result_handle result, uint32_t column);
int mdb_result_value_is_null(mdb_result_handle result, uint32_t column);

/* Column metadata is valid for the lifetime of the result handle. */
const char *mdb_result_column_name(mdb_result_handle result, uint32_t column);
uint32_t mdb_result_column_type(mdb_result_handle result, uint32_t column);
uint32_t mdb_result_column_flags(mdb_result_handle result, uint32_t column);
uint32_t mdb_result_column_decimals(mdb_result_handle result, uint32_t column);
uint32_t mdb_result_column_charsetnr(mdb_result_handle result, uint32_t column);

void mdb_result_free(mdb_result_handle result);

#ifdef __cplusplus
}
#endif

#endif /* MARIADB_WASM_H */
