/*
  InnoDB locking with two genuinely concurrent transactions.

  These are only expressible because queries run on their own thread. With a
  synchronous driver the first blocking call owns the JavaScript thread, so the
  lock holder can never reach its COMMIT — a lock wait could only ever end in a
  timeout, and a deadlock could not form at all for InnoDB to detect.
*/
import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { createEmbeddedMariaDb } from "../src/index.ts";
import { MariaDbEmbeddedError } from "../src/errors.ts";
import type { EmbeddedMariaDbConnection, EmbeddedMariaDbServer } from "../src/types.ts";

let server: EmbeddedMariaDbServer;

before(
  async () => {
    server = await createEmbeddedMariaDb({
      /* Short enough that a genuine hang fails the test quickly, long enough
       that a merely slow machine does not. */
      serverOptions: ["--innodb-lock-wait-timeout=5"],
    });
    const setup = await server.connect();
    await setup.query("CREATE DATABASE lock_db");
    await setup.query("USE lock_db");
    await setup.query("CREATE TABLE t (id INT PRIMARY KEY, v INT NOT NULL) ENGINE=InnoDB");
    await setup.close();
  },
  { timeout: 120_000 },
);

after(async () => {
  await server?.close();
});

async function seed(rows: [number, number][]) {
  const connection = await server.connect({ database: "lock_db" });
  await connection.query("DELETE FROM t");
  for (const [id, v] of rows) await connection.execute("INSERT INTO t VALUES (?, ?)", [id, v]);
  await connection.close();
}

/* Resolves once `promise` settles; false if it is still pending after `ms`. */
function settledWithin(promise: Promise<unknown>, ms: number) {
  const pending = Symbol("pending");
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise((resolve) => setTimeout(() => resolve(pending), ms)).then(
      (value) => value !== pending,
    ),
  ]);
}

describe("row locking", () => {
  test("a lock wait resolves when the holder commits", { timeout: 60_000 }, async () => {
    await seed([[1, 10]]);
    const a = await server.connect({ database: "lock_db" });
    const b = await server.connect({ database: "lock_db" });

    try {
      await a.beginTransaction();
      await a.query("UPDATE t SET v = 11 WHERE id = 1");

      await b.beginTransaction();
      const waiting = b.query("SELECT v FROM t WHERE id = 1 FOR UPDATE");

      /* It must actually be blocked — otherwise the rest proves nothing. */
      assert.equal(
        await settledWithin(waiting, 200),
        false,
        "B should be blocked while A holds the lock",
      );

      await a.commit();

      const [rows] = await waiting;
      assert.equal(rows[0].v, 11, "B should see A's committed value");
      await b.rollback();
    } finally {
      await a.close();
      await b.close();
    }
  });

  test(
    "a lock wait times out with 1205 when the holder does not commit",
    { timeout: 120_000 },
    async () => {
      await seed([[1, 10]]);
      const fast = await createEmbeddedMariaDb({
        serverOptions: ["--innodb-lock-wait-timeout=1"],
      });
      try {
        const setup = await fast.connect();
        await setup.query("CREATE DATABASE d");
        await setup.query("USE d");
        await setup.query("CREATE TABLE t (id INT PRIMARY KEY, v INT NOT NULL) ENGINE=InnoDB");
        await setup.query("INSERT INTO t VALUES (1, 10)");
        await setup.close();

        const a = await fast.connect({ database: "d" });
        const b = await fast.connect({ database: "d" });

        await a.beginTransaction();
        await a.query("UPDATE t SET v = 11 WHERE id = 1");
        await b.beginTransaction();

        await assert.rejects(
          () => b.query("SELECT v FROM t WHERE id = 1 FOR UPDATE"),
          (error: unknown) =>
            error instanceof MariaDbEmbeddedError && (error as MariaDbEmbeddedError).code === 1205,
        );

        /* Both connections must survive a lock timeout. */
        await a.rollback();
        await b.rollback();
        const [rows] = await a.query("SELECT v FROM t WHERE id = 1");
        assert.equal(rows[0].v, 10);

        await a.close();
        await b.close();
      } finally {
        await fast.close();
      }
    },
  );

  test("a non-conflicting row is not blocked", { timeout: 60_000 }, async () => {
    await seed([
      [1, 10],
      [2, 20],
    ]);
    const a = await server.connect({ database: "lock_db" });
    const b = await server.connect({ database: "lock_db" });

    try {
      await a.beginTransaction();
      await a.query("UPDATE t SET v = 11 WHERE id = 1");

      /* Locks are per row, so this must not wait on the lock for id=1. */
      const other = b.query("SELECT v FROM t WHERE id = 2 FOR UPDATE");
      assert.equal(await settledWithin(other, 1000), true, "a different row should not be blocked");

      await a.rollback();
    } finally {
      await a.close();
      await b.close();
    }
  });
});

