import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../src/index.ts";

test(
  "small tablespaces grow for larger fixtures without losing data",
  { timeout: 60000 },
  async () => {
    const server = await createServer();
    try {
      const c = await server.connect();
      const size = async (name: string) => {
        const [rows] = await c.execute(
          "SELECT FILE_SIZE AS bytes FROM information_schema.INNODB_SYS_TABLESPACES WHERE NAME=?",
          [name],
        );
        assert.equal(rows.length, 1);
        return rows[0].bytes as bigint;
      };
      const systemBefore = await size("innodb_system");
      const tempBefore = await size("innodb_temporary");
      assert.equal(
        systemBefore <= 16n * 1024n * 1024n,
        true,
        `startup system tablespace: ${systemBefore}`,
      );
      assert.equal(
        tempBefore <= 4n * 1024n * 1024n,
        true,
        `startup temp tablespace: ${tempBefore}`,
      );
      await c.query("CREATE DATABASE growth");
      await c.query("USE growth");
      await c.query("SET GLOBAL innodb_file_per_table=OFF");
      await c.query(
        "CREATE TABLE persistent_data (id INT PRIMARY KEY, payload LONGBLOB) ENGINE=InnoDB",
      );
      await c.query(`INSERT INTO persistent_data WITH RECURSIVE seq AS
      (SELECT 1 AS n UNION ALL SELECT n+1 FROM seq WHERE n<256)
      SELECT n, REPEAT(CHAR(65 + MOD(n,26)), 65536) FROM seq`);
      await c.query("CREATE TEMPORARY TABLE temporary_data LIKE persistent_data");
      await c.query("INSERT INTO temporary_data SELECT * FROM persistent_data");
      for (const table of ["persistent_data", "temporary_data"]) {
        assert.deepEqual(
          (
            await c.query(`SELECT COUNT(*) AS n, SUM(OCTET_LENGTH(payload)) AS bytes FROM ${table}`)
          )[0],
          [{ n: 256n, bytes: "16777216" }],
        );
        assert.deepEqual(
          (
            await c.query(
              `SELECT id, ASCII(SUBSTRING(payload,65536,1)) AS last_byte FROM ${table} WHERE id IN (1,256) ORDER BY id`,
            )
          )[0],
          [
            { id: 1, last_byte: 66 },
            { id: 256, last_byte: 87 },
          ],
        );
      }
      assert.equal((await size("innodb_system")) > systemBefore, true);
      assert.equal((await size("innodb_temporary")) > tempBefore, true);
      // Exercise 11.8's decommit/recommit path while retaining dirty table data.
      for (const bytes of [8 * 1024 * 1024, 16 * 1024 * 1024]) {
        await c.query(`SET GLOBAL innodb_buffer_pool_size=${bytes}`);
        const [pool] = await c.query("SELECT @@global.innodb_buffer_pool_size AS bytes");
        assert.equal(Number(pool[0].bytes), bytes);
        assert.deepEqual(
          (
            await c.query(
              "SELECT COUNT(*) AS n, SUM(OCTET_LENGTH(payload)) AS bytes FROM persistent_data",
            )
          )[0],
          [{ n: 256n, bytes: "16777216" }],
        );
      }
      await c.close();
    } finally {
      await server.close();
    }
  },
);
