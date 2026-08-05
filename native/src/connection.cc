/* Connection lifecycle and query execution. */
#include "internal.h"

#include <cstring>

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
                          database_name, 0, nullptr, 0)) {
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
