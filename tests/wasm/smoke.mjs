/*
  Phase 9/10: drive the wasm module from Node through the same C ABI the
  native abi_smoke.c uses, running the same scenario.

  Intentionally raw — no TypeScript package, no worker, no abstraction. When
  the first InnoDB-under-wasm failure happens, the stack should be
  Node -> ccall -> MariaDB and nothing else, so there is no question about
  which layer broke.
*/
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(here, "..", "..", "dist", "mariadb.mjs");

let failures = 0;
const fail = (msg) => {
  console.log(`  FAIL ${msg}`);
  failures++;
};
const ok = (what) => console.log(`  ok   ${what}`);

/* Mirrors mdb_status in native/include/mariadb_wasm.h. */
const MDB_OK = 0;
const MDB_ERR_MYSQL = 1;
const MDB_ERR_BAD_HANDLE = 2;
const MDB_ERR_BAD_STATE = 3;

const createModule = (await import(modulePath)).default;

const stderrLines = [];

/* MariaDB's startup complaints are diagnostics, not failures, so they are
   buffered and only dumped if something goes wrong — except under MDB_DEBUG,
   where they stream. Buffering is useless for diagnosing a hang, which is
   precisely when the last line before the stall is the thing worth seeing. */
const debug = process.env.MDB_DEBUG === "1";
const Module = await createModule({
  printErr: (line) => {
    stderrLines.push(line);
    if (debug) console.error(`[mariadb] ${line}`);
  },
});

const { ccall, UTF8ToString, FS, NODEFS, _malloc, _free } = Module;

/*
  The heap views must NOT be destructured. With ALLOW_MEMORY_GROWTH the
  SharedArrayBuffer is replaced on every growth and Emscripten rebinds
  Module.HEAPU8/HEAPU32 to fresh views; anything captured earlier is left
  pointing at a detached buffer. MariaDB grows the heap several times during
  mysql_server_init alone (128MB -> ~412MB with a 16MB buffer pool), so a
  cached view survives exactly until the first query and then throws
  "offset is out of bounds".
*/
const u8 = () => Module.HEAPU8;
const u32 = () => Module.HEAPU32;

/* The server's static data lives on the host and is mounted read-only rather
   than bundled, so a rebuild of errmsg.sys does not require relinking the
   module. The datadir itself stays on MEMFS — see below. */
const wasmBuild = path.join(here, "..", "..", "build", "wasm");
const sourceTree = path.join(here, "..", "..", "mariadb");

FS.mkdirTree("/mariadb/share");
FS.mkdirTree("/mariadb/charsets");
FS.mount(NODEFS, { root: path.join(wasmBuild, "sql", "share") }, "/mariadb/share");
FS.mount(NODEFS, { root: path.join(sourceTree, "sql", "share", "charsets") }, "/mariadb/charsets");

/* --- small helpers over the ABI ------------------------------------------ */

const allocations = [];

function allocCString(value) {
  const bytes = new TextEncoder().encode(value);
  const ptr = _malloc(bytes.length + 1);
  u8().set(bytes, ptr);
  u8()[ptr + bytes.length] = 0;
  allocations.push(ptr);
  return ptr;
}

/* const char *const * — an array of pointers, so two allocations deep. */
function allocCStringArray(values) {
  const pointers = values.map(allocCString);
  const arrayPtr = _malloc(pointers.length * 4); /* wasm32: 4-byte pointers */
  allocations.push(arrayPtr);
  pointers.forEach((p, i) => {
    u32()[(arrayPtr >> 2) + i] = p;
  });
  return arrayPtr;
}

function freeAll() {
  for (const ptr of allocations) _free(ptr);
  allocations.length = 0;
}

const call = (name, returnType, argTypes, args) => ccall(name, returnType, argTypes, args);

/* mdb_error is { uint32 code; const char *sql_state; const char *message; },
   so 12 bytes on wasm32. */
function readError(fn, handle) {
  const errPtr = _malloc(12);
  try {
    if (call(fn, "number", ["number", "number"], [handle, errPtr]) !== MDB_OK)
      return { code: 0, sqlState: "", message: "(no detail)" };
    return {
      code: u32()[errPtr >> 2],
      sqlState: UTF8ToString(u32()[(errPtr >> 2) + 1]),
      message: UTF8ToString(u32()[(errPtr >> 2) + 2]),
    };
  } finally {
    _free(errPtr);
  }
}

