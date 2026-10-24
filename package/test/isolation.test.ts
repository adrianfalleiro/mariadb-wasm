/*
  Phase 14: several independent runtimes at once, and the guarantee test
  workers actually depend on — that they cannot see each other's data.

  Isolation here comes from the wasm instance boundary, not from anything this
  package enforces. Each call to the Emscripten factory builds a module with
  its own linear memory and its own filesystem, so two servers share no
  datadir, no buffer pool and no MariaDB globals. That is also why the brief's
  "one server runtime per WASM instance" rule is not a limitation to work
  around: it is the isolation mechanism.
*/
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "../src/index.ts";
import type { EmbeddedMariaDbServer } from "../src/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("parallel isolation", () => {
  test("four concurrent servers share no state", { timeout: 300_000 }, async () => {
    const count = 4;

    /* Created concurrently, not in sequence: serial creation would not
         exercise the case where four instances are initialising at once,
         which is when a shared-state bug would actually show. */
    const servers: EmbeddedMariaDbServer[] = await Promise.all(
      Array.from({ length: count }, () => createServer({ storage: { type: "memory" } })),
    );

    try {
      /* Every server builds the same schema under the same name and writes
           rows only it should see. */
      await Promise.all(
        servers.map(async (server, index) => {
          const connection = await server.connect();
          await connection.query("CREATE DATABASE shared_name");
          await connection.query("USE shared_name");
          await connection.query(`
              CREATE TABLE items (
                id INT NOT NULL AUTO_INCREMENT,
                owner INT NOT NULL,
                PRIMARY KEY (id)
              ) ENGINE=InnoDB
            `);
          for (let row = 0; row < 25; row++)
            await connection.execute("INSERT INTO items(owner) VALUES (?)", [index]);
          await connection.close();
        }),
      );

      await Promise.all(
        servers.map(async (server, index) => {
          const connection = await server.connect({ database: "shared_name" });

          const [counts] = await connection.query("SELECT COUNT(*) AS n FROM items");
          assert.equal(counts[0].n, 25n, `server ${index} should hold exactly its own 25 rows`);

          const [owners] = await connection.query("SELECT DISTINCT owner FROM items");
          assert.equal(owners.length, 1, `server ${index} saw rows from another instance`);
          assert.equal(owners[0].owner, index);

          await connection.close();
        }),
      );
    } finally {
      await Promise.all(servers.map((server) => server.close()));
    }
  });

  test("a server survives repeated create/close cycles", { timeout: 300_000 }, async () => {
    /* Startup and shutdown must be deterministic, which is the property the
         old deadlock broke. Doing it repeatedly in one process also catches
         state leaking between instances. */
    for (let round = 0; round < 3; round++) {
      const server = await createServer();
      const connection = await server.connect();
      await connection.query("CREATE DATABASE round_db");
      await connection.query("USE round_db");
      await connection.query("CREATE TABLE t (id INT PRIMARY KEY) ENGINE=InnoDB");
      await connection.query("INSERT INTO t VALUES (1)");

      const [rows] = await connection.query("SELECT COUNT(*) AS n FROM t");
      assert.equal(rows[0].n, 1n, `round ${round} lost its row`);

      await connection.close();
      await server.close();
    }
  });
});

describe("test-worker ownership", () => {
  test(
    "two worker_threads each run their own runtime and Node still exits",
    { timeout: 300_000 },
    async () => {
      /*
        The topology a parallel test runner produces: one MariaDB per worker.
        This also covers criterion 3.2.9 in the form that matters - a worker
        whose Emscripten pthreads outlived shutdown would never emit 'exit',
        and this test would hang rather than pass.
      */
      const runWorker = (id: number) =>
        new Promise<number>((resolve, reject) => {
          const worker = new Worker(new URL("./isolation-worker.ts", import.meta.url), {
            workerData: { id },
          });
          let reported: number | undefined;
          worker.on("message", (value: number) => {
            reported = value;
          });
          worker.on("error", reject);
          worker.on("exit", (code) => {
            if (code !== 0) reject(new Error(`worker ${id} exited with ${code}`));
            else if (reported === undefined)
              reject(new Error(`worker ${id} exited without reporting`));
            else resolve(reported);
          });
        });

      const [first, second] = await Promise.all([runWorker(1), runWorker(2)]);
      assert.equal(first, 1, "worker 1 should see only its own row");
      assert.equal(second, 2, "worker 2 should see only its own row");
    },
  );
});
