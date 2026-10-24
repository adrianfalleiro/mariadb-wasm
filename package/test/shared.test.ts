import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { createSharedDatabaseWorker, connectDatabasePort } from "../src/shared.ts";
import { createConnection } from "../src/mysql2.ts";
import { createConnection as createMariaConnection } from "../src/mariadb.ts";

test(
  "shared engine partitions real workers and drops only the released database",
  { timeout: 60000 },
  async () => {
    const host = await createSharedDatabaseWorker();
    const workers: Worker[] = [];
    try {
      const ports = await Promise.all([host.createClientPort(), host.createClientPort()]);
      const clients = ports.map((port, index) => {
        const worker = new Worker(
          `
        const { parentPort, workerData } = require('node:worker_threads');
        (async () => {
          const { connectDatabasePort } = await import(workerData.module);
          const client = connectDatabasePort(workerData.port);
          const c = await client.connect();
          await c.query('CREATE TABLE t (id INT PRIMARY KEY) ENGINE=InnoDB');
          await c.execute('INSERT INTO t VALUES (?)', [workerData.index]);
          await c.beginTransaction();
          await c.query('INSERT INTO t VALUES (99)');
          await c.rollback();
          parentPort.postMessage({ rows: (await c.query('SELECT * FROM t'))[0], database: (await c.query('SELECT DATABASE() AS d'))[0][0].d });
          parentPort.once('message', async () => { await client.close(); parentPort.close(); });
        })().catch(error => { throw error; });
      `,
          {
            eval: true,
            workerData: { port, index, module: new URL("../src/shared.ts", import.meta.url).href },
            transferList: [port],
          },
        );
        workers.push(worker);
        return new Promise<any>((resolve, reject) => {
          worker.once("message", resolve);
          worker.once("error", reject);
        });
      });
      const results = await Promise.all(clients);
      assert.deepEqual(
        results.map((r) => r.rows),
        [[{ id: 0 }], [{ id: 1 }]],
      );
      assert.notEqual(results[0].database, results[1].database);
      const admin = await host.connect();
      // Seeing both schemas from this host proves there is one shared engine.
      assert.deepEqual(
        (
          await admin.query(
            `SELECT id FROM ${results[0].database}.t UNION ALL SELECT id FROM ${results[1].database}.t ORDER BY id`,
          )
        )[0],
        [{ id: 0 }, { id: 1 }],
      );
      const exited = new Promise((resolve) => workers[0].once("exit", resolve));
      workers[0].postMessage("close");
      await exited;
      assert.deepEqual(
        (
          await admin.query(
            `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='${results[0].database}'`,
          )
        )[0],
        [],
      );
      assert.deepEqual((await admin.query(`SELECT id FROM ${results[1].database}.t`))[0], [
        { id: 1 },
      ]);
      await admin.close();
    } finally {
      await host.close();
      await Promise.all(workers.map((w) => w.terminate()));
    }
  },
);

test(
  "shared ports support driver results, queued close, errors and owner shutdown",
  { timeout: 60000 },
  async () => {
    const host = await createSharedDatabaseWorker();
    try {
      const client = connectDatabasePort(await host.createClientPort());
      const c = await createConnection({ server: client });
      await c.query("CREATE TABLE t (v INT)");
      const maria = await createMariaConnection({ server: client });
      const binaryRows = await maria.query("SELECT 9007199254740993 AS n, X'00ff' AS bytes");
      const binaryRow = (binaryRows as unknown as Array<{ n: bigint; bytes: Buffer }>)[0];
      assert.equal(binaryRow.n, 9007199254740993n);
      assert.deepEqual(binaryRow.bytes, Buffer.from([0, 255]));
      await maria.end();
      await assert.rejects(c.query("SELECT * FROM missing_table"), { code: "ER_NO_SUCH_TABLE" });
      const insert = c.execute("INSERT INTO t VALUES (?)", [42]);
      const closed = client.close();
      assert.equal(((await insert) as unknown as [{ affectedRows: number }])[0].affectedRows, 1);
      await closed;
      await client.close();
      await assert.rejects(client.connect(), /closing|closed/);
      const survivor = connectDatabasePort(await host.createClientPort());
      const connection = await survivor.connect();
      assert.deepEqual((await connection.query("SELECT 7 AS n"))[0], [{ n: 7 }]);
      await host.close();
      await assert.rejects(connection.query("SELECT 8"), /closed/);
      await assert.rejects(host.createClientPort(), /closing|closed/);
    } finally {
      await host.close();
    }
  },
);

test(
  "shared startup failures reject and terminate the engine worker",
  { timeout: 60000 },
  async () => {
    await assert.rejects(createSharedDatabaseWorker({ serverOptions: ["--not-a-real-option"] }));
  },
);

test(
  "a terminated Node client rolls back its transaction and releases its database",
  { timeout: 60000 },
  async () => {
    const host = await createSharedDatabaseWorker({
      serverOptions: ["--innodb-lock-wait-timeout=2"],
    });
    let worker: Worker | undefined;
    try {
      const admin = await host.connect();
      await admin.query("CREATE DATABASE shared_lock");
      await admin.query("CREATE TABLE shared_lock.t (v INT) ENGINE=InnoDB");
      await admin.query("INSERT INTO shared_lock.t VALUES (1)");
      const port = await host.createClientPort();
      worker = new Worker(
        `
      const {parentPort,workerData} = require('node:worker_threads');
      (async () => {
        const {connectDatabasePort} = await import(workerData.module);
        const c = await connectDatabasePort(workerData.port).connect();
        await c.beginTransaction();
        await c.query('UPDATE shared_lock.t SET v=2');
        parentPort.postMessage('locked');
      })();
    `,
        {
          eval: true,
          workerData: { port, module: new URL("../src/shared.ts", import.meta.url).href },
          transferList: [port],
        },
      );
      assert.equal(
        await new Promise((resolve, reject) => {
          worker!.once("message", resolve);
          worker!.once("error", reject);
        }),
        "locked",
      );
      await worker.terminate();
      // This would time out if the orphaned transaction retained its lock.
      await admin.query("UPDATE shared_lock.t SET v=v+10");
      assert.deepEqual((await admin.query("SELECT v FROM shared_lock.t"))[0], [{ v: 11 }]);
      await admin.close();
    } finally {
      await worker?.terminate();
      await host.close();
    }
  },
);
