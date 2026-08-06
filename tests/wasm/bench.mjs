/*
  Phase 15 measurements. Numbers, not impressions — the optimisation list in
  the brief is ordered by expected payoff, and picking from it without
  measuring is how effort goes into the wrong place.

  Run after the differential suite passes, which is the point at which
  optimising is allowed to start.
*/
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createEmbeddedMariaDb } from "../../package/src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, "..", "..", "dist");

const ms = (value) => `${value.toFixed(1)} ms`;
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function time(label, fn) {
  const start = performance.now();
  const result = await fn();
  const elapsed = performance.now() - start;
  process.stdout.write(`${label.padEnd(38)} ${ms(elapsed).padStart(12)}\n`);
  return { result, elapsed };
}

process.stdout.write("measurement                                     value\n");
process.stdout.write("".padEnd(52, "-") + "\n");

/* Artifact sizes first: they are the one thing that does not need a run. */
const { statSync } = await import("node:fs");
for (const artifact of ["mariadb.mjs", "mariadb.wasm"]) {
  const bytes = statSync(path.join(distDir, artifact)).size;
  process.stdout.write(`${`artifact ${artifact}`.padEnd(38)} ${mb(bytes).padStart(12)}\n`);
}

const { result: server } = await time("server create (load + init)", () =>
  createEmbeddedMariaDb({ storage: { type: "memory" } }),
);

const { result: connection } = await time("first connection", () =>
  server.connect(),
);

await time("first query", () => connection.query("SELECT 1"));

await time("schema setup", async () => {
  await connection.query("CREATE DATABASE bench");
  await connection.query("USE bench");
  await connection.query(`
    CREATE TABLE t (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      v INT NOT NULL,
      s VARCHAR(64) NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB
  `);
});

await time("1000 simple queries", async () => {
  for (let i = 0; i < 1000; i++) await connection.query("SELECT 1");
});

await time("1000 prepared inserts", async () => {
  for (let i = 0; i < 1000; i++)
    await connection.execute("INSERT INTO t(v, s) VALUES (?, ?)", [
      i,
      `row ${i}`,
    ]);
});

await time("1000 inserts in one transaction", async () => {
  await connection.beginTransaction();
  for (let i = 0; i < 1000; i++)
    await connection.execute("INSERT INTO t(v, s) VALUES (?, ?)", [i, "tx"]);
  await connection.commit();
});

await time("select 2000 rows", async () => {
  const [rows] = await connection.query("SELECT id, v, s FROM t");
  if (rows.length !== 2000) throw new Error(`expected 2000 rows, got ${rows.length}`);
});

await time("indexed point lookups (1000)", async () => {
  for (let i = 1; i <= 1000; i++)
    await connection.execute("SELECT v FROM t WHERE id = ?", [i]);
});

process.stdout.write(
  `${"heap after workload".padEnd(38)} ${mb(process.memoryUsage().rss).padStart(12)} rss\n`,
);

await time("connection close", () => connection.close());
await time("server close", () => server.close());

process.stdout.write("".padEnd(52, "-") + "\n");
