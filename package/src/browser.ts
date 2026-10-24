import type { EmbeddedMariaDbOptions } from "./types.ts";
import { createWorkerClient } from "./worker-client.ts";
export { connectDatabasePort } from "./worker-client.ts";

export async function createDatabaseWorker(
  options: EmbeddedMariaDbOptions & {
    workerUrl?: string | URL;
    startupTimeoutMs?: number;
  } = {},
) {
  if (!globalThis.crossOriginIsolated) {
    throw new Error("MariaDB workers require COOP: same-origin and COEP: require-corp headers");
  }
  const { workerUrl, startupTimeoutMs = 60000, ...engineOptions } = options;
  const worker = new Worker(workerUrl ?? new URL("./worker.mjs", import.meta.url), {
    type: "module",
  });
  const client = createWorkerClient(worker, () => worker.terminate());
  const timer = setTimeout(
    () => client.stop(new Error("database worker startup timed out")),
    startupTimeoutMs,
  );
  try {
    await client.call("init", engineOptions);
    return {
      connect: client.connect,
      close: client.close,
      createClientPort: client.createClientPort,
    };
  } catch (error) {
    client.stop(error as Error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
