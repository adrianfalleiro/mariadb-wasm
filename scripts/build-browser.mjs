import { build } from "../package/node_modules/esbuild/lib/main.js";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: {
    worker: "package/src/worker-entry.ts",
    browser: "package/src/browser.ts",
    "mysql2-callback-driver": "package/src/mysql2-callback.ts",
    "mariadb-callback-driver": "package/src/mariadb-callback.ts",
    "mysql2-driver": "package/src/mysql2.ts",
    "mariadb-driver": "package/src/mariadb.ts",
  },
  outdir: "dist/browser",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  inject: ["package/src/browser-buffer.ts"],
  external: ["node:*"],
  define: { "process.versions.node": "undefined" },
});
