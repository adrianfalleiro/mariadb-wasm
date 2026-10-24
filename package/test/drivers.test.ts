import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createEmbeddedMariaDb } from "../src/server.ts";
import mysql from "../src/mysql2.ts";
import maria from "../src/mariadb.ts";

let server: Awaited<ReturnType<typeof createEmbeddedMariaDb>>;
before(async () => {
  server = await createEmbeddedMariaDb();
});
after(async () => {
  await server.close();
});

test("same-connection operations queue and close drains accepted operations", async () => {
  const c = await server.connect();
  const first = c.run("SELECT SLEEP(0.01) AS slept");
  const second = c.run("SELECT 42 AS n");
  const end = c.close();
  assert.equal((await first).rows[0].slept, 0);
  assert.equal((await second).rows[0].n, 42);
  await end;
  await assert.rejects(c.run("SELECT 1"), /closed/);
});

test("a failed queued query does not poison the next query", async () => {
  const c = await server.connect();
  const bad = c.run("THIS IS NOT SQL");
  const good = c.run("SELECT 8 AS n");
  await assert.rejects(bad, { code: 1064 });
  assert.deepEqual((await good).rows, [{ n: 8 }]);
  await c.close();
});

test("zero-argument execute validates missing prepared parameters", async () => {
  const c = await server.connect();
  await assert.rejects(c.execute("SELECT ?"), /expects 1 parameter/);
  assert.deepEqual((await c.execute("SELECT 7 AS n"))[0], [{ n: 7 }]);
  await c.close();
});

for (const [kind, driver] of [
  ["mysql2", mysql],
  ["mariadb", maria],
] as const) {
  test(`${kind}: query, execute, DML results, transactions, types and SQL errors`, async () => {
    const c = await driver.createConnection({
      server,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    const rowsOf = (r: any) => (kind === "mysql2" ? r[0] : r);
    try {
      await c.query(`CREATE DATABASE ${kind}`);
      await c.query(`USE ${kind}`);
      await c.query(
        "CREATE TABLE t (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, body VARCHAR(100), amount DECIMAL(20,4), bytes VARBINARY(8)) ENGINE=InnoDB AUTO_INCREMENT=9007199254740993",
      );
      const header = rowsOf(
        await c.execute("INSERT INTO t (body, amount, bytes) VALUES (?, ?, ?)", [
          "a'\\b",
          "1234567890123456.7890",
          new Uint8Array([0, 255]),
        ]),
      );
      assert.equal(header.affectedRows, 1);
      assert.equal(header.insertId, kind === "mysql2" ? "9007199254740993" : 9007199254740993n);
      assert.equal(header.warningStatus, 0);
      const result: any = await c.query("SELECT * FROM t WHERE id=?", [9007199254740993n]);
      const rows = rowsOf(result);
      assert.deepEqual(
        [...rows],
        [
          {
            id: kind === "mysql2" ? "9007199254740993" : 9007199254740993n,
            body: "a'\\b",
            amount: "1234567890123456.7890",
            bytes: Buffer.from([0, 255]),
          },
        ],
      );
      assert.equal((kind === "mysql2" ? result[1] : result.meta)[0].name, "id");
      await c.beginTransaction();
      await c.query("UPDATE t SET body=?", ["changed"]);
      await c.rollback();
      assert.equal(rowsOf(await c.query("SELECT body FROM t"))[0].body, "a'\\b");
      await c.beginTransaction();
      await c.query("UPDATE t SET body=?", ["committed"]);
      await c.commit();
      assert.deepEqual([...rowsOf(await c.query("SELECT body FROM t"))], [{ body: "committed" }]);
      await assert.rejects(c.execute("INSERT INTO t (id) VALUES (?)", [9007199254740993n]), {
        errno: 1062,
        code: "ER_DUP_ENTRY",
        sqlState: "23000",
      });
      const [[a], [b]] = await Promise.all([
        c.query("SELECT 1 AS n"),
        c.query("SELECT 2 AS n"),
      ]).then((rs) => rs.map(rowsOf));
      assert.deepEqual([a, b], [{ n: 1 }, { n: 2 }]);
      await assert.rejects(c.execute("SELECT ?", [undefined]), /undefined/);
      await assert.rejects(c.execute("SELECT ?"), /expects 1 parameter/);
      const binary = rowsOf(await c.query("SELECT ? AS b", [new Uint8Array([0, 255])]))[0].b;
      assert.deepEqual(binary, Buffer.from([0, 255]));
    } finally {
      await c.end();
    }
    await assert.rejects(c.query("SELECT 1"), /closed/);
  });
}

test("driver rejects unsupported connection options instead of silently ignoring them", async () => {
  await assert.rejects(mysql.createConnection({ host: "remote" } as any), /Unsupported.*host/);
  await assert.rejects(maria.createConnection({ timezone: "local" } as any), /UTC/);
});

test("concurrent server close drains work once", async () => {
  const own = await createEmbeddedMariaDb();
  const c = await own.connect();
  const query = c.run("SELECT 19 AS n");
  await Promise.all([own.close(), own.close()]);
  assert.deepEqual((await query).rows, [{ n: 19 }]);
  assert.equal(own.state, "CLOSED");
  await assert.rejects(own.connect(), /CLOSED/);
});

test("numeric prepared parameters retain their SQL numeric type", async () => {
  const c = await server.connect();
  try {
    assert.deepEqual((await c.execute("SELECT ? AS n, ? AS f, ? AS b", [7, 1.25, true]))[0], [
      { n: 7, f: 1.25, b: 1 },
    ]);
  } finally {
    await c.close();
  }
});

test("failed startup releases threads and lets Node exit", { timeout: 10000 }, async () => {
  const moduleUrl = new URL("../src/server.ts", import.meta.url).href;
  const script = `import(${JSON.stringify(moduleUrl)}).then(async ({createEmbeddedMariaDb}) => {
   try { await createEmbeddedMariaDb({serverOptions: ['--not-a-real-server-option']}); process.exitCode = 1; }
   catch (error) { if (!error.message.includes('mysql_server_init failed')) throw error; console.log('EXPECTED_START_FAILURE'); }
 });`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--eval", script], {
    timeout: 8000,
  });
  assert.match(stdout, /EXPECTED_START_FAILURE/);
});

