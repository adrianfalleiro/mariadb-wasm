/*
  Creates a MariaDB datadir containing the mysql.* system tables, by running
  the server's own bootstrap SQL through the embedded server.

  Uses libmariadbd rather than `mariadbd --bootstrap` because we do not build
  the server binary — and because the embedded server is the exact code that
  will later consume the datadir, which is the compatibility that matters.

  Statements arrive one per line, hex-encoded, already split by
  scripts/06-build-datadir-template.sh. Splitting SQL is fiddly and is much
  easier to get right in Python than in C; hex keeps newlines and quotes in
  the statements from colliding with the line format.
*/
#include "mariadb_wasm.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int hex_value(int c)
{
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

int main(int argc, char **argv)
{
  char datadir_arg[4096];
  char lc_messages_arg[4096];
  char charsets_arg[4096];
  char log_size_arg[256];
  char data_file_arg[512];
  char undo_arg[256];
  FILE *statements;
  char *line = NULL;
  size_t line_capacity = 0;
  ssize_t line_length;
  mdb_connection_handle conn;
  long executed = 0, failed = 0;

  if (argc < 8)
  {
    fprintf(stderr,
            "usage: %s <datadir> <lc-messages-dir> <charsets-dir>"
            " <statement-file> <innodb-log-size> <innodb-data-file-path>"
            " <innodb-undo-tablespaces>\n",
            argv[0]);
    return 2;
  }

  snprintf(datadir_arg, sizeof datadir_arg, "--datadir=%s", argv[1]);
  snprintf(lc_messages_arg, sizeof lc_messages_arg, "--lc-messages-dir=%s",
           argv[2]);
  snprintf(charsets_arg, sizeof charsets_arg, "--character-sets-dir=%s",
           argv[3]);
  snprintf(log_size_arg, sizeof log_size_arg, "--innodb-log-file-size=%s",
           argv[5]);
  snprintf(data_file_arg, sizeof data_file_arg, "--innodb-data-file-path=%s",
           argv[6]);
  snprintf(undo_arg, sizeof undo_arg, "--innodb-undo-tablespaces=%s", argv[7]);

  {
    const char *server_args[] = {
      "--no-defaults",
      "--skip-grant-tables",
      "--skip-networking",
      "--performance-schema=OFF",
      /* Bootstrap SQL creates tables in the mysql database, which
         --enforce-storage-engine would override. */
      "--enforce-storage-engine=",
      datadir_arg,
      lc_messages_arg,
      charsets_arg,
      log_size_arg,
      data_file_arg,
      undo_arg,
    };
    int nargs = (int) (sizeof server_args / sizeof server_args[0]);

    if (mdb_runtime_init(nargs, server_args) != MDB_OK)
    {
      mdb_error error;
      mdb_last_global_error(&error);
      fprintf(stderr, "runtime init failed: %s\n", error.message);
      return 1;
    }
  }

  conn = mdb_connection_open(NULL);
  if (conn == MDB_INVALID_HANDLE)
  {
    fprintf(stderr, "could not open a connection\n");
    return 1;
  }

  statements = fopen(argv[4], "r");
  if (!statements)
  {
    fprintf(stderr, "cannot open %s\n", argv[4]);
    return 1;
  }

  while ((line_length = getline(&line, &line_capacity, statements)) != -1)
  {
    unsigned char *sql;
    size_t sql_length;
    mdb_result_handle result = MDB_INVALID_HANDLE;

    while (line_length > 0
           && (line[line_length - 1] == '\n' || line[line_length - 1] == '\r'))
      line[--line_length] = '\0';
    if (line_length == 0)
      continue;

    sql = (unsigned char *) malloc((size_t) line_length / 2 + 1);
    if (!sql)
      return 1;

    sql_length = (size_t) line_length / 2;
    for (size_t i = 0; i < sql_length; i++)
    {
      int hi = hex_value(line[i * 2]);
      int lo = hex_value(line[i * 2 + 1]);
      if (hi < 0 || lo < 0)
      {
        fprintf(stderr, "malformed hex input\n");
        return 1;
      }
      sql[i] = (unsigned char) ((hi << 4) | lo);
    }

    if (mdb_connection_query(conn, sql, sql_length, &result) != MDB_OK)
    {
      mdb_error error;
      mdb_connection_last_error(conn, &error);
      /* Reported rather than fatal: the bootstrap SQL contains statements
         that depend on plugins this build excludes, and a template that is
         useful for tests does not need every one of them. The script decides
         what an acceptable failure count is. */
      fprintf(stderr, "  statement failed (%u/%s): %.120s\n    %s\n",
              error.code, error.sql_state, (const char *) sql, error.message);
      failed++;
    }
    else
    {
      if (result != MDB_INVALID_HANDLE)
        mdb_result_free(result);
      executed++;
    }

    free(sql);
  }

  free(line);
  fclose(statements);

  /*
    Emit the DDL for every InnoDB table in the mysql database.

    Asked of the server rather than extracted from the bootstrap SQL, because
    that SQL does not always contain an executable CREATE: transaction_registry
    is assembled into a variable and run through PREPARE, and gtid_slave_pos is
    generated per replication engine. SHOW CREATE TABLE is the server's own
    answer and cannot drift from what it actually built.
  */
  if (argc > 8)
  {
    FILE *ddl = fopen(argv[8], "w");
    mdb_result_handle names = MDB_INVALID_HANDLE;
    const char *list_sql =
      "SELECT TABLE_NAME FROM information_schema.TABLES"
      " WHERE TABLE_SCHEMA='mysql' AND ENGINE='InnoDB' ORDER BY TABLE_NAME";

    if (!ddl)
    {
      fprintf(stderr, "cannot write %s\n", argv[8]);
      return 1;
    }

    if (mdb_connection_query(conn, (const uint8_t *) list_sql,
                             strlen(list_sql), &names) != MDB_OK
        || names == MDB_INVALID_HANDLE)
    {
      fprintf(stderr, "could not list InnoDB system tables\n");
      return 1;
    }

    /* Collected first: the DDL query below reuses the connection, which
       invalidates this result. */
    char table_names[64][128];
    int table_count = 0;
    while (mdb_result_next(names) == 1 && table_count < 64)
    {
      const uint8_t *value = mdb_result_value_data(names, 0);
      size_t length = mdb_result_value_length(names, 0);
      if (length >= sizeof table_names[0])
        length = sizeof table_names[0] - 1;
      memcpy(table_names[table_count], value, length);
      table_names[table_count][length] = '\0';
      table_count++;
    }
    mdb_result_free(names);

    for (int i = 0; i < table_count; i++)
    {
      char show_sql[256];
      mdb_result_handle ddl_result = MDB_INVALID_HANDLE;

      snprintf(show_sql, sizeof show_sql, "SHOW CREATE TABLE mysql.`%s`",
               table_names[i]);

      if (mdb_connection_query(conn, (const uint8_t *) show_sql,
                               strlen(show_sql), &ddl_result) != MDB_OK
          || ddl_result == MDB_INVALID_HANDLE
          || mdb_result_next(ddl_result) != 1)
      {
        fprintf(stderr, "SHOW CREATE TABLE failed for %s\n", table_names[i]);
        return 1;
      }

      /* Column 1 is the CREATE statement. */
      fwrite(mdb_result_value_data(ddl_result, 1), 1,
             mdb_result_value_length(ddl_result, 1), ddl);
      fputs(";\n", ddl);
      mdb_result_free(ddl_result);
    }

    fclose(ddl);
    printf("wrote DDL for %d InnoDB system tables\n", table_count);
  }

  mdb_connection_close(conn);
  mdb_runtime_shutdown();

  printf("executed %ld statements, %ld failed\n", executed, failed);
  return failed > 0 ? 3 : 0;
}
