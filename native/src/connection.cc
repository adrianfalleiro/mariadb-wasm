/* Connection lifecycle and query execution. */
#include "internal.h"

#include <cstring>
#include <memory>
#include <pthread.h>

extern "C" {

mdb_connection_handle mdb_connection_open(const char *database_name) {
  MDB_GUARD_BEGIN

  if (!mdb::runtime_ready()) {
    mdb::set_global_error(0, "HY000", "runtime not initialised");
    return MDB_INVALID_HANDLE;
  }

  auto connection = std::unique_ptr<mdb::Connection>(new mdb::Connection());
  connection->mysql = mysql_init(nullptr);
  if (!connection->mysql) {
    mdb::set_global_error(0, "HY000", "mysql_init failed");
    return MDB_INVALID_HANDLE;
  }

  /* The whole point of the exercise: this makes mysql_real_connect dispatch
     in-process through lib_sql.cc instead of opening a socket. Without it the
     client half would try to reach a daemon that does not exist. */
  mysql_options(connection->mysql, MYSQL_OPT_USE_EMBEDDED_CONNECTION, nullptr);

  if (!mysql_real_connect(connection->mysql, nullptr, nullptr, nullptr,
                          database_name, 0, nullptr, CLIENT_FOUND_ROWS)) {
    connection->capture_error();
    mdb::set_global_error(connection->last_errno,
                          connection->last_sql_state.c_str(),
                          connection->last_message.c_str());
    return MDB_INVALID_HANDLE;
  }

  uint32_t handle = mdb::connections().insert(std::move(connection));
  if (handle == MDB_INVALID_HANDLE)
    mdb::set_global_error(0, "HY000", "connection handle table exhausted");

  return handle;

  MDB_GUARD_END(MDB_INVALID_HANDLE)
}

int mdb_connection_close(mdb_connection_handle connection) {
  MDB_GUARD_BEGIN

  mdb::Connection *current = mdb::connections().get(connection);
  if (current && current->pending.state.load(std::memory_order_acquire) != 0)
    return MDB_ERR_BAD_STATE;

  /* remove() takes it out of the table before destruction runs, so a
     concurrent call with the same handle gets BAD_HANDLE rather than racing
     mysql_close. */
  std::unique_ptr<mdb::Connection> owned = mdb::connections().remove(connection);
  if (!owned)
    return MDB_ERR_BAD_HANDLE;

  owned.reset();
  return MDB_OK;

  MDB_GUARD_END(MDB_ERR_INTERNAL)
}

int mdb_connection_query(mdb_connection_handle connection,
                         const uint8_t *sql,
                         size_t sql_length,
                         mdb_result_handle *result) {
  MDB_GUARD_BEGIN

  if (result)
    *result = MDB_INVALID_HANDLE;

  mdb::Connection *conn = mdb::connections().get(connection);
  if (!conn)
    return MDB_ERR_BAD_HANDLE;
  if (!sql && sql_length != 0)
    return MDB_ERR_BAD_HANDLE;

  conn->clear_error();

  /* Length-delimited, so SQL containing NUL bytes is executed intact rather
     than silently truncated. */
  if (mysql_real_query(conn->mysql, reinterpret_cast<const char *>(sql),
                       static_cast<unsigned long>(sql_length)) != 0) {
    conn->capture_error();
    return MDB_ERR_MYSQL;
  }

  /* No result set is normal for INSERT/UPDATE/DDL. Distinguishing that from a
     genuine failure needs mysql_field_count, not just a NULL result: a SELECT
     whose store_result failed also returns NULL. */
  MYSQL_RES *res = mysql_store_result(conn->mysql);
  if (!res) {
    if (mysql_field_count(conn->mysql) == 0)
      return MDB_OK;  /* statement legitimately returned no rows */

    conn->capture_error();
    return MDB_ERR_MYSQL;
  }

  if (!result) {
    /* Caller does not want the rows; do not leak them. */
    mysql_free_result(res);
    return MDB_OK;
  }

  auto wrapper = std::unique_ptr<mdb::Result>(new mdb::Result());
  wrapper->res = res;
  wrapper->column_count = mysql_num_fields(res);
  wrapper->fields = mysql_fetch_fields(res);

  uint32_t handle = mdb::results().insert(std::move(wrapper));
  if (handle == MDB_INVALID_HANDLE) {
    conn->last_errno = 0;
    conn->last_sql_state = "HY000";
    conn->last_message = "result handle table exhausted";
    return MDB_ERR_NO_MEMORY;
  }

  *result = handle;
  return MDB_OK;

  MDB_GUARD_END(MDB_ERR_INTERNAL)
}

uint64_t mdb_connection_affected_rows(mdb_connection_handle connection) {
  MDB_GUARD_BEGIN

  mdb::Connection *conn = mdb::connections().get(connection);
  if (!conn)
    return 0;

  /* MariaDB returns (my_ulonglong)-1 for statements where the count is not
     meaningful. Passing that through as 0xFFFF... would reach JavaScript as
     18446744073709551615, so it is normalised to 0 here and documented. */
  my_ulonglong affected = mysql_affected_rows(conn->mysql);
  if (affected == static_cast<my_ulonglong>(-1))
    return 0;

  return static_cast<uint64_t>(affected);

  MDB_GUARD_END(0)
}

uint64_t mdb_connection_insert_id(mdb_connection_handle connection) {
  MDB_GUARD_BEGIN

  mdb::Connection *conn = mdb::connections().get(connection);
  if (!conn)
    return 0;

  return static_cast<uint64_t>(mysql_insert_id(conn->mysql));

  MDB_GUARD_END(0)
}

uint32_t mdb_connection_warning_count(mdb_connection_handle connection) {
  MDB_GUARD_BEGIN

  mdb::Connection *conn = mdb::connections().get(connection);
  if (!conn)
    return 0;

  return static_cast<uint32_t>(mysql_warning_count(conn->mysql));

  MDB_GUARD_END(0)
}

int mdb_connection_last_error(mdb_connection_handle connection,
                              mdb_error *out_error) {
  MDB_GUARD_BEGIN

  if (!out_error)
    return MDB_ERR_BAD_HANDLE;

  mdb::Connection *conn = mdb::connections().get(connection);
  if (!conn)
    return MDB_ERR_BAD_HANDLE;

  /* Points into the Connection's own strings, which live until the next
     capture_error on this connection. */
  out_error->code = conn->last_errno;
  out_error->sql_state = conn->last_sql_state.c_str();
  out_error->message = conn->last_message.c_str();
  return MDB_OK;

  MDB_GUARD_END(MDB_ERR_INTERNAL)
}

}  // extern "C"

