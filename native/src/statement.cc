/* Prepared statements: parameter binding and binary-protocol results. */
#include "internal.h"

#include <cstring>

namespace mdb {

Statement::~Statement() {
  if (stmt) {
    mysql_stmt_close(stmt);
    stmt = nullptr;
  }
}

void Statement::reset_bindings() {
  binds.assign(param_count, MYSQL_BIND{});
  buffers.assign(param_count, std::vector<char>());
  lengths.assign(param_count, 0);
  nulls.assign(param_count, 0);

  /* Unbound parameters default to NULL rather than to whatever the previous
     execution left behind. Executing with a stale value is far worse than
     executing with a NULL the server will usually reject. */
  for (uint32_t i = 0; i < param_count; i++) {
    binds[i].buffer_type = MYSQL_TYPE_NULL;
    binds[i].is_null = &nulls[i];
    nulls[i] = 1;
  }
}

void Statement::capture_error() {
  last_errno = stmt ? mysql_stmt_errno(stmt) : 0;
  const char *state = stmt ? mysql_stmt_sqlstate(stmt) : nullptr;
  const char *message = stmt ? mysql_stmt_error(stmt) : nullptr;
  last_sql_state = state ? state : "";
  last_message = message ? message : "";
}

HandleTable<Statement> &statements() {
  static HandleTable<Statement> instance;
  return instance;
}

std::unique_ptr<Result> materialise_statement_result(Statement &statement) {
  MYSQL_RES *meta = mysql_stmt_result_metadata(statement.stmt);
  if (!meta)
    return nullptr;  /* no result set; caller checks errno to tell why */

  auto result = std::unique_ptr<Result>(new Result());
  result->from_statement = true;
  result->res = meta;
  result->stmt = statement.stmt;
  result->column_count = mysql_num_fields(meta);
  result->fields = mysql_fetch_fields(meta);

  /* max_length is only populated when the whole result is buffered and the
     attribute is set, and it is what lets each column's buffer be sized once
     instead of refetching truncated values. */
  my_bool update_max_length = 1;
  mysql_stmt_attr_set(statement.stmt, STMT_ATTR_UPDATE_MAX_LENGTH,
                      &update_max_length);

  if (mysql_stmt_store_result(statement.stmt) != 0) {
    statement.capture_error();
    return nullptr;
  }

  const uint32_t columns = result->column_count;
  result->binds.assign(columns, MYSQL_BIND{});
  result->buffers.resize(columns);
  result->lengths.assign(columns, 0);
  result->nulls.assign(columns, 0);
  result->truncated.assign(columns, 0);

  for (uint32_t i = 0; i < columns; i++) {
    /* Every column is fetched as text. The text protocol already hands the
       decoder strings, so doing the same here keeps prepared statements and
       plain queries returning byte-identical values — which is exactly what
       the differential suite compares. Binding native numeric types instead
       would route DECIMAL and BIGINT through a double and lose precision the
       text path preserves.

       +1 so a value of exactly max_length still has somewhere to land. */
    size_t capacity = static_cast<size_t>(result->fields[i].max_length) + 1;
    result->buffers[i].assign(capacity, '\0');

    result->binds[i].buffer_type = MYSQL_TYPE_STRING;
    result->binds[i].buffer = result->buffers[i].data();
    result->binds[i].buffer_length = static_cast<unsigned long>(capacity);
    result->binds[i].length = &result->lengths[i];
    result->binds[i].is_null = &result->nulls[i];
    result->binds[i].error = &result->truncated[i];
  }

  if (mysql_stmt_bind_result(statement.stmt, result->binds.data()) != 0) {
    statement.capture_error();
    return nullptr;
  }

  return result;
}

namespace {

/* Shared prologue for the bind_* family. */
Statement *resolve_for_bind(mdb_statement_handle handle, uint32_t index) {
  Statement *statement = statements().get(handle);
  if (!statement || index >= statement->param_count)
    return nullptr;
  return statement;
}

/* Copies `length` bytes into the parameter's own buffer and points the bind
   at it, so the caller's memory is not retained. */
int bind_bytes(Statement &statement, uint32_t index, const uint8_t *data,
               size_t length, enum enum_field_types type) {
  std::vector<char> &buffer = statement.buffers[index];
  buffer.assign(length + 1, '\0');
  if (length && data)
    std::memcpy(buffer.data(), data, length);

  statement.lengths[index] = static_cast<unsigned long>(length);
  statement.nulls[index] = 0;

  MYSQL_BIND &bind = statement.binds[index];
  bind = MYSQL_BIND{};
  bind.buffer_type = type;
  bind.buffer = buffer.data();
  bind.buffer_length = static_cast<unsigned long>(length);
  bind.length = &statement.lengths[index];
  bind.is_null = &statement.nulls[index];
  return MDB_OK;
}

/* Numeric binds keep the value in the same per-parameter buffer, since
   MYSQL_BIND stores a pointer and the value must outlive the call. */
template <typename T>
int bind_scalar(Statement &statement, uint32_t index, T value,
                enum enum_field_types type, bool is_unsigned) {
  std::vector<char> &buffer = statement.buffers[index];
  buffer.assign(sizeof(T), '\0');
  std::memcpy(buffer.data(), &value, sizeof(T));

