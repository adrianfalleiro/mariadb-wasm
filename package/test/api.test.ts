/*
  The public API, exercised the way a consumer would.

  Run with `node --test package/test/*.test.ts` — Node strips the types, so
  this needs no build step and no node_modules.
*/
import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { createServer } from "../src/index.ts";
import { MariaDbEmbeddedError, MariaDbEmbeddedStateError } from "../src/errors.ts";
import type { EmbeddedMariaDbServer } from "../src/types.ts";

let server: EmbeddedMariaDbServer;

before(
  async () => {
    server = await createServer({ storage: { type: "memory" } });
  },
  { timeout: 120_000 },
);

after(async () => {
  await server?.close();
});

test("runs MariaDB 11.8 and accepts MySQL 8 collation names", async () => {
  const connection = await server.connect();
  try {
    const [version] = await connection.query("SELECT VERSION() AS version");
    assert.match(String(version[0].version), /^11\.8\./);
    await connection.query(
      "CREATE DATABASE upgrade_118 CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci",
    );
    await connection.query("USE upgrade_118");
    await connection.query("CREATE TABLE words (word VARCHAR(40)) ENGINE=InnoDB");
    await connection.execute("INSERT INTO words VALUES (?)", ["Café"]);
    const [rows] = await connection.query("SELECT word FROM words WHERE word = 'cafe'");
    assert.deepEqual(rows, [{ word: "Café" }]);
  } finally {
    await connection.close();
  }
});

describe("the brief's worked example", () => {
  test("runs verbatim", async () => {
    const connection = await server.connect();

    await connection.query("CREATE DATABASE IF NOT EXISTS example");
    await connection.query("USE example");

    await connection.query(`
      CREATE TABLE users (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        email VARCHAR(255) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_users_email (email)
      ) ENGINE=InnoDB
    `);

    await connection.execute("INSERT INTO users(email) VALUES (?)", ["person@example.com"]);

    const [rows] = await connection.query("SELECT id, email FROM users");

    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, "person@example.com");
    /* BIGINT UNSIGNED is a BigInt by default, not a lossy number. */
    assert.equal(rows[0].id, 1n);

    await connection.close();
  });
});

describe("type fidelity", () => {
  test("preserves the distinctions JavaScript most easily loses", async () => {
    const connection = await server.connect();
    await connection.query("CREATE DATABASE IF NOT EXISTS types_db");
    await connection.query("USE types_db");
    await connection.query(`
      CREATE TABLE t (
        id INT NOT NULL,
        big BIGINT UNSIGNED NOT NULL,
        exact DECIMAL(20,4) NOT NULL,
        approx DOUBLE NOT NULL,
        blob_col VARBINARY(32),
        text_col VARCHAR(32),
        when_col DATETIME(6) NOT NULL,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB
    `);

    await connection.query(`
      INSERT INTO t VALUES
        (1, 18446744073709551615, 12345.6789, 0.5, X'000102FF', '',
         '2026-01-02 03:04:05.123456'),
        (2, 0, -0.0001, -0.25, NULL, NULL, '2026-01-02 03:04:05.000001')
    `);

    const [rows, fields] = await connection.query("SELECT * FROM t ORDER BY id");

    /* BIGINT UNSIGNED at its maximum: 2^64-1 cannot be a JS number at all. */
    assert.equal(rows[0].big, 18446744073709551615n);
    /* DECIMAL keeps its declared scale, trailing zeros included. */
    assert.equal(rows[0].exact, "12345.6789");
    assert.equal(rows[1].exact, "-0.0001");
    assert.equal(rows[0].approx, 0.5);

    /* Binary stays bytes; the embedded NUL survives. */
    assert.ok(rows[0].blob_col instanceof Uint8Array);
    assert.deepEqual([...(rows[0].blob_col as Uint8Array)], [0, 1, 2, 255]);

    /* NULL and empty string are different values. */
    assert.equal(rows[0].text_col, "");
    assert.equal(rows[1].text_col, null);
    assert.equal(rows[1].blob_col, null);

    assert.equal(rows[0].when_col, "2026-01-02 03:04:05.123456");

    /* Metadata carries what the decoder relied on. */
    const big = fields.find((f) => f.name === "big")!;
    assert.equal(big.unsigned, true);
    const blob = fields.find((f) => f.name === "blob_col")!;
    assert.equal(blob.binary, true);
    const text = fields.find((f) => f.name === "text_col")!;
    assert.equal(text.binary, false);

    await connection.close();
  });

  test("honours conversion options", { timeout: 120_000 }, async () => {
    const stringy = await createServer({
      bigIntMode: "string",
      decimalMode: "number",
      dateMode: "date",
    });
    try {
      const connection = await stringy.connect();
      const [rows] = await connection.query(
        "SELECT CAST(9007199254740993 AS UNSIGNED) AS big," +
          " CAST('1.50' AS DECIMAL(10,2)) AS dec_col," +
          " CAST('2026-01-02 03:04:05' AS DATETIME) AS when_col",
      );

      assert.equal(rows[0].big, "9007199254740993");
      assert.equal(rows[0].dec_col, 1.5);
      assert.ok(rows[0].when_col instanceof Date);
      assert.equal((rows[0].when_col as Date).toISOString(), "2026-01-02T03:04:05.000Z");
      await connection.close();
    } finally {
      await stringy.close();
    }
  });
});

