import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "../src/server.ts";
import mysql from "../src/mysql2-callback.ts";
import maria from "../src/mariadb-callback.ts";
const require = createRequire(import.meta.url);
const knex = require("knex");
for (const [kind, driver] of [
  ["mysql2", mysql],
  ["mariadb", maria],
] as const) {
  test(`${kind} callback driver runs Knex schema, pooling, transactions and errors`, async () => {
    const server = await createServer();
    const admin = await server.connect();
    await admin.run("CREATE DATABASE knex_test");
    await admin.close();
    const dialect = knex({ client: kind === "mariadb" ? "mysql" : kind });
    const Base = dialect.client.constructor;
    await dialect.destroy();
    // Knex 3.2 has no MariaDB dialect; both callback protocols use the MySQL compiler.
    class EmbeddedClient extends Base {
      _driver() {
        return {
          createConnection: (options: any) => driver.createConnection({ ...options, server }),
        };
      }
    }
    const db = knex({
      client: EmbeddedClient as any,
      connection: { database: "knex_test" },
      pool: { min: 0, max: 2 },
    });
    try {
      await db.schema.createTable("items", (table: any) => {
        table.increments("id");
        table.string("name").unique();
      });
      assert.deepEqual(await db("items").insert({ name: "original" }), [
        kind === "mariadb" ? 1n : 1,
      ]);
      await assert.rejects(
        db.transaction(async (trx: any) => {
          await trx("items").insert({ name: "rolled back" });
          throw new Error("rollback requested");
        }),
        /rollback requested/,
      );
      await db.transaction(async (trx: any) => {
        await trx("items").where({ id: 1 }).update({ name: "committed" });
      });
      assert.deepEqual(await db("items").select("name"), [{ name: "committed" }]);
      await assert.rejects(db("items").insert({ name: "committed" }), {
        code: "ER_DUP_ENTRY",
        errno: 1062,
      });
      const results = await Promise.all([
        db("items").count("* as total"),
        db("items").select("name"),
      ]);
      assert.equal(Number(results[0][0].total), 1);
      assert.deepEqual(results[1], [{ name: "committed" }]);
    } finally {
      await db.destroy();
      await server.close();
    }
  });
}
