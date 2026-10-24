# Debugging

## Get MariaDB to tell you what happened

The package buffers MariaDB's output and only surfaces it on failure. To stream
it:

```ts
const server = await createServer({ debug: true });
```

For the raw harnesses:

```bash
MDB_DEBUG=1 node tests/wasm/smoke.mjs
```

A failed `initAsync` already includes the captured output in the thrown error,
which is usually enough to see which server option MariaDB rejected.

## Build a debug artifact

```bash
bash scripts/05-link-wasm-module.sh debug
```

That gives `-O1 -g`, `ASSERTIONS=2`, `STACK_OVERFLOW_CHECK=2` and
`PTHREADS_DEBUG=1`. The last one traces every thread create, TLS init and entry
point, and is how the startup deadlock was tracked down — the tell was a worker
sitting after `invokeEntryPoint` with no further output from any thread.

Be aware that `ASSERTIONS=2` logs every heap resize from every pthread, and
those workers do not inherit the Module's `printErr`, so the lines go straight
to the console. That noise is exactly why release is the default.

Switch back with `bash scripts/05-link-wasm-module.sh release`.

## Inspect the virtual filesystem

`FS` is exported, so from inside a test:

```js
Module.FS.readdir("/runtime/instance-0");
Module.FS.stat("/runtime/instance-0/ibdata1");
```

To get real files you can inspect with ordinary tools, use host-backed storage:

```ts
await createServer({
  storage: { type: "node", directory: "/tmp/mdb-debug" },
});
```

## Check for leaked handles and threads

```ts
(server as any).liveHandles; // { connections, results, statements }
```

All three must be 0 after every connection is closed. If Node will not exit
after `server.close()`, an Emscripten pthread worker is still alive — that is
criterion 3.2.9 failing, and the cause is usually a runtime that was never shut
down rather than a thread that refused to stop.

## Capture a failing SQL sequence

`MariaDbEmbeddedError` carries `code`, `sqlState` and `sql`. For a reproducer
independent of the package, add the statements to
`tests/differential/cases.mjs` and run:

```bash
bash scripts/13-run-differential.sh
```

If native and wasm disagree, that is a porting bug and the harness prints both
sides. If they agree, the behaviour is MariaDB's and the expectation is wrong.
`MDB_DIFF_DUMP=/tmp/diff` writes both full record streams for eyeballing.

## Distinguish a wrapper bug from a porting bug

Three suites, deliberately layered:

```bash
bash scripts/11-run-native-smoke.sh   # libmariadbd direct, no wrapper
bash scripts/12-run-abi-smoke.sh      # the C ABI, natively
node tests/wasm/smoke.mjs             # the C ABI, under wasm
```

Failing at the first means MariaDB or the server arguments. Failing only at the
second means the wrapper. Failing only at the third means the port.

## Reproduce a CI failure locally

CI runs exactly the scripts in `docs/build.md`, in order. The one thing that
does not reproduce is concurrency: `build/` and the in-place-patched `mariadb/`
checkout are shared mutable state with no locking, and two builds at once
corrupt each other in ways that surface as impossible compiler errors. If you
see a compile error naming a header that should exist, check
`build/wasm/CMakeCache.txt` for a host compiler before believing it.