describe("prepared statements", () => {
  test("bind parameters rather than interpolating them", async () => {
    const connection = await server.connect();
    await connection.query("CREATE DATABASE IF NOT EXISTS params_db");
    await connection.query("USE params_db");
    await connection.query(`
      CREATE TABLE p (
        id INT NOT NULL AUTO_INCREMENT,
        label VARCHAR(64),
        payload VARBINARY(32),
        amount DECIMAL(16,4),
        big_val BIGINT,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB
    `);

    /* A value that would end the statement early if it were interpolated. */
    const hostile = "'); DROP TABLE p; -- ";
    await connection.execute("INSERT INTO p(label, payload, amount) VALUES (?, ?, ?)", [
      hostile,
      new Uint8Array([0, 255, 0]),
      1234.5678,
    ]);

    const [rows] = await connection.execute(
      "SELECT label, payload, amount FROM p WHERE label = ?",
      [hostile],
    );

    assert.equal(rows.length, 1, "the table should still exist and hold the row");
    assert.equal(rows[0].label, hostile);
    assert.deepEqual([...(rows[0].payload as Uint8Array)], [0, 255, 0]);
    assert.equal(rows[0].amount, "1234.5678");

    await connection.close();
  });

  test("bind NULL, BigInt and Date parameters", async () => {
    const connection = await server.connect();
    await connection.query("USE params_db");

    /* 9007199254740993 is 2^53+1 — the smallest integer a JS number cannot
       represent. It survives only because parameters are bound as text and
       parsed by the server, never routed through a double. */
    const beyondDouble = 9007199254740993n;

    await connection.execute("INSERT INTO p(label, payload, big_val) VALUES (?, ?, ?)", [
      null,
      null,
      beyondDouble,
    ]);

    const [rows] = await connection.execute(
      "SELECT label, big_val FROM p WHERE label IS NULL AND big_val = ?",
      [beyondDouble],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].label, null, "NULL parameter should store NULL");
    assert.equal(rows[0].big_val, beyondDouble, "2^53+1 must round-trip exactly");

    /* A DECIMAL too wide for its column is MariaDB's error to raise, not
       something this package should paper over. */
    await assert.rejects(
      () => connection.execute("INSERT INTO p(amount) VALUES (?)", [99999999999999999999n]),
      (error: unknown) =>
        error instanceof MariaDbEmbeddedError &&
        (error as MariaDbEmbeddedError).sqlState === "22003",
    );

    await connection.close();
  });

  test("reject a parameter-count mismatch before reaching the server", async () => {
    const connection = await server.connect();
    await connection.query("USE params_db");

    await assert.rejects(
      () => connection.execute("SELECT * FROM p WHERE id = ? AND label = ?", [1]),
      (error: unknown) =>
        error instanceof MariaDbEmbeddedStateError &&
        /expects 2 parameters, received 1/.test((error as Error).message),
    );

    await connection.close();
  });
});

