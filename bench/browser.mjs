// Browser process-tree RSS includes shared pages counted in multiple processes.
// Compare modes using fresh browser processes; this is not unique physical memory.
import { execFileSync } from "node:child_process";
import { withBrowser } from "../tests/browser/harness.mjs";

import { build } from "../package/node_modules/esbuild/lib/main.js";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ["bench/workload.mjs"],
  outfile: "dist/browser/bench-workload.mjs",
  bundle: true,
  format: "esm",
  platform: "browser",
  inject: ["package/src/browser-buffer.ts"],
});

const mode = process.argv.includes("--shared") ? "shared" : "isolated";
const workers = Number(process.env.BENCH_WORKERS ?? 4);
const tests = Number(process.env.BENCH_TESTS ?? 1000);
await withBrowser(async (page, browser) => {
  const cdp = await browser.newBrowserCDPSession();
  let sampling = true;
  let peakRss = 0;
  const sampler = (async () => {
    while (sampling) {
      const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
      const pids = processInfo.map((p) => p.id).join(",");
      const rss = execFileSync("ps", ["-o", "rss=", "-p", pids], { encoding: "utf8" });
      peakRss = Math.max(
        peakRss,
        rss
          .trim()
          .split(/\s+/)
          .reduce((sum, n) => sum + Number(n), 0) * 1024,
      );
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  let result;
  try {
    result = await page.evaluate(
      async ({ mode, workers, tests }) => {
        const { createDatabaseWorker } = await import("/dist/browser/browser.mjs");
        const started = performance.now();
        const host = mode === "shared" ? await createDatabaseWorker() : undefined;
        const code = `
        import {createDatabaseWorker,connectDatabasePort} from '${location.origin}/dist/browser/browser.mjs';
        import {SCHEMA,SEED,runTest} from '${location.origin}/dist/browser/bench-workload.mjs';
        onmessage = async ({data}) => {
          let server;
          try {
            server = data.port ? connectDatabasePort(data.port) : await createDatabaseWorker();
            const c = await server.connect();
            if (!data.port) { await c.query('CREATE DATABASE bench'); await c.query('USE bench'); }
            for(const sql of SCHEMA) await c.query(sql);
            for(const [sql,params] of SEED) await c.execute(sql,params);
            const ready = performance.now();
            const db = {query:s=>c.query(s),execute:(s,p)=>c.execute(s,p),begin:()=>c.beginTransaction(),rollback:()=>c.rollback()};
            for(let n=0;n<data.tests;n++) await runTest(db,data.index*100000+n);
            const testsMs = performance.now()-ready;
            await c.close(); await server.close();
            postMessage({testsMs});
          } catch(e) { await server?.close(); postMessage({error:e.message}); }
        };
      `;
        const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
        const clients = [];
        try {
          const results = await Promise.all(
            Array.from({ length: workers }, async (_, index) => {
              const port = await host?.createClientPort();
              const worker = new Worker(url, { type: "module" });
              clients.push(worker);
              return new Promise((resolve, reject) => {
                worker.onmessage = ({ data }) =>
                  data.error ? reject(new Error(data.error)) : resolve(data);
                worker.onerror = (e) => reject(new Error(e.message));
                worker.postMessage({ port, index, tests }, port ? [port] : []);
              });
            }),
          );
          await host?.close();
          return {
            wallMs: performance.now() - started,
            testsMs: Math.max(...results.map((r) => r.testsMs)),
          };
        } finally {
          clients.forEach((w) => w.terminate());
          await host?.close();
          URL.revokeObjectURL(url);
        }
      },
      { mode, workers, tests },
    );
  } finally {
    sampling = false;
    await sampler;
  }
  console.log(
    "RESULT_JSON=" + JSON.stringify({ mode, workers, tests, ...result, rssMiB: peakRss / 1048576 }),
  );
});
