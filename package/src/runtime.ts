/*
  Low-level binding to the wasm module: memory marshalling and one typed
  method per C ABI entry point. Everything above this file works in handles
  and JavaScript values; everything below is pointers.
*/
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MDB_OK } from "./types.ts";
import { MariaDbEmbeddedError } from "./errors.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
/* package/src -> repo root. Overridable via options.modulePath. */
const defaultDistDir = path.resolve(here, "..", "..", "dist");

export interface MdbError {
  code: number;
  sqlState: string;
  message: string;
}

interface EmscriptenModule {
  ccall(name: string, returnType: string | null, argTypes: string[], args: unknown[]): number;
  UTF8ToString(ptr: number): string;
  FS: {
    mkdirTree(path: string): void;
    mount(type: unknown, opts: unknown, mountpoint: string): void;
    unmount(mountpoint: string): void;
  };
  NODEFS: unknown;
  PThread?: { terminateAllThreads?: () => void };
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
}

const encoder = new TextEncoder();

export class WasmRuntime {
  #module: EmscriptenModule;
  #distDir: string;
  #stderr: string[] = [];
  #debug: boolean;

  private constructor(module: EmscriptenModule, distDir: string, debug: boolean) {
    this.#module = module;
    this.#distDir = distDir;
    this.#debug = debug;
  }

  static async load(options: { modulePath?: string; debug?: boolean } = {}) {
    const distDir = options.modulePath
      ? path.dirname(path.resolve(options.modulePath))
      : defaultDistDir;
    const modulePath = options.modulePath ?? path.join(distDir, "mariadb.mjs");

    const factory = (await import(modulePath)).default as (
      init: Record<string, unknown>,
    ) => Promise<EmscriptenModule>;

    const stderr: string[] = [];
    const debug = options.debug === true;

    /*
      Each call to the factory builds an independent instance with its own
      memory and its own filesystem, which is what makes one server per test
      worker possible. MariaDB's server init is process-global *within* an
      instance, so isolation has to come from having separate instances.
    */
    const module = await factory({
      printErr: (line: string) => {
        stderr.push(line);
        if (debug) console.error(`[mariadb] ${line}`);
      },
      print: (line: string) => {
        stderr.push(line);
        if (debug) console.log(`[mariadb] ${line}`);
      },
    });

    const runtime = new WasmRuntime(module, distDir, debug);
    runtime.#stderr = stderr;
    runtime.#mountStaticData();
    return runtime;
  }

  /* errmsg.sys and the charset XML are staged next to the module by
     scripts/05-link-wasm-module.sh, and mounted read-only rather than copied
     so they cost nothing per instance. */
  #mountStaticData() {
    const { FS, NODEFS } = this.#module;
    FS.mkdirTree("/mariadb/share");
    FS.mkdirTree("/mariadb/charsets");
    FS.mount(NODEFS, { root: path.join(this.#distDir, "share") }, "/mariadb/share");
    FS.mount(NODEFS, { root: path.join(this.#distDir, "charsets") }, "/mariadb/charsets");
  }

  get capturedStderr(): readonly string[] {
    return this.#stderr;
  }

  clearStderr() {
    this.#stderr.length = 0;
  }

  /* Heap views are read through getters, never cached: ALLOW_MEMORY_GROWTH
     replaces the underlying SharedArrayBuffer and Emscripten rebinds these,
     leaving any saved reference detached. */
  get #u8() {
    return this.#module.HEAPU8;
  }
  get #u32() {
    return this.#module.HEAPU32;
  }

  mkdirTree(dir: string) {
    this.#module.FS.mkdirTree(dir);
  }

  mountNodeFs(hostDirectory: string, mountpoint: string) {
    this.#module.FS.mkdirTree(mountpoint);
    this.#module.FS.mount(this.#module.NODEFS, { root: hostDirectory }, mountpoint);
  }

  terminateThreads() {
    this.#module.PThread?.terminateAllThreads?.();
  }

  /* --- memory helpers ---------------------------------------------------- */

  #allocBytes(bytes: Uint8Array): number {
    const ptr = this.#module._malloc(Math.max(bytes.length, 1));
    this.#u8.set(bytes, ptr);
    return ptr;
  }

  #free(ptr: number) {
    this.#module._free(ptr);
  }

  #call(name: string, argTypes: string[], args: unknown[]): number {
    return this.#module.ccall(name, "number", argTypes, args);
  }

  #readError(fn: string, handle: number): MdbError {
    /* mdb_error is { uint32; const char*; const char* } — 12 bytes on wasm32. */
    const ptr = this.#module._malloc(12);
    try {
      if (this.#call(fn, ["number", "number"], [handle, ptr]) !== MDB_OK)
        return { code: 0, sqlState: "HY000", message: "no error detail available" };
      const base = ptr >> 2;
      return {
        code: this.#u32[base],
        sqlState: this.#module.UTF8ToString(this.#u32[base + 1]),
        message: this.#module.UTF8ToString(this.#u32[base + 2]),
      };
    } finally {
      this.#free(ptr);
    }
  }

