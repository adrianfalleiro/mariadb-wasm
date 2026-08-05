/* Shared internals of the C ABI wrapper. Not installed, not part of the ABI. */
#ifndef MARIADB_WASM_INTERNAL_H
#define MARIADB_WASM_INTERNAL_H

#include <mysql.h>

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

  ~Connection();

  /* Snapshot whatever mysql_errno/sqlstate/error currently report. */
  void capture_error();
  void clear_error();
};

/* A buffered result set. mysql_store_result is used rather than use_result so
   row_count is available and so a half-read result cannot wedge the
   connection when JavaScript abandons iteration — which it will, on any test
   that throws mid-loop. */
struct Result {
  MYSQL_RES *res = nullptr;
  MYSQL_ROW current_row = nullptr;      /* owned by res */
  unsigned long *current_lengths = nullptr;
  uint32_t column_count = 0;
  MYSQL_FIELD *fields = nullptr;        /* owned by res */

  ~Result();
};

HandleTable<Connection> &connections();
HandleTable<Result> &results();

bool runtime_ready();
void set_runtime_ready(bool ready);

/* Records an error that has no connection to belong to. */
void set_global_error(uint32_t code, const char *sql_state, const char *message);

/* Fills out_error with pointers into long-lived storage; valid until the next
   set_global_error. */
void fill_global_error(mdb_error *out_error);

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
