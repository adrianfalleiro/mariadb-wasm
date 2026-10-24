/* Shared internals of the C ABI wrapper. Not installed, not part of the ABI. */
#ifndef MARIADB_WASM_INTERNAL_H
#define MARIADB_WASM_INTERNAL_H

#include <mysql.h>

#include <atomic>
#include <condition_variable>
#include <mutex>
#include <pthread.h>
#include <string>
#include <vector>

#include "handles.h"
#include "mariadb_wasm.h"

namespace mdb {

/* Which server-side call a worker thread should run against a connection. */
enum class PendingKind {
  None = 0,
  Query,      /* mysql_real_query + store               -> result handle    */
  Prepare,    /* mysql_stmt_prepare                     -> statement handle */
  Execute,    /* mysql_stmt_execute + store             -> result handle    */
};

/*
  The one call a connection may have in flight, and its outcome.

  Everything that reaches the server goes through this slot, rather than each
  operation carrying its own state. That is what makes "one call at a time per
  connection" structural: the MariaDB client API does not support concurrent
  calls on a single MYSQL, and a query racing a prepared execute would corrupt
  the protocol state rather than fail cleanly. With a single slot there is
  nowhere for a second call to be recorded, so it is rejected instead.

  The state transitions are split by thread so the flag needs no lock:
  the caller moves 0 -> 1 before starting a worker, the worker moves 1 -> 2
  when it finishes, and the caller moves 2 -> 0 when it collects the result.
  Only the caller's thread ever starts a call, so testing and setting it there
  cannot race.
*/
struct PendingCall {
  std::atomic<int> state{0};   /* 0 idle, 1 running, 2 finished uncollected */

  PendingKind kind = PendingKind::None;
  int status = MDB_OK;

  /* Query and execute produce a result handle, prepare a statement handle.
     One field, because only one of them can be in flight. */
  uint32_t produced = MDB_INVALID_HANDLE;

  std::string sql;                                      /* query, prepare */
  mdb_statement_handle statement = MDB_INVALID_HANDLE;  /* execute        */
};

/* A connection plus room to stage its last error. mysql_error() returns a
   pointer into the MYSQL struct that the next call overwrites, so the strings
   are copied here before being handed out through mdb_error. */
struct Connection {
  MYSQL *mysql = nullptr;
  uint32_t last_errno = 0;
  std::string last_sql_state;
  std::string last_message;

  /*
    Two connections cannot contend for a row lock while both are driven from
    one JavaScript thread: the first blocking call owns the thread, so the
    other transaction can never reach its COMMIT. Running server calls on
    their own thread is what makes real concurrency - and therefore deadlock
    detection, and lock waits that resolve rather than time out - expressible
    at all.
  */
  PendingCall pending;

  // A connection serializes calls on one reusable execution thread. Repeated
  // calls reuse the pthread instead of repeatedly creating and detaching one.
  std::mutex work_mutex;
  std::condition_variable work_ready;
  pthread_t worker{};
  bool worker_started = false;
  bool stop_worker = false;

  ~Connection();

  /* Snapshot whatever mysql_errno/sqlstate/error currently report. */
  void capture_error();
  void clear_error();
};

/*
  A buffered result set, from either the text protocol (mysql_store_result) or
  a prepared statement (the binary protocol). Both are buffered rather than
  streamed so row_count is available and so a half-read result cannot wedge
  the connection when JavaScript abandons iteration — which it will, on any
  test that throws mid-loop.

  One struct with a discriminator rather than two, because the result half of
  the ABI must behave identically whichever protocol produced the rows.
  Anything else pushes the distinction out to the TypeScript decoder, where it
  would show up as prepared statements quietly returning different types.
*/
struct Result {
  bool from_statement = false;

  MYSQL_RES *res = nullptr;             /* metadata for both; rows for text */
  uint32_t column_count = 0;
  MYSQL_FIELD *fields = nullptr;        /* owned by res */

  /* Text protocol. */
  MYSQL_ROW current_row = nullptr;      /* owned by res */
  unsigned long *current_lengths = nullptr;

  /* Binary protocol. Borrowed; the Statement owns it. */
  MYSQL_STMT *stmt = nullptr;
  std::vector<MYSQL_BIND> binds;
  std::vector<std::vector<char>> buffers;
  std::vector<unsigned long> lengths;
  std::vector<my_bool> nulls;
  std::vector<my_bool> truncated;
  bool row_available = false;

  ~Result();
};

/* A prepared statement plus the storage backing its bound parameters.
   MYSQL_BIND holds pointers, not values, so the buffers must outlive
   execution — keeping them here is what makes "values are copied" true at the
   ABI boundary. */
struct Statement {
  MYSQL_STMT *stmt = nullptr;
  uint32_t param_count = 0;

