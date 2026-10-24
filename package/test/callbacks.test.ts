import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createEmbeddedMariaDb } from "../src/server.ts";
import mysql from "../src/mysql2-callback.ts";
import maria from "../src/mariadb-callback.ts";
let server: Awaited<ReturnType<typeof createEmbeddedMariaDb>>;
before(async () => {
  server = await createEmbeddedMariaDb();
});
after(async () => {
  await server.close();
});
const call = (c: any, method: string, ...args: any[]) =>
  new Promise<any>((resolve, reject) =>
    c[method](...args, (error: Error | null, rows: any, fields: any) =>
      error ? reject(error) : resolve({ rows, fields }),
    ),
  );
for (const [kind, driver] of [
  ["mysql2", mysql],
  ["mariadb", maria],
] as const) {
  test(`${kind} callback connections support bindings, metadata, transactions and errors`, async () => {
    const c = driver.createConnection({ server, supportBigNumbers: true, bigNumberStrings: true });
    assert.equal(typeof (c as any).then, "undefined");
    try {
      // Calls made immediately after createConnection must wait for startup.
      assert.deepEqual((await call(c, "query", { sql: "SELECT ? AS n", values: [42] })).rows, [
        { n: 42 },
      ]);
      await call(c, "connect");
      assert.equal(c.state, "authenticated");
      assert.equal(c.isValid(), true);
      await call(c, "query", `CREATE DATABASE callback_${kind}`);
      await call(c, "query", `USE callback_${kind}`);
      await call(
        c,
        "query",
        "CREATE TABLE t (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(30)) AUTO_INCREMENT=9007199254740993",
      );
      const insert = await call(c, "execute", "INSERT INTO t(name) VALUES (?)", ["original"]);
      assert.equal(insert.rows.affectedRows, 1);
      assert.equal(
        insert.rows.insertId,
        kind === "mysql2" ? "9007199254740993" : 9007199254740993n,
      );
      await call(c, "beginTransaction");
      await call(c, "query", "UPDATE t SET name=?", ["rollback"]);
      await call(c, "rollback");
      assert.equal((await call(c, "query", "SELECT name FROM t")).rows[0].name, "original");
      await call(c, "beginTransaction");
      await call(c, "execute", "UPDATE t SET name=?", ["committed"]);
      await call(c, "commit");
      const selected = await call(c, "execute", { sql: "SELECT name FROM t" });
      assert.equal(selected.rows[0].name, "committed");
      assert.equal(selected.fields[0].name, "name");
      await assert.rejects(call(c, "query", "INVALID SQL"), {
        code: "ER_PARSE_ERROR",
        errno: 1064,
        sqlState: "42000",
      });
      assert.equal((await call(c, "query", "SELECT 7 AS n")).rows[0].n, 7);
      await assert.rejects(
        call(c, "query", { sql: "SELECT 1", rowsAsArray: true }),
        /Unsupported query option/,
      );
    } finally {
      await call(c, "end");
    }
    assert.equal(c.isValid(), false);
    assert.equal(c.stream.destroyed, true);
    assert.equal(c.state, "disconnected");
    await assert.rejects(call(c, "query", "SELECT 1"), /closed/);
    await call(c, "end");
  });
  test(`${kind} end drains accepted operations and preserves callback order`, async () => {
    const c = driver.createConnection({ server });
    const order: string[] = [];
    const first = call(c, "query", "SELECT 1 AS n").then((r) => {
      order.push("first");
      assert.equal(r.rows[0].n, 1);
    });
    const second = call(c, "query", "SELECT 2 AS n").then((r) => {
      order.push("second");
      assert.equal(r.rows[0].n, 2);
    });
    const end = call(c, "end").then(() => {
      order.push("end");
    });
    await Promise.all([first, second, end]);
    assert.deepEqual(order, ["first", "second", "end"]);
  });
}
test("commands without callbacks emit fields, results, end and errors", async () => {
  const c = mysql.createConnection({ server });
  try {
    const events: any[] = [];
    await new Promise<void>((resolve, reject) =>
      c
        .query("SELECT 12 AS n")
        .on("fields", (fields) => events.push(fields[0].name))
        .on("result", (row) => events.push(row))
        .on("end", resolve)
        .on("error", reject),
    );
    assert.deepEqual(events, ["n", { n: 12 }]);
    await new Promise<void>((resolve, reject) =>
      c.query("INVALID SQL").on("error", (error) => {
        try {
          assert.equal(error.errno, 1064);
          resolve();
        } catch (e) {
          reject(e);
        }
      }),
    );
    const headers: any[] = [];
    await new Promise<void>((resolve, reject) =>
      c
        .query("SET @callback_test=1")
        .on("result", (header) => headers.push(header))
        .on("end", resolve)
        .on("error", reject),
    );
    assert.equal(headers.length, 1);
    assert.equal(headers[0].affectedRows, 0);
  } finally {
    await call(c, "end");
  }
});
test("startup failure reaches callbacks asynchronously without poisoning the engine", async () => {
  const c = mysql.createConnection({ server, database: "missing_callback_db" });
  let returned = false;
  const failure = new Promise<void>((resolve, reject) =>
    c.connect((error) => {
      try {
        assert.equal(returned, true);
        assert.equal((error as any).errno, 1049);
        resolve();
      } catch (e) {
        reject(e);
      }
    }),
  );
  returned = true;
  await failure;
  await assert.rejects(call(c, "query", "SELECT 1"), { errno: 1049 });
  await assert.rejects(call(c, "end"), { errno: 1049 });
});
