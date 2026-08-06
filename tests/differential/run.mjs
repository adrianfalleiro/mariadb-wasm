/*
  Phase 13: run identical SQL against native libmariadbd and the wasm build,
  and compare at the C ABI level.

  Comparing raw bytes and column metadata rather than decoded JavaScript
  values is deliberate. The TypeScript decoder is shared by both backends, so
  a difference in what MariaDB returned could be normalised into the same
  JavaScript value and vanish. The bytes cannot lie.
*/
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cases, encodeCases } from "./cases.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

/* --- native backend ------------------------------------------------------ */

function runNative(caseFile) {
  const build = path.join(root, "build", "native");
  const datadir = fs.mkdtempSync(path.join(os.tmpdir(), "mdb-diff-native-"));

  try {
    return execFileSync(
      path.join(build, "differential-runner"),
      [
        datadir,
        path.join(build, "sql", "share"),
        path.join(root, "mariadb", "sql", "share", "charsets"),
        caseFile,
      ],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
  } finally {
    fs.rmSync(datadir, { recursive: true, force: true });
  }
}

/* --- wasm backend -------------------------------------------------------- */

/*
  Emits the exact record format runner.c writes, from the same ABI calls, so
  the two outputs are comparable as text.
*/
async function runWasm(caseList) {
  const createModule = (await import(path.join(root, "dist", "mariadb.mjs")))
    .default;

  const stderr = [];
  const Module = await createModule({
    printErr: (line) => stderr.push(line),
    print: (line) => stderr.push(line),
  });

  const u8 = () => Module.HEAPU8;
  const u32 = () => Module.HEAPU32;
  const { ccall, UTF8ToString, FS, NODEFS, _malloc, _free } = Module;
  const call = (name, args = [], types = []) =>
    ccall(name, "number", types, args);

  FS.mkdirTree("/mariadb/share");
  FS.mkdirTree("/mariadb/charsets");
  FS.mount(NODEFS, { root: path.join(root, "dist", "share") }, "/mariadb/share");
  FS.mount(NODEFS, { root: path.join(root, "dist", "charsets") }, "/mariadb/charsets");
  FS.mkdirTree("/runtime/diff");

  const serverArgs = [
    "--no-defaults",
    "--skip-grant-tables",
    "--skip-networking",
    "--performance-schema=OFF",
    "--max-connections=20",
    "--innodb-buffer-pool-size=16M",
    "--innodb-flush-log-at-trx-commit=0",
    "--innodb-doublewrite=0",
    "--datadir=/runtime/diff",
    "--lc-messages-dir=/mariadb/share",
    "--character-sets-dir=/mariadb/charsets",
  ];

  const encoder = new TextEncoder();
  const pointers = serverArgs.map((arg) => {
    const bytes = encoder.encode(arg + "\0");
    const ptr = _malloc(bytes.length);
    u8().set(bytes, ptr);
    return ptr;
  });
  const argvPtr = _malloc(pointers.length * 4);
  pointers.forEach((p, i) => {
    u32()[(argvPtr >> 2) + i] = p;
  });

  if (call("mdb_runtime_init_async", [serverArgs.length, argvPtr], ["number", "number"]) !== 0)
    throw new Error(`wasm init failed:\n${stderr.join("\n")}`);

  for (;;) {
    const poll = call("mdb_runtime_init_poll");
    if (poll === 1) break;
    if (poll < 0) throw new Error(`wasm init failed:\n${stderr.join("\n")}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  pointers.forEach(_free);
  _free(argvPtr);

  const out = [];
  const hex = (bytes) =>
    bytes.length
      ? [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
      : "-";

  const readError = (fn, handle) => {
    const ptr = _malloc(12);
    try {
      call(fn, [handle, ptr], ["number", "number"]);
      const base = ptr >> 2;
      return {
        code: u32()[base],
        sqlState: UTF8ToString(u32()[base + 1]) || "-",
        message: UTF8ToString(u32()[base + 2]),
      };
    } finally {
      _free(ptr);
    }
  };

  let conn = call("mdb_connection_open", [0], ["number"]);

  for (const [caseIndex, testCase] of caseList.entries()) {
    if (caseIndex > 0) {
      /* Same connection boundary the native runner uses, so session state
         cannot leak between cases on one side only. */
      call("mdb_connection_close", [conn], ["number"]);
      conn = call("mdb_connection_open", [0], ["number"]);
    }
    out.push(`CASE ${caseIndex}`);

    for (const [statementIndex, sql] of testCase.statements.entries()) {
      out.push(`STMT ${statementIndex}`);

      const sqlBytes = encoder.encode(sql);
      const sqlPtr = _malloc(Math.max(sqlBytes.length, 1));
      u8().set(sqlBytes, sqlPtr);
      const outPtr = _malloc(4);
      u32()[outPtr >> 2] = 0;

      const status = call(
        "mdb_connection_query",
        [conn, sqlPtr, sqlBytes.length, outPtr],
        ["number", "number", "number", "number"],
      );
      const resultHandle = u32()[outPtr >> 2];
      _free(sqlPtr);
      _free(outPtr);

      if (status !== 0) {
        const error = readError("mdb_connection_last_error", conn);
        out.push("STATUS error");
        out.push(`ERRNO ${error.code}`);
        out.push(`SQLSTATE ${error.sqlState}`);
        out.push(`MESSAGE ${hex(encoder.encode(error.message))}`);
        out.push("END");
        continue;
      }

      out.push("STATUS ok");
      out.push(`AFFECTED ${call("mdb_connection_affected_rows", [conn], ["number"])}`);
      out.push(`INSERTID ${call("mdb_connection_insert_id", [conn], ["number"])}`);

      if (!resultHandle) {
        out.push("FIELDS 0", "ROWS 0", "END");
        continue;
      }

      const columns = call("mdb_result_column_count", [resultHandle], ["number"]);
      out.push(`FIELDS ${columns}`);
      for (let i = 0; i < columns; i++) {
        const namePtr = call("mdb_result_column_name", [resultHandle, i], ["number", "number"]);
        const name = namePtr ? UTF8ToString(namePtr) : "";
        out.push(
          `FIELD ${hex(encoder.encode(name))} ` +
            `${call("mdb_result_column_type", [resultHandle, i], ["number", "number"])} ` +
            `${call("mdb_result_column_flags", [resultHandle, i], ["number", "number"])} ` +
            `${call("mdb_result_column_charsetnr", [resultHandle, i], ["number", "number"])} ` +
            `${call("mdb_result_column_decimals", [resultHandle, i], ["number", "number"])}`,
        );
      }

      out.push("ROWSTART");
      let rows = 0;
      for (;;) {
        const next = call("mdb_result_next", [resultHandle], ["number"]);
        if (next !== 1) break;
        for (let i = 0; i < columns; i++) {
          if (call("mdb_result_value_is_null", [resultHandle, i], ["number", "number"])) {
            out.push(`CELL ${rows} ${i} NULL`);
          } else {
            const ptr = call("mdb_result_value_data", [resultHandle, i], ["number", "number"]);
            const length = call("mdb_result_value_length", [resultHandle, i], ["number", "number"]);
            out.push(`CELL ${rows} ${i} HEX ${hex(u8().slice(ptr, ptr + length))}`);
          }
        }
        rows++;
      }
      out.push(`ROWS ${rows}`);
      out.push("END");
    }
  }

  call("mdb_connection_close", [conn], ["number"]);
  call("mdb_runtime_shutdown");
  Module.PThread?.terminateAllThreads?.();

  return out.join("\n") + "\n";
}

/* --- comparison ---------------------------------------------------------- */

/*
  MESSAGE lines are diagnostic only. Error *text* embeds datadir paths and
  generated identifiers, and MariaDB is free to reword it between builds;
  the number and SQLSTATE are the contract a test suite asserts on, and those
  are compared strictly.
*/
function normalise(text) {
  return text
    .split("\n")
    .filter((line) => !line.startsWith("MESSAGE "))
    .join("\n");
}

function compare(nativeOut, wasmOut) {
  const a = normalise(nativeOut).split("\n");
  const b = normalise(wasmOut).split("\n");

  const differences = [];
  const limit = Math.max(a.length, b.length);
  let caseIndex = -1;
  let statement = -1;

  for (let i = 0; i < limit; i++) {
    const left = a[i] ?? "<missing>";
    const right = b[i] ?? "<missing>";
    if (left.startsWith("CASE ")) caseIndex = Number(left.slice(5));
    if (left.startsWith("STMT ")) statement = Number(left.slice(5));
    if (left !== right) {
      differences.push({
        caseIndex,
        statement,
        line: i,
        native: left,
        wasm: right,
      });
      if (differences.length >= 40) break;
    }
  }
  return differences;
}

/* --- main ---------------------------------------------------------------- */

const caseFile = path.join(os.tmpdir(), `mdb-diff-cases-${process.pid}.txt`);
fs.writeFileSync(caseFile, encodeCases(cases));

try {
  process.stdout.write(`running ${cases.length} cases against both backends\n`);

  const nativeOut = runNative(caseFile);
  const wasmOut = await runWasm(cases);

  const differences = compare(nativeOut, wasmOut);

  /*
    Negative control. A comparison harness that cannot fail proves nothing, so
    every run perturbs one byte of the wasm output and asserts the comparison
    notices. If this ever stops firing, the PASSED above is meaningless.
  */
  const perturbed = wasmOut.replace(/^CELL (\d+) (\d+) HEX ([0-9a-f]+)$/m,
    (line, row, col, value) =>
      `CELL ${row} ${col} HEX ${value.slice(0, -1)}${value.endsWith("0") ? "1" : "0"}`);
  if (perturbed === wasmOut)
    throw new Error("self-check could not perturb the output; no CELL rows?");
  if (compare(nativeOut, perturbed).length === 0)
    throw new Error("self-check FAILED: the comparison did not detect a changed cell");
  process.stdout.write("self-check: a one-byte change is detected\n");

  if (differences.length === 0) {
    const statements = cases.reduce((n, c) => n + c.statements.length, 0);
    process.stdout.write(
      `\nPASSED — native and wasm agree on all ${statements} statements ` +
        `across ${cases.length} cases\n`,
    );
    process.exitCode = 0;
  } else {
    process.stdout.write(`\nFAILED — ${differences.length} difference(s)\n\n`);
    for (const d of differences) {
      const name = cases[d.caseIndex]?.name ?? `case ${d.caseIndex}`;
      const sql = cases[d.caseIndex]?.statements[d.statement];
      process.stdout.write(`${name} / statement ${d.statement}\n`);
      if (sql) process.stdout.write(`  sql:    ${sql.replace(/\s+/g, " ").slice(0, 120)}\n`);
      process.stdout.write(`  native: ${d.native}\n`);
      process.stdout.write(`  wasm:   ${d.wasm}\n\n`);
    }
    process.exitCode = 1;
  }

  if (process.env.MDB_DIFF_DUMP) {
    fs.writeFileSync(`${process.env.MDB_DIFF_DUMP}.native.txt`, nativeOut);
    fs.writeFileSync(`${process.env.MDB_DIFF_DUMP}.wasm.txt`, wasmOut);
  }
} finally {
  fs.rmSync(caseFile, { force: true });
}