  statement.nulls[index] = 0;
  statement.lengths[index] = sizeof(T);

  MYSQL_BIND &bind = statement.binds[index];
  bind = MYSQL_BIND{};
  bind.buffer_type = type;
  bind.buffer = buffer.data();
  bind.buffer_length = sizeof(T);
  bind.is_null = &statement.nulls[index];
  bind.is_unsigned = is_unsigned ? 1 : 0;
  return MDB_OK;
}

}  // namespace

int prepare_statement_now(Connection &connection,
                          mdb_connection_handle connection_handle,
                          const std::string &sql,
                          mdb_statement_handle *out_statement) {
  auto statement = std::unique_ptr<Statement>(new Statement());
  statement->owner = connection_handle;
  statement->stmt = mysql_stmt_init(connection.mysql);
  if (!statement->stmt) {
    connection.capture_error();
    return MDB_ERR_MYSQL;
  }

  if (mysql_stmt_prepare(statement->stmt, sql.data(),
                         static_cast<unsigned long>(sql.size())) != 0) {
    statement->capture_error();
    /* Also on the connection: the caller has no statement handle to ask. */
    connection.last_errno = statement->last_errno;
    connection.last_sql_state = statement->last_sql_state;
    connection.last_message = statement->last_message;
    set_global_error(statement->last_errno,
                     statement->last_sql_state.c_str(),
                     statement->last_message.c_str());
    return MDB_ERR_MYSQL;
  }

  statement->param_count =
      static_cast<uint32_t>(mysql_stmt_param_count(statement->stmt));
  statement->reset_bindings();

  mdb_statement_handle handle = statements().insert(std::move(statement));
  if (handle == MDB_INVALID_HANDLE) {
    connection.last_errno = 0;
    connection.last_sql_state = "HY000";
    connection.last_message = "statement handle table exhausted";
    set_global_error(0, "HY000", "statement handle table exhausted");
    return MDB_ERR_NO_MEMORY;
  }

  *out_statement = handle;
  return MDB_OK;
}

int execute_statement_now(Statement &statement, mdb_result_handle *out_result) {
  statement.last_errno = 0;
  statement.last_sql_state.clear();
  statement.last_message.clear();

  if (statement.param_count > 0 &&
      mysql_stmt_bind_param(statement.stmt, statement.binds.data()) != 0) {
    statement.capture_error();
    return MDB_ERR_MYSQL;
  }

  if (mysql_stmt_execute(statement.stmt) != 0) {
    statement.capture_error();
    return MDB_ERR_MYSQL;
  }

  std::unique_ptr<Result> materialised = materialise_statement_result(statement);

  if (!materialised) {
    /* No metadata means no result set, which is normal for INSERT and DDL.
       An error during store/bind sets errno, which is how the two are told
       apart. */
    return statement.last_errno != 0 ? MDB_ERR_MYSQL : MDB_OK;
  }

  mdb_result_handle handle = results().insert(std::move(materialised));
  if (handle == MDB_INVALID_HANDLE) {
    statement.last_sql_state = "HY000";
    statement.last_message = "result handle table exhausted";
    return MDB_ERR_NO_MEMORY;
  }

  *out_result = handle;
  return MDB_OK;
}

}  // namespace mdb