namespace mdb {
namespace {

/* Handed to the worker thread; owns nothing the caller frees. */
struct AsyncCallJob {
  mdb_connection_handle connection;
};

/* The query body, shared by nothing else — the synchronous entry point above
   predates the pending slot and keeps its own copy so native callers are not
   routed through machinery they do not need. */
int run_pending_query(Connection &connection, uint32_t *produced) {
  connection.clear_error();
  const std::string &sql = connection.pending.sql;

  if (mysql_real_query(connection.mysql, sql.data(),
                       static_cast<unsigned long>(sql.size())) != 0) {
    connection.capture_error();
    return MDB_ERR_MYSQL;
  }

  MYSQL_RES *res = mysql_store_result(connection.mysql);
  if (!res) {
    /* No result set is normal for INSERT/UPDATE/DDL; only a non-zero field
       count means store_result genuinely failed. */
    if (mysql_field_count(connection.mysql) != 0) {
      connection.capture_error();
      return MDB_ERR_MYSQL;
    }
    return MDB_OK;
  }

  auto wrapper = std::unique_ptr<Result>(new Result());
  wrapper->res = res;
  wrapper->column_count = mysql_num_fields(res);
  wrapper->fields = mysql_fetch_fields(res);

  uint32_t handle = results().insert(std::move(wrapper));
  if (handle == MDB_INVALID_HANDLE) {
    connection.last_errno = 0;
    connection.last_sql_state = "HY000";
    connection.last_message = "result handle table exhausted";
    return MDB_ERR_NO_MEMORY;
  }

  *produced = handle;
  return MDB_OK;
}

/*
  Runs whatever the connection's pending slot asks for, on its own thread.

  Resolve the handle on entry; the connection destructor signals this worker
  and joins it before releasing the connection storage.
*/
void *async_call_entry(void *raw) {
  std::unique_ptr<AsyncCallJob> job(static_cast<AsyncCallJob *>(raw));

  /* Every thread that touches the client API must register with mysys, and
     must unregister before it exits - a thread that skips my_thread_end is
     exactly what makes mysql_server_end wait out its full timeout. */
  mysql_thread_init();

  Connection *conn = connections().get(job->connection);
  while (conn) {
    {
      std::unique_lock<std::mutex> lock(conn->work_mutex);
      conn->work_ready.wait(lock, [&] {
        return conn->stop_worker || conn->pending.state.load(std::memory_order_acquire) == 1;
      });
      if (conn->stop_worker) break;
    }
    int status = MDB_OK;
    uint32_t produced = MDB_INVALID_HANDLE;

    try {
      switch (conn->pending.kind) {
        case PendingKind::Query:
          status = run_pending_query(*conn, &produced);
          break;

        case PendingKind::Prepare: {
          mdb_statement_handle statement = MDB_INVALID_HANDLE;
          status = prepare_statement_now(*conn, job->connection,
                                         conn->pending.sql, &statement);
          produced = statement;
          break;
        }

        case PendingKind::Execute: {
          /* Re-resolved for the same reason as the connection: the caller may
             have closed the statement while this was queued. */
          Statement *statement = statements().get(conn->pending.statement);
          if (!statement) {
            status = MDB_ERR_BAD_HANDLE;
            break;
          }
          mdb_result_handle result = MDB_INVALID_HANDLE;
          status = execute_statement_now(*statement, &result);
          produced = result;
          break;
        }

        case PendingKind::None:
          status = MDB_ERR_BAD_STATE;
          break;
      }
    } catch (...) {
      status = MDB_ERR_INTERNAL;
    }

    conn->pending.status = status;
    conn->pending.produced = produced;
    /* Release: a poller that sees state 2 must also see status and produced. */
    conn->pending.state.store(2, std::memory_order_release);
  }

  mysql_thread_end();
  return nullptr;
}

}  // namespace

int start_pending_call(mdb_connection_handle connection_handle,
                       Connection &connection,
                       PendingKind kind,
                       const uint8_t *sql,
                       size_t sql_length,
                       mdb_statement_handle statement) {
  std::lock_guard<std::mutex> lock(connection.work_mutex);
  if (connection.pending.state.load(std::memory_order_acquire) != 0) {
    connection.last_errno = 0;
    connection.last_sql_state = "HY000";
    connection.last_message = "a call is already in flight on this connection";
    return MDB_ERR_BAD_STATE;
  }

  /* The SQL is copied on the caller's thread: the caller frees its buffer as
     soon as this returns. Execute passes none, and assign(nullptr, 0) is not
     something to rely on. */
  if (sql)
    connection.pending.sql.assign(reinterpret_cast<const char *>(sql),
                                  sql_length);
  else
    connection.pending.sql.clear();
  connection.pending.kind = kind;
  connection.pending.statement = statement;
  connection.pending.status = MDB_OK;
  connection.pending.produced = MDB_INVALID_HANDLE;
  connection.pending.state.store(1, std::memory_order_release);

  if (!connection.worker_started) {
    auto job = std::unique_ptr<AsyncCallJob>(new AsyncCallJob{connection_handle});
    if (pthread_create(&connection.worker, nullptr, async_call_entry, job.get()) != 0) {
      connection.pending.kind = PendingKind::None;
      connection.pending.state.store(0, std::memory_order_release);
      connection.last_errno = 0;
      connection.last_sql_state = "HY000";
      connection.last_message = "could not create a thread for the connection";
      return MDB_ERR_INTERNAL;
    }
    job.release();
    connection.worker_started = true;
  }
  connection.work_ready.notify_one();
  return MDB_OK;
}

int poll_pending_call(Connection &connection, PendingKind expected,
                      uint32_t *out_produced) {
  const int state = connection.pending.state.load(std::memory_order_acquire);

  /* Checked before the state is interpreted: polling for one operation while
     another is in flight would otherwise be answered with "still running",
     which reads as progress rather than as the caller bug it is. */
  if (state != 0 && connection.pending.kind != expected)
    return -MDB_ERR_BAD_STATE;

  switch (state) {
    case 1:
      return 0;
    case 2: {
      const int status = connection.pending.status;
      const uint32_t produced = connection.pending.produced;

      /* Collected: the slot is free for the next call. */
      connection.pending.kind = PendingKind::None;
      connection.pending.state.store(0, std::memory_order_release);

      if (status != MDB_OK)
        return -status;
      if (out_produced)
        *out_produced = produced;
      return 1;
    }
    default:
      return -MDB_ERR_BAD_STATE;
  }
}

}  // namespace mdb

extern "C" {

int mdb_connection_query_async(mdb_connection_handle connection,
                               const uint8_t *sql,
                               size_t sql_length) {
  MDB_GUARD_BEGIN

  mdb::Connection *conn = mdb::connections().get(connection);
  if (!conn)
    return MDB_ERR_BAD_HANDLE;
  if (!sql && sql_length != 0)
    return MDB_ERR_BAD_HANDLE;

  return mdb::start_pending_call(connection, *conn, mdb::PendingKind::Query,
                                 sql, sql_length, MDB_INVALID_HANDLE);

  MDB_GUARD_END(MDB_ERR_INTERNAL)
}

int mdb_connection_query_poll(mdb_connection_handle connection,
                              mdb_result_handle *result) {
  MDB_GUARD_BEGIN

  if (result)
    *result = MDB_INVALID_HANDLE;

  mdb::Connection *conn = mdb::connections().get(connection);
  if (!conn)
    return -MDB_ERR_BAD_HANDLE;

  return mdb::poll_pending_call(*conn, mdb::PendingKind::Query, result);

  MDB_GUARD_END(-MDB_ERR_INTERNAL)
}

}  // extern "C"
