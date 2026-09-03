/*
  Test-suite benchmark: embedded wasm against a real MySQL server.

  The question is not "which executes SQL faster" — a warm native server will
  usually win that. It is "which gets a test suite finished sooner", and for
  that the costs that matter are:

    1. cold start   — nothing usable exists until the server is up. In CI this
                      is paid on every run.
    2. setup        — per worker: an isolated database with the schema applied.
    3. tests        — the actual work, identical SQL on both sides.
    4. parallelism  — whether workers help or contend.

  Run:  node bench/run.mjs             (both backends, 1 and 4 workers)
        node bench/run.mjs --embedded  (skip Docker)
*/
import { execFileSync, spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { STATEMENTS_PER_TEST } from "./workload.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const IMAGE = process.env.BENCH_IMAGE ?? "public.ecr.aws/docker/library/mysql:8.0.42";
const CONTAINER = "mariadb-wasm-bench";
const PORT = Number(process.env.BENCH_PORT ?? 13306);
const TESTS_PER_WORKER = Number(process.env.BENCH_TESTS ?? 100);
const WORKER_COUNTS = (process.env.BENCH_WORKERS ?? "1,4")
  .split(",").map(Number);

const onlyEmbedded = process.argv.includes("--embedded");

const ms = (v) => `${v.toFixed(0)} ms`;
const secs = (v) => `${(v / 1000).toFixed(2)} s`;

/* --- docker lifecycle ---------------------------------------------------- */

function docker(args, opts = {}) {
  return execFileSync("docker", args, { encoding: "utf8", ...opts });
}

/*
  The container's memory lives outside this process, so worker RSS alone would
  flatter the server side. Read it from docker and add it in.
*/
function containerMemoryBytes() {
  try {
    const out = docker([
      "stats", "--no-stream", "--format", "{{.MemUsage}}", CONTAINER,
    ]).trim();
    const [used] = out.split("/");
    const match = /([\d.]+)\s*([a-zA-Z]+)/.exec(used.trim());
    if (!match) return 0;
    const scale = { B: 1, KiB: 1024, MiB: 1048576, GiB: 1073741824,
                    kB: 1000, MB: 1e6, GB: 1e9 }[match[2]] ?? 1;
    return Number(match[1]) * scale;
  } catch {
    return 0;
  }
}

function stopContainer() {
  spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
}

/*
  Cold start is measured the way CI experiences it: from `docker run` to the
  first query a test could actually issue. Polling with a real connection
  rather than trusting the healthcheck, because "container started" and
  "accepts queries" are not the same moment and the gap is most of the cost.
*/
async function startServerColdMeasured() {
  stopContainer();

  const mysql = await import("mysql2/promise");
  const started = performance.now();

  docker([
    "run", "-d", "--name", CONTAINER,
    "-e", "MYSQL_ROOT_PASSWORD=bench",
    "-p", `${PORT}:3306`,
    IMAGE,
    /* Comparable durability to the embedded defaults, so the server is not
       penalised for guarantees the embedded build does not offer. */
    "--innodb-flush-log-at-trx-commit=0",
    "--innodb-doublewrite=0",
    "--skip-log-bin",
    "--performance-schema=OFF",
  ]);

  for (;;) {
    try {
      const c = await mysql.createConnection({
        host: "127.0.0.1", port: PORT, user: "root", password: "bench",
        connectTimeout: 1000,
      });
      await c.query("SELECT 1");
      await c.end();
      break;
    } catch {
      if (performance.now() - started > 180_000)
        throw new Error("MySQL container did not become usable within 180s");
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return performance.now() - started;
}

/* --- suite execution ----------------------------------------------------- */

function runWorkers(backend, count, tests) {
  return Promise.all(
    Array.from({ length: count }, (_, index) =>
      new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./worker.mjs", import.meta.url), {
          workerData: { backend, root, port: PORT, index, tests },
        });
        let result;
        worker.on("message", (m) => { result = m; });
        worker.on("error", reject);
        worker.on("exit", (code) =>
          code === 0 && result
            ? resolve(result)
            : reject(new Error(`worker ${index} exited ${code}`)));
      }),
    ),
  );
}

async function measureSuite(backend, workers, tests) {
  const started = performance.now();

  /*
    Sampled in the parent, because worker_threads share one process and one
    RSS. Polling for the peak rather than reading it at the end, since the
    workers finish at different times and the interesting figure is how much
    memory the suite actually needed at once.
  */
  let peakRss = 0;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 25);

  let results;
  try {
    results = await runWorkers(backend, workers, tests);
  } finally {
    clearInterval(sampler);
  }
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  const wall = performance.now() - started;

  return {
    wall,
    setup: Math.max(...results.map((r) => r.setupMs)),
    tests: Math.max(...results.map((r) => r.testsMs)),
    rss: peakRss,
    testsPerWorker: tests,
    totalTests: workers * tests,
  };
}

/* --- report -------------------------------------------------------------- */

const rows = [];

