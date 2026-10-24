/* Server lifecycle: one initialised MariaDB runtime per wasm instance. */

import { Connection } from "./connection.ts";
import { MariaDbEmbeddedStateError } from "./errors.ts";
import { resolveConversion } from "./result-decoder.ts";
import { WasmRuntime } from "./runtime.ts";
import type {
  ConversionOptions,
  EmbeddedMariaDbConnection,
  EmbeddedMariaDbOptions,
  EmbeddedMariaDbServer,
  RuntimeState,
  StorageMode,
} from "./types.ts";

/* Each server gets its own directory inside the instance's filesystem. The
   counter only has to be unique within one wasm instance, since instances do
   not share a filesystem — cross-worker isolation comes for free from that. */
let instanceCounter = 0;

/* Written beside the template by scripts/06-build-datadir-template.sh. */
const DEFERRED_DDL_FILE = "innodb-system-tables.sql";

/*
  Test-oriented defaults. Durability is deliberately relaxed: these runtimes
  are ephemeral by design and this package makes no crash-persistence claim.
  The settings are explicit rather than implied so nobody mistakes the
  intent — see docs/unsupported-features.md.
*/
function defaultServerOptions(datadir: string): string[] {
  return [
    "--no-defaults",
    "--skip-grant-tables",
    "--skip-networking",
    "--performance-schema=OFF",
    "--max-connections=20",
    "--innodb-buffer-pool-size=16M",
    /* Small ephemeral transactions need less redo buffering and purge concurrency. */
    "--innodb-log-buffer-size=1M",
    "--innodb-purge-threads=1",
    /*
      MariaDB sizes these two for a dedicated database host: 128 MB each by
      default, which together account for ~290 MB of the wasm heap before a
      single query runs. Measured: they take the heap after initialisation
      from 479 MB down to 192 MB, and RSS from 851 MB to 580 MB.

      Both are pure caches — MyISAM key blocks and Aria pages — so this is a
      performance setting, not a semantic one. Aria is kept at 8 MB rather
      than 1 MB because it also backs internal temporary tables, which a
      GROUP BY or DISTINCT will use.
    */
    "--key-buffer-size=1M",
    "--aria-pagecache-buffer-size=8M",
    /* Not a durability guarantee: with MEMFS there is nothing to be durable
       to, and fsync per commit only costs proxied syscalls. */
    "--innodb-flush-log-at-trx-commit=0",
    "--innodb-doublewrite=0",
    /* These three must match what scripts/06-build-datadir-template.sh used,
       or InnoDB rejects the template with a tablespace size mismatch. The
       template ships no tablespaces - InnoDB rebuilds them on first start -
       but the geometry still has to agree. */
    "--innodb-log-file-size=4M",
    "--innodb-data-file-path=ibdata1:1M:autoextend",
    "--innodb-undo-tablespaces=0",
    // MEMFS reserves real RAM for file capacity; grow small fixtures incrementally.
    "--innodb-autoextend-increment=1",
    "--innodb-temp-data-file-path=ibtmp1:1M:autoextend",
    `--datadir=${datadir}`,
    "--lc-messages-dir=/mariadb/share",
    "--character-sets-dir=/mariadb/charsets",
  ];
}

class Server implements EmbeddedMariaDbServer {
  #runtime: WasmRuntime;
  #templateApplied = false;
  #state: RuntimeState = "UNINITIALIZED";
  #connections = new Set<Connection>();
  #closePromise?: Promise<void>;
  #conversion: Required<ConversionOptions>;
  #options: EmbeddedMariaDbOptions;
  #datadir: string;

  constructor(
    runtime: WasmRuntime,
    options: EmbeddedMariaDbOptions,
    datadir: string,
    templateApplied: boolean,
  ) {
    this.#templateApplied = templateApplied;
    this.#runtime = runtime;
    this.#options = options;
    this.#datadir = datadir;
    this.#conversion = resolveConversion(options);
  }

  get state(): RuntimeState {
    return this.#state;
  }

