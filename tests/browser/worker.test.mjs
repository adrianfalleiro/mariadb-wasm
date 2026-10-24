import { test } from "node:test";
import assert from "node:assert/strict";
import { withBrowser } from "./harness.mjs";

test(
  "real MariaDB in a browser worker: InnoDB, adapters, queueing and teardown",
  { timeout: 90000 },
  async () => {
    await withBrowser(async (page) => {
      const result = await page.evaluate(async () => {
        const { createDatabaseWorker } = await import("/dist/browser/browser.mjs");
        const mysql = await import("/dist/browser/mysql2-driver.mjs");
        const maria = await import("/dist/browser/mariadb-driver.mjs");
        const server = await createDatabaseWorker();
        try {
          const a = await mysql.createConnection({
            server,
            dateStrings: true,
            supportBigNumbers: true,
            bigNumberStrings: true,
          });
          await a.query("CREATE DATABASE test");
          await a.query("USE test");
          await a.query(
            "CREATE TABLE t (id INT PRIMARY KEY, body VARCHAR(80), amount DECIMAL(20,4)) ENGINE=InnoDB",
          );
          const [write] = await a.execute("INSERT INTO t VALUES (?, ?, ?)", [
            1,
            "hello ' worker",
            "1234567890123456.7890",
          ]);
          const [[engine]] = await a.query(
            "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA='test' AND TABLE_NAME='t'",
          );
          const queued = await Promise.all([
            a.query("SELECT SLEEP(0.01)"),
            a.query("SELECT 2 AS n"),
          ]);
          await a.beginTransaction();
          await a.query("UPDATE t SET body=? WHERE id=?", ["changed", 1]);
          await a.rollback();
          const b = await maria.createConnection({ server, database: "test", dateStrings: true });
          const rows = await b.query("SELECT * FROM t WHERE id=?", [1]);
          const metadata = rows.meta.map((field) => field.name);
          let duplicate;
          try {
            await a.execute("INSERT INTO t VALUES (?, ?, ?)", [1, "bad", "0"]);
          } catch (error) {
            duplicate = { errno: error.errno, code: error.code, sqlState: error.sqlState };
          }
          const [[binary]] = await a.query("SELECT ? AS bytes", [new Uint8Array([0, 255])]);
          const inflight = a.query("SELECT 3 AS n");
          const ended = a.end();
          const [[last]] = await inflight;
          await ended;
          await b.end();
          return {
            write,
            engine,
            queued: queued[1][0],
            rows: [...rows],
            metadata,
            duplicate,
            binary: Array.from(binary.bytes),
            last,
          };
        } finally {
          await server.close();
        }
      });
      assert.deepEqual(result, {
        write: { affectedRows: 1, insertId: 0, warningStatus: 0 },
        engine: { ENGINE: "InnoDB" },
        queued: [{ n: 2 }],
        rows: [{ id: 1, body: "hello ' worker", amount: "1234567890123456.7890" }],
        metadata: ["id", "body", "amount"],
        duplicate: { errno: 1062, code: "ER_DUP_ENTRY", sqlState: "23000" },
        binary: [0, 255],
        last: { n: 3 },
      });
    });
  },
);

test(
  "worker startup failures reject and independent workers have isolated databases",
  { timeout: 90000 },
  async () => {
    await withBrowser(async (page) => {
      const result = await page.evaluate(async () => {
        const { createDatabaseWorker } = await import("/dist/browser/browser.mjs");
        let failed = false;
        try {
          await createDatabaseWorker({ workerUrl: "/missing-worker.mjs", startupTimeoutMs: 1000 });
        } catch {
          failed = true;
        }
        const a = await createDatabaseWorker();
        const b = await createDatabaseWorker();
        try {
          const c = await a.connect();
          const d = await b.connect();
          await c.run("CREATE DATABASE isolated_marker");
          const seen = await d.run("SHOW DATABASES LIKE 'isolated_marker'");
          await c.close();
          let closed = false;
          try {
            await c.run("SELECT 1");
          } catch {
            closed = true;
          }
          await d.close();
          return { failed, closed, rows: seen.rows };
        } finally {
          await Promise.all([a.close(), b.close()]);
        }
      });
      assert.deepEqual(result, { failed: true, closed: true, rows: [] });
      await page.goto(new URL("/unisolated", page.url()).href);
      const message = await page.evaluate(async () => {
        try {
          await (await import("/dist/browser/browser.mjs")).createDatabaseWorker();
        } catch (error) {
          return error.message;
        }
      });
      assert.match(message, /COOP.*COEP/);
    });
  },
);

