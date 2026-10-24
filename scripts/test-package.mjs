import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withBrowser } from "../tests/browser/harness.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "mariadb-npm-"));
try {
  const [packed] = JSON.parse(
    execFileSync("npm", ["pack", "./build/npm", "--pack-destination", temp, "--json"], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  assert(packed.files.some(({ path }) => path === "dist/mariadb.wasm"));
  assert(packed.files.some(({ path }) => path === "dist/browser/mariadb.wasm"));
  assert(!packed.files.some(({ path }) => path.endsWith(".pem")));
  await fs.writeFile(path.join(temp, "package.json"), '{"private":true,"type":"module"}');
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", path.join(temp, packed.filename)],
    { cwd: temp, stdio: "pipe" },
  );
  await fs.writeFile(
    path.join(temp, "check.mjs"),
    `
import assert from "node:assert/strict";
import { createServer } from "@adrianfalleiro/mariadb-wasm";
import mysql from "@adrianfalleiro/mariadb-wasm/mysql2/promise";
import maria from "@adrianfalleiro/mariadb-wasm/mariadb";
import callbacks from "@adrianfalleiro/mariadb-wasm/mysql2";
import mariaCallbacks from "@adrianfalleiro/mariadb-wasm/mariadb/callback";
import { createSharedDatabaseWorker } from "@adrianfalleiro/mariadb-wasm/shared";
for (const create of [createServer, createSharedDatabaseWorker]) {
  const server = await create();
  try {
    const c = await mysql.createConnection({server});
    assert.deepEqual((await c.query("SELECT 42 AS n"))[0], [{n:42}]);
    assert.match((await c.query("SELECT VERSION() AS v"))[0][0].v, /^11\\.8\\./);
    await c.end();
    const m = await maria.createConnection({server});
    assert.equal((await m.query("SELECT 43 AS n"))[0].n, 43);
    await m.end();
    for (const driver of [callbacks, mariaCallbacks]) {
      const cb = driver.createConnection({server});
      const rows = await new Promise((resolve, reject) => cb.query("SELECT 44 AS n",
        (err, rows) => err ? reject(err) : resolve(rows)));
      assert.equal(rows[0].n, 44);
      await new Promise((resolve, reject) => cb.end(err => err ? reject(err) : resolve()));
    }
  } finally { await server.close(); }
}
console.log("Installed npm package: Node APIs and worker passed");
`,
  );
  execFileSync(process.execPath, ["check.mjs"], { cwd: temp, stdio: "inherit", timeout: 90000 });
  await fs.writeFile(
    path.join(temp, "consumer.ts"),
    `
import { createServer } from "@adrianfalleiro/mariadb-wasm";
import { createSharedDatabaseWorker } from "@adrianfalleiro/mariadb-wasm/shared";
import { createDatabaseWorker } from "@adrianfalleiro/mariadb-wasm/browser";
import mysql from "@adrianfalleiro/mariadb-wasm/mysql2/promise";
const db = await createServer();
const connection = await mysql.createConnection({server: db});
await connection.query("SELECT 1");
await connection.end();
await db.close();
void createSharedDatabaseWorker;
void createDatabaseWorker;
`,
  );
  execFileSync(
    process.execPath,
    [
      path.join(root, "package/node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--module",
      "nodenext",
      "--target",
      "es2023",
      "--typeRoots",
      path.join(root, "package/node_modules/@types"),
      "consumer.ts",
    ],
    { cwd: temp, stdio: "inherit" },
  );
  const installed = path.join(temp, "node_modules/@adrianfalleiro/mariadb-wasm");
  await withBrowser(
    async (page) => {
      const rows = await page.evaluate(async () => {
        const { createDatabaseWorker } = await import("/dist/browser/browser.mjs");
        const db = await createDatabaseWorker();
        try {
          const c = await db.connect();
          try {
            return (await c.query("SELECT 42 AS n"))[0];
          } finally {
            await c.close();
          }
        } finally {
          await db.close();
        }
      });
      assert.deepEqual(rows, [{ n: 42 }]);
    },
    pathToFileURL(installed + "/"),
  );
  console.log("Installed npm package: browser worker passed");
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