extern "C" {

mdb_statement_handle mdb_statement_prepare(mdb_connection_handle connection,
                                           const uint8_t *sql,
                                           size_t sql_length) {
  MDB_GUARD_BEGIN

  mdb::Connection *conn = mdb::connections().get(connection);
  if (!conn) {
    mdb::set_global_error(0, "HY000", "unknown connection handle");
    return MDB_INVALID_HANDLE;
  }

  mdb_statement_handle handle = MDB_INVALID_HANDLE;
  std::string owned;
  if (sql)
    owned.assign(reinterpret_cast<const char *>(sql), sql_length);
  if (mdb::prepare_statement_now(*conn, connection, owned, &handle) != MDB_OK)
    return MDB_INVALID_HANDLE;

  return handle;

  MDB_GUARD_END(MDB_INVALID_HANDLE)
}

uint32_t mdb_statement_param_count(mdb_statement_handle statement) {
  MDB_GUARD_BEGIN

  mdb::Statement *found = mdb::statements().get(statement);
  return found ? found->param_count : 0;

  MDB_GUARD_END(0)
}

int mdb_statement_bind_null(mdb_statement_handle statement, uint32_t index) {
  MDB_GUARD_BEGIN

  mdb::Statement *found = mdb::resolve_for_bind(statement, index);
  if (!found)
    return MDB_ERR_BAD_HANDLE;

  found->nulls[index] = 1;
  found->binds[index] = MYSQL_BIND{};
  found->binds[index].buffer_type = MYSQL_TYPE_NULL;
  found->binds[index].is_null = &found->nulls[index];
  return MDB_OK;

  MDB_GUARD_END(MDB_ERR_INTERNAL)
}

int mdb_statement_bind_int64(mdb_statement_handle statement, uint32_t index,
                             int64_t value) {
  MDB_GUARD_BEGIN

  mdb::Statement *found = mdb::resolve_for_bind(statement, index);
  if (!found)
    return MDB_ERR_BAD_HANDLE;

  return mdb::bind_scalar(*found, index, value, MYSQL_TYPE_LONGLONG, false);

  MDB_GUARD_END(MDB_ERR_INTERNAL)
}

int mdb_statement_bind_uint64(mdb_statement_handle statement, uint32_t index,
                              uint64_t value) {
  MDB_GUARD_BEGIN

  mdb::Statement *found = mdb::resolve_for_bind(statement, index);
  if (!found)
    return MDB_ERR_BAD_HANDLE;

  return mdb::bind_scalar(*found, index, value, MYSQL_TYPE_LONGLONG, true);

  MDB_GUARD_END(MDB_ERR_INTERNAL)
}

int mdb_statement_bind_double(mdb_statement_handle statement, uint32_t index,
                              double value) {
  MDB_GUARD_BEGIN

  mdb::Statement *found = mdb::resolve_for_bind(statement, index);
  if (!found)
    return MDB_ERR_BAD_HANDLE;

  return mdb::bind_scalar(*found, index, value, MYSQL_TYPE_DOUBLE, false);

  MDB_GUARD_END(MDB_ERR_INTERNAL)
}

int mdb_statement_bind_string(mdb_statement_handle statement, uint32_t index,
                              const uint8_t *data, size_t length) {
  MDB_GUARD_BEGIN

  mdb::Statement *found = mdb::resolve_for_bind(statement, index);
  if (!found)
    return MDB_ERR_BAD_HANDLE;

  return mdb::bind_bytes(*found, index, data, length, MYSQL_TYPE_STRING);

  MDB_GUARD_END(MDB_ERR_INTERNAL)
}

int mdb_statement_bind_blob(mdb_statement_handle statement, uint32_t index,
                            const uint8_t *data, size_t length) {
  MDB_GUARD_BEGIN

  mdb::Statement *found = mdb::resolve_for_bind(statement, index);
  if (!found)
    return MDB_ERR_BAD_HANDLE;

  /* MYSQL_TYPE_BLOB rather than STRING so the server does not apply the
     connection charset to bytes that are not text. */
  return mdb::bind_bytes(*found, index, data, length, MYSQL_TYPE_BLOB);

  MDB_GUARD_END(MDB_ERR_INTERNAL)
}

int mdb_statement_execute(mdb_statement_handle statement,
                          mdb_result_handle *result) {
  MDB_GUARD_BEGIN

  if (result)
    *result = MDB_INVALID_HANDLE;

  mdb::Statement *found = mdb::statements().get(statement);
  if (!found)
    return MDB_ERR_BAD_HANDLE;

  mdb_result_handle produced = MDB_INVALID_HANDLE;
  const int status = mdb::execute_statement_now(*found, &produced);

  if (status != MDB_OK)
    return status;

  if (!produced)
    return MDB_OK;

  if (!result) {
    /* Caller does not want the rows; do not leak them. */
    mdb_result_free(produced);
    return MDB_OK;
  }

  *result = produced;
  return MDB_OK;

  MDB_GUARD_END(MDB_ERR_INTERNAL)
}

int mdb_statement_prepare_async(mdb_connection_handle connection,
                                const uint8_t *sql,
                                size_t sql_length) {
  MDB_GUARD_BEGIN

  mdb::Connection *conn = mdb::connections().get(connection);
  if (!conn)
    return MDB_ERR_BAD_HANDLE;
  if (!sql && sql_length != 0)
    return MDB_ERR_BAD_HANDLE;

  return mdb::start_pending_call(connection, *conn, mdb::PendingKind::Prepare,
                                 sql, sql_length, MDB_INVALID_HANDLE);

  MDB_GUARD_END(MDB_ERR_INTERNAL)
}

int mdb_statement_prepare_poll(mdb_connection_handle connection,
                               mdb_statement_handle *statement) {
  MDB_GUARD_BEGIN

  if (statement)
    *statement = MDB_INVALID_HANDLE;

  mdb::Connection *conn = mdb::connections().get(connection);
  if (!conn)
    return -MDB_ERR_BAD_HANDLE;

  return mdb::poll_pending_call(*conn, mdb::PendingKind::Prepare, statement);

  MDB_GUARD_END(-MDB_ERR_INTERNAL)
}

int mdb_statement_execute_async(mdb_statement_handle statement) {
  MDB_GUARD_BEGIN

  mdb::Statement *found = mdb::statements().get(statement);
  if (!found)
    return MDB_ERR_BAD_HANDLE;

  /* Execution is serialised on the connection, not on the statement: two
     statements prepared on one connection share a single MYSQL, so they
     contend for the same pending slot. */
  mdb::Connection *conn = mdb::connections().get(found->owner);
  if (!conn) {
    found->last_errno = 0;
    found->last_sql_state = "HY000";
    found->last_message = "the connection this statement was prepared on is closed";
    return MDB_ERR_BAD_HANDLE;
  }

  return mdb::start_pending_call(found->owner, *conn, mdb::PendingKind::Execute,
                                 nullptr, 0, statement);

  MDB_GUARD_END(MDB_ERR_INTERNAL)
}

int mdb_statement_execute_poll(mdb_statement_handle statement,
                               mdb_result_handle *result) {
  MDB_GUARD_BEGIN

  if (result)
    *result = MDB_INVALID_HANDLE;

  mdb::Statement *found = mdb::statements().get(statement);
  if (!found)
    return -MDB_ERR_BAD_HANDLE;

  mdb::Connection *conn = mdb::connections().get(found->owner);
  if (!conn)
    return -MDB_ERR_BAD_HANDLE;

  /* Guards against polling one statement for another's execution: both share
     the connection's slot, so the handle has to match too. */
  if (conn->pending.state.load(std::memory_order_acquire) != 0 &&
      conn->pending.statement != statement)
    return -MDB_ERR_BAD_STATE;

  return mdb::poll_pending_call(*conn, mdb::PendingKind::Execute, result);

  MDB_GUARD_END(-MDB_ERR_INTERNAL)
}

uint64_t mdb_statement_affected_rows(mdb_statement_handle statement) {
  MDB_GUARD_BEGIN

  mdb::Statement *found = mdb::statements().get(statement);
  if (!found)
    return 0;

  my_ulonglong affected = mysql_stmt_affected_rows(found->stmt);
  if (affected == static_cast<my_ulonglong>(-1))
    return 0;  /* same normalisation as the connection-level accessor */

  return static_cast<uint64_t>(affected);

  MDB_GUARD_END(0)
}

uint64_t mdb_statement_insert_id(mdb_statement_handle statement) {
  MDB_GUARD_BEGIN

  mdb::Statement *found = mdb::statements().get(statement);
  return found ? static_cast<uint64_t>(mysql_stmt_insert_id(found->stmt)) : 0;

  MDB_GUARD_END(0)
}

int mdb_statement_last_error(mdb_statement_handle statement,
                             mdb_error *out_error) {
  MDB_GUARD_BEGIN

  if (!out_error)
    return MDB_ERR_BAD_HANDLE;

  mdb::Statement *found = mdb::statements().get(statement);
  if (!found)
    return MDB_ERR_BAD_HANDLE;

  out_error->code = found->last_errno;
  out_error->sql_state = found->last_sql_state.c_str();
  out_error->message = found->last_message.c_str();
  return MDB_OK;

  MDB_GUARD_END(MDB_ERR_INTERNAL)
}

int mdb_statement_reset(mdb_statement_handle statement) {
  MDB_GUARD_BEGIN

  mdb::Statement *found = mdb::statements().get(statement);
  if (!found)
    return MDB_ERR_BAD_HANDLE;

  /* free_result before reset: a stored result still attached to the statement
     keeps the connection busy, and the next execute would fail with
     "Commands out of sync". */
  mysql_stmt_free_result(found->stmt);

  if (mysql_stmt_reset(found->stmt) != 0) {
    found->capture_error();
    return MDB_ERR_MYSQL;
  }

  found->reset_bindings();
  return MDB_OK;

  MDB_GUARD_END(MDB_ERR_INTERNAL)
}

int mdb_statement_close(mdb_statement_handle statement) {
  MDB_GUARD_BEGIN

  std::unique_ptr<mdb::Statement> owned = mdb::statements().remove(statement);
  if (!owned)
    return MDB_ERR_BAD_HANDLE;

  owned.reset();
  return MDB_OK;

  MDB_GUARD_END(MDB_ERR_INTERNAL)
}

}  // extern "C"
