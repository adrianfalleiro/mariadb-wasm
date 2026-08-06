/*
  Phase 2 exit condition: the same scenario as smoke.c, driven entirely through
  the C ABI in native/include/mariadb_wasm.h.

  Run natively, this proves the wrapper is correct before Emscripten is in the
  picture. Anything that fails here is a wrapper bug; anything that fails only
  under wasm is a porting bug. Keeping the two testable separately is the point.
*/
#include "mariadb_wasm.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures = 0;

static void fail(const char *fmt, ...)
{
  va_list ap;
  va_start(ap, fmt);
  fputs("  FAIL ", stdout);
  vprintf(fmt, ap);
  fputc('\n', stdout);
  va_end(ap);
  failures++;
}

static void ok(const char *what) { printf("  ok   %s\n", what); }

static void report_error(mdb_connection_handle conn, const char *what)
{
  mdb_error error;
  if (mdb_connection_last_error(conn, &error) == MDB_OK)
    fail("%s: errno=%u sqlstate=%s message=%s", what, error.code,
         error.sql_state, error.message);
  else
    fail("%s: (no error detail available)", what);
}

/* Executes and discards any result set. */
static int exec_sql(mdb_connection_handle conn, const char *sql)
{
  mdb_result_handle result = MDB_INVALID_HANDLE;
  int status = mdb_connection_query(conn, (const uint8_t *) sql, strlen(sql),
                                    &result);
  if (status != MDB_OK)
  {
    report_error(conn, sql);
    return -1;
  }
  if (result != MDB_INVALID_HANDLE)
    mdb_result_free(result);
  return 0;
}

/*
  Reads cell (0,0) as a length-delimited byte range and compares it to `want`.
  Deliberately does not use strcmp on the raw pointer: the ABI promises values
  are not NUL-terminated, and a test that relied on termination would hide the
  bug it exists to catch.
*/
static void expect_scalar(mdb_connection_handle conn, const char *sql,
                          const char *want, const char *what)
{
  mdb_result_handle result = MDB_INVALID_HANDLE;
  const uint8_t *data;
  size_t length;

  if (mdb_connection_query(conn, (const uint8_t *) sql, strlen(sql), &result)
      != MDB_OK)
  {
    report_error(conn, sql);
    return;
  }
  if (result == MDB_INVALID_HANDLE)
  {
    fail("%s: statement returned no result set", what);
    return;
  }
  if (mdb_result_next(result) != 1)
  {
    fail("%s: empty result set", what);
    mdb_result_free(result);
    return;
  }

  data = mdb_result_value_data(result, 0);
  length = mdb_result_value_length(result, 0);

  if (!data)
    fail("%s: value is NULL, expected %s", what, want);
  else if (length != strlen(want) || memcmp(data, want, length) != 0)
    fail("%s: expected '%s', got '%.*s' (%zu bytes)", what, want, (int) length,
         (const char *) data, length);
  else
    ok(what);

  mdb_result_free(result);
}

