# mariadb-wasm

Run MariaDB 11.8.9 in Node.js or a browser worker using WebAssembly. Real InnoDB,
transactions, foreign keys and prepared statements, without starting a database
server or Docker container.

Built for integration tests, disposable development databases and browser
sandboxes. Databases live in memory by default and are discarded when closed.

## Install

```sh
npm install @adrianfalleiro/mariadb-wasm
```

Requires Node.js 22.6 or newer. The package includes compiled JavaScript,
TypeScript declarations, WASM binaries and system-table fixtures. No native
compilation is required to use it.

## Quick start

```js
import { createServer } from "@adrianfalleiro/mariadb-wasm";

const server = await createServer();
try {
  const connection = await server.connect();
  try {
    await connection.query("CREATE DATABASE app");
    await connection.query("USE app");
    await connection.query(
      "CREATE TABLE users (id INT PRIMARY KEY, email VARCHAR(255)) ENGINE=InnoDB",
    );
    await connection.execute("INSERT INTO users VALUES (?, ?)", [1, "person@example.com"]);

    const [rows] = await connection.query("SELECT * FROM users");
    console.log(rows); // [{ id: 1, email: "person@example.com" }]
  } finally {
    await connection.close();
  }
} finally {
  await server.close();
}
```

Each server owns an independent engine. Connections from the same server share
its databases and can use transactions, locks and concurrent queries. Always
close the server to release its workers and memory.

## MySQL2 and MariaDB driver APIs

Adapters provide familiar promise and callback APIs:

| Import                                          | API                                               |
| ----------------------------------------------- | ------------------------------------------------- |
| `@adrianfalleiro/mariadb-wasm/mysql2/promise`   | MySQL2 promises; queries return `[rows, fields]`  |
| `@adrianfalleiro/mariadb-wasm/mysql2`           | MySQL2 callbacks                                  |
| `@adrianfalleiro/mariadb-wasm/mariadb`          | MariaDB promises; queries return rows with `meta` |
| `@adrianfalleiro/mariadb-wasm/mariadb/callback` | MariaDB callbacks                                 |

```js
import mysql from "@adrianfalleiro/mariadb-wasm/mysql2/promise";

const connection = await mysql.createConnection();
try {
  const [rows] = await connection.execute("SELECT ? AS answer", [42]);
  console.log(rows[0].answer); // 42
} finally {
  await connection.end();
}
```

Without a `server` option, a connection owns its engine and closes it on
`end()`. To share an engine across connections, create a server and pass
`{ server }` to each `createConnection()`; close the server separately.

Callback connections are returned immediately and queue operations during startup:

```js
import mysql from "@adrianfalleiro/mariadb-wasm/mysql2";

const connection = mysql.createConnection();
connection.execute("SELECT ? AS answer", [42], (error, rows) => {
  connection.end();
  if (error) throw error;
  console.log(rows[0].answer); // 42
});
```

