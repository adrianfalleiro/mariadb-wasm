/*
  Phase 1 control: drive libmariadbd directly, with no wrapper in between.

  Everything the wasm port is later expected to reproduce is demonstrated here
  first, on a target where nothing is emulated. If a behaviour cannot be shown
  here it is not a porting problem, and chasing it under Emscripten would be
  wasted effort.

  Deliberately plain C against <mysql.h> — the C ABI wrapper comes in phase 2,
  and mixing the two would blur which layer a failure belongs to.
*/
#include <mysql.h>

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

/* Every query goes through here so a MariaDB error is always reported with
   errno + SQLSTATE + message, which is exactly the triple acceptance
   criterion 3.2.8 requires to survive the wasm boundary later. */
static int run(MYSQL *db, const char *sql)
{
  if (mysql_real_query(db, sql, (unsigned long) strlen(sql)))
  {
    fail("query failed: %s\n       errno=%u sqlstate=%s message=%s",
         sql, mysql_errno(db), mysql_sqlstate(db), mysql_error(db));
    return -1;
  }
  return 0;
}

/* Single-cell fetch, used for the read-back assertions. Returns a malloc'd
   copy so the caller is not racing mysql_free_result. NULL cells come back as
   the literal "NULL" string; the smoke test has no NULL expectations, and
   phase 13 is where NULL-vs-empty gets tested properly. */
static char *scalar(MYSQL *db, const char *sql)
{
  MYSQL_RES *res;
  MYSQL_ROW row;
  char *out;

  if (run(db, sql))
    return NULL;

  res = mysql_store_result(db);
  if (!res)
  {
    fail("no result set for: %s", sql);
    return NULL;
  }

  row = mysql_fetch_row(res);
  if (!row)
  {
    fail("empty result set for: %s", sql);
    mysql_free_result(res);
    return NULL;
  }

  out = strdup(row[0] ? row[0] : "NULL");
  mysql_free_result(res);
  return out;
}

static void expect_scalar(MYSQL *db, const char *sql, const char *want,
                          const char *what)
{
  char *got = scalar(db, sql);
  if (!got)
    return;
  if (strcmp(got, want) != 0)
    fail("%s: expected %s, got %s", what, want, got);
  else
    ok(what);
  free(got);
}

