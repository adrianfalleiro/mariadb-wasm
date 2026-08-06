/* Shared internals of the C ABI wrapper. Not installed, not part of the ABI. */
#ifndef MARIADB_WASM_INTERNAL_H
#define MARIADB_WASM_INTERNAL_H

#include <mysql.h>

#include <atomic>
#include <string>
#include <vector>

#include "handles.h"
#include "mariadb_wasm.h"

namespace mdb {

/* A connection plus room to stage its last error. mysql_error() returns a
   pointer into the MYSQL struct that the next call overwrites, so the strings
   are copied here before being handed out through mdb_error. */
struct Connection {
  MYSQL *mysql = nullptr;
  uint32_t last_errno = 0;
  std::string last_sql_state;
  std::string last_message;

  /*
    Async execution state.

    Two connections cannot contend for a row lock while both are driven from
    one JavaScript thread: the first blocking call owns the thread, so the
    other transaction can never reach its COMMIT. Running a query on its own
    thread is what makes real concurrency - and therefore deadlock detection,
    and lock waits that resolve rather than time out - expressible at all.

    One query at a time per connection. The MariaDB client API does not
    support concurrent calls on a single connection, and pretending otherwise
    would corrupt the protocol state rather than fail cleanly.
  */
  std::atomic<int> async_state{0};   /* 0 idle, 1 running, 2 finished */
  int async_status = MDB_OK;
  mdb_result_handle async_result = 0;
  std::string async_sql;

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
