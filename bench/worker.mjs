/*
  One test worker: sets up its own isolated database and runs a slice of the
  suite. Spawned per worker by run.mjs so parallelism is real (separate
  processes, as test runners use) rather than simulated with Promise.all.

  Reports its own setup and run times so the orchestrator can separate
  "time to get a usable database" from "time to execute tests" — the former is
  the whole point of the comparison.
*/
import { parentPort, workerData } from "node:worker_threads";

import { createEmbedded, createServer, createShared } from "./adapters.mjs";
import { runTest } from "./workload.mjs";

const { backend, root, port, index, tests, clientPort } = workerData;

const started = performance.now();

const target =
  backend === "embedded"
    ? await createEmbedded({ root })
    : backend === "shared"
      ? await createShared({ root, clientPort })
      : await createServer({ port, database: `bench_w${index}` });

const ready = performance.now();

for (let n = 0; n < tests; n++) await runTest(target.db, index * 100000 + n);

const done = performance.now();

await target.close();

parentPort?.postMessage({
  index,
  setupMs: ready - started,
  testsMs: done - ready,
  closeMs: performance.now() - done,
});
/* Deliberately no RSS here: worker_threads share a process, so
   process.memoryUsage() reports the whole thing. Summing it per worker
   multiplies the same number. The parent samples it once instead. */
