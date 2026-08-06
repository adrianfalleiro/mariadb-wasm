/*
  Helpers for wiring a runtime into a test file.

  Runner-agnostic on purpose: each returns a plain object with setup/teardown
  functions, so it works with node:test, Vitest, Jest or Mocha without this
  package depending on any of them.
*/
import { createEmbeddedMariaDb } from "./server.ts";
import { MariaDbEmbeddedStateError } from "./errors.ts";
import type {
  EmbeddedMariaDbConnection,
  EmbeddedMariaDbOptions,
  EmbeddedMariaDbServer,
} from "./types.ts";

let databaseCounter = 0;

/* Backtick-quoted with embedded backticks doubled — MariaDB's own rule. An
   identifier cannot be a bound parameter, so quoting is the only defence. */
function quoteIdentifier(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

/*
  One server for the whole test file, created lazily.

  A runtime costs ~180 ms to create, so one per test would dominate a suite.
  Per-file is the granularity that matters anyway: test *runners* already give
  each file its own worker, and isolation between workers comes from the wasm
  instance boundary.
*/
export function resetServerPerFile(options: EmbeddedMariaDbOptions = {}) {
  let server: EmbeddedMariaDbServer | undefined;

  return {
    async setup(): Promise<EmbeddedMariaDbServer> {
      server ??= await createEmbeddedMariaDb(options);
      return server;
    },
    /* Between tests: drop user schemas but keep the runtime. */
    async reset(): Promise<void> {
      if (server) await server.reset();
    },
    async teardown(): Promise<void> {
      await server?.close();
      server = undefined;
    },
    get current(): EmbeddedMariaDbServer {
      if (!server)
        throw new MariaDbEmbeddedStateError("setup() has not run yet");
      return server;
    },
  };
}

/*
  A fresh database per test, on a shared server. Cheaper than a fresh runtime
  and gives genuine isolation for anything that is not cross-schema.
*/
export function createDatabasePerTest(server: EmbeddedMariaDbServer) {
  return {
    async setup(): Promise<{
      connection: EmbeddedMariaDbConnection;
      database: string;
    }> {
      const database = `test_${process.pid}_${databaseCounter++}`;
      const connection = await server.connect();
      await connection.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
      await connection.query(`USE ${quoteIdentifier(database)}`);
      return { connection, database };
    },

    async teardown(handle: {
      connection: EmbeddedMariaDbConnection;
      database: string;
    }): Promise<void> {
      /* Drop before closing: closing first would leave the schema behind, and
         these accumulate across a file. */
      try {
        await handle.connection.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(handle.database)}`,
        );
      } finally {
        await handle.connection.close();
      }
    },
  };
}

/*
  Applies a schema once, then gives each test its own database created from it.

  MariaDB has no "clone this schema" primitive, so the DDL is simply replayed
  per test. For a schema of any size that is slower than a template datadir
  would be, and that is the honest trade until one exists.
*/
export function createSchemaPerTest(
  server: EmbeddedMariaDbServer,
  schemaStatements: readonly string[],
) {
  const perTest = createDatabasePerTest(server);

  return {
    async setup() {
      const handle = await perTest.setup();
      for (const statement of schemaStatements)
        await handle.connection.query(statement);
      return handle;
    },
    teardown: perTest.teardown,
  };
}

/*
  Runs `body` inside a transaction that is always rolled back.

  Do not reach for this by default. DDL in MariaDB commits implicitly, so a
  CREATE TABLE inside the callback survives the rollback and leaks into the
  next test — and so does anything done on a *different* connection. It is
  only sound for tests that stay on this connection and only touch DML.
  createDatabasePerTest is the one that always works.
*/
export async function withTransactionRollback<T>(
  connection: EmbeddedMariaDbConnection,
  body: (connection: EmbeddedMariaDbConnection) => Promise<T>,
): Promise<T> {
  await connection.beginTransaction();
  try {
    return await body(connection);
  } finally {
    /* finally, not catch: a passing test must roll back too — that is the
       whole point — and a rollback failure must not mask the real error. */
    try {
      await connection.rollback();
    } catch {
      /* The connection is already broken; the original outcome is what
         matters. Closing it will roll back anyway. */
    }
  }
}
