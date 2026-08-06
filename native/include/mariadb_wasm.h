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

/*
  How long mysql_server_end waits for MariaDB-registered threads to finish,
  in seconds. MariaDB's default is 5.

  Under wasm exactly one thread never calls my_thread_end, so the wait always
  runs to completion and every shutdown costs a flat 5 seconds — ruinous for a
  test suite that creates a server per file. Setting this to 0 skips the wait.

  That is safe only because the caller then terminates every Emscripten worker
  and discards the whole wasm instance, which is what the TypeScript layer
  does. It is not safe in a process that intends to keep running: MariaDB
  deliberately leaves its global mutexes undestroyed when the wait times out,
  precisely to avoid a use-after-free by a thread that is still live.
*/
void mdb_runtime_set_shutdown_wait_seconds(uint32_t seconds);

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

/*
  Runs the same statement on a dedicated thread and returns immediately; poll
  with mdb_connection_query_poll.

  Needed for two reasons. First, concurrency: two connections driven from one
  JavaScript thread cannot contend, because the first blocking call owns the
  thread and the other transaction never reaches its COMMIT - so lock waits
  can only ever time out, and deadlocks cannot form at all. Second, it keeps
  the caller's thread free, which under wasm is the thread that services
  MariaDB's proxied filesystem syscalls.

  One query at a time per connection: a second submission while one is in
  flight returns MDB_ERR_BAD_STATE rather than corrupting the protocol state.
*/
int mdb_connection_query_async(mdb_connection_handle connection,
                               const uint8_t *sql,
                               size_t sql_length);

/*
  0 = still running, 1 = finished (result in *result, which may be
  MDB_INVALID_HANDLE for statements returning no rows), negative = -mdb_status
  with detail available from mdb_connection_last_error.
*/
int mdb_connection_query_poll(mdb_connection_handle connection,
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

/* -------------------------------------------------------------- statement */

/*
  Prepared statements exist so parameters are bound through MariaDB's
  statement API rather than interpolated into SQL text. Interpolation in
  JavaScript cannot be made correct — it has to reproduce MariaDB's quoting,
  charset and SQL-mode rules — and it is how injection bugs get written.
*/
mdb_statement_handle mdb_statement_prepare(mdb_connection_handle connection,
                                           const uint8_t *sql,
                                           size_t sql_length);

uint32_t mdb_statement_param_count(mdb_statement_handle statement);

/*
  Binding. Each call sets one parameter; values are copied, so the caller may
  free its buffers immediately. Index is zero-based.

  Integers are split by signedness because BIGINT UNSIGNED above 2^63 cannot
  round-trip through a signed value, and JavaScript reaches those via BigInt.
  Decimals and dates are bound with mdb_statement_bind_string, which sends
  them as text for the server to parse in the column's own type — the same
  path the text protocol takes, so no precision is lost to a double.
*/
int mdb_statement_bind_null(mdb_statement_handle statement, uint32_t index);
int mdb_statement_bind_int64(mdb_statement_handle statement, uint32_t index,
                             int64_t value);
int mdb_statement_bind_uint64(mdb_statement_handle statement, uint32_t index,
                              uint64_t value);
int mdb_statement_bind_double(mdb_statement_handle statement, uint32_t index,
                              double value);
int mdb_statement_bind_string(mdb_statement_handle statement, uint32_t index,
                              const uint8_t *data, size_t length);
int mdb_statement_bind_blob(mdb_statement_handle statement, uint32_t index,
                            const uint8_t *data, size_t length);

/*
  Executes with the currently bound parameters. As with
  mdb_connection_query, *result is MDB_INVALID_HANDLE for statements that
  return no rows; that is not an error.
*/
int mdb_statement_execute(mdb_statement_handle statement,
                          mdb_result_handle *result);

uint64_t mdb_statement_affected_rows(mdb_statement_handle statement);
uint64_t mdb_statement_insert_id(mdb_statement_handle statement);

int mdb_statement_last_error(mdb_statement_handle statement,
                             mdb_error *out_error);

/* Re-executable after this; bound parameters are cleared. */
int mdb_statement_reset(mdb_statement_handle statement);

int mdb_statement_close(mdb_statement_handle statement);

#ifdef __cplusplus
}
#endif

#endif /* MARIADB_WASM_H */