describe("transactions", () => {
  test("roll back and commit", async () => {
    const connection = await server.connect();
    await connection.query("CREATE DATABASE IF NOT EXISTS tx_db");
    await connection.query("USE tx_db");
    await connection.query("CREATE TABLE t (id INT PRIMARY KEY, v INT NOT NULL) ENGINE=InnoDB");
    await connection.query("INSERT INTO t VALUES (1, 10)");

    await connection.beginTransaction();
    await connection.execute("UPDATE t SET v = ? WHERE id = ?", [99, 1]);
    let [rows] = await connection.query("SELECT v FROM t WHERE id = 1");
    assert.equal(rows[0].v, 99);
    await connection.rollback();

    [rows] = await connection.query("SELECT v FROM t WHERE id = 1");
    assert.equal(rows[0].v, 10, "rollback must restore the prior value");

    await connection.beginTransaction();
    await connection.execute("UPDATE t SET v = ? WHERE id = ?", [55, 1]);
    await connection.commit();

    [rows] = await connection.query("SELECT v FROM t WHERE id = 1");
    assert.equal(rows[0].v, 55);

    await connection.close();
  });

  test("savepoints", async () => {
    const connection = await server.connect();
    await connection.query("USE tx_db");

    await connection.beginTransaction();
    await connection.query("UPDATE t SET v = 1 WHERE id = 1");
    await connection.query("SAVEPOINT sp1");
    await connection.query("UPDATE t SET v = 2 WHERE id = 1");
    await connection.query("ROLLBACK TO SAVEPOINT sp1");

    const [rows] = await connection.query("SELECT v FROM t WHERE id = 1");
    assert.equal(rows[0].v, 1, "only the post-savepoint change should be undone");

    await connection.rollback();
    await connection.close();
  });

  test("closing a connection rolls back its open transaction", async () => {
    const first = await server.connect({ database: "tx_db" });
    await first.beginTransaction();
    await first.query("UPDATE t SET v = 777 WHERE id = 1");
    await first.close();

    const second = await server.connect({ database: "tx_db" });
    const [rows] = await second.query("SELECT v FROM t WHERE id = 1");
    assert.notEqual(rows[0].v, 777);
    await second.close();
  });
});

