import { test } from "node:test";
import assert from "node:assert/strict";
import nativeMysql from "mysql2/promise";
import nativeMaria from "mariadb";
import mysql from "../src/mysql2.ts";
import maria from "../src/mariadb.ts";
import { createServer } from "../src/server.ts";

// The native server is disposable and supplied by the test runner, never a developer database.
const port = Number(process.env.MYSQL_CONTRACT_PORT);
for (const kind of ["mysql2", "mariadb"] as const) {
  test(
    `${kind}: same observable contract as the official driver`,
    { skip: !port, timeout: 60000 },
    async () => {
      const server = await createServer();
      const config = {
        dateStrings: true,
        timezone: "Z" as const,
        supportBigNumbers: true,
        bigNumberStrings: true,
      };
      const native =
        kind === "mysql2"
          ? await nativeMysql.createConnection({
              host: "127.0.0.1",
              port,
              user: "root",
              password: "contract",
              ...config,
            })
          : await nativeMaria.createConnection({
              host: "127.0.0.1",
              port,
              user: "root",
              password: "contract",
              dateStrings: true,
              timezone: "Z",
            });
      const embedded = await (kind === "mysql2" ? mysql : maria).createConnection({
        server,
        ...config,
      });
      async function contract(connection: any) {
        const unwrap = (r: any) => (kind === "mysql2" ? r[0] : r);
        const writes: any[] = [];
        const write = async (sql: string, values?: unknown[]) => {
          const r = unwrap(await connection.execute(sql, values));
          writes.push({
            affectedRows: r.affectedRows,
            insertId: r.insertId,
            warningStatus: r.warningStatus,
          });
        };
        await connection.query(`CREATE DATABASE contract_${kind}`);
        await connection.query(`USE contract_${kind}`);
        await connection.query(
          "CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY, n INT, amount DECIMAL(20,4), bytes VARBINARY(8), stamp DATETIME) ENGINE=InnoDB",
        );
        await write("INSERT INTO t (n, amount, bytes, stamp) VALUES (?, ?, ?, ?)", [
          4,
          "1234567890123456.7890",
          Buffer.from([0, 255]),
          "2026-01-02 03:04:05",
        ]);
        await write("UPDATE t SET n=4 WHERE id=1");
        await connection.beginTransaction();
        await connection.query("UPDATE t SET n=?", [5]);
        await connection.rollback();
        const rows = [...unwrap(await connection.query("SELECT * FROM t WHERE id=?", [1]))];
        await connection.query(
          "CREATE TABLE large_id (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB AUTO_INCREMENT=9007199254740993",
        );
        await write("INSERT INTO large_id VALUES ()");
        const bound = [
          ...unwrap(
            await connection.execute("SELECT ? AS n, ? AS fraction, ? AS txt, ? AS null_value", [
              7,
              1.25,
              "quoted ' \\ text",
              null,
            ]),
          ),
        ];
        let duplicate;
        try {
          await connection.execute("INSERT INTO t (id) VALUES (?)", [1]);
        } catch (e: any) {
          duplicate = { code: e.code, errno: e.errno, sqlState: e.sqlState };
        }
        const queued = await Promise.all([
          connection.query("SELECT 11 AS n"),
          connection.query("SELECT 12 AS n"),
        ]);
        return { writes, rows, bound, duplicate, queued: queued.map((r) => [...unwrap(r)]) };
      }
      try {
        const expected = await contract(native);
        const actual = await contract(embedded);
        assert.deepEqual(actual, expected);
      } finally {
        await embedded.end();
        await server.close();
        await native.end();
      }
    },
  );
}