const connectionError = (conn) => readError("mdb_connection_last_error", conn);

function query(conn, sql) {
  const sqlBytes = new TextEncoder().encode(sql);
  const sqlPtr = _malloc(sqlBytes.length);
  u8().set(sqlBytes, sqlPtr);
  const outPtr = _malloc(4);
  u32()[outPtr >> 2] = 0;

  try {
    const status = call(
      "mdb_connection_query",
      "number",
      ["number", "number", "number", "number"],
      [conn, sqlPtr, sqlBytes.length, outPtr],
    );
    return { status, result: u32()[outPtr >> 2] };
  } finally {
    _free(sqlPtr);
    _free(outPtr);
  }
}

function exec(conn, sql, what) {
  const { status, result } = query(conn, sql);
  if (status !== MDB_OK) {
    const e = connectionError(conn);
    fail(`${what ?? sql}: ${e.code}/${e.sqlState} ${e.message}`);
    return false;
  }
  if (result) call("mdb_result_free", null, ["number"], [result]);
  if (what) ok(what);
  return true;
}

/* Reads cell (row, 0) as bytes. Uses the length, never NUL-termination. */
function scalar(conn, sql) {
  const { status, result } = query(conn, sql);
  if (status !== MDB_OK || !result) return null;

  try {
    if (call("mdb_result_next", "number", ["number"], [result]) !== 1) return null;
    if (call("mdb_result_value_is_null", "number", ["number", "number"], [result, 0])) return null;

    const dataPtr = call("mdb_result_value_data", "number", ["number", "number"], [result, 0]);
    const length = call("mdb_result_value_length", "number", ["number", "number"], [result, 0]);
    /* Copy before anything else touches the heap — a growth would detach it. */
    return new TextDecoder().decode(u8().slice(dataPtr, dataPtr + length));
  } finally {
    call("mdb_result_free", null, ["number"], [result]);
  }
}

function expectScalar(conn, sql, want, what) {
  const got = scalar(conn, sql);
  if (got !== want) fail(`${what}: expected ${want}, got ${got}`);
  else ok(what);
}

/* --- the scenario -------------------------------------------------------- */

const datadir = "/runtime/instance-0";
FS.mkdirTree(datadir);
ok("MEMFS datadir created");

/* The datadir is empty and lives on MEMFS: InnoDB bootstraps its own system
   tablespace, as the native reference demonstrated, so no packaged template is
   needed for this milestone. */
const serverArgs = [
  "--no-defaults",
  "--skip-grant-tables",
  "--skip-networking",
  "--performance-schema=OFF",
  "--max-connections=20",
  "--innodb-buffer-pool-size=16M",
  `--datadir=${datadir}`,
  "--lc-messages-dir=/mariadb/share",
  "--character-sets-dir=/mariadb/charsets",
];

/*
  Initialisation runs on its own thread and we poll from the event loop rather
  than calling mdb_runtime_init directly.

  Emscripten keeps MEMFS in the main thread's JavaScript heap, so 54 syscalls
  in a threaded build are proxied to the main thread when a pthread makes them.
  InnoDB opens and writes its system tablespace and redo logs from background
  threads during startup. Blocking the main thread inside mysql_server_init
  therefore deadlocks it against the very threads it is waiting for — which is
  what made startup a coin flip. Returning to the event loop between polls lets
  those proxied calls be serviced.
*/
const argvPtr = allocCStringArray(serverArgs);
let initStatus = call(
  "mdb_runtime_init_async",
  "number",
  ["number", "number"],
  [serverArgs.length, argvPtr],
);

