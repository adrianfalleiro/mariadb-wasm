/*
  The wasm benchmark's workload, run against the native libmariadbd through
  the same C ABI.

  This is the only comparison that isolates what WebAssembly costs. Both sides
  are MariaDB 11.4.4's embedded server, the same wrapper sources, the same
  server options, the same statements in the same order; the compilation
  target is the only difference. Comparing against a packaged mariadbd instead
  would fold in the wire protocol, a scheduler, and whatever the distribution
  configured, and answer a different question.

  Two modes, because the wasm side does not use the synchronous ABI:

    sync   - mdb_connection_query / mdb_statement_execute, the natural native
             path, and the floor for how fast this workload can go.
    async  - the *_async/_poll pair the TypeScript package drives, with a busy
             poll standing in for the JavaScript event loop. Same threading,
             so the difference between the two modes is the price of running
             every call on its own thread rather than the price of wasm.

  Usage: bench <datadir> <share-dir> <charsets-dir> [sync|async]
*/
#include "mariadb_wasm.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static int use_async = 0;
static int failures = 0;

static double now_ms(void)
{
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double) ts.tv_sec * 1000.0 + (double) ts.tv_nsec / 1.0e6;
}

static double mark;
static void start(void) { mark = now_ms(); }
static void report(const char *label)
{
  printf("%-38s %9.1f ms\n", label, now_ms() - mark);
}

static void fail(const char *what)
{
  printf("  FAIL %s\n", what);
  failures++;
}

static void report_error(mdb_connection_handle conn, const char *what)
{
  mdb_error error;
  if (mdb_connection_last_error(conn, &error) == MDB_OK)
    printf("  FAIL %s: errno=%u sqlstate=%s message=%s\n", what, error.code,
           error.sql_state, error.message);
  else
    printf("  FAIL %s: (no detail)\n", what);
  failures++;
}

/*
  A query, through whichever path the mode selects. The async branch spins on
  the poll rather than yielding: there is no event loop here, and sleeping
  would measure the sleep. It therefore flatters the async path slightly
  compared to the package, which pays a setImmediate per poll.
*/
static int run_query(mdb_connection_handle conn, const char *sql,
                     mdb_result_handle *result)
{
  const uint8_t *bytes = (const uint8_t *) sql;
  const size_t length = strlen(sql);

  if (!use_async)
    return mdb_connection_query(conn, bytes, length, result);

  if (mdb_connection_query_async(conn, bytes, length) != MDB_OK)
    return MDB_ERR_MYSQL;

  for (;;)
  {
    const int poll = mdb_connection_query_poll(conn, result);
    if (poll == 1)
      return MDB_OK;
    if (poll < 0)
      return MDB_ERR_MYSQL;
  }
}

static int exec_sql(mdb_connection_handle conn, const char *sql)
{
  mdb_result_handle result = MDB_INVALID_HANDLE;
  if (run_query(conn, sql, &result) != MDB_OK)
  {
    report_error(conn, sql);
    return -1;
  }
  if (result != MDB_INVALID_HANDLE)
    mdb_result_free(result);
  return 0;
}

static mdb_statement_handle prepare(mdb_connection_handle conn, const char *sql)
{
  const uint8_t *bytes = (const uint8_t *) sql;
  const size_t length = strlen(sql);

  if (!use_async)
    return mdb_statement_prepare(conn, bytes, length);

  if (mdb_statement_prepare_async(conn, bytes, length) != MDB_OK)
    return MDB_INVALID_HANDLE;

  for (;;)
  {
    mdb_statement_handle statement = MDB_INVALID_HANDLE;
    const int poll = mdb_statement_prepare_poll(conn, &statement);
    if (poll == 1)
      return statement;
    if (poll < 0)
      return MDB_INVALID_HANDLE;
  }
}

static int execute(mdb_statement_handle statement, mdb_result_handle *result)
{
  if (!use_async)
    return mdb_statement_execute(statement, result);

  if (mdb_statement_execute_async(statement) != MDB_OK)
    return MDB_ERR_MYSQL;

  for (;;)
  {
    const int poll = mdb_statement_execute_poll(statement, result);
    if (poll == 1)
      return MDB_OK;
    if (poll < 0)
      return MDB_ERR_MYSQL;
  }
}

static void bind_text(mdb_statement_handle statement, uint32_t index,
                      const char *value)
{
  mdb_statement_bind_string(statement, index, (const uint8_t *) value,
                            strlen(value));
}

/*
  Prepare, bind, execute, close — exactly what the package's execute() does
  for a parameterised call, including throwing the statement away afterwards.
  Reusing it would measure a different thing than the wasm side measures.
*/
static void prepared_call(mdb_connection_handle conn, const char *sql,
                          int a, const char *b, int drain)
{
  char number[32];
  mdb_result_handle result = MDB_INVALID_HANDLE;
  mdb_statement_handle statement = prepare(conn, sql);

  if (statement == MDB_INVALID_HANDLE)
  {
    report_error(conn, sql);
    return;
  }

  snprintf(number, sizeof number, "%d", a);
  bind_text(statement, 0, number);
  if (b)
    bind_text(statement, 1, b);

  if (execute(statement, &result) != MDB_OK)
    fail(sql);

  if (result != MDB_INVALID_HANDLE)
  {
    if (drain)
      while (mdb_result_next(result) == 1)
      {
        size_t length = 0;
        (void) mdb_result_value_data(result, 0);
        (void) length;
      }
    mdb_result_free(result);
  }

  mdb_statement_close(statement);
}