  async start(): Promise<void> {
    if (this.#state !== "UNINITIALIZED")
      throw new MariaDbEmbeddedStateError(`cannot start a server in state ${this.#state}`);

    this.#state = "INITIALIZING";
    try {
      const args = [...defaultServerOptions(this.#datadir), ...(this.#options.serverOptions ?? [])];
      await this.#runtime.initAsync(args);
      this.#state = "READY";
      await this.#createDeferredSystemTables();
    } catch (error) {
      this.#state = "FAILED";
      throw error;
    }
  }

  /*
    Recreates the mysql.* tables that live in InnoDB's shared tablespace.

    The template deliberately ships no tablespaces, because they are tens of
    megabytes of mostly-empty file for four small tables and would be copied
    into every instance. InnoDB rebuilds the tablespace from nothing on first
    start; these four tables then have to be put back into it. The DDL is
    whatever the server itself reported at template build time, so it cannot
    drift from the MariaDB revision the template was made with.
  */
  async #createDeferredSystemTables(): Promise<void> {
    if (!this.#templateApplied) return;

    const ddl = this.#runtime.deferredDDL();
    if (!ddl) return;

    const connection = await this.connect({ database: "mysql" });
    try {
      for (const statement of ddl
        .split(";\n")
        .map((s) => s.trim())
        .filter(Boolean)) {
        await connection.query(statement);
      }
    } finally {
      await connection.close();
    }
  }

  async connect(options: { database?: string } = {}): Promise<EmbeddedMariaDbConnection> {
    if (this.#state !== "READY")
      throw new MariaDbEmbeddedStateError(`cannot connect to a server in state ${this.#state}`);

    const handle = this.#runtime.connectionOpen();
    const connection = new Connection(this.#runtime, handle, this.#conversion, (closed) =>
      this.#connections.delete(closed),
    );
    this.#connections.add(connection);
    try {
      // Embedded mysql_real_connect loses the error detail on a missing schema.
      // USE goes through the asynchronous query path and preserves its SQLSTATE.
      if (options.database) await connection.run(`USE \`${options.database.replace(/`/g, "``")}\``);
      return connection;
    } catch (error) {
      await connection.close();
      throw error;
    }
  }

  /*
    Reset drops every schema the tests created rather than restarting the
    runtime. MariaDB's server init is process-global and mysql_server_end
    followed by another mysql_server_init is not a supported sequence, so a
    genuine restart means a new wasm instance — which is what close() plus
    createEmbeddedMariaDb() gives you.

    Correctness first, as the brief asks: this is the obvious implementation,
    not a clever one.
  */
  async reset(): Promise<void> {
    if (this.#state !== "READY")
      throw new MariaDbEmbeddedStateError(`cannot reset a server in state ${this.#state}`);

    for (const connection of [...this.#connections]) await connection.close();

    const connection = await this.connect();
    try {
      const [rows] = await connection.query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA");
      for (const row of rows) {
        const name = String(row.SCHEMA_NAME);
        if (RESERVED_SCHEMAS.has(name.toLowerCase())) continue;
        /* Identifier, so it cannot be a bound parameter; backtick-quoted with
           embedded backticks doubled, which is MariaDB's own escaping rule. */
        await connection.query(`DROP DATABASE \`${name.replace(/`/g, "``")}\``);
      }
    } finally {
      await connection.close();
    }
  }

  close(): Promise<void> {
    return (this.#closePromise ??= this.#shutdown());
  }

  async #shutdown(): Promise<void> {
    this.#state = "SHUTTING_DOWN";
    for (const connection of [...this.#connections]) {
      try {
        await connection.close();
      } catch {
        /* Already-broken connections must not prevent shutting the rest down. */
      }
    }

    try {
      await this.#runtime.shutdown();
    } finally {
      this.#runtime.terminateThreads();
      this.#state = "CLOSED";
    }
  }

  /* Exposed for the leak assertions in the test suite. */
  get liveHandles() {
    return {
      connections: this.#runtime.liveConnections(),
      results: this.#runtime.liveResults(),
      statements: this.#runtime.liveStatements(),
    };
  }

  /*
    False if MariaDB gave up waiting for its own threads during close(),
    which means one of them never called my_thread_end. Exposed rather than
    merely logged because the symptom otherwise is just a slow shutdown, and a
    flat five seconds per server is easy to mistake for "wasm is slow".
  */
  get shutdownWasClean(): boolean {
    return this.#runtime.shutdownIsClean();
  }

  get diagnostics(): string {
    return this.#runtime.diagnostics();
  }
}

/* Schemas MariaDB owns. Dropping any of these breaks the running server. */
const RESERVED_SCHEMAS = new Set(["mysql", "information_schema", "performance_schema", "sys"]);

export async function createEmbeddedMariaDb(
  options: EmbeddedMariaDbOptions = {},
): Promise<EmbeddedMariaDbServer> {
  const runtime = await WasmRuntime.load({
    modulePath: options.modulePath,
    debug: options.debug,
  });

  try {
    const storage: StorageMode = options.storage ?? { type: "memory" };
    const datadir = `/runtime/instance-${instanceCounter++}`;

    let templateApplied = false;

    if (storage.type === "node") {
      /* Host-backed, for debugging and restart tests. NODEFS gives real files
       with real persistence; MEMFS is gone the moment the instance is. The
       caller owns the directory, so the template is not written into it. */
      runtime.mountNodeFs(storage.directory, datadir);
    } else {
      runtime.mkdirTree(datadir);
      templateApplied = runtime.copyTemplate(
        runtime.templateDirectory(),
        datadir,
        /* Not a MariaDB file - it is replayed after startup instead. */
        [DEFERRED_DDL_FILE],
      );
    }

    const server = new Server(runtime, options, datadir, templateApplied);
    await server.start();
    return server;
  } catch (error) {
    runtime.terminateThreads();
    throw error;
  }
}
