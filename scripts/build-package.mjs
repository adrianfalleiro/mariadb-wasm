import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import ts from "../package/node_modules/typescript/lib/typescript.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "build/npm");
const pkg = JSON.parse(await fs.readFile(path.join(root, "package/package.json"), "utf8"));
// Fail before replacing the last package if either engine target is missing.
for (const file of [
  "mariadb.wasm",
  "mariadb.mjs",
  "datadir-template.manifest.json",
  "browser/mariadb.wasm",
  "browser/mariadb.mjs",
  "browser/worker.mjs",
]) {
  await fs.access(path.join(root, "dist", file));
}
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
const config = JSON.parse(await fs.readFile(path.join(root, "package/tsconfig.json"), "utf8"));
config.include = ["src/**/*.ts"];
Object.assign(config.compilerOptions, {
  noEmit: false,
  declaration: true,
  rewriteRelativeImportExtensions: true,
  rootDir: "src",
  outDir: "../build/npm/lib/node",
});
const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.join(root, "package"));
const program = ts.createProgram(parsed.fileNames, parsed.options);
const result = program.emit();
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program), ...result.diagnostics];
if (diagnostics.length) {
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: (name) => name,
      getNewLine: () => "\n",
    }),
  );
}
await fs.cp(path.join(root, "dist"), path.join(out, "dist"), { recursive: true });
await fs.copyFile(path.join(root, "README.md"), path.join(out, "README.md"));
await fs.copyFile(path.join(root, "mariadb/COPYING"), path.join(out, "LICENSE"));
await fs.cp(path.join(root, "native"), path.join(out, "source/native"), { recursive: true });
await fs.cp(path.join(root, "scripts"), path.join(out, "source/scripts"), { recursive: true });
await fs.cp(path.join(root, "package/src"), path.join(out, "source/package/src"), {
  recursive: true,
});
await fs.copyFile(
  path.join(root, "package/package-lock.json"),
  path.join(out, "source/package/package-lock.json"),
);
await fs.copyFile(
  path.join(root, "package/package.json"),
  path.join(out, "source/package/package.json"),
);
await fs.copyFile(
  path.join(root, "package/tsconfig.json"),
  path.join(out, "source/package/tsconfig.json"),
);
const entry = (name) => ({
  types: "./lib/node/" + name + ".d.ts",
  default: "./lib/node/" + name + ".js",
});
const driver = (name, browser) => ({
  types: "./lib/node/" + name + ".d.ts",
  browser: "./dist/browser/" + browser + ".mjs",
  default: "./lib/node/" + name + ".js",
});
pkg.main = "./lib/node/index.js";
pkg.types = "./lib/node/index.d.ts";
pkg.exports = {
  ".": entry("index"),
  "./browser": { types: "./lib/node/browser.d.ts", default: "./dist/browser/browser.mjs" },
  "./shared": entry("shared"),
  "./mysql2": driver("mysql2-callback", "mysql2-callback-driver"),
  "./mysql2/promise": driver("mysql2", "mysql2-driver"),
  "./mariadb": driver("mariadb", "mariadb-driver"),
  "./mariadb/callback": driver("mariadb-callback", "mariadb-callback-driver"),
  "./dist/browser/*": "./dist/browser/*",
  "./package.json": "./package.json",
};
pkg.files = ["lib", "dist", "source", "README.md", "LICENSE"];
pkg.gitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
delete pkg.private;
delete pkg.scripts;
delete pkg.devDependencies;
await fs.writeFile(path.join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
console.log("Publishable package: " + out);