int main(int argc, char **argv)
{
  const char *datadir = (argc > 1) ? argv[1] : NULL;
  char datadir_arg[4096];
  char lc_messages_arg[4096];
  char charsets_arg[4096];
  MYSQL *db;
  char *payload_hex;

  if (!datadir || argc < 4)
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
    /* Kept close to what the wasm build will pass, so a divergence in
       behaviour is not silently a divergence in configuration. */
    char *server_args[] = {
      (char *) "mariadb_wasm_smoke",
      (char *) "--no-defaults",
      (char *) "--skip-grant-tables",
      (char *) "--skip-networking",
      (char *) "--performance-schema=OFF",
      (char *) "--max-connections=20",
      (char *) "--innodb-buffer-pool-size=16M",
      datadir_arg,
      lc_messages_arg,
      charsets_arg,
    };
    char *server_groups[] = { (char *) "embedded", NULL };
    int nargs = (int) (sizeof server_args / sizeof server_args[0]);

    printf("mysql_server_init\n");
    if (mysql_server_init(nargs, server_args, server_groups))
    {
      fprintf(stderr, "  FAIL mysql_server_init returned non-zero\n");
      return 1;
    }
    ok("mysql_server_init");
  }

  db = mysql_init(NULL);
  if (!db)
  {
    fprintf(stderr, "  FAIL mysql_init returned NULL\n");
    return 1;
  }

  /* The embedded handshake: no host, no port, no socket. mysql_real_connect
     dispatches in-process via lib_sql.cc once the connection is marked
     embedded. */
  mysql_options(db, MYSQL_OPT_USE_EMBEDDED_CONNECTION, NULL);
  if (!mysql_real_connect(db, NULL, NULL, NULL, NULL, 0, NULL, 0))
  {
    fprintf(stderr, "  FAIL mysql_real_connect: errno=%u sqlstate=%s %s\n",
            mysql_errno(db), mysql_sqlstate(db), mysql_error(db));
    return 1;
  }
  ok("mysql_real_connect (embedded)");

  if (run(db, "CREATE DATABASE IF NOT EXISTS wasm_test") == 0)
    ok("CREATE DATABASE");

  if (mysql_select_db(db, "wasm_test"))
    fail("mysql_select_db: %s", mysql_error(db));
  else
    ok("USE wasm_test");

  if (run(db,
          "CREATE TABLE users ("
          "  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,"
          "  email VARCHAR(255) NOT NULL,"
          "  balance DECIMAL(20,4) NOT NULL DEFAULT 0,"
          "  payload VARBINARY(255),"
          "  created_at DATETIME(6) NOT NULL,"
          "  PRIMARY KEY (id),"
          "  UNIQUE KEY uq_users_email (email)"
          ") ENGINE=InnoDB") == 0)
    ok("CREATE TABLE ... ENGINE=InnoDB");

  /* Proves the engine actually is InnoDB rather than having been silently
     substituted, which MariaDB will do if InnoDB failed to initialise. */
  expect_scalar(db,
                "SELECT ENGINE FROM information_schema.TABLES"
                " WHERE TABLE_SCHEMA='wasm_test' AND TABLE_NAME='users'",
                "InnoDB", "table engine is InnoDB");

  if (run(db,
          "INSERT INTO users(email, balance, payload, created_at) VALUES ("
          "  'a@example.com', 10.2500, X'000102FF',"
          "  '2026-01-02 03:04:05.123456')") == 0)
    ok("INSERT");

  if (mysql_affected_rows(db) != 1)
    fail("affected_rows: expected 1, got %llu",
         (unsigned long long) mysql_affected_rows(db));
  else
    ok("affected_rows == 1");

  if (mysql_insert_id(db) != 1)
    fail("insert_id: expected 1, got %llu",
         (unsigned long long) mysql_insert_id(db));
  else
    ok("insert_id == 1");

  expect_scalar(db, "SELECT balance FROM users WHERE email='a@example.com'",
                "10.2500", "DECIMAL(20,4) round-trips exactly");

  /* VARBINARY with an embedded NUL. Compared as hex so the assertion itself
     is not the thing that truncates at the NUL. */
  payload_hex = scalar(db, "SELECT HEX(payload) FROM users WHERE id=1");
  if (payload_hex)
  {
    if (strcmp(payload_hex, "000102FF") != 0)
      fail("VARBINARY: expected 000102FF, got %s", payload_hex);
    else
      ok("VARBINARY with embedded NUL round-trips");
    free(payload_hex);
  }

  expect_scalar(db, "SELECT created_at FROM users WHERE id=1",
                "2026-01-02 03:04:05.123456", "DATETIME(6) keeps microseconds");

  /* The transaction scenario. A rollback that does not roll back is the
     single most likely way a broken InnoDB port still looks healthy. */
  if (run(db, "START TRANSACTION") == 0)
    ok("START TRANSACTION");
  if (run(db, "UPDATE users SET balance = 99.0000 WHERE email='a@example.com'") == 0)
    ok("UPDATE inside transaction");
  expect_scalar(db, "SELECT balance FROM users WHERE id=1", "99.0000",
                "UPDATE visible inside transaction");
  if (run(db, "ROLLBACK") == 0)
    ok("ROLLBACK");
  expect_scalar(db, "SELECT balance FROM users WHERE id=1", "10.2500",
                "ROLLBACK restored the original value");

  /* Same shape again, committed, so a no-op transaction system cannot pass
     the rollback assertion by never writing anything. */
  if (run(db, "START TRANSACTION") == 0)
    ok("START TRANSACTION (commit path)");
  run(db, "UPDATE users SET balance = 55.0000 WHERE id=1");
  if (run(db, "COMMIT") == 0)
    ok("COMMIT");
  expect_scalar(db, "SELECT balance FROM users WHERE id=1", "55.0000",
                "COMMIT persisted the value");

  /* Error propagation: duplicate key must surface as 1062 / 23000. */
  {
    const char *dup =
      "INSERT INTO users(email, created_at) VALUES ('a@example.com', NOW(6))";
    if (mysql_real_query(db, dup, (unsigned long) strlen(dup)) == 0)
      fail("duplicate key insert unexpectedly succeeded");
    else if (mysql_errno(db) != 1062 || strcmp(mysql_sqlstate(db), "23000") != 0)
      fail("duplicate key: expected 1062/23000, got %u/%s",
           mysql_errno(db), mysql_sqlstate(db));
    else
      ok("duplicate key -> errno 1062, SQLSTATE 23000");
  }

  mysql_close(db);
  ok("mysql_close");

  mysql_server_end();
  ok("mysql_server_end");

  printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED", failures,
         failures == 1 ? "" : "s");
  return failures ? 1 : 0;
}