describe("InnoDB relational behaviour", () => {
  test("enforces foreign keys and cascades", async () => {
    const connection = await server.connect();
    await connection.query("CREATE DATABASE IF NOT EXISTS fk_db");
    await connection.query("USE fk_db");
    await connection.query("CREATE TABLE parent (id INT PRIMARY KEY) ENGINE=InnoDB");
    await connection.query(`
      CREATE TABLE child (
        id INT PRIMARY KEY,
        parent_id INT NOT NULL,
        FOREIGN KEY (parent_id) REFERENCES parent(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);
    await connection.query("INSERT INTO parent VALUES (1)");
    await connection.query("INSERT INTO child VALUES (1, 1)");

    /* 1452 = ER_NO_REFERENCED_ROW_2. */
    await assert.rejects(
      () => connection.query("INSERT INTO child VALUES (2, 999)"),
      (error: unknown) =>
        error instanceof MariaDbEmbeddedError && (error as MariaDbEmbeddedError).code === 1452,
    );

    await connection.query("DELETE FROM parent WHERE id = 1");
    const [rows] = await connection.query("SELECT COUNT(*) AS n FROM child");
    /* COUNT() is BIGINT, so it decodes to a BigInt like any other BIGINT. */
    assert.equal(rows[0].n, 0n, "ON DELETE CASCADE should have removed the child");

    await connection.close();
  });
});

describe("errors", () => {
  test("carry MariaDB's error number and SQLSTATE", async () => {
    const connection = await server.connect();
    await connection.query("CREATE DATABASE IF NOT EXISTS err_db");
    await connection.query("USE err_db");
    await connection.query("CREATE TABLE u (email VARCHAR(64) NOT NULL UNIQUE) ENGINE=InnoDB");
    await connection.query("INSERT INTO u VALUES ('a@example.com')");

    await assert.rejects(
      () => connection.query("INSERT INTO u VALUES ('a@example.com')"),
      (error: unknown) => {
        assert.ok(error instanceof MariaDbEmbeddedError);
        assert.equal((error as MariaDbEmbeddedError).code, 1062);
        assert.equal((error as MariaDbEmbeddedError).sqlState, "23000");
        return true;
      },
    );

    await assert.rejects(
      () => connection.query("SELECT * FROM does_not_exist"),
      (error: unknown) =>
        error instanceof MariaDbEmbeddedError &&
        (error as MariaDbEmbeddedError).code === 1146 &&
        (error as MariaDbEmbeddedError).sqlState === "42S02",
    );

    await assert.rejects(
      () => connection.query("THIS IS NOT SQL"),
      (error: unknown) =>
        error instanceof MariaDbEmbeddedError && (error as MariaDbEmbeddedError).code === 1064,
    );

    await connection.close();
  });

  test("reject use of a closed connection", async () => {
    const connection = await server.connect();
    await connection.close();
    await assert.rejects(
      () => connection.query("SELECT 1"),
      (error: unknown) => error instanceof MariaDbEmbeddedStateError,
    );
  });
});

describe("lifecycle", () => {
  test("supports several concurrent connections on one runtime", async () => {
    const a = await server.connect();
    const b = await server.connect();

    await a.query("CREATE DATABASE IF NOT EXISTS multi_db");
    await a.query("USE multi_db");
    await a.query("CREATE TABLE t (id INT PRIMARY KEY) ENGINE=InnoDB");
    await a.query("INSERT INTO t VALUES (1)");

    await b.query("USE multi_db");
    const [rows] = await b.query("SELECT COUNT(*) AS n FROM t");
    assert.equal(rows[0].n, 1n, "the second connection should see committed data");

    await a.close();
    await b.close();
  });

  test("leaves no leaked handles", async () => {
    const connection = await server.connect();
    await connection.query("SELECT 1");
    await connection.execute("SELECT ?", [1]);
    await connection.close();

    const live = (server as unknown as { liveHandles: Record<string, number> }).liveHandles;
    assert.equal(live.results, 0, "results should not leak");
    assert.equal(live.statements, 0, "statements should not leak");
  });

  test("reset drops user schemas but keeps the server usable", { timeout: 60_000 }, async () => {
    const connection = await server.connect();
    await connection.query("CREATE DATABASE IF NOT EXISTS scratch_db");
    await connection.close();

    await server.reset();

    const after = await server.connect();
    const [rows] = await after.query(
      "SELECT COUNT(*) AS n FROM information_schema.SCHEMATA" + " WHERE SCHEMA_NAME = 'scratch_db'",
    );
    assert.equal(rows[0].n, 0n);

    /* Still usable, and mysql/information_schema survived. */
    const [check] = await after.query("SELECT 1 AS ok");
    assert.equal(check[0].ok, 1);
    await after.close();
  });

  test("close is idempotent and refuses later use", { timeout: 120_000 }, async () => {
    const disposable = await createServer();
    await disposable.close();
    await disposable.close();
    assert.equal(disposable.state, "CLOSED");
    await assert.rejects(
      () => disposable.connect(),
      (error: unknown) => error instanceof MariaDbEmbeddedStateError,
    );
  });
});

describe("generated SQL parsers", () => {
  test("preserves routine actions and recovers from semantic aborts in both modes", async () => {
    const connection = await server.connect();
    try {
      await connection.query("CREATE DATABASE parser_db");
      await connection.query("USE parser_db");
      await connection.query(
        "CREATE FUNCTION add_one(v INT) RETURNS INT DETERMINISTIC BEGIN RETURN v + 1; END",
      );
      assert.deepEqual((await connection.execute("SELECT add_one(?) AS n", [41]))[0], [{ n: 42 }]);
      await assert.rejects(connection.query(""), { code: 1065 });
      assert.deepEqual((await connection.query("SELECT add_one(9) AS n"))[0], [{ n: 10 }]);
      await connection.query("SET sql_mode = 'ORACLE'");
      await connection.query(
        "CREATE FUNCTION add_two(v IN INT) RETURN INT IS BEGIN RETURN v + 2; END;",
      );
      assert.deepEqual((await connection.execute("SELECT add_two(?) AS n FROM DUAL", [40]))[0], [
        { n: 42 },
      ]);
      await assert.rejects(connection.query(""), { code: 1065 });
      assert.deepEqual((await connection.query("SELECT add_two(8) AS n FROM DUAL"))[0], [
        { n: 10 },
      ]);
    } finally {
      await connection.close();
    }
  });
});
