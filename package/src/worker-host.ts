import { createEmbeddedMariaDb } from "./server.ts";
import type { EmbeddedMariaDbServer, EmbeddedMariaDbConnection } from "./types.ts";
import type { DatabaseEndpoint } from "./worker-client.ts";

// One engine, with a connection namespace and default database per client port.
// Databases are test partitions, not a security boundary; SQL can name other schemas.
export function serveDatabaseWorker(root: DatabaseEndpoint) {
  let server: EmbeddedMariaDbServer | undefined;
  let initializing = false;
  let closing = false;
  let nextDatabase = 1;
  const sessions = new Set<ReturnType<typeof attach>>();

  function attach(endpoint: DatabaseEndpoint, database?: string) {
    const connections = new Map<number, EmbeddedMariaDbConnection>();
    const running = new Set<Promise<void>>();
    let nextConnection = 1;
    let closed = false;
    const session = { endpoint, running };
    sessions.add(session);

    async function release(predecessors: Promise<void>[]) {
      const engine = server;
      if (!engine) return;
      closed = true;
      if (endpoint === root) {
        closing = true;
        await Promise.all(
          [...sessions].flatMap((s) => (s === session ? predecessors : [...s.running])),
        );
        await engine.close();
        for (const other of sessions) {
          if (other !== session) {
            other.endpoint.postMessage({ event: "closed" }, []);
            other.endpoint.close?.();
          }
        }
        sessions.clear();
      } else {
        await Promise.all(predecessors);
        await Promise.all([...connections.values()].map((c) => c.close()));
        const admin = await engine.connect();
        try {
          await admin.query(`DROP DATABASE IF EXISTS ${database}`);
        } finally {
          await admin.close();
        }
        sessions.delete(session);
      }
      connections.clear();
    }

    // Node emits close when a test worker exits or is terminated. Browser
    // clients must close explicitly; the owner also cleans all clients at teardown.
    endpoint.addEventListener?.("close", () => {
      if (!closed && !closing) {
        const cleanup = release([...running]).catch(() => {
          // Owner shutdown is the final cleanup if the client cannot release its schema.
        });
        running.add(cleanup);
        void cleanup.finally(() => running.delete(cleanup));
      }
    });
    endpoint.onmessage = ({ data: { id, method, args } }) => {
      const predecessors = [...running];
      const operation = (async () => {
        try {
          if (closed || closing) throw new Error("database client is closed");
          let value: unknown;
          if (method === "init" && endpoint === root) {
            if (server || initializing) throw new Error("worker already initialized");
            initializing = true;
            server = await createEmbeddedMariaDb(args[0]);
          } else {
            if (!server) throw new Error("worker is not initialized");
            if (method === "attach" && endpoint === root) {
              const port = args[0] as MessagePort;
              const name = `mdb_worker_${nextDatabase++}`;
              const admin = await server.connect();
              try {
                await admin.query(`CREATE DATABASE ${name}`);
                attach(port, name);
                port.start();
              } catch (error) {
                port.close();
                throw error;
              } finally {
                await admin.close();
              }
            } else if (method === "connect") {
              const connection = await server.connect({
                ...args[0],
                database: args[0]?.database ?? database,
              });
              value = nextConnection++;
              connections.set(value as number, connection);
            } else if (method === "close") {
              await release(predecessors);
            } else {
              const connection = connections.get(args[0]);
              if (!connection) throw new Error("unknown or closed connection");
              if (method === "run") value = await connection.run(args[1], args[2]);
              else if (method === "disconnect") {
                await connection.close();
                connections.delete(args[0]);
              } else throw new Error(`unknown worker method: ${method}`);
            }
          }
          endpoint.postMessage({ id, value }, []);
          if (method === "close" && endpoint !== root) endpoint.close?.();
        } catch (error) {
          const e = error as Error & { code?: number; sqlState?: string; sql?: string };
          endpoint.postMessage(
            { id, error: { message: e.message, code: e.code, sqlState: e.sqlState, sql: e.sql } },
            [],
          );
        }
      })();
      running.add(operation);
      void operation.finally(() => running.delete(operation));
    };
    return session;
  }
  attach(root);
}