  /* --- runtime ----------------------------------------------------------- */

  /*
    Always the async path under wasm. Emscripten proxies filesystem syscalls
    to the main thread, and InnoDB does file I/O from background threads while
    starting up, so blocking the main thread inside mysql_server_init
    deadlocks it against the threads it is waiting for. Polling from the event
    loop keeps the main thread free to service those calls.
  */
  async initAsync(serverArgs: readonly string[], timeoutMs = 60_000) {
    const pointers = serverArgs.map((arg) =>
      this.#allocBytes(encoder.encode(arg + "\0")),
    );
    const arrayPtr = this.#module._malloc(Math.max(pointers.length * 4, 4));
    pointers.forEach((p, i) => {
      this.#u32[(arrayPtr >> 2) + i] = p;
    });

    try {
      const started = this.#call(
        "mdb_runtime_init_async",
        ["number", "number"],
        [serverArgs.length, arrayPtr],
      );
      if (started !== MDB_OK) throw this.#globalError("mdb_runtime_init_async failed");

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const poll = this.#call("mdb_runtime_init_poll", [], []);
        if (poll === 1) return;
        if (poll < 0) throw this.#globalError("MariaDB initialisation failed");
        if (Date.now() > deadline)
          throw new MariaDbEmbeddedError(
            `MariaDB initialisation did not complete within ${timeoutMs}ms.\n` +
              this.diagnostics(),
          );
        /* Yielding is the point; the delay is incidental. */
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    } finally {
      for (const p of pointers) this.#free(p);
      this.#free(arrayPtr);
    }
  }

  shutdown(): number {
    /*
      Skip MariaDB's wait for threads to finish. Exactly one thread never
      calls my_thread_end under wasm, so the wait always runs its full 5
      seconds — which would be the single largest cost in a test suite that
      creates a server per file.

      Safe here only because terminateThreads() runs immediately afterwards
      and the whole instance is then discarded. See the note on
      mdb_runtime_set_shutdown_wait_seconds in the ABI header.
    */
    this.#module.ccall(
      "mdb_runtime_set_shutdown_wait_seconds", null, ["number"], [0],
    );
    return this.#call("mdb_runtime_shutdown", [], []);
  }

  isReady(): boolean {
    return this.#call("mdb_runtime_is_ready", [], []) === 1;
  }

  liveConnections(): number {
    return this.#call("mdb_live_connections", [], []);
  }
  liveResults(): number {
    return this.#call("mdb_live_results", [], []);
  }
  liveStatements(): number {
    return this.#call("mdb_live_statements", [], []);
  }

  #globalError(fallback: string): MariaDbEmbeddedError {
    const error = this.#readError("mdb_last_global_error", 0);
    return new MariaDbEmbeddedError(
      `${error.message || fallback}\n${this.diagnostics()}`,
      { code: error.code, sqlState: error.sqlState },
    );
  }

  diagnostics(): string {
    const tail = this.#stderr.slice(-40);
    return tail.length
      ? `MariaDB output:\n  ${tail.join("\n  ")}`
      : "MariaDB produced no output.";
  }

  /* --- connections ------------------------------------------------------- */

  connectionOpen(database?: string): number {
    const ptr = database ? this.#allocBytes(encoder.encode(database + "\0")) : 0;
    try {
      const handle = this.#call("mdb_connection_open", ["number"], [ptr]);
      if (!handle) throw this.#globalError("could not open an embedded connection");
      return handle;
    } finally {
      if (ptr) this.#free(ptr);
    }
  }

  connectionClose(handle: number): number {
    return this.#call("mdb_connection_close", ["number"], [handle]);
  }

  /* Returns a result handle, or 0 for statements that produce no rows. */
  connectionQuery(handle: number, sql: string): number {
    const bytes = encoder.encode(sql);
    const sqlPtr = this.#allocBytes(bytes);
    const outPtr = this.#module._malloc(4);
    this.#u32[outPtr >> 2] = 0;

    try {
      const status = this.#call(
        "mdb_connection_query",
        ["number", "number", "number", "number"],
        [handle, sqlPtr, bytes.length, outPtr],
      );
      if (status !== MDB_OK) throw this.connectionError(handle, sql);
      return this.#u32[outPtr >> 2];
    } finally {
      this.#free(sqlPtr);
      this.#free(outPtr);
    }
  }

  connectionError(handle: number, sql?: string): MariaDbEmbeddedError {
    const error = this.#readError("mdb_connection_last_error", handle);
    return new MariaDbEmbeddedError(error.message || "MariaDB reported an error", {
      code: error.code,
      sqlState: error.sqlState,
      sql,
    });
  }

  affectedRows(handle: number): number {
    return this.#call("mdb_connection_affected_rows", ["number"], [handle]);
  }
  insertId(handle: number): number {
    return this.#call("mdb_connection_insert_id", ["number"], [handle]);
  }
  warningCount(handle: number): number {
    return this.#call("mdb_connection_warning_count", ["number"], [handle]);
  }

  /* --- results ----------------------------------------------------------- */

  resultColumnCount(handle: number): number {
    return this.#call("mdb_result_column_count", ["number"], [handle]);
  }

  resultNext(handle: number): number {
    return this.#call("mdb_result_next", ["number"], [handle]);
  }

  resultFree(handle: number) {
    this.#module.ccall("mdb_result_free", null, ["number"], [handle]);
  }

  columnMeta(handle: number, index: number) {
    const namePtr = this.#call("mdb_result_column_name", ["number", "number"], [handle, index]);
    return {
      name: namePtr ? this.#module.UTF8ToString(namePtr) : `col_${index}`,
      type: this.#call("mdb_result_column_type", ["number", "number"], [handle, index]),
      flags: this.#call("mdb_result_column_flags", ["number", "number"], [handle, index]),
      decimals: this.#call("mdb_result_column_decimals", ["number", "number"], [handle, index]),
      charsetnr: this.#call("mdb_result_column_charsetnr", ["number", "number"], [handle, index]),
    };
  }

  /* Returns null for SQL NULL, which is distinct from a zero-length value. */
  columnValue(handle: number, index: number): Uint8Array | null {
    if (this.#call("mdb_result_value_is_null", ["number", "number"], [handle, index]))
      return null;

    const ptr = this.#call("mdb_result_value_data", ["number", "number"], [handle, index]);
    const length = this.#call("mdb_result_value_length", ["number", "number"], [handle, index]);
    if (!ptr) return null;

    /* slice, not subarray: the caller keeps this past the next heap growth,
       which would detach a view onto wasm memory. */
    return this.#u8.slice(ptr, ptr + length);
  }

  /* --- statements -------------------------------------------------------- */

  statementPrepare(connection: number, sql: string): number {
    const bytes = encoder.encode(sql);
    const ptr = this.#allocBytes(bytes);
    try {
      const handle = this.#call(
        "mdb_statement_prepare",
        ["number", "number", "number"],
        [connection, ptr, bytes.length],
      );
      if (!handle) throw this.connectionError(connection, sql);
      return handle;
    } finally {
      this.#free(ptr);
    }
  }

  statementParamCount(handle: number): number {
    return this.#call("mdb_statement_param_count", ["number"], [handle]);
  }

  bindNull(handle: number, index: number) {
    this.#call("mdb_statement_bind_null", ["number", "number"], [handle, index]);
  }

  /*
    Deliberately no bindInt64/bindUint64 here.

    Emscripten legalizes an i64 parameter into two i32s, and ccall's "number"
    marshalling knows nothing about that — a BigInt would arrive truncated,
    which is the precise failure the lossless defaults exist to prevent. The
    C ABI keeps those entry points for native callers, where they are safe.

    Integers are bound as text instead and parsed by the server in the
    column's own type. That is what the text protocol does anyway, so it is
    exact for BIGINT and DECIMAL alike, and it keeps prepared and plain
    statements agreeing.
  */

  bindDouble(handle: number, index: number, value: number) {
    this.#call(
      "mdb_statement_bind_double",
      ["number", "number", "number"],
      [handle, index, value],
    );
  }

  bindBytes(handle: number, index: number, bytes: Uint8Array, binary: boolean) {
    const ptr = this.#allocBytes(bytes);
    try {
      this.#call(
        binary ? "mdb_statement_bind_blob" : "mdb_statement_bind_string",
        ["number", "number", "number", "number"],
        [handle, index, ptr, bytes.length],
      );
    } finally {
      this.#free(ptr);
    }
  }

  statementExecute(handle: number): number {
    const outPtr = this.#module._malloc(4);
    this.#u32[outPtr >> 2] = 0;
    try {
      const status = this.#call(
        "mdb_statement_execute",
        ["number", "number"],
        [handle, outPtr],
      );
      if (status !== MDB_OK) throw this.statementError(handle);
      return this.#u32[outPtr >> 2];
    } finally {
      this.#free(outPtr);
    }
  }

  statementError(handle: number, sql?: string): MariaDbEmbeddedError {
    const error = this.#readError("mdb_statement_last_error", handle);
    return new MariaDbEmbeddedError(error.message || "MariaDB reported an error", {
      code: error.code,
      sqlState: error.sqlState,
      sql,
    });
  }

  statementAffectedRows(handle: number): number {
    return this.#call("mdb_statement_affected_rows", ["number"], [handle]);
  }
  statementInsertId(handle: number): number {
    return this.#call("mdb_statement_insert_id", ["number"], [handle]);
  }
  statementClose(handle: number): number {
    return this.#call("mdb_statement_close", ["number"], [handle]);
  }
}
