/*
  One MariaDB runtime inside a worker_threads worker — the shape a parallel
  test runner produces, with one server per worker.

  Writes `id` rows and reports how many it can see. If instances leaked into
  each other the count would come back wrong; if shutdown left Emscripten
  pthread workers running, this worker would never exit and the parent test
  would time out rather than pass.
*/
import { parentPort, workerData } from "node:worker_threads";

import { createEmbeddedMariaDb } from "../src/index.ts";

const { id } = workerData as { id: number };

const server = await createEmbeddedMariaDb({ storage: { type: "memory" } });
try {
  const connection = await server.connect();
  await connection.query("CREATE DATABASE worker_db");
  await connection.query("USE worker_db");
  await connection.query(
    "CREATE TABLE t (id INT NOT NULL AUTO_INCREMENT, PRIMARY KEY (id)) ENGINE=InnoDB",
  );
  for (let row = 0; row < id; row++)
    await connection.query("INSERT INTO t() VALUES ()");

  const [rows] = await connection.query("SELECT COUNT(*) AS n FROM t");
  parentPort?.postMessage(Number(rows[0].n));

  await connection.close();
} finally {
  await server.close();
}