test("connection errors use driver errno and SQLSTATE", async () => {
  await assert.rejects(mysql.createConnection({ server, database: "missing_database" }), {
    errno: 1049,
    code: "ER_BAD_DB_ERROR",
    sqlState: "42000",
  });
});

for (const [kind, driver] of [
  ["mysql2", mysql],
  ["mariadb", maria],
] as const) {
  test(`${kind}: decodes JSON metadata without interpreting ordinary text`, async () => {
    const c = await driver.createConnection({ server });
    const rowsOf = (r: any) => (kind === "mysql2" ? r[0] : r);
    try {
      await c.query("CREATE DATABASE IF NOT EXISTS json_driver");
      await c.query("USE json_driver");
      await c.query("CREATE TEMPORARY TABLE json_values (doc JSON, text_value TEXT)");
      await c.query(
        `INSERT INTO json_values VALUES ('{"nested":[1,true,null]}', '{"nested":[1,true,null]}'), (NULL, 'null')`,
      );
      for (const method of ["query", "execute"] as const) {
        assert.deepEqual(
          rowsOf(await c[method]("SELECT doc, text_value FROM json_values ORDER BY doc IS NULL")),
          [
            { doc: { nested: [1, true, null] }, text_value: '{"nested":[1,true,null]}' },
            { doc: null, text_value: "null" },
          ],
        );
        assert.deepEqual(
          rowsOf(await c[method]("SELECT JSON_ARRAY(1,2) AS value, '[1,2]' AS ordinary")),
          [{ value: [1, 2], ordinary: "[1,2]" }],
        );
      }
    } finally {
      await c.end();
    }
  });
}
