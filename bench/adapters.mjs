/*
  Two adapters over the same tiny interface, so workload.mjs cannot tell which
  backend it is running against.

  Both apply the same schema and use transaction-rollback isolation. The
  server side gets a database per worker, which is how a shared instance is
  normally partitioned for parallel tests; the embedded side gets an instance
  per worker, which is how it partitions naturally.
*/
import { SCHEMA, SEED } from "./workload.mjs";

/* --- embedded wasm ------------------------------------------------------- */

export async function createEmbedded({ root }) {
  const { createEmbeddedMariaDb } = await import(`${root}/package/src/index.ts`);

  const server = await createEmbeddedMariaDb({ storage: { type: "memory" } });
  return createEmbeddedClient(server, true);
}

export async function createShared({ root, clientPort }) {
  const { connectDatabasePort } = await import(`${root}/package/src/shared.ts`);
  return createEmbeddedClient(connectDatabasePort(clientPort), false);
}

async function createEmbeddedClient(server, isolated) {
  const connection = await server.connect();
  if (isolated) {
    await connection.query("CREATE DATABASE bench");
    await connection.query("USE bench");
  }
  for (const statement of SCHEMA) await connection.query(statement);
  for (const [sql, params] of SEED) await connection.execute(sql, params);
  return {
    db: {
      query: (sql) => connection.query(sql),
      execute: (sql, params) => connection.execute(sql, params),
      begin: () => connection.beginTransaction(),
      rollback: () => connection.rollback(),
    },
    async close() {
      await connection.close();
      await server.close();
    },
  };
}

/* --- MySQL server over the wire ------------------------------------------ */

export async function createServer({ port, database }) {
  const mysql = await import("mysql2/promise");

  /* One admin connection to create the per-worker database, then a dedicated
     connection for the tests themselves — the same shape as the embedded
     side, which also runs its tests on one connection. */
  const admin = await mysql.createConnection({
    host: "127.0.0.1",
    port,
    user: "root",
    password: "bench",
    multipleStatements: false,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await admin.query(`CREATE DATABASE \`${database}\``);
  await admin.end();

  const connection = await mysql.createConnection({
    host: "127.0.0.1",
    port,
    user: "root",
    password: "bench",
    database,
    /* Matches the embedded decoder's lossless defaults, so neither side is
       doing more or less conversion work than the other. */
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: true,
  });

  for (const statement of SCHEMA) await connection.query(statement);
  for (const [sql, params] of SEED) await connection.execute(sql, params);

  return {
    name: "mysql server (docker)",
    db: {
      query: (sql) => connection.query(sql),
      execute: (sql, params) => connection.execute(sql, params),
      begin: () => connection.beginTransaction(),
      rollback: () => connection.rollback(),
    },
    async close() {
      await connection.end();
    },
  };
}