int main(int argc, char **argv)
{
  const char *datadir = argc > 1 ? argv[1] : "./bench-datadir";
  const char *share = argc > 2 ? argv[2] : NULL;
  const char *charsets = argc > 3 ? argv[3] : NULL;
  char datadir_arg[1024], share_arg[1024], charsets_arg[1024];
  mdb_connection_handle conn;
  mdb_result_handle result = MDB_INVALID_HANDLE;
  int i;

  if (argc > 4 && strcmp(argv[4], "async") == 0)
    use_async = 1;

  snprintf(datadir_arg, sizeof datadir_arg, "--datadir=%s", datadir);
  snprintf(share_arg, sizeof share_arg, "--lc-messages-dir=%s", share);
  snprintf(charsets_arg, sizeof charsets_arg, "--character-sets-dir=%s",
           charsets);

  /* Byte-for-byte the list in package/src/server.ts, so neither side is
     tuned differently from the other. */
  const char *server_args[] = {
      "--no-defaults",
      "--skip-grant-tables",
      "--skip-networking",
      "--performance-schema=OFF",
      "--max-connections=20",
      "--innodb-buffer-pool-size=16M",
      "--key-buffer-size=1M",
      "--aria-pagecache-buffer-size=8M",
      "--innodb-flush-log-at-trx-commit=0",
      "--innodb-doublewrite=0",
      "--innodb-log-file-size=4M",
      "--innodb-data-file-path=ibdata1:1M:autoextend",
      "--innodb-undo-tablespaces=0",
      datadir_arg,
      share_arg,
      charsets_arg,
  };

  printf("native libmariadbd, %s ABI\n", use_async ? "async" : "sync");
  printf("measurement                                value\n");
  printf("----------------------------------------------------\n");

  start();
  if (mdb_runtime_init((int) (sizeof server_args / sizeof server_args[0]),
                       server_args) != MDB_OK)
  {
    mdb_error error;
    mdb_last_global_error(&error);
    printf("init failed: %s\n", error.message);
    return 1;
  }
  report("server create (init)");

  start();
  conn = mdb_connection_open(NULL);
  report("first connection");
  if (conn == MDB_INVALID_HANDLE)
  {
    printf("could not connect\n");
    return 1;
  }

  start();
  if (run_query(conn, "SELECT 1", &result) == MDB_OK
      && result != MDB_INVALID_HANDLE)
    mdb_result_free(result);
  report("first query");

  start();
  exec_sql(conn, "CREATE DATABASE bench");
  exec_sql(conn, "USE bench");
  exec_sql(conn,
           "CREATE TABLE t ("
           " id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,"
           " v INT NOT NULL,"
           " s VARCHAR(64) NOT NULL,"
           " PRIMARY KEY (id)) ENGINE=InnoDB");
  report("schema setup");

  start();
  for (i = 0; i < 1000; i++)
  {
    result = MDB_INVALID_HANDLE;
    if (run_query(conn, "SELECT 1", &result) != MDB_OK)
      fail("SELECT 1");
    if (result != MDB_INVALID_HANDLE)
      mdb_result_free(result);
  }
  report("1000 simple queries");

  start();
  for (i = 0; i < 1000; i++)
  {
    char text[32];
    snprintf(text, sizeof text, "row %d", i);
    prepared_call(conn, "INSERT INTO t(v, s) VALUES (?, ?)", i, text, 0);
  }
  report("1000 prepared inserts");

  start();
  exec_sql(conn, "START TRANSACTION");
  for (i = 0; i < 1000; i++)
    prepared_call(conn, "INSERT INTO t(v, s) VALUES (?, ?)", i, "tx", 0);
  exec_sql(conn, "COMMIT");
  report("1000 inserts in one transaction");

  start();
  {
    uint64_t rows = 0;
    result = MDB_INVALID_HANDLE;
    if (run_query(conn, "SELECT id, v, s FROM t", &result) != MDB_OK)
      fail("select 2000 rows");
    if (result != MDB_INVALID_HANDLE)
    {
      /* Every cell is touched, so the row loop is comparable to the decoding
         the JavaScript side has to do. It is not the same work — JavaScript
         also builds an object per row — but skipping it entirely would make
         the native side look faster than it is. */
      while (mdb_result_next(result) == 1)
      {
        uint32_t c;
        for (c = 0; c < 3; c++)
        {
          (void) mdb_result_value_data(result, c);
          (void) mdb_result_value_length(result, c);
        }
        rows++;
      }
      mdb_result_free(result);
    }
    if (rows != 2000)
      printf("  note: expected 2000 rows, got %llu\n",
             (unsigned long long) rows);
  }
  report("select 2000 rows");

  start();
  for (i = 1; i <= 1000; i++)
    prepared_call(conn, "SELECT v FROM t WHERE id = ?", i, NULL, 1);
  report("indexed point lookups (1000)");

  start();
  mdb_connection_close(conn);
  report("connection close");

  start();
  mdb_runtime_shutdown();
  report("server close");

  printf("----------------------------------------------------\n");
  return failures ? 1 : 0;
}
