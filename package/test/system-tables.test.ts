/*
  What the datadir template unblocks.

  Without it the datadir starts empty and InnoDB bootstraps its own tablespace
  — enough for ordinary tables, but the mysql.* system tables are absent, and
  everything that stores metadata in them fails. These are the features that
  were listed as unsupported until the template existed.
*/
import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { createEmbeddedMariaDb } from "../src/index.ts";
import type { EmbeddedMariaDbServer } from "../src/types.ts";

let server: EmbeddedMariaDbServer;

before(async () => {
  server = await createEmbeddedMariaDb({ storage: { type: "memory" } });
  const setup = await server.connect();
  await setup.query("CREATE DATABASE app");
  await setup.close();
}, { timeout: 120_000 });

after(async () => {
  await server?.close();
});

describe("system tables", () => {
  test("the mysql schema is populated", async () => {
    const connection = await server.connect();
    const [rows] = await connection.query(
      "SELECT COUNT(*) AS n FROM information_schema.TABLES" +
        " WHERE TABLE_SCHEMA = 'mysql'",
    );
    assert.ok(
      (rows[0].n as bigint) > 25n,
      `expected the mysql schema to be populated, found ${rows[0].n} tables`,
    );

    /* The four InnoDB ones are recreated after startup rather than shipped;
       if that step regressed they would be missing while the rest were fine. */
    for (const table of [
      "innodb_table_stats",
      "innodb_index_stats",
      "gtid_slave_pos",
      "transaction_registry",
    ]) {
      const [count] = await connection.execute(
        "SELECT COUNT(*) AS n FROM information_schema.TABLES" +
          " WHERE TABLE_SCHEMA='mysql' AND TABLE_NAME = ?",
        [table],
      );
      assert.equal(count[0].n, 1n, `mysql.${table} should exist`);
    }

    await connection.close();
  });
});

describe("stored routines", () => {
  test("create, call and drop a procedure", async () => {
    const connection = await server.connect({ database: "app" });
    await connection.query(
      "CREATE TABLE counter (id INT PRIMARY KEY, n INT NOT NULL) ENGINE=InnoDB",
    );
    await connection.query("INSERT INTO counter VALUES (1, 0)");

    /* No DELIMITER: that is a client-side convention, and this driver sends
       one statement at a time. A single-statement body needs no BEGIN/END. */
    await connection.query(
      "CREATE PROCEDURE bump(IN amount INT)" +
        " UPDATE counter SET n = n + amount WHERE id = 1",
    );

    await connection.query("CALL bump(5)");
    await connection.query("CALL bump(3)");

    const [rows] = await connection.query("SELECT n FROM counter WHERE id = 1");
    assert.equal(rows[0].n, 8);

    /* It is a row in mysql.proc — the table the template exists to provide. */
    const [procs] = await connection.query(
      "SELECT COUNT(*) AS n FROM mysql.proc WHERE db='app' AND name='bump'",
    );
    assert.equal(procs[0].n, 1n);

    await connection.query("DROP PROCEDURE bump");
    await connection.close();
  });

  test("create and call a function", async () => {
    const connection = await server.connect({ database: "app" });
    await connection.query(
      "CREATE FUNCTION doubled(x INT) RETURNS INT DETERMINISTIC RETURN x * 2",
    );
    const [rows] = await connection.query("SELECT doubled(21) AS v");
    assert.equal(rows[0].v, 42);
    await connection.query("DROP FUNCTION doubled");
    await connection.close();
  });
});

describe("triggers", () => {
  test("fire on insert", async () => {
    const connection = await server.connect({ database: "app" });
    await connection.query(
      "CREATE TABLE t (id INT PRIMARY KEY, v INT NOT NULL) ENGINE=InnoDB",
    );
    await connection.query(
      "CREATE TABLE audit (id INT PRIMARY KEY AUTO_INCREMENT, v INT) ENGINE=InnoDB",
    );
    await connection.query(
      "CREATE TRIGGER t_ai AFTER INSERT ON t FOR EACH ROW" +
        " INSERT INTO audit(v) VALUES (NEW.v)",
    );

    await connection.query("INSERT INTO t VALUES (1, 10), (2, 20)");

    const [rows] = await connection.query("SELECT v FROM audit ORDER BY id");
    assert.deepEqual(rows.map((r) => r.v), [10, 20]);

    await connection.query("DROP TRIGGER t_ai");
    await connection.close();
  });
});

describe("views", () => {
  test("create and query", async () => {
    const connection = await server.connect({ database: "app" });
    await connection.query("CREATE VIEW big AS SELECT * FROM t WHERE v >= 20");
    const [rows] = await connection.query("SELECT id FROM big");
    assert.deepEqual(rows.map((r) => r.id), [2]);
    await connection.query("DROP VIEW big");
    await connection.close();
  });
});

describe("time zones", () => {
  test("offsets work; named zones are documented as unavailable", async () => {
    const connection = await server.connect();

    /* Numeric offsets need no time zone tables. */
    const [offset] = await connection.query(
      "SELECT CONVERT_TZ('2026-01-02 12:00:00', '+00:00', '+02:00') AS v",
    );
    assert.equal(offset[0].v, "2026-01-02 14:00:00");

    /* mysql.time_zone* exist but are empty — the template ships the schema,
       not the zoneinfo, which mysql_tzinfo_to_sql loads from the host OS.
       CONVERT_TZ returns NULL rather than failing, which is MariaDB's own
       behaviour for an unknown zone. */
    const [named] = await connection.query(
      "SELECT CONVERT_TZ('2026-01-02 12:00:00', 'UTC', 'Europe/London') AS v",
    );
    assert.equal(named[0].v, null, "named zones need loaded zoneinfo");

    const [zones] = await connection.query(
      "SELECT COUNT(*) AS n FROM mysql.time_zone_name",
    );
    assert.equal(zones[0].n, 0n, "the table exists but is empty");

    await connection.close();
  });
});

describe("startup", () => {
  test("no longer complains about missing privilege tables", async () => {
    const quiet = await createEmbeddedMariaDb();
    try {
      const output = (quiet as unknown as { diagnostics: string }).diagnostics;

      assert.ok(
        !/mysql\.servers' doesn't exist/.test(output),
        `the mysql.servers warning should be gone:\n${output}`,
      );

      /*
        This one remains, and is expected.

        The template ships no InnoDB tablespaces — they were 42 MB of
        mostly-empty file for four small tables, copied into every instance —
        so mysql.innodb_table_stats is recreated after the server is up.
        InnoDB looks for it *during* startup and says so. Persistent index
        statistics fall back to sampling for that moment and the table is
        present for the rest of the session.

        Asserted rather than ignored so that if the trade is ever revisited,
        this test says what changed.
      */
      assert.match(
        output,
        /innodb_table_stats not found/,
        "expected the known post-startup-creation warning",
      );

      /* The table really is there once startup has finished. */
      const connection = await quiet.connect();
      const [rows] = await connection.query(
        "SELECT COUNT(*) AS n FROM mysql.innodb_table_stats",
      );
      assert.equal(rows[0].n, 0n);
      await connection.close();
    } finally {
      await quiet.close();
    }
  }, { timeout: 120_000 });
});