/*
  The same contention, driven through execute() rather than query().

  This is a separate block because it exercises a different ABI path, not a
  different database behaviour. query() has run on its own thread since
  Phase 12; prepare and execute did not, so a prepared statement blocked the
  thread that services MariaDB's proxied filesystem syscalls under wasm. These
  tests fail by hanging if that ever comes back — the holder cannot reach its
  COMMIT while the waiter owns the JavaScript thread.
*/
describe("row locking through prepared statements", () => {
  test("a lock wait resolves when the holder commits", { timeout: 60_000 }, async () => {
    await seed([[1, 10]]);
    const a = await server.connect({ database: "lock_db" });
    const b = await server.connect({ database: "lock_db" });

    try {
      await a.beginTransaction();
      await a.execute("UPDATE t SET v = ? WHERE id = ?", [11, 1]);

      await b.beginTransaction();
      const waiting = b.execute("SELECT v FROM t WHERE id = ? FOR UPDATE", [1]);

      assert.equal(
        await settledWithin(waiting, 200),
        false,
        "B should be blocked while A holds the lock",
      );

      await a.commit();

      const [rows] = await waiting;
      assert.equal(rows[0].v, 11, "B should see A's committed value");
      await b.rollback();
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("a deadlock still resolves when both sides are prepared", { timeout: 60_000 }, async () => {
    await seed([
      [1, 10],
      [2, 20],
    ]);
    const a = await server.connect({ database: "lock_db" });
    const b = await server.connect({ database: "lock_db" });

    try {
      await a.beginTransaction();
      await b.beginTransaction();

      await a.execute("UPDATE t SET v = ? WHERE id = ?", [100, 1]);
      await b.execute("UPDATE t SET v = ? WHERE id = ?", [200, 2]);

      const outcomes = await Promise.allSettled([
        a.execute("UPDATE t SET v = ? WHERE id = ?", [101, 2]),
        b.execute("UPDATE t SET v = ? WHERE id = ?", [201, 1]),
      ]);

      const victims = outcomes.filter(
        (outcome) =>
          outcome.status === "rejected" &&
          outcome.reason instanceof MariaDbEmbeddedError &&
          outcome.reason.code === 1213,
      );

      assert.equal(
        victims.length,
        1,
        `expected exactly one deadlock victim, got ${victims.length}`,
      );

      const survivor = outcomes[0].status === "fulfilled" ? a : b;
      await survivor.commit();
    } finally {
      await a.close().catch(() => {});
      await b.close().catch(() => {});
    }
  });

  test("two connections interleave prepared reads and writes", { timeout: 120_000 }, async () => {
    await seed([]);
    const a = await server.connect({ database: "lock_db" });
    const b = await server.connect({ database: "lock_db" });

    try {
      /* Disjoint rows, both sides preparing and executing throughout. If
         either side serialised the other this would still pass — the point is
         that it must not hang, and that nothing is lost. */
      await Promise.all([
        (async () => {
          for (let i = 0; i < 20; i++) await a.execute("INSERT INTO t VALUES (?, ?)", [i, 1]);
        })(),
        (async () => {
          for (let i = 100; i < 120; i++) await b.execute("INSERT INTO t VALUES (?, ?)", [i, 2]);
        })(),
      ]);

      const [rows] = await a.execute("SELECT COUNT(*) AS n FROM t WHERE v IN (?, ?)", [1, 2]);
      assert.equal(rows[0].n, 40n, "every prepared insert should have landed");
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe("deadlock detection", () => {
  test(
    "InnoDB breaks a cycle with 1213 and picks exactly one victim",
    { timeout: 60_000 },
    async () => {
      await seed([
        [1, 10],
        [2, 20],
      ]);
      const a = await server.connect({ database: "lock_db" });
      const b = await server.connect({ database: "lock_db" });

      try {
        await a.beginTransaction();
        await b.beginTransaction();

        await a.query("UPDATE t SET v = 100 WHERE id = 1"); /* A locks row 1 */
        await b.query("UPDATE t SET v = 200 WHERE id = 2"); /* B locks row 2 */

        /* Each now wants the other's row. Both are in flight at once, which is
         the only way the cycle can exist for InnoDB to find. */
        const outcomes = await Promise.allSettled([
          a.query("UPDATE t SET v = 101 WHERE id = 2"),
          b.query("UPDATE t SET v = 201 WHERE id = 1"),
        ]);

        const victims = outcomes.filter(
          (outcome) =>
            outcome.status === "rejected" &&
            outcome.reason instanceof MariaDbEmbeddedError &&
            outcome.reason.code === 1213,
        );

        assert.equal(
          victims.length,
          1,
          `expected exactly one deadlock victim, got ${victims.length}`,
        );
        assert.equal(
          (victims[0] as PromiseRejectedResult).reason.sqlState,
          "40001",
          "a deadlock is SQLSTATE 40001, which is what retry logic keys on",
        );

        /* The survivor must be able to finish; the victim's transaction is
         already rolled back by InnoDB. */
        const survivor = outcomes[0].status === "fulfilled" ? a : b;
        await survivor.commit();
      } finally {
        await a.close().catch(() => {});
        await b.close().catch(() => {});
      }
    },
  );
});

describe("isolation levels", () => {
  test(
    "REPEATABLE READ hides a concurrent commit; READ COMMITTED shows it",
    { timeout: 60_000 },
    async () => {
      await seed([[1, 10]]);
      const reader = await server.connect({ database: "lock_db" });
      const writer = await server.connect({ database: "lock_db" });

      try {
        /* REPEATABLE READ is MariaDB's default, and the snapshot is taken at the
         first read, not at START TRANSACTION. */
        await reader.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        await reader.beginTransaction();
        const [first] = await reader.query("SELECT v FROM t WHERE id = 1");
        assert.equal(first[0].v, 10);

        await writer.query("UPDATE t SET v = 42 WHERE id = 1");

        const [again] = await reader.query("SELECT v FROM t WHERE id = 1");
        assert.equal(again[0].v, 10, "REPEATABLE READ should hold the snapshot");
        await reader.commit();

        const [after] = await reader.query("SELECT v FROM t WHERE id = 1");
        assert.equal(after[0].v, 42, "and see it once the transaction ends");

        await reader.query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
        await reader.beginTransaction();
        const [before] = await reader.query("SELECT v FROM t WHERE id = 1");
        assert.equal(before[0].v, 42);

        await writer.query("UPDATE t SET v = 43 WHERE id = 1");

        const [now] = await reader.query("SELECT v FROM t WHERE id = 1");
        assert.equal(now[0].v, 43, "READ COMMITTED should see the new commit");
        await reader.commit();
      } finally {
        await reader.close();
        await writer.close();
      }
    },
  );
});

describe("concurrent throughput", () => {
  test("four connections write to disjoint rows at once", { timeout: 120_000 }, async () => {
    await seed([]);
    const connections: EmbeddedMariaDbConnection[] = await Promise.all(
      Array.from({ length: 4 }, () => server.connect({ database: "lock_db" })),
    );

    try {
      /* Genuinely interleaved, not serialised by the driver. Disjoint rows, so
         nothing should contend and nothing should be lost. */
      await Promise.all(
        connections.map(async (connection, index) => {
          for (let i = 0; i < 25; i++)
            await connection.execute("INSERT INTO t VALUES (?, ?)", [index * 100 + i, index]);
        }),
      );

      const [rows] = await connections[0].query("SELECT COUNT(*) AS n FROM t");
      assert.equal(rows[0].n, 100n, "every insert should have landed");
    } finally {
      await Promise.all(connections.map((c) => c.close()));
    }
  });
});
