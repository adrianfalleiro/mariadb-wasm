import { Buffer } from "buffer";
import SqlString from "sqlstring";
import { errorNames } from "./error-names.ts";
import { FieldType } from "./types.ts";
import type { QueryResult, EmbeddedMariaDbOptions } from "./types.ts";

interface EngineConnection {
  run(sql: string, parameters?: readonly unknown[]): Promise<QueryResult>;
  close(): Promise<void>;
}
export interface DriverServer {
  connect(options?: { database?: string }): Promise<EngineConnection>;
  close(): Promise<void>;
}
export interface DriverOptions {
  server?: DriverServer;
  database?: string;
  dateStrings?: boolean;
  supportBigNumbers?: boolean;
  bigNumberStrings?: boolean;
  decimalNumbers?: boolean;
  bigIntAsNumber?: boolean;
  insertIdAsNumber?: boolean;
  timezone?: "Z";
  engine?: EmbeddedMariaDbOptions;
}

export async function connectDriver(kind: "mysql2" | "mariadb", options: DriverOptions = {}) {
  const supported = new Set([
    "server",
    "database",
    "dateStrings",
    "supportBigNumbers",
    "bigNumberStrings",
    "decimalNumbers",
    "bigIntAsNumber",
    "insertIdAsNumber",
    "timezone",
    "engine",
  ]);
  for (const name of Object.keys(options)) {
    if (!supported.has(name)) throw new Error(`Unsupported embedded driver option: ${name}`);
  }
  if (options.timezone && options.timezone !== "Z")
    throw new Error("Only UTC (timezone: Z) is supported");
  const owned = !options.server;
  const server =
    options.server ??
    (typeof process !== "undefined" && process.versions?.node
      ? await (await import("./server.ts")).createEmbeddedMariaDb(options.engine)
      : await (await import("./browser.ts")).createDatabaseWorker(options.engine));
  let connection: EngineConnection;
  try {
    connection = await server.connect({ database: options.database });
  } catch (error) {
    if (owned) await server.close();
    throw driverError(error);
  }
  let end: Promise<void> | undefined;
  const bigint = (value: unknown) => {
    const text = String(value);
    if (kind === "mariadb") return options.bigIntAsNumber ? Number(text) : BigInt(text);
    if (!options.supportBigNumbers) return Number(text);
    return options.bigNumberStrings || !Number.isSafeInteger(Number(text)) ? text : Number(text);
  };
  async function run(sql: string, values: readonly unknown[] | undefined, prepared: boolean) {
    try {
      if (typeof sql !== "string") throw new TypeError("SQL must be a string");
      if (values !== undefined && !Array.isArray(values))
        throw new TypeError("parameters must be an array");
      if (values?.some((value) => value === undefined))
        throw new TypeError("Use null instead of undefined in parameters");
      // sqlstring uses Buffer.isBuffer; Uint8Array is the browser representation.
      const textValues = values?.map((value) =>
        value instanceof Uint8Array
          ? SqlString.raw(
              "X'" + Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("") + "'",
            )
          : typeof value === "bigint"
            ? SqlString.raw(String(value))
            : value,
      );
      const result = await connection.run(
        prepared ? sql : SqlString.format(sql, textValues, false, "Z"),
        prepared ? (values ?? []) : undefined,
      );
      if (!result.fields.length) {
        const header = {
          affectedRows: Number(result.affectedRows),
          insertId:
            kind === "mariadb"
              ? options.insertIdAsNumber
                ? Number(result.insertId)
                : result.insertId
              : Number.isSafeInteger(Number(result.insertId))
                ? Number(result.insertId)
                : String(result.insertId),
          warningStatus: result.warningCount,
        };
        return kind === "mysql2" ? [header, undefined] : header;
      }
      const rows = result.rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const field of result.fields) {
          let value = row[field.name];
          if (value !== null) {
            if (field.json) value = JSON.parse(String(value));
            else if (field.type === FieldType.LONGLONG) value = bigint(value);
            else if (
              options.decimalNumbers &&
              ([FieldType.DECIMAL, FieldType.NEWDECIMAL] as number[]).includes(field.type)
            )
              value = Number(value);
            else if (
              !options.dateStrings &&
              ([FieldType.DATE, FieldType.DATETIME, FieldType.TIMESTAMP] as number[]).includes(
                field.type,
              )
            ) {
              const text = String(value);
              value = new Date(
                text.length === 10 ? text + "T00:00:00Z" : text.replace(" ", "T") + "Z",
              );
            }
          }
          if (value instanceof Uint8Array) value = Buffer.from(value);
          Object.defineProperty(out, field.name, {
            value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        return out;
      });
      const fields = result.fields.map((field) => ({
        ...field,
        columnType: field.type,
        characterSet: field.charsetnr,
      }));
      if (kind === "mysql2") return [rows, fields];
      Object.defineProperty(rows, "meta", { value: fields, enumerable: false });
      return rows;
    } catch (error) {
      throw driverError(error, sql);
    }
  }
  return {
    query: (sql: string, values?: readonly unknown[]) => run(sql, values, false),
    execute: (sql: string, values: readonly unknown[] = []) => run(sql, values, true),
    async beginTransaction() {
      await run("START TRANSACTION", undefined, false);
    },
    async commit() {
      await run("COMMIT", undefined, false);
    },
    async rollback() {
      await run("ROLLBACK", undefined, false);
    },
    end() {
      return (end ??= connection.close().finally(async () => {
        if (owned) await server.close();
      }));
    },
  };
}

function driverError(error: unknown, sql?: string): unknown {
  const original = error as Error & { code?: number; sqlState?: string };
  if (typeof original.code !== "number" || original.code === 0) return error;
  return Object.assign(new Error(original.message), {
    code: errorNames[original.code],
    errno: original.code,
    sqlState: original.sqlState,
    sqlMessage: original.message,
    sql,
    fatal: false,
  });
}
