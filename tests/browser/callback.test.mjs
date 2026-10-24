import { test } from "node:test";
import assert from "node:assert/strict";
import { withBrowser } from "./harness.mjs";
test("callback bundles run against a real browser database worker", async () => {
  await withBrowser(async (page) => {
    const result = await page.evaluate(async () => {
      const { createDatabaseWorker } = await import("/dist/browser/browser.mjs");
      const mysql = await import("/dist/browser/mysql2-callback-driver.mjs");
      const maria = await import("/dist/browser/mariadb-callback-driver.mjs");
      const server = await createDatabaseWorker();
      const call = (c, method, ...args) =>
        new Promise((resolve, reject) =>
          c[method](...args, (err, rows, fields) =>
            err ? reject(err) : resolve({ rows, fields }),
          ),
        );
      const results = [];
      try {
        for (const driver of [mysql, maria]) {
          const c = driver.createConnection({ server });
          try {
            const { rows, fields } = await call(c, "execute", "SELECT ? AS n", [42]);
            results.push({ rows, field: fields[0].name });
          } finally {
            await call(c, "end");
          }
        }
      } finally {
        await server.close();
      }
      return results;
    });
    assert.deepEqual(result, [
      { rows: [{ n: 42 }], field: "n" },
      { rows: [{ n: 42 }], field: "n" },
    ]);
  });
});