function record(scenario, backend, coldMs, suite) {
  const statements = suite.totalTests * STATEMENTS_PER_TEST;
  rows.push({
    scenario, backend,
    workers: suite.totalTests / suite.testsPerWorker,
    testsPerWorker: suite.testsPerWorker,
    cold: coldMs,
    setup: suite.setup,
    tests: suite.tests,
    wall: suite.wall,
    total: (coldMs ?? 0) + suite.wall,
    perTest: suite.tests / (suite.totalTests / /* per worker */ 1) ,
    statements,
    rssMb: suite.rss / 1048576,
  });
}

console.log(`workload: ${TESTS_PER_WORKER} tests/worker, ` +
  `${STATEMENTS_PER_TEST} statements each, transaction-rollback isolation`);
console.log(`workers:  ${WORKER_COUNTS.join(", ")}`);
console.log(`image:    ${onlyEmbedded ? "(skipped)" : IMAGE}\n`);

try {
  /* Embedded: "cold start" is module load, which is already inside setup, so
     there is no separate cost to attribute. That is the point. */
  for (const workers of WORKER_COUNTS) {
    process.stdout.write(`embedded wasm, ${workers} worker(s)... `);
    const suite = await measureSuite("embedded", workers, TESTS_PER_WORKER);
    record(`${workers} worker(s)`, "embedded wasm", 0, suite);
    console.log(secs(suite.wall));
  }

  if (!onlyEmbedded) {
    process.stdout.write(`mysql container cold start... `);
    const cold = await startServerColdMeasured();
    console.log(secs(cold));

    for (const workers of WORKER_COUNTS) {
      process.stdout.write(`mysql server, ${workers} worker(s)... `);
      const suite = await measureSuite("server", workers, TESTS_PER_WORKER);
      /* Cold start is attributed to the first configuration only, which is how
         CI pays it: once per run, not once per worker. */
      suite.rss += containerMemoryBytes();
      record(`${workers} worker(s)`, "mysql server", cold, suite);
      console.log(secs(suite.wall));
    }
  }
} finally {
  if (!onlyEmbedded) stopContainer();
}

console.log("\n" + "".padEnd(96, "="));
console.log(
  "scenario".padEnd(14) + "backend".padEnd(16) +
  "cold".padStart(10) + "setup".padStart(10) + "tests".padStart(10) +
  "wall".padStart(10) + "total".padStart(11) + "rss".padStart(10));
console.log("".padEnd(96, "="));
for (const r of rows) {
  console.log(
    r.scenario.padEnd(14) + r.backend.padEnd(16) +
    (r.cold ? ms(r.cold) : "—").padStart(10) +
    ms(r.setup).padStart(10) +
    ms(r.tests).padStart(10) +
    ms(r.wall).padStart(10) +
    secs(r.total).padStart(11) +
    `${r.rssMb.toFixed(0)} MB`.padStart(10));
}
console.log("".padEnd(96, "="));

/*
  Where the two cross over. The embedded build wins the cold start outright
  and loses steady-state execution, so there is a suite size beyond which the
  server's faster queries repay its startup. Anyone deciding whether to switch
  wants that number, not a ratio.
*/
for (const workers of WORKER_COUNTS) {
  const wasm = rows.find((r) => r.backend === "embedded wasm" && r.workers === workers);
  const server = rows.find((r) => r.backend === "mysql server" && r.workers === workers);
  if (!wasm || !server) continue;

  const wasmPerTest = wasm.tests / wasm.testsPerWorker;
  const serverPerTest = server.tests / server.testsPerWorker;
  const penalty = wasmPerTest - serverPerTest;

  console.log(`\n${workers} worker(s): ${wasmPerTest.toFixed(2)} ms/test embedded vs ` +
    `${serverPerTest.toFixed(2)} ms/test on the server`);

  if (penalty <= 0) {
    console.log("  the embedded build is faster per test too — it wins at any size");
  } else {
    const breakEven = Math.round((server.cold + server.setup - wasm.setup) / penalty);
    console.log(`  embedded is ${(wasmPerTest / serverPerTest).toFixed(1)}x slower per test, ` +
      `but starts ${secs(server.cold)} sooner`);
    console.log(`  break-even: ~${breakEven.toLocaleString()} tests per worker ` +
      `(${(breakEven * workers).toLocaleString()} total) at this suite size`);
    console.log("  extrapolated, and it moves: the embedded build has a fixed");
    console.log("  warm-up that amortises, while the server contends more as workers");
    console.log("  are added, so both per-test figures shift with suite size. Run the");
    console.log("  sizes you actually have rather than trusting this number.");
  }
}

console.log(
  "\ncold  = until the first query is possible (CI pays this every run)" +
  "\nsetup = slowest worker's isolated-database + schema setup" +
  "\ntests = slowest worker's test execution" +
  "\nwall  = whole suite, all workers in parallel" +
  "\ntotal = cold + wall, i.e. what a CI run actually costs" +
  "\nrss   = peak of the whole test process, plus the container for the server");
