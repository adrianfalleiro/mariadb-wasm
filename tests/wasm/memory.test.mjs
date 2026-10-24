import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../../package/src/server.ts";
import { SCHEMA, SEED, runTest } from "../../bench/workload.mjs";

test(
  "serial CI transactions do not continually expand the JS worker pool",
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "mariadb-worker-memory-"));
    const dist = new URL("../../dist/", import.meta.url);
    let server;
    try {
      await writeFile(
        join(dir, "mariadb.mjs"),
        `import factory from ${JSON.stringify(new URL("mariadb.mjs", dist).href)};
      export default async options => { const module=await factory(options); globalThis.memoryTestModule=module; return module; };`,
      );
      for (const name of ["share", "charsets", "datadir-template"])
        await symlink(fileURLToPath(new URL(name, dist)), join(dir, name));
      server = await createServer({ modulePath: join(dir, "mariadb.mjs") });
      const c = await server.connect();
      await c.query("CREATE DATABASE workload");
      await c.query("USE workload");
      for (const sql of SCHEMA) await c.query(sql);
      for (const [sql, params] of SEED) await c.execute(sql, params);
      const count = () => {
        const pool = globalThis.memoryTestModule.PThread;
        return Object.keys(pool.pthreads).length + pool.unusedWorkers.length;
      };
      const initial = count();
      let peak = initial;
      const db = {
        query: (s) => c.query(s),
        execute: (s, p) => c.execute(s, p),
        begin: () => c.beginTransaction(),
        rollback: () => c.rollback(),
      };
      for (let n = 0; n < 1000; n++) {
        await runTest(db, n);
        peak = Math.max(peak, count());
      }
      assert.equal(peak <= initial + 4, true, `JS workers grew from ${initial} to ${peak}`);
      await c.close();
      await server.close();
      assert.equal(count(), 0);
    } finally {
      await server?.close();
      delete globalThis.memoryTestModule;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