test("standalone browser adapter owns and closes its worker", { timeout: 60000 }, async () => {
  await withBrowser(async (page) => {
    const result = await page.evaluate(async () => {
      const mysql = await import("/dist/browser/mysql2-driver.mjs");
      let unknownDatabase;
      try {
        await mysql.createConnection({ database: "not_here" });
      } catch (e) {
        unknownDatabase = e.errno;
      }
      const connection = await mysql.createConnection();
      const [rows] = await connection.execute("SELECT ? AS value", [123]);
      await Promise.all([connection.end(), connection.end()]);
      let closed = false;
      try {
        await connection.query("SELECT 1");
      } catch {
        closed = true;
      }
      return { rows, closed, unknownDatabase };
    });
    assert.deepEqual(result, { rows: [{ value: 123 }], closed: true, unknownDatabase: 1049 });
  });
});

test("one browser database host serves independent Web Workers", { timeout: 90000 }, async () => {
  await withBrowser(async (page) => {
    const result = await page.evaluate(async () => {
      const { createDatabaseWorker } = await import("/dist/browser/browser.mjs");
      const host = await createDatabaseWorker();
      const workers = [];
      const code = `
        import { connectDatabasePort } from "${location.origin}/dist/browser/browser.mjs";
        import { createConnection } from "${location.origin}/dist/browser/mysql2-driver.mjs";
        let client;
        onmessage = async ({data}) => {
          try {
            if (data.close) { await client.close(); postMessage({closed:true}); return; }
            client = connectDatabasePort(data.port);
            const c = await createConnection({server: client});
            await c.query('CREATE TABLE t (id INT PRIMARY KEY) ENGINE=InnoDB');
            await c.execute('INSERT INTO t VALUES (?)', [data.index]);
            await c.beginTransaction();
            await c.query('INSERT INTO t VALUES (99)');
            await c.rollback();
            const [rows] = await c.query('SELECT * FROM t');
            const [[db]] = await c.query('SELECT DATABASE() AS name');
            postMessage({rows, database: db.name});
          } catch (e) { postMessage({error:e.message}); }
        };
      `;
      const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      const request = (worker, message, transfers = []) =>
        new Promise((resolve, reject) => {
          worker.onmessage = ({ data }) =>
            data.error ? reject(new Error(data.error)) : resolve(data);
          worker.onerror = (event) => reject(new Error(event.message));
          worker.postMessage(message, transfers);
        });
      try {
        const responses = await Promise.all(
          [0, 1].map(async (index) => {
            const worker = new Worker(url, { type: "module" });
            workers.push(worker);
            const port = await host.createClientPort();
            return request(worker, { port, index }, [port]);
          }),
        );
        const admin = await host.connect();
        const combined = (
          await admin.query(
            `SELECT id FROM ${responses[0].database}.t UNION ALL SELECT id FROM ${responses[1].database}.t ORDER BY id`,
          )
        )[0];
        await request(workers[0], { close: true });
        const removed = (
          await admin.query(
            `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='${responses[0].database}'`,
          )
        )[0];
        const surviving = (await admin.query(`SELECT * FROM ${responses[1].database}.t`))[0];
        return { rows: responses.map((r) => r.rows), combined, removed, surviving };
      } finally {
        await host.close();
        workers.forEach((w) => w.terminate());
        URL.revokeObjectURL(url);
      }
    });
    assert.deepEqual(result, {
      rows: [[{ id: 0 }], [{ id: 1 }]],
      combined: [{ id: 0 }, { id: 1 }],
      removed: [],
      surviving: [{ id: 1 }],
    });
  });
});