if (initStatus === MDB_OK) {
  const deadlineMs = Date.now() + 60_000;
  for (;;) {
    const poll = call("mdb_runtime_init_poll", "number", []);
    if (poll === 1) {
      initStatus = MDB_OK;
      break;
    }
    if (poll < 0) {
      initStatus = -poll;
      break;
    }
    if (Date.now() > deadlineMs) {
      console.log("  FAIL initialisation did not finish within 60s");
      initStatus = MDB_ERR_BAD_STATE;
      break;
    }
    /* Yielding to the event loop is the point, not the delay. */
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
freeAll();

if (initStatus !== MDB_OK) {
  const e = readError("mdb_last_global_error", 0);
  console.log(`  FAIL mdb_runtime_init -> ${initStatus}: ${e.message}`);
  console.log("--- captured stderr ---");
  for (const line of stderrLines) console.log(line);
  process.exit(1);
}
ok("mdb_runtime_init");

const conn = call("mdb_connection_open", "number", ["number"], [0]);
if (!conn) {
  const e = readError("mdb_last_global_error", 0);
  console.log(`  FAIL mdb_connection_open: ${e.message}`);
  console.log("--- captured stderr ---");
  for (const line of stderrLines) console.log(line);
  process.exit(1);
}
ok("mdb_connection_open");

expectScalar(conn, "SELECT 1", "1", "SELECT 1");

exec(conn, "CREATE DATABASE IF NOT EXISTS wasm_test", "CREATE DATABASE");
exec(conn, "USE wasm_test", "USE wasm_test");

exec(
  conn,
  `CREATE TABLE users (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     email VARCHAR(255) NOT NULL,
     balance DECIMAL(20,4) NOT NULL DEFAULT 0,
     payload VARBINARY(255),
     created_at DATETIME(6) NOT NULL,
     PRIMARY KEY (id),
     UNIQUE KEY uq_users_email (email)
   ) ENGINE=InnoDB`,
  "CREATE TABLE ... ENGINE=InnoDB",
);

expectScalar(
  conn,
  "SELECT ENGINE FROM information_schema.TABLES" +
    " WHERE TABLE_SCHEMA='wasm_test' AND TABLE_NAME='users'",
  "InnoDB",
  "table engine is InnoDB",
);

exec(
  conn,
  "INSERT INTO users(email, balance, payload, created_at) VALUES" +
    " ('a@example.com', 10.2500, X'000102FF', '2026-01-02 03:04:05.123456')",
  "INSERT",
);

expectScalar(
  conn,
  "SELECT balance FROM users WHERE id=1",
  "10.2500",
  "DECIMAL(20,4) round-trips exactly",
);
expectScalar(
  conn,
  "SELECT HEX(payload) FROM users WHERE id=1",
  "000102FF",
  "VARBINARY with embedded NUL round-trips",
);
expectScalar(
  conn,
  "SELECT created_at FROM users WHERE id=1",
  "2026-01-02 03:04:05.123456",
  "DATETIME(6) keeps microseconds",
);

exec(conn, "START TRANSACTION", "START TRANSACTION");
exec(conn, "UPDATE users SET balance = 99.0000 WHERE id=1");
expectScalar(
  conn,
  "SELECT balance FROM users WHERE id=1",
  "99.0000",
  "UPDATE visible inside transaction",
);
exec(conn, "ROLLBACK", "ROLLBACK");
expectScalar(
  conn,
  "SELECT balance FROM users WHERE id=1",
  "10.2500",
  "ROLLBACK restored the original value",
);

exec(conn, "START TRANSACTION", "START TRANSACTION (commit path)");
exec(conn, "UPDATE users SET balance = 55.0000 WHERE id=1");
exec(conn, "COMMIT", "COMMIT");
expectScalar(conn, "SELECT balance FROM users WHERE id=1", "55.0000", "COMMIT persisted the value");

{
  const dup = "INSERT INTO users(email, created_at) VALUES ('a@example.com', NOW(6))";
  const { status } = query(conn, dup);
  if (status === MDB_OK) fail("duplicate key insert unexpectedly succeeded");
  else {
    const e = connectionError(conn);
    if (e.code !== 1062 || e.sqlState !== "23000")
      fail(`duplicate key: expected 1062/23000, got ${e.code}/${e.sqlState}`);
    else ok("duplicate key -> errno 1062, SQLSTATE 23000");
  }
}

/* Prepared statements: bound through MariaDB's statement API, never by
   interpolating into SQL text. */
{
  const sql = "INSERT INTO users(email, balance, payload, created_at)" + " VALUES (?, ?, ?, ?)";
  const sqlBytes = new TextEncoder().encode(sql);
  const sqlPtr = _malloc(sqlBytes.length);
  u8().set(sqlBytes, sqlPtr);

  const stmt = call(
    "mdb_statement_prepare",
    "number",
    ["number", "number", "number"],
    [conn, sqlPtr, sqlBytes.length],
  );
  _free(sqlPtr);

  if (!stmt) fail("mdb_statement_prepare");
  else {
    ok("mdb_statement_prepare");

    if (call("mdb_statement_param_count", "number", ["number"], [stmt]) !== 4)
      fail("param_count should be 4");
    else ok("param_count == 4");

    const bindText = (index, text, fn = "mdb_statement_bind_string") => {
      const bytes = new TextEncoder().encode(text);
      const ptr = _malloc(bytes.length);
      u8().set(bytes, ptr);
      call(
        fn,
        "number",
        ["number", "number", "number", "number"],
        [stmt, index, ptr, bytes.length],
      );
      _free(ptr);
    };

    bindText(0, "d@example.com");
    bindText(1, "98765.4321"); /* DECIMAL as text, never a double */
    {
      const blob = new Uint8Array([0x00, 0x01, 0x02, 0xff]);
      const ptr = _malloc(blob.length);
      u8().set(blob, ptr);
      call(
        "mdb_statement_bind_blob",
        "number",
        ["number", "number", "number", "number"],
        [stmt, 2, ptr, blob.length],
      );
      _free(ptr);
    }
    bindText(3, "2026-03-04 05:06:07.891011");

    if (call("mdb_statement_execute", "number", ["number", "number"], [stmt, 0]) !== MDB_OK)
      fail("mdb_statement_execute");
    else ok("mdb_statement_execute (bound INSERT)");

    call("mdb_statement_close", "number", ["number"], [stmt]);
  }
}

/*
  The same thing through the non-blocking statement ABI.

  Kept alongside the synchronous block rather than replacing it: the two paths
  must agree, and the synchronous one is what the native reference and the
  differential runner drive. This is the wasm-only half — prepare and execute
  each run on their own thread so the main thread stays free to service
  MariaDB's proxied filesystem syscalls.
*/
{
  const sql = "INSERT INTO users(email, balance, payload, created_at)" + " VALUES (?, ?, ?, ?)";
  const sqlBytes = new TextEncoder().encode(sql);
  const sqlPtr = _malloc(sqlBytes.length);
  u8().set(sqlBytes, sqlPtr);

  const submitted = call(
    "mdb_statement_prepare_async",
    "number",
    ["number", "number", "number"],
    [conn, sqlPtr, sqlBytes.length],
  );

  /* Submitting a second call while one is in flight must be refused rather
     than corrupting the protocol state on the shared MYSQL. */
  const second = call(
    "mdb_statement_prepare_async",
    "number",
    ["number", "number", "number"],
    [conn, sqlPtr, sqlBytes.length],
  );
  if (second !== MDB_ERR_BAD_STATE)
    fail(`a second in-flight call should be refused, got ${second}`);
  else ok("a second call on a busy connection is refused");

  const busyClose = call("mdb_connection_close", "number", ["number"], [conn]);
  if (busyClose !== MDB_ERR_BAD_STATE)
    fail(`closing a busy connection should be refused, got ${busyClose}`);
  else ok("closing a busy connection is refused without losing its handle");

  _free(sqlPtr);

  let stmt = 0;
  if (submitted !== MDB_OK) fail("mdb_statement_prepare_async");
  else {
    const outPtr = _malloc(4);
    u32()[outPtr >> 2] = 0;
    for (;;) {
      const poll = call(
        "mdb_statement_prepare_poll",
        "number",
        ["number", "number"],
        [conn, outPtr],
      );
      if (poll === 1) {
        stmt = u32()[outPtr >> 2];
        break;
      }
      if (poll < 0) {
        fail(`mdb_statement_prepare_poll -> ${poll}`);
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    _free(outPtr);
  }

  if (!stmt) fail("mdb_statement_prepare_async produced no statement");
  else {
    ok("mdb_statement_prepare_async");

    const bindText = (index, text, fn = "mdb_statement_bind_string") => {
      const bytes = new TextEncoder().encode(text);
      const ptr = _malloc(bytes.length);
      u8().set(bytes, ptr);
      call(
        fn,
        "number",
        ["number", "number", "number", "number"],
        [stmt, index, ptr, bytes.length],
      );
      _free(ptr);
    };

    bindText(0, "e@example.com");
    bindText(1, "13579.2468");
    {
      const blob = new Uint8Array([0xff, 0x00, 0x10]);
      const ptr = _malloc(blob.length);
      u8().set(blob, ptr);
      call(
        "mdb_statement_bind_blob",
        "number",
        ["number", "number", "number", "number"],
        [stmt, 2, ptr, blob.length],
      );
      _free(ptr);
    }
    bindText(3, "2026-07-08 09:10:11.121314");

    if (call("mdb_statement_execute_async", "number", ["number"], [stmt]) !== MDB_OK) {
      fail("mdb_statement_execute_async");
    } else {
      const outPtr = _malloc(4);
      u32()[outPtr >> 2] = 0;
      let done = false;
      for (;;) {
        const poll = call(
          "mdb_statement_execute_poll",
          "number",
          ["number", "number"],
          [stmt, outPtr],
        );
        if (poll === 1) {
          done = true;
          break;
        }
        if (poll < 0) {
          fail(`mdb_statement_execute_poll -> ${poll}`);
          break;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      const produced = u32()[outPtr >> 2];
      if (produced) call("mdb_result_free", null, ["number"], [produced]);
      _free(outPtr);
      if (done) ok("mdb_statement_execute_async (bound INSERT)");
    }

    call("mdb_statement_close", "number", ["number"], [stmt]);
  }
}

expectScalar(
  conn,
  "SELECT balance FROM users WHERE email='e@example.com'",
  "13579.2468",
  "async-bound DECIMAL stored exactly",
);
expectScalar(
  conn,
  "SELECT HEX(payload) FROM users WHERE email='e@example.com'",
  "FF0010",
  "async-bound binary parameter survived",
);
expectScalar(
  conn,
  "SELECT created_at FROM users WHERE email='e@example.com'",
  "2026-07-08 09:10:11.121314",
  "async-bound DATETIME(6) kept microseconds",
);

expectScalar(
  conn,
  "SELECT balance FROM users WHERE email='d@example.com'",
  "98765.4321",
  "bound DECIMAL stored exactly",
);
expectScalar(
  conn,
  "SELECT HEX(payload) FROM users WHERE email='d@example.com'",
  "000102FF",
  "bound binary parameter kept its NUL byte",
);
expectScalar(
  conn,
  "SELECT created_at FROM users WHERE email='d@example.com'",
  "2026-03-04 05:06:07.891011",
  "bound DATETIME(6) kept microseconds",
);

if (call("mdb_live_statements", "number", []) !== 0) fail("leaked statements");
else ok("no leaked statements");

if (call("mdb_connection_close", "number", ["number"], [conn]) !== MDB_OK)
  fail("mdb_connection_close");
else ok("mdb_connection_close");

/*
  Shut down with MariaDB's real thread wait in place — this test never calls
  mdb_runtime_set_shutdown_wait_seconds. Every thread the wrapper starts pairs
  mysql_thread_init with mysql_thread_end, so the count reaches zero and the
  wait returns immediately. If one does not, my_thread_global_end burns its
  full five seconds and says so on stderr, which is the only place it reports.
*/
const shutdownStarted = Date.now();
if (call("mdb_runtime_shutdown", "number", []) !== MDB_OK) fail("mdb_runtime_shutdown");
else ok("mdb_runtime_shutdown");
const shutdownMs = Date.now() - shutdownStarted;

if (stderrLines.some((line) => line.includes("threads didn't exit")))
  fail("a MariaDB thread never called my_thread_end");
else ok("every MariaDB thread exited at shutdown");

/* Well under the flat 5s the leak used to cost, well over a clean shutdown. */
if (shutdownMs >= 2500) fail(`shutdown took ${shutdownMs}ms — the thread wait ran to completion`);
else ok(`shutdown did not wait on threads (${shutdownMs}ms)`);

console.log(
  `\n${failures ? "FAILED" : "PASSED"} (${failures} failure${failures === 1 ? "" : "s"})`,
);

if (failures) {
  console.log("--- captured stderr ---");
  for (const line of stderrLines) console.log(line);
}

/* Criterion 3.2.9: no lingering pthread workers may keep Node alive. The
   process must exit on its own; process.exit() here would hide exactly the
   bug this is checking for. */
process.exitCode = failures ? 1 : 0;