  /* The connection this was prepared on. Held as a handle rather than a
     pointer so that a statement outliving its connection is a lookup miss
     instead of a dangling read, and so the async paths can find the pending
     slot that serialises everything running against that connection. */
  mdb_connection_handle owner = MDB_INVALID_HANDLE;
  std::vector<MYSQL_BIND> binds;
  std::vector<std::vector<char>> buffers;
  std::vector<unsigned long> lengths;
  std::vector<my_bool> nulls;

  uint32_t last_errno = 0;
  std::string last_sql_state;
  std::string last_message;

  ~Statement();

  void reset_bindings();
  void capture_error();
};

HandleTable<Connection> &connections();
HandleTable<Result> &results();
HandleTable<Statement> &statements();

/* Builds a Result from an executed statement, binding every column as text.
   Returns nullptr and sets the statement's error when metadata or store
   fails; a statement that legitimately returns no rows yields nullptr with no
   error recorded, so callers must check the statement's errno. */
std::unique_ptr<Result> materialise_statement_result(Statement &statement);

/*
  The bodies behind the statement half of the ABI, factored out so the
  synchronous entry points and the worker thread run byte-identical code. A
  divergence between the two would be invisible to the differential suite,
  which drives the synchronous ABI natively and the asynchronous one under
  wasm.

  Both report failure through the same channel the synchronous ABI uses: the
  statement's captured error for execute, the connection's for prepare.
*/
int prepare_statement_now(Connection &connection,
                          mdb_connection_handle connection_handle,
                          const std::string &sql,
                          mdb_statement_handle *out_statement);

int execute_statement_now(Statement &statement, mdb_result_handle *out_result);

/*
  Stages a call in the connection's pending slot and wakes its reusable worker.

  Reserving and staging happen together, in that order, because the slot is
  only safe to write while no worker is reading it. Splitting them would leave
  a window in which a second caller overwrites the SQL an in-flight worker is
  still executing.

  The mutex and release/acquire state transition publish the pending payload
  before the worker reads it. The worker is created lazily on the first call.

  Returns MDB_ERR_BAD_STATE if a call is already in flight, or if one has
  finished and its result has not been collected. `sql` is ignored for
  Execute, `statement` for Query and Prepare.
*/
int start_pending_call(mdb_connection_handle connection_handle,
                       Connection &connection,
                       PendingKind kind,
                       const uint8_t *sql,
                       size_t sql_length,
                       mdb_statement_handle statement);

/*
  Shared poll: 0 still running, 1 finished (handle in *out_produced),
  negative -mdb_status. Collecting a finished call frees the slot for the next
  one, so a caller that never polls leaves the connection busy.

  `expected` guards against polling for the wrong operation - asking for a
  prepared-statement result while a plain query is in flight is a caller bug,
  not something to answer with another operation's handle.
*/
int poll_pending_call(Connection &connection, PendingKind expected,
                      uint32_t *out_produced);

bool runtime_ready();
void set_runtime_ready(bool ready);

/* Records an error that has no connection to belong to. */
void set_global_error(uint32_t code, const char *sql_state, const char *message);

/* Fills out_error with pointers into long-lived storage; valid until the next
   set_global_error. */
void fill_global_error(mdb_error *out_error);

/* Prepends the program name and copies the caller's argv, which it does not
   own beyond the call. */
std::vector<std::string> copy_server_args(int argc, const char *const *argv);

/* The shared body of both init paths. */
int run_server_init(std::vector<std::string> owned);

/* Async init: see the comment on mdb_runtime_init_async in the public header
   for why the wasm build cannot initialise on the main thread. */
int start_async_init(std::vector<std::string> args);
int init_state();
int init_poll();

}  // namespace mdb

/*
  No exception may cross the ABI boundary: on the wasm side an escaping
  exception aborts the module, taking the whole test worker with it and
  reporting nothing useful. Every exported function wraps its body.
*/
#define MDB_GUARD_BEGIN try {
#define MDB_GUARD_END(failure_value)                                          \
  } catch (const std::exception &e) {                                         \
    ::mdb::set_global_error(0, "HY000", e.what());                            \
    return (failure_value);                                                   \
  } catch (...) {                                                             \
    ::mdb::set_global_error(0, "HY000", "unknown C++ exception at ABI boundary"); \
    return (failure_value);                                                   \
  }

/* Same, for exported functions returning void. */
#define MDB_GUARD_END_VOID                                                    \
  } catch (const std::exception &e) {                                         \
    ::mdb::set_global_error(0, "HY000", e.what());                            \
  } catch (...) {                                                             \
    ::mdb::set_global_error(0, "HY000", "unknown C++ exception at ABI boundary"); \
  }

#endif /* MARIADB_WASM_INTERNAL_H */