Supported methods include `query`, `execute`, `beginTransaction`, `commit`,
`rollback` and `end`. These adapters cover a subset of the native drivers;
see [compatibility](#compatibility-and-limits) below.

## Browser workers

The engine runs in a dedicated Web Worker, with additional pthread workers for
MariaDB's background work.

Copy the contents of `node_modules/@adrianfalleiro/mariadb-wasm/dist/browser/`
to a static directory on your site, such as `/mariadb/`. Keep the generated
modules, chunks and WASM files together.

Serve your page with these headers:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Use HTTPS or localhost, and serve `.wasm` files as `application/wasm`.

```html
<script type="module">
  import mysql from "/mariadb/mysql2-driver.mjs";

  const connection = await mysql.createConnection();
  try {
    const [rows] = await connection.execute("SELECT ? AS answer", [42]);
    console.log(rows[0].answer); // 42
  } finally {
    await connection.end();
  }
</script>
```

For multiple connections, import `createDatabaseWorker` from
`/mariadb/browser.mjs`, create one server, and pass `{ server }` to the adapters.
Close each connection, then call `server.close()`.

Bundler users can import `createDatabaseWorker` from
`@adrianfalleiro/mariadb-wasm/browser`. Pass `workerUrl` if your bundler relocates
the entrypoint; the worker and its supporting assets must still be served together.
Browser storage is in-memory; closing the engine discards its data.

## Sharing one engine across test workers

To reduce memory use, Node test workers can share one engine through
`MessagePort` connections. Create a host in your test coordinator:

```js
import { createSharedDatabaseWorker } from "@adrianfalleiro/mariadb-wasm/shared";

const host = await createSharedDatabaseWorker();
const port = await host.createClientPort();
// Transfer port to a test worker, for example:
// worker.postMessage({ port }, [port]);
// After all test workers finish: await host.close();
```

Inside each test worker, call `connectDatabasePort(port)` from the same
`/shared` entrypoint and pass the returned client as `{ server: client }`
to a driver adapter. Each client port gets a fresh, selected database.
Call `client.close()` during teardown to close its connections and drop its database.

Browsers support the same pattern through `createDatabaseWorker()`,
`createClientPort()` and `connectDatabasePort()` from `/browser`.

Separate schemas provide test isolation, not a security boundary: SQL can
reference other schemas, and server settings and resource limits are shared.
Use separate engines when tests need independent server state.

## Runtime limits

- **Partial driver compatibility.** No built-in pools, `.promise()` wrapper,
  streaming/backpressure, prepared-statement objects, named placeholders or
  multiple result sets. Unknown connection options are rejected.
- **Dates and metadata.** Date conversion is UTC-only; use `dateStrings: true`
  to preserve SQL date strings. Field metadata does not reproduce every native
  driver field or packet class.
- **No network server.** Connections use the embedded engine directly. There is
  no MySQL wire-protocol listener or TCP port.
- **No authentication boundary.** Privilege checks are disabled with
  `--skip-grant-tables`.
- **No production durability guarantee.** The defaults favor disposable test
  databases. Crash recovery is not validated, and named time-zone data is not included.

Stored procedures, functions, triggers and views are supported through the
included system-table template. For more detail, see
[unsupported features](docs/unsupported-features.md).

## Building from source

The build pins MariaDB 11.8.9 and Emscripten 6.0.5. You need a C/C++ toolchain,
CMake, Ninja and Bison 3.x. See [build instructions](docs/build.md) for host setup.

```sh
npm ci --prefix package
bash scripts/00-fetch-emsdk.sh
bash scripts/01-fetch-mariadb.sh
bash scripts/02b-patch-mariadb.sh
bash scripts/02-build-host-tools.sh
bash scripts/10-build-native-reference.sh
bash scripts/06-build-datadir-template.sh
bash scripts/03-configure-wasm.sh
bash scripts/04-build-wasm.sh
bash scripts/05-link-wasm-module.sh release
bash scripts/05-link-wasm-module.sh release browser
npm run build:browser --prefix package
npm run pack:npm --prefix package
```

Do not run concurrent builds in one checkout: the source and build directories
are shared.

### Validation

```sh
npm run typecheck --prefix package
npm test --prefix package
npm run test:memory --prefix package

# Install Chromium once, or set CHROMIUM_PATH to an existing installation.
(cd package && npx playwright install chromium)
npm run test:browser --prefix package
npm run test:package --prefix package
```

`npm run test:package` installs the tarball in a temporary project and checks its
Node APIs, browser worker and TypeScript declarations.
`bash scripts/13-run-differential.sh` compares native and WASM SQL results.
The optional `npm run test:contract --prefix package` compares the adapters with
the official drivers using a disposable Docker MariaDB instance.

### Releases

Bump the version in `package/package.json` and its lockfile, then run the
[Publish npm workflow](https://github.com/adrianfalleiro/mariadb-wasm/actions/workflows/publish.yml).
It builds and tests the package on GitHub Actions before publishing through npm
trusted publishing. No npm token secret is required.

The development package remains marked private to prevent publishing an
incomplete checkout. The release package is assembled in `build/npm/`.

## Internals

Emscripten provides the threading and filesystem support needed by MariaDB's
embedded library. JavaScript APIs call a C ABI wrapper around `libmariadbd`;
portability patches adapt the build and memory handling for WASM.

- [Architecture](docs/architecture.md)
- [Portability](docs/portability-matrix.md)
- [Debugging](docs/debugging.md)
- [Upgrading MariaDB](docs/upgrading-mariadb.md)

## License

GPL-2.0-only. The WASM binary includes statically linked MariaDB Server code.
The npm package includes license notices in `dist/licenses/`, wrapper source
and build scripts in `source/`, and a build manifest identifying the upstream
MariaDB revision.
