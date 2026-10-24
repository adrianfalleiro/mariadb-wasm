import { EventEmitter } from "events";
import { connectDriver } from "./driver.ts";
import type { DriverOptions } from "./driver.ts";

type Callback = (error: Error | null, rows?: any, fields?: any) => void;
type Sql = string | { sql: string; values?: readonly unknown[] };

// Both callback APIs share the Promise driver's binding, conversion and error rules.
export function connectCallbackDriver(kind: "mysql2" | "mariadb", options: DriverOptions = {}) {
  const connection = new EventEmitter();
  let closing = false;
  let closeResult: Promise<void> | undefined;
  const stream = { destroyed: false }; // Knex uses this solely as a liveness check.
  const ready = connectDriver(kind, options);
  // Creation starts connecting immediately, but errors are delivered through connect/query.
  void ready.catch(() => {});
  let tail: Promise<unknown> = ready;
  function enqueue<T>(operation: (driver: Awaited<typeof ready>) => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new Error("connection is closed"));
    const result = tail
      .catch(() => {})
      .then(() => ready)
      .then(operation);
    tail = result;
    // A caller may subscribe through events on the returned command instead of a Promise.
    void result.catch(() => {});
    return result;
  }
  function deliver(result: Promise<unknown>, callback: Callback) {
    void result.then(
      (value) => queueMicrotask(() => callback(null, value)),
      (error) => queueMicrotask(() => callback(error as Error)),
    );
  }
  function command(
    method: "query" | "execute",
    sql: Sql,
    values?: readonly unknown[] | Callback,
    cb?: Callback,
  ) {
    const callback = typeof values === "function" ? values : cb;
    const command = new EventEmitter();
    const result = enqueue(async (driver) => {
      if (typeof sql !== "string") {
        for (const key of Object.keys(sql)) {
          if (key !== "sql" && key !== "values")
            throw new Error(`Unsupported query option: ${key}`);
        }
      }
      const parameters = Array.isArray(values)
        ? values
        : typeof sql === "string"
          ? undefined
          : sql.values;
      return driver[method](typeof sql === "string" ? sql : sql.sql, parameters);
    });
    void result.then(
      (value) =>
        queueMicrotask(() => {
          const rows = kind === "mysql2" ? (value as any)[0] : value;
          const fields = kind === "mysql2" ? (value as any)[1] : (value as any).meta;
          if (callback) callback(null, rows, fields);
          else {
            if (fields) command.emit("fields", fields);
            if (Array.isArray(rows)) for (const row of rows) command.emit("result", row);
            else command.emit("result", rows);
            command.emit("end");
          }
        }),
      (error) =>
        queueMicrotask(() => {
          if (callback) callback(error as Error);
          else command.emit("error", error);
        }),
    );
    return command;
  }
  const api = Object.assign(connection, {
    stream,
    state: "connecting",
    connect(callback: Callback) {
      deliver(ready, (error) => {
        if (!error && !closing) api.state = "authenticated";
        callback(error);
      });
    },
    query: (sql: Sql, values?: readonly unknown[] | Callback, callback?: Callback) =>
      command("query", sql, values, callback),
    execute: (sql: Sql, values?: readonly unknown[] | Callback, callback?: Callback) =>
      command("execute", sql, values, callback),
    beginTransaction(callback: Callback) {
      deliver(
        enqueue((driver) => driver.beginTransaction()),
        callback,
      );
    },
    commit(callback: Callback) {
      deliver(
        enqueue((driver) => driver.commit()),
        callback,
      );
    },
    rollback(callback: Callback) {
      deliver(
        enqueue((driver) => driver.rollback()),
        callback,
      );
    },
    isValid() {
      return !closing;
    },
    end(
      callback: Callback = (error) => {
        if (error) connection.emit("error", error);
      },
    ) {
      closing = true;
      closeResult ??= tail
        .catch(() => {})
        .then(() => ready)
        .then((driver) => driver.end())
        .finally(() => {
          stream.destroyed = true;
          api.state = "disconnected";
        });
      deliver(closeResult, callback);
    },
  });
  return api;
}
