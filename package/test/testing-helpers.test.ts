/* The Phase 14 helpers, including the case where one of them is unsound. */
import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import {
  createDatabasePerTest,
  createSchemaPerTest,
  resetServerPerFile,
  withTransactionRollback,
} from "../src/testing.ts";
import type { EmbeddedMariaDbServer } from "../src/types.ts";

const file = resetServerPerFile({ storage: { type: "memory" } });
let server: EmbeddedMariaDbServer;

before(async () => {
  server = await file.setup();
}, { timeout: 120_000 });

after(async () => {
  await file.teardown();
});

describe("resetServerPerFile", () => {
  test("returns the same server on repeated setup", async () => {
    assert.equal(await file.setup(), server);
  });
});

describe("createDatabasePerTest", () => {
  test("gives each test its own database", async () => {
    const perTest = createDatabasePerTest(server);

    const first = await perTest.setup();
    const second = await perTest.setup();
    assert.notEqual(first.database, second.database);

    await first.connection.query(
      "CREATE TABLE t (id INT PRIMARY KEY) ENGINE=InnoDB",
    );
    await first.connection.query("INSERT INTO t VALUES (1)");

    /* Same table name in the other database must not see it. */
    await second.connection.query(
      "CREATE TABLE t (id INT PRIMARY KEY) ENGINE=InnoDB",
    );
    const [rows] = await second.connection.query("SELECT COUNT(*) AS n FROM t");
    assert.equal(rows[0].n, 0n);

    await perTest.teardown(first);
    await perTest.teardown(second);

    /* Teardown really dropped them. */
    const check = await server.connect();
    const [remaining] = await check.execute(
      "SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN (?, ?)",
      [first.database, second.database],
    );
    assert.equal(remaining[0].n, 0n);
    await check.close();
  });
});

describe("createSchemaPerTest", () => {
  test("applies the schema to each fresh database", async () => {
    const withSchema = createSchemaPerTest(server, [
      "CREATE TABLE users (id INT PRIMARY KEY, email VARCHAR(64)) ENGINE=InnoDB",
      "INSERT INTO users VALUES (1, 'seed@example.com')",
    ]);

    const handle = await withSchema.setup();
    const [rows] = await handle.connection.query("SELECT email FROM users");
    assert.equal(rows[0].email, "seed@example.com");

    /* A second test gets the seed row again, not two of them. */
    const other = await withSchema.setup();
    const [otherRows] = await other.connection.query("SELECT COUNT(*) AS n FROM users");
    assert.equal(otherRows[0].n, 1n);

    await withSchema.teardown(handle);
    await withSchema.teardown(other);
  });
});

describe("withTransactionRollback", () => {
  test("undoes DML and propagates the result", async () => {
    const perTest = createDatabasePerTest(server);
    const handle = await perTest.setup();
    const { connection } = handle;

    await connection.query("CREATE TABLE t (id INT PRIMARY KEY) ENGINE=InnoDB");
    await connection.query("INSERT INTO t VALUES (1)");

    const result = await withTransactionRollback(connection, async (c) => {
      await c.query("INSERT INTO t VALUES (2)");
      const [rows] = await c.query("SELECT COUNT(*) AS n FROM t");
      assert.equal(rows[0].n, 2n, "the insert should be visible inside");
      return "returned";
    });
    assert.equal(result, "returned");

    const [rows] = await connection.query("SELECT COUNT(*) AS n FROM t");
    assert.equal(rows[0].n, 1n, "the insert should have been rolled back");

    await perTest.teardown(handle);
  });

  test("rolls back even when the body throws, and rethrows", async () => {
    const perTest = createDatabasePerTest(server);
    const handle = await perTest.setup();
    const { connection } = handle;

    await connection.query("CREATE TABLE t (id INT PRIMARY KEY) ENGINE=InnoDB");

    await assert.rejects(
      () =>
        withTransactionRollback(connection, async (c) => {
          await c.query("INSERT INTO t VALUES (1)");
          throw new Error("boom");
        }),
      /boom/,
    );

    const [rows] = await connection.query("SELECT COUNT(*) AS n FROM t");
    assert.equal(rows[0].n, 0n);

    await perTest.teardown(handle);
  });

  test("does NOT undo DDL — the documented limitation", async () => {
    /*
      Asserting the sharp edge rather than only the happy path. DDL commits
      implicitly in MariaDB, so a CREATE TABLE inside the callback survives the
      rollback and leaks into the next test. Anyone reaching for this helper
      should be able to find that fact in a test, not just in a comment.
    */
    const perTest = createDatabasePerTest(server);
    const handle = await perTest.setup();
    const { connection } = handle;

    await withTransactionRollback(connection, async (c) => {
      await c.query("CREATE TABLE leaked (id INT PRIMARY KEY) ENGINE=InnoDB");
    });

    const [rows] = await connection.query(
      "SELECT COUNT(*) AS n FROM information_schema.TABLES" +
        " WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leaked'",
    );
    assert.equal(rows[0].n, 1n, "DDL is not transactional; use a fresh database");

    await perTest.teardown(handle);
  });
});
