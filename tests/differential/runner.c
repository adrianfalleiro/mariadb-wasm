/*
  Native side of the differential suite.

  Reads a case file, executes it through the same C ABI the wasm build uses,
  and writes a record stream the JavaScript harness compares against the wasm
  run. The comparison is at the ABI level - raw bytes plus column metadata -
  rather than after decoding, so a difference cannot be hidden by the
  TypeScript decoder normalising both sides into the same JavaScript value.

  Input: one statement per line, hex-encoded, blank line ends a case.
  Hex because SQL contains newlines, quotes and, in these tests, NUL bytes.

  Output: line-oriented and hex-encoded for the same reason. Verbose, but a
  diff points at a field name rather than at an offset in a blob.
*/
#include "mariadb_wasm.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char HEX[] = "0123456789abcdef";

static void put_hex(const unsigned char *data, size_t length)
{
  for (size_t i = 0; i < length; i++)
  {
    putchar(HEX[data[i] >> 4]);
    putchar(HEX[data[i] & 0x0F]);
  }
  if (length == 0)
    fputs("-", stdout);   /* empty is distinct from absent */
}

static int hex_value(int c)
{
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/* Decodes in place; returns the byte length, or -1 on malformed input. */
static long decode_hex(char *text, unsigned char *out)
{
  size_t length = strlen(text);
  if (length % 2 != 0)
    return -1;

  for (size_t i = 0; i < length; i += 2)
  {
    int hi = hex_value(text[i]);
    int lo = hex_value(text[i + 1]);
    if (hi < 0 || lo < 0)
      return -1;
    out[i / 2] = (unsigned char) ((hi << 4) | lo);
  }
  return (long) (length / 2);
}

static void emit_error(mdb_error *error)
{
  printf("ERRNO %u\n", error->code);
  printf("SQLSTATE %s\n", error->sql_state[0] ? error->sql_state : "-");
  /* The message text itself is not compared - it embeds paths and generated
     names - but the number and SQLSTATE are. Emitted for diagnosis only. */
  printf("MESSAGE ");
  put_hex((const unsigned char *) error->message, strlen(error->message));
  putchar('\n');
}

static void run_statement(mdb_connection_handle conn, const unsigned char *sql,
                          size_t sql_length, int index)
{
  mdb_result_handle result = MDB_INVALID_HANDLE;
  int status;

  printf("STMT %d\n", index);

  status = mdb_connection_query(conn, sql, sql_length, &result);
  if (status != MDB_OK)
  {
    mdb_error error;
    printf("STATUS error\n");
    mdb_connection_last_error(conn, &error);
    emit_error(&error);
    printf("END\n");
    return;
  }

  printf("STATUS ok\n");
  printf("AFFECTED %llu\n",
         (unsigned long long) mdb_connection_affected_rows(conn));
  printf("INSERTID %llu\n",
         (unsigned long long) mdb_connection_insert_id(conn));

  if (result == MDB_INVALID_HANDLE)
  {
    printf("FIELDS 0\nROWS 0\nEND\n");
    return;
  }

  {
    uint32_t columns = mdb_result_column_count(result);
    uint32_t i;
    long rows = 0;

    printf("FIELDS %u\n", columns);
    for (i = 0; i < columns; i++)
    {
      const char *name = mdb_result_column_name(result, i);
      printf("FIELD ");
      put_hex((const unsigned char *) (name ? name : ""),
              name ? strlen(name) : 0);
      printf(" %u %u %u %u\n", mdb_result_column_type(result, i),
             mdb_result_column_flags(result, i),
             mdb_result_column_charsetnr(result, i),
             mdb_result_column_decimals(result, i));
    }

    /* Rows are buffered and printed as they are fetched; the harness only
       needs them in order. */
    printf("ROWSTART\n");
    while (mdb_result_next(result) == 1)
    {
      for (i = 0; i < columns; i++)
      {
        printf("CELL %ld %u ", rows, i);
        if (mdb_result_value_is_null(result, i))
          printf("NULL\n");
        else
        {
          const uint8_t *data = mdb_result_value_data(result, i);
          size_t length = mdb_result_value_length(result, i);
          printf("HEX ");
          put_hex(data, length);
          putchar('\n');
        }
      }
      rows++;
    }
    printf("ROWS %ld\n", rows);
    mdb_result_free(result);
  }

  printf("END\n");
}

int main(int argc, char **argv)
{
  char datadir_arg[4096];
  char lc_messages_arg[4096];
  char charsets_arg[4096];
  FILE *cases;
  char *line = NULL;
  size_t line_capacity = 0;
  ssize_t line_length;
  mdb_connection_handle conn;
  int statement_index = 0;
  int case_index = 0;

  if (argc < 5)
  {
    fprintf(stderr,
            "usage: %s <datadir> <lc-messages-dir> <charsets-dir> <case-file>\n",
            argv[0]);
    return 2;
  }

  snprintf(datadir_arg, sizeof datadir_arg, "--datadir=%s", argv[1]);
  snprintf(lc_messages_arg, sizeof lc_messages_arg, "--lc-messages-dir=%s",
           argv[2]);
  snprintf(charsets_arg, sizeof charsets_arg, "--character-sets-dir=%s",
           argv[3]);

  {
    /* Byte-for-byte the arguments package/src/server.ts passes, so a
       behavioural difference cannot be a configuration difference. */
    const char *server_args[] = {
      "--no-defaults",
      "--skip-grant-tables",
      "--skip-networking",
      "--performance-schema=OFF",
      "--max-connections=20",
      "--innodb-buffer-pool-size=16M",
      "--innodb-flush-log-at-trx-commit=0",
      "--innodb-doublewrite=0",
      datadir_arg,
      lc_messages_arg,
      charsets_arg,
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

  cases = fopen(argv[4], "r");
  if (!cases)
  {
    fprintf(stderr, "cannot open case file %s\n", argv[4]);
    return 1;
  }

  conn = mdb_connection_open(NULL);
  if (conn == MDB_INVALID_HANDLE)
  {
    fprintf(stderr, "could not open a connection\n");
    return 1;
  }
  printf("CASE %d\n", case_index);

  while ((line_length = getline(&line, &line_capacity, cases)) != -1)
  {
    unsigned char *sql;
    long sql_length;

    while (line_length > 0
           && (line[line_length - 1] == '\n' || line[line_length - 1] == '\r'))
      line[--line_length] = '\0';

    if (line_length == 0)
    {
      /* Case boundary: a fresh connection, so session state such as the
         default database and any open transaction does not leak forward. */
      mdb_connection_close(conn);
      conn = mdb_connection_open(NULL);
      case_index++;
      statement_index = 0;
      printf("CASE %d\n", case_index);
      continue;
    }

    sql = (unsigned char *) malloc((size_t) line_length / 2 + 1);
    if (!sql)
      return 1;

    sql_length = decode_hex(line, sql);
    if (sql_length < 0)
    {
      fprintf(stderr, "malformed hex on line: %s\n", line);
      return 1;
    }

    run_statement(conn, sql, (size_t) sql_length, statement_index++);
    free(sql);
  }

  free(line);
  fclose(cases);

  mdb_connection_close(conn);
  mdb_runtime_shutdown();
  return 0;
}
