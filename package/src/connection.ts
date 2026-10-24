/* Connection: query, prepared execute, transactions. */
import { decodeValue, describeColumn, encodeParameter } from "./result-decoder.ts";
import { MariaDbEmbeddedStateError } from "./errors.ts";
import type {
  ConversionOptions,
  EmbeddedMariaDbConnection,
  FieldMetadata,
  QueryResult,
  Row,
} from "./types.ts";
import type { WasmRuntime } from "./runtime.ts";

export class Connection implements EmbeddedMariaDbConnection {
  #runtime: WasmRuntime;
  #handle: number;
  #conversion: Required<ConversionOptions>;
  #closed = false;
  #tail: Promise<unknown> = Promise.resolve();
  #closePromise?: Promise<void>;
  #onClose: (connection: Connection) => void;

  constructor(
    runtime: WasmRuntime,
    handle: number,
    conversion: Required<ConversionOptions>,
    onClose: (connection: Connection) => void,
  ) {
    this.#runtime = runtime;
    this.#handle = handle;
    this.#conversion = conversion;
    this.#onClose = onClose;
  }

  #assertOpen() {
    if (this.#closed) throw new MariaDbEmbeddedStateError("this connection is closed");
  }

  async query(sql: string): Promise<[Row[], FieldMetadata[]]> {
    const result = await this.run(sql);
    return [result.rows, result.fields];
  }

  async execute(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<[Row[], FieldMetadata[]]> {
    const result = await this.run(sql, parameters);
    return [result.rows, result.fields];
  }

  async run(sql: string, parameters?: readonly unknown[]): Promise<QueryResult> {
    this.#assertOpen();

    // Serialize one connection, while independent connections remain concurrent.
    const operation = this.#tail.then(() =>
      parameters === undefined ? this.#runText(sql) : this.#runPrepared(sql, parameters),
    );
    this.#tail = operation.catch(() => {});
    return operation;
  }

  async #runText(sql: string): Promise<QueryResult> {
    const resultHandle = await this.#runtime.connectionQueryAsync(this.#handle, sql);

    const affectedRows = this.#runtime.affectedRows(this.#handle);
    const insertId = BigInt(this.#runtime.insertId(this.#handle));
    const warningCount = this.#runtime.warningCount(this.#handle);

    if (!resultHandle) return { rows: [], fields: [], affectedRows, insertId, warningCount };

    try {
      const { rows, fields } = this.#drain(resultHandle, sql);
      return { rows, fields, affectedRows, insertId, warningCount };
    } finally {
      this.#runtime.resultFree(resultHandle);
    }
  }

  async #runPrepared(sql: string, parameters: readonly unknown[]): Promise<QueryResult> {
    const statement = await this.#runtime.statementPrepareAsync(this.#handle, sql);

    try {
      const expected = this.#runtime.statementParamCount(statement);
      if (expected !== parameters.length) {
        throw new MariaDbEmbeddedStateError(
          `statement expects ${expected} parameter${expected === 1 ? "" : "s"}` +
            `, received ${parameters.length}`,
        );
      }

      parameters.forEach((value, index) => {
        const encoded = encodeParameter(value);
        switch (encoded.kind) {
          case "null":
            this.#runtime.bindNull(statement, index);
            break;
          case "double":
            this.#runtime.bindDouble(statement, index, encoded.value!);
            break;
          case "text":
            this.#runtime.bindBytes(statement, index, encoded.bytes!, false);
            break;
          case "binary":
            this.#runtime.bindBytes(statement, index, encoded.bytes!, true);
            break;
        }
      });

      const resultHandle = await this.#runtime.statementExecuteAsync(statement);

      const affectedRows = this.#runtime.statementAffectedRows(statement);
      const insertId = BigInt(this.#runtime.statementInsertId(statement));
      const warningCount = this.#runtime.warningCount(this.#handle);

      if (!resultHandle) return { rows: [], fields: [], affectedRows, insertId, warningCount };

      try {
        const { rows, fields } = this.#drain(resultHandle, sql);
        return { rows, fields, affectedRows, insertId, warningCount };
      } finally {
        this.#runtime.resultFree(resultHandle);
      }
    } finally {
      /* Closed even on failure: a leaked statement pins server-side state and
         would show up as a leak assertion at shutdown. */
      this.#runtime.statementClose(statement);
    }
  }

  /*
    Rows are materialised eagerly. Values live in wasm memory that the next
    mdb_result_next invalidates, so a lazy iterator would hand out references
    that expire — and JavaScript gives no way to notice. Streaming, if it is
    ever wanted, has to copy per row anyway.
  */
  #drain(resultHandle: number, sql: string): { rows: Row[]; fields: FieldMetadata[] } {
    const columnCount = this.#runtime.resultColumnCount(resultHandle);
    const fields: FieldMetadata[] = [];
    for (let i = 0; i < columnCount; i++)
      fields.push(describeColumn(this.#runtime.columnMeta(resultHandle, i)));

    const rows: Row[] = [];
    for (;;) {
      const status = this.#runtime.resultNext(resultHandle);
      if (status === 0) break;
      if (status < 0) throw this.#runtime.connectionError(this.#handle, sql);

      const row: Row = {};
      for (let i = 0; i < columnCount; i++) {
        const bytes = this.#runtime.columnValue(resultHandle, i);
        /* Duplicate column names collapse, exactly as they do in every other
           object-shaped MySQL client. Callers needing both must alias them. */
        row[fields[i].name] = decodeValue(bytes, fields[i], this.#conversion);
      }
      rows.push(row);
    }

    return { rows, fields };
  }

  async beginTransaction(): Promise<void> {
    await this.run("START TRANSACTION");
  }

  async commit(): Promise<void> {
    await this.run("COMMIT");
  }

  async rollback(): Promise<void> {
    await this.run("ROLLBACK");
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#tail.then(() => {
      this.#runtime.connectionClose(this.#handle);
      this.#onClose(this);
    });
    return this.#closePromise;
  }

  get closed(): boolean {
    return this.#closed;
  }
}
