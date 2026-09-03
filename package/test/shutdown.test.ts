/*
  Shutdown drains every MariaDB-registered thread.

  This used to be a documented gap: one thread never called my_thread_end, so
  my_thread_global_end waited out its full my_thread_end_wait_time and gave up
  with "1 threads didn't exit". The workaround was to set that wait to 0, which
  hid the symptom — a flat five seconds per server — without establishing that
  anything had actually stopped.

  The thread was the one running mdb_runtime_init_async. mysql_server_init
  registers its *calling* thread with mysys, and under wasm that call happens
  off the main thread, so the registration outlived the thread that made it.
  Natively it was invisible: init runs on the thread that later calls
  mysql_server_end, and my_end unregisters it there.

  The wait is now left at MariaDB's default, so these tests fail loudly rather
  than silently costing five seconds each.
*/
import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { createEmbeddedMariaDb } from "../src/index.ts";
import type { EmbeddedMariaDbServer } from "../src/types.ts";

/* shutdownWasClean and diagnostics are on the concrete Server, which is not
   exported — the same cast the leak assertions in api.test.ts use. */
type Inspectable = EmbeddedMariaDbServer & {
  shutdownWasClean: boolean;
  diagnostics: string;
};
const inspect = (server: EmbeddedMariaDbServer) =>
  server as unknown as Inspectable;

/*
  Comfortably under the 5s the leak used to cost and far above the ~100ms a
  clean shutdown takes, so it fails on a regression rather than on a slow
  machine. A clean shutdown does not wait at all — the count is already zero.
*/
const SHUTDOWN_BUDGET_MS = 2_500;

describe("shutdown", () => {
  test("drains every MariaDB thread, and does not wait to find out", async () => {
    const server = inspect(await createEmbeddedMariaDb());

    const connection = await server.connect();
    await connection.query("CREATE DATABASE shutdown_db");
    await connection.query("USE shutdown_db");
    await connection.query(
      "CREATE TABLE t (id INT PRIMARY KEY, v INT) ENGINE=InnoDB",
    );
    await connection.execute("INSERT INTO t VALUES (?, ?)", [1, 10]);
    await connection.close();

    const started = Date.now();
    await server.close();
    const elapsed = Date.now() - started;

    assert.equal(
      server.shutdownWasClean,
      true,
      "MariaDB reported threads that never called my_thread_end:\n" +
        server.diagnostics,
    );
    assert.ok(
      elapsed < SHUTDOWN_BUDGET_MS,
      `shutdown took ${elapsed}ms, over the ${SHUTDOWN_BUDGET_MS}ms budget — ` +
        "the thread wait is running to completion again",
    );
  }, { timeout: 120_000 });

  test("stays clean after the async statement path has been used", async () => {
    /* prepare and execute each run on their own thread now. Both must pair
       mysql_thread_init with mysql_thread_end, or they leak exactly the way
       initialisation did — and a query-per-test suite would leak one per
       statement rather than one per server. */
    const server = inspect(await createEmbeddedMariaDb());

    const connection = await server.connect();
    await connection.query("CREATE DATABASE stmt_db");
    await connection.query("USE stmt_db");
    await connection.query(
      "CREATE TABLE t (id INT PRIMARY KEY, v VARCHAR(32)) ENGINE=InnoDB",
    );

    for (let i = 0; i < 50; i++)
      await connection.execute("INSERT INTO t VALUES (?, ?)", [i, `row-${i}`]);

    const [rows] = await connection.execute(
      "SELECT COUNT(*) AS n FROM t WHERE id < ?",
      [50],
    );
    assert.equal(rows[0].n, 50n);
    await connection.close();

    const started = Date.now();
    await server.close();
    const elapsed = Date.now() - started;

    assert.equal(
      server.shutdownWasClean,
      true,
      "a statement worker thread did not unregister:\n" + server.diagnostics,
    );
    assert.ok(
      elapsed < SHUTDOWN_BUDGET_MS,
      `shutdown took ${elapsed}ms after 51 prepared statements`,
    );
  }, { timeout: 120_000 });
});
