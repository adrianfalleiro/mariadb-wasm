import { MariaDbEmbeddedError } from "./errors.ts";
import type { QueryResult } from "./types.ts";

export interface DatabaseEndpoint {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  close?(): void;
  addEventListener?(type: string, listener: () => void): void;
  onerror?: ((event: ErrorEvent) => void) | null;
}

// Shared by dedicated browser workers and transferred Node/browser ports.
export function createWorkerClient(worker: DatabaseEndpoint, dispose: () => void) {
  let nextId = 1;
  let stopped = false;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  function stop(error: Error) {
    if (stopped) return;
    stopped = true;
    dispose();
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  worker.onerror = (event) => stop(new Error(event.message || "database worker failed"));
  worker.onmessageerror = () => stop(new Error("database worker response could not be decoded"));
  worker.onmessage = ({ data }) => {
    if (data.event === "closed") {
      stop(new Error("database host is closed"));
      return;
    }
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new MariaDbEmbeddedError(data.error.message, data.error));
    else request.resolve(data.value);
  };
  function call(method: string, ...args: unknown[]): Promise<any> {
    if (stopped) return Promise.reject(new Error("database worker is closed"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage(
          { id, method, args },
          method === "attach" ? [args[0] as MessagePort] : [],
        );
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }
  return {
    call,
    stop,
    async createClientPort() {
      if (closing) throw new Error("database worker is closing");
      const { port1, port2 } = new MessageChannel();
      try {
        await call("attach", port2);
        return port1;
      } catch (error) {
        port1.close();
        port2.close();
        throw error;
      }
    },
    async connect(options: { database?: string } = {}) {
      if (closing) throw new Error("database worker is closing");
      const handle = await call("connect", options);
      let closed = false;
      let end: Promise<void> | undefined;
      const run = (sql: string, params?: readonly unknown[]): Promise<QueryResult> => {
        if (closed || closing) return Promise.reject(new Error("connection is closed"));
        return call("run", handle, sql, params);
      };
      return {
        run,
        async query(sql: string) {
          const result = await run(sql);
          return [result.rows, result.fields] as const;
        },
        async execute(sql: string, params: readonly unknown[] = []) {
          const result = await run(sql, params);
          return [result.rows, result.fields] as const;
        },
        async beginTransaction() {
          await run("START TRANSACTION");
        },
        async commit() {
          await run("COMMIT");
        },
        async rollback() {
          await run("ROLLBACK");
        },
        close() {
          closed = true;
          return (end ??= call("disconnect", handle));
        },
      };
    },
    close(): Promise<void> {
      closing = true;
      return (closePromise ??= call("close").finally(() =>
        stop(new Error("database worker is closed")),
      ));
    },
  };
}

export function connectDatabasePort(port: MessagePort) {
  const client = createWorkerClient(port, () => port.close());
  port.start();
  return { connect: client.connect, close: client.close };
}