int main(int argc, char **argv)
{
  char datadir_arg[4096];
  char lc_messages_arg[4096];
  char charsets_arg[4096];
  mdb_connection_handle conn;

  if (argc < 4)
  {
    fprintf(stderr, "usage: %s <datadir> <lc-messages-dir> <charsets-dir>\n",
            argv[0]);
    return 2;
  }

  snprintf(datadir_arg, sizeof datadir_arg, "--datadir=%s", argv[1]);
  snprintf(lc_messages_arg, sizeof lc_messages_arg, "--lc-messages-dir=%s",
           argv[2]);
  snprintf(charsets_arg, sizeof charsets_arg, "--character-sets-dir=%s",
           argv[3]);

  {
    /* Note: no argv[0]. The wrapper prepends the program name itself, which is
       one of the details the ABI exists to keep out of the caller. */
    const char *server_args[] = {
      "--no-defaults",
      "--skip-grant-tables",
      "--skip-networking",
      "--performance-schema=OFF",
      "--max-connections=20",
      "--innodb-buffer-pool-size=16M",
      datadir_arg,
      lc_messages_arg,
      charsets_arg,
    };
    int nargs = (int) (sizeof server_args / sizeof server_args[0]);

    if (mdb_runtime_init(nargs, server_args) != MDB_OK)
    {
      mdb_error error;
      mdb_last_global_error(&error);
      fprintf(stderr, "  FAIL mdb_runtime_init: %s\n", error.message);
      return 1;
    }
    ok("mdb_runtime_init");
  }

  if (!mdb_runtime_is_ready())
    fail("mdb_runtime_is_ready returned 0 after a successful init");
  else
    ok("mdb_runtime_is_ready");

  /* Initialisation is process-global, so a second init must be refused rather
     than quietly re-entering mysql_server_init. */
  if (mdb_runtime_init(0, NULL) != MDB_ERR_BAD_STATE)
    fail("second mdb_runtime_init should have returned MDB_ERR_BAD_STATE");
  else
    ok("double init rejected with MDB_ERR_BAD_STATE");

  conn = mdb_connection_open(NULL);
  if (conn == MDB_INVALID_HANDLE)
  {
    mdb_error error;
    mdb_last_global_error(&error);
    fprintf(stderr, "  FAIL mdb_connection_open: %s\n", error.message);
    return 1;
  }
  ok("mdb_connection_open");

  if (exec_sql(conn, "CREATE DATABASE IF NOT EXISTS wasm_test") == 0)
    ok("CREATE DATABASE");
  if (exec_sql(conn, "USE wasm_test") == 0)
    ok("USE wasm_test");

  if (exec_sql(conn,
               "CREATE TABLE users ("
               "  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,"
               "  email VARCHAR(255) NOT NULL,"
               "  balance DECIMAL(20,4) NOT NULL DEFAULT 0,"
               "  payload VARBINARY(255),"
               "  note VARCHAR(64),"
               "  created_at DATETIME(6) NOT NULL,"
               "  PRIMARY KEY (id),"
               "  UNIQUE KEY uq_users_email (email)"
               ") ENGINE=InnoDB") == 0)
    ok("CREATE TABLE ... ENGINE=InnoDB");

  expect_scalar(conn,
                "SELECT ENGINE FROM information_schema.TABLES"
                " WHERE TABLE_SCHEMA='wasm_test' AND TABLE_NAME='users'",
                "InnoDB", "table engine is InnoDB");

  /* note is deliberately '' on one row and NULL on the other, so the
     NULL-vs-empty distinction is exercised rather than assumed. */
  if (exec_sql(conn,
               "INSERT INTO users(email, balance, payload, note, created_at)"
               " VALUES ('a@example.com', 10.2500, X'000102FF', '',"
               "         '2026-01-02 03:04:05.123456'),"
               "        ('b@example.com', 0.0001, NULL, NULL,"
               "         '2026-01-02 03:04:05.000001')") == 0)
    ok("INSERT (multi-row)");

  if (mdb_connection_affected_rows(conn) != 2)
    fail("affected_rows: expected 2, got %llu",
         (unsigned long long) mdb_connection_affected_rows(conn));
  else
    ok("affected_rows == 2");

  if (mdb_connection_insert_id(conn) != 1)
    fail("insert_id: expected 1, got %llu",
         (unsigned long long) mdb_connection_insert_id(conn));
  else
    ok("insert_id == 1");

  expect_scalar(conn, "SELECT balance FROM users WHERE id=1", "10.2500",
                "DECIMAL(20,4) round-trips exactly");
  expect_scalar(conn, "SELECT HEX(payload) FROM users WHERE id=1", "000102FF",
                "VARBINARY with embedded NUL round-trips");
  expect_scalar(conn, "SELECT created_at FROM users WHERE id=1",
                "2026-01-02 03:04:05.123456", "DATETIME(6) keeps microseconds");

  /* The ABI's central promise: NULL and '' are distinguishable. */
  {
    mdb_result_handle result = MDB_INVALID_HANDLE;
    const char *sql = "SELECT note FROM users ORDER BY id";

    if (mdb_connection_query(conn, (const uint8_t *) sql, strlen(sql), &result)
        == MDB_OK && result != MDB_INVALID_HANDLE)
    {
      if (mdb_result_next(result) != 1)
        fail("NULL/empty: no first row");
      else if (mdb_result_value_is_null(result, 0))
        fail("NULL/empty: row 1 note should be '' but reads as NULL");
      else if (mdb_result_value_length(result, 0) != 0)
        fail("NULL/empty: row 1 note should be zero-length");
      else if (mdb_result_value_data(result, 0) == NULL)
        fail("NULL/empty: zero-length value must still have a non-NULL pointer");
      else
        ok("zero-length value is non-NULL with length 0");

      if (mdb_result_next(result) != 1)
        fail("NULL/empty: no second row");
      else if (!mdb_result_value_is_null(result, 0))
        fail("NULL/empty: row 2 note should be NULL");
      else if (mdb_result_value_data(result, 0) != NULL)
        fail("NULL/empty: NULL value must have a NULL data pointer");
      else
        ok("NULL is distinct from zero-length");

      if (mdb_result_next(result) != 0)
        fail("NULL/empty: expected exactly 2 rows");
      else
        ok("mdb_result_next returns 0 at end of results");

      mdb_result_free(result);
    }
    else
      fail("NULL/empty: query failed");
  }

  /* Column metadata the TypeScript decoder depends on. */
  {
    mdb_result_handle result = MDB_INVALID_HANDLE;
    const char *sql = "SELECT id, email, payload FROM users WHERE id=1";

    if (mdb_connection_query(conn, (const uint8_t *) sql, strlen(sql), &result)
        == MDB_OK && result != MDB_INVALID_HANDLE)
    {
      if (mdb_result_column_count(result) != 3)
        fail("column_count: expected 3, got %u",
             mdb_result_column_count(result));
      else
        ok("column_count == 3");

      if (mdb_result_row_count(result) != 1)
        fail("row_count: expected 1, got %llu",
             (unsigned long long) mdb_result_row_count(result));
      else
        ok("row_count == 1 (buffered result)");

      if (strcmp(mdb_result_column_name(result, 1), "email") != 0)
        fail("column_name(1): expected 'email', got '%s'",
             mdb_result_column_name(result, 1));
      else
        ok("column_name");

      /* UNSIGNED_FLAG is 32. Without it, BIGINT UNSIGNED is indistinguishable
         from BIGINT and large ids decode as negative. */
      if ((mdb_result_column_flags(result, 0) & 32) == 0)
        fail("column_flags(0): UNSIGNED_FLAG not set on BIGINT UNSIGNED");
      else
        ok("column_flags carries UNSIGNED_FLAG");

      /* charsetnr 63 == binary, the only way to tell VARBINARY from VARCHAR. */
      if (mdb_result_column_charsetnr(result, 2) != 63)
        fail("column_charsetnr(2): expected 63 (binary), got %u",
             mdb_result_column_charsetnr(result, 2));
      else
        ok("column_charsetnr marks VARBINARY as binary");

      mdb_result_free(result);
    }
    else
      fail("metadata: query failed");
  }

  /* Transactions. */
  if (exec_sql(conn, "START TRANSACTION") == 0)
    ok("START TRANSACTION");
  exec_sql(conn, "UPDATE users SET balance = 99.0000 WHERE id=1");
  expect_scalar(conn, "SELECT balance FROM users WHERE id=1", "99.0000",
                "UPDATE visible inside transaction");
  if (exec_sql(conn, "ROLLBACK") == 0)
    ok("ROLLBACK");
  expect_scalar(conn, "SELECT balance FROM users WHERE id=1", "10.2500",
                "ROLLBACK restored the original value");

  if (exec_sql(conn, "START TRANSACTION") == 0)
    ok("START TRANSACTION (commit path)");
  exec_sql(conn, "UPDATE users SET balance = 55.0000 WHERE id=1");
  if (exec_sql(conn, "COMMIT") == 0)
    ok("COMMIT");
  expect_scalar(conn, "SELECT balance FROM users WHERE id=1", "55.0000",
                "COMMIT persisted the value");

  /* Error propagation through the ABI. */
  {
    const char *dup =
      "INSERT INTO users(email, created_at) VALUES ('a@example.com', NOW(6))";
    mdb_result_handle result = MDB_INVALID_HANDLE;

    if (mdb_connection_query(conn, (const uint8_t *) dup, strlen(dup), &result)
        == MDB_OK)
      fail("duplicate key insert unexpectedly succeeded");
    else
    {
      mdb_error error;
      mdb_connection_last_error(conn, &error);
      if (error.code != 1062 || strcmp(error.sql_state, "23000") != 0)
        fail("duplicate key: expected 1062/23000, got %u/%s", error.code,
             error.sql_state);
      else
        ok("duplicate key -> errno 1062, SQLSTATE 23000");
    }
  }

  /* Handle hygiene. */
  {
    mdb_result_handle result = MDB_INVALID_HANDLE;
    const char *sql = "SELECT 1";

    mdb_connection_query(conn, (const uint8_t *) sql, strlen(sql), &result);
    mdb_result_free(result);

    /* Reusing a freed handle must be rejected, not silently aliased onto
       whatever object next occupies the slot. */
    if (mdb_result_next(result) >= 0)
      fail("stale result handle was accepted");
    else
      ok("stale result handle rejected");
  }

  if (mdb_connection_query(9999, (const uint8_t *) "SELECT 1", 8, NULL)
      != MDB_ERR_BAD_HANDLE)
    fail("unknown connection handle was accepted");
  else
    ok("unknown connection handle rejected");

  /* Multiple concurrent connections against one runtime (criterion 3.2.6). */
  {
    mdb_connection_handle second = mdb_connection_open("wasm_test");
    if (second == MDB_INVALID_HANDLE)
      fail("could not open a second connection");
    else
    {
      expect_scalar(second, "SELECT balance FROM users WHERE id=1", "55.0000",
                    "second connection sees the committed row");
      if (mdb_live_connections() != 2)
        fail("live_connections: expected 2, got %u", mdb_live_connections());
      else
        ok("live_connections == 2");
      mdb_connection_close(second);
    }
  }

  /* --- prepared statements --------------------------------------------- */
  {
    const char *sql =
      "INSERT INTO users(email, balance, payload, note, created_at)"
      " VALUES (?, ?, ?, ?, ?)";
    mdb_statement_handle stmt =
      mdb_statement_prepare(conn, (const uint8_t *) sql, strlen(sql));

    if (stmt == MDB_INVALID_HANDLE)
      fail("mdb_statement_prepare");
    else
    {
      ok("mdb_statement_prepare");

      if (mdb_statement_param_count(stmt) != 5)
        fail("param_count: expected 5, got %u", mdb_statement_param_count(stmt));
      else
        ok("param_count == 5");

      mdb_statement_bind_string(stmt, 0, (const uint8_t *) "c@example.com", 13);
      /* DECIMAL bound as text: routing it through a double would lose exactly
         the precision this column exists to keep. */
      mdb_statement_bind_string(stmt, 1, (const uint8_t *) "12345.6789", 10);
      {
        /* Binary with an embedded NUL, to prove binding is length-delimited. */
        static const uint8_t blob[4] = { 0x00, 0x01, 0x02, 0xFF };
        mdb_statement_bind_blob(stmt, 2, blob, sizeof blob);
      }
      mdb_statement_bind_null(stmt, 3);
      mdb_statement_bind_string(stmt, 4,
                                (const uint8_t *) "2026-03-04 05:06:07.891011", 26);

      if (mdb_statement_execute(stmt, NULL) != MDB_OK)
      {
        mdb_error error;
        mdb_statement_last_error(stmt, &error);
        fail("mdb_statement_execute: %u/%s %s", error.code, error.sql_state,
             error.message);
      }
      else
        ok("mdb_statement_execute (INSERT with 5 params)");

      if (mdb_statement_affected_rows(stmt) != 1)
        fail("statement affected_rows: expected 1, got %llu",
             (unsigned long long) mdb_statement_affected_rows(stmt));
      else
        ok("statement affected_rows == 1");

      mdb_statement_close(stmt);
    }
  }

  /* Read the bound row back through the text protocol: values must be
     identical whichever protocol wrote them. */
  expect_scalar(conn, "SELECT balance FROM users WHERE email='c@example.com'",
                "12345.6789", "bound DECIMAL stored exactly");
  expect_scalar(conn, "SELECT HEX(payload) FROM users WHERE email='c@example.com'",
                "000102FF", "bound binary parameter kept its NUL byte");
  expect_scalar(conn, "SELECT created_at FROM users WHERE email='c@example.com'",
                "2026-03-04 05:06:07.891011",
                "bound DATETIME(6) kept microseconds");
  expect_scalar(conn,
                "SELECT note IS NULL FROM users WHERE email='c@example.com'",
                "1", "bound NULL parameter stored as NULL");

  /* A SELECT through the binary protocol must produce the same bytes as the
     text protocol — that equivalence is what lets the decoder be shared. */
  {
    const char *sql = "SELECT balance, note FROM users WHERE email = ?";
    mdb_statement_handle stmt =
      mdb_statement_prepare(conn, (const uint8_t *) sql, strlen(sql));
    mdb_result_handle result = MDB_INVALID_HANDLE;

    mdb_statement_bind_string(stmt, 0, (const uint8_t *) "c@example.com", 13);

    if (mdb_statement_execute(stmt, &result) != MDB_OK
        || result == MDB_INVALID_HANDLE)
      fail("prepared SELECT did not return a result set");
    else
    {
      if (mdb_result_row_count(result) != 1)
        fail("prepared SELECT row_count: expected 1, got %llu",
             (unsigned long long) mdb_result_row_count(result));
      else
        ok("prepared SELECT row_count == 1");

      if (mdb_result_next(result) != 1)
        fail("prepared SELECT returned no row");
      else
      {
        const uint8_t *data = mdb_result_value_data(result, 0);
        size_t length = mdb_result_value_length(result, 0);

        if (!data || length != 10 || memcmp(data, "12345.6789", 10) != 0)
          fail("prepared SELECT DECIMAL: got '%.*s'", (int) length,
               data ? (const char *) data : "");
        else
          ok("prepared SELECT returns DECIMAL as exact text");

        if (!mdb_result_value_is_null(result, 1))
          fail("prepared SELECT: NULL column did not read as NULL");
        else
          ok("prepared SELECT preserves NULL");
      }

      if (mdb_result_next(result) != 0)
        fail("prepared SELECT: expected exactly one row");
      else
        ok("prepared SELECT ends cleanly");

      mdb_result_free(result);
    }

    /* Statement reuse after reset, with a different parameter. */
    if (mdb_statement_reset(stmt) != MDB_OK)
      fail("mdb_statement_reset");
    else
      ok("mdb_statement_reset");

    mdb_statement_bind_string(stmt, 0, (const uint8_t *) "a@example.com", 13);
    result = MDB_INVALID_HANDLE;
    if (mdb_statement_execute(stmt, &result) != MDB_OK
        || result == MDB_INVALID_HANDLE)
      fail("statement reuse: execute failed");
    else
    {
      if (mdb_result_next(result) != 1)
        fail("statement reuse: no row");
      else
      {
        const uint8_t *data = mdb_result_value_data(result, 0);
        size_t length = mdb_result_value_length(result, 0);
        if (!data || length != 7 || memcmp(data, "55.0000", 7) != 0)
          fail("statement reuse: expected 55.0000, got '%.*s'", (int) length,
               data ? (const char *) data : "");
        else
          ok("statement reuse with a new parameter");
      }
      mdb_result_free(result);
    }

    mdb_statement_close(stmt);

    if (mdb_live_statements() != 0)
      fail("leaked %u statement(s)", mdb_live_statements());
    else
      ok("no leaked statements");
  }

  /* Error propagation through the statement path. */
  {
    const char *bad = "SELECT * FROM no_such_table WHERE x = ?";
    mdb_statement_handle stmt =
      mdb_statement_prepare(conn, (const uint8_t *) bad, strlen(bad));

    if (stmt != MDB_INVALID_HANDLE)
    {
      fail("preparing against a missing table unexpectedly succeeded");
      mdb_statement_close(stmt);
    }
    else
    {
      mdb_error error;
      mdb_connection_last_error(conn, &error);
      /* 1146 = ER_NO_SUCH_TABLE, SQLSTATE 42S02. */
      if (error.code != 1146 || strcmp(error.sql_state, "42S02") != 0)
        fail("prepare error: expected 1146/42S02, got %u/%s", error.code,
             error.sql_state);
      else
        ok("prepare failure -> errno 1146, SQLSTATE 42S02");
    }
  }

  if (mdb_connection_close(conn) != MDB_OK)
    fail("mdb_connection_close");
  else
    ok("mdb_connection_close");

  if (mdb_connection_close(conn) != MDB_ERR_BAD_HANDLE)
    fail("double close should report MDB_ERR_BAD_HANDLE");
  else
    ok("double close rejected");

  if (mdb_live_connections() != 0)
    fail("leaked %u connection(s) at shutdown", mdb_live_connections());
  else
    ok("no leaked connections");
  if (mdb_live_results() != 0)
    fail("leaked %u result(s) at shutdown", mdb_live_results());
  else
    ok("no leaked results");

  if (mdb_runtime_shutdown() != MDB_OK)
    fail("mdb_runtime_shutdown");
  else
    ok("mdb_runtime_shutdown");

  /* Shutdown is idempotent at this layer even though mysql_server_end is not. */
  if (mdb_runtime_shutdown() != MDB_OK)
    fail("second mdb_runtime_shutdown should be a no-op");
  else
    ok("double shutdown is a no-op");

  printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED", failures,
         failures == 1 ? "" : "s");
  return failures ? 1 : 0;
}
