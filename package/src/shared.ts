import { Worker, MessageChannel, type MessagePort as NodeMessagePort } from "node:worker_threads";
import { createWorkerClient } from "./worker-client.ts";
import type { EmbeddedMariaDbOptions } from "./types.ts";

export function connectDatabasePort(port: NodeMessagePort) {
  const client = createWorkerClient(port as unknown as MessagePort, () => port.close());
  port.on("close", () => client.stop(new Error("database port is closed")));
  port.start();
  return { connect: client.connect, close: client.close };
}

export async function createSharedDatabaseWorker(options: EmbeddedMariaDbOptions = {}) {
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL("./node-worker-entry.ts", import.meta.url), {
    workerData: { port: port2 },
    transferList: [port2],
  });
  const client = createWorkerClient(port1 as unknown as MessagePort, () => {
    port1.close();
    void worker.terminate();
  });
  port1.on("close", () => client.stop(new Error("database port is closed")));
  worker.on("error", (error) => client.stop(error));
  worker.on("exit", () => client.stop(new Error("database worker exited")));
  const timer = setTimeout(
    () => client.stop(new Error("database worker startup timed out")),
    60000,
  );
  try {
    await client.call("init", options);
    return {
      connect: client.connect,
      close: client.close,
      async createClientPort() {
        return (await client.createClientPort()) as unknown as NodeMessagePort;
      },
    };
  } catch (error) {
    client.stop(error as Error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
