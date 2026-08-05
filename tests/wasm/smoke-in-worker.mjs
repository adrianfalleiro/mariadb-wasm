/*
  Runs tests/wasm/smoke.mjs unchanged, but inside a node:worker_threads worker.

  Hypothesis under test: the intermittent startup hang is Emscripten's main
  thread spinning instead of blocking. Emscripten treats its main thread as
  unable to block — that is true of a browser's main thread, where Atomics.wait
  is forbidden — and compiles futex waits there into a busy spin. MariaDB does
  block during mysql_server_init, waiting for InnoDB's background threads to
  come up, so the spin competes with the very workers it is waiting for.

  Making the module's main thread a worker removes the special case: inside a
  worker, Atomics.wait is permitted and the wait is a real block.

  If this is the fix, the same topology is what Phase 12 wants anyway — one
  MariaDB-owning worker per test worker, with the public API unchanged.
*/
import { Worker } from "node:worker_threads";

const worker = new Worker(new URL("./smoke.mjs", import.meta.url));

worker.on("error", (error) => {
  console.error("worker error:", error);
  process.exitCode = 1;
});

worker.on("exit", (code) => {
  process.exitCode = code;
});
