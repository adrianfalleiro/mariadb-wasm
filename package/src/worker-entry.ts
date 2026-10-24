import { serveDatabaseWorker } from "./worker-host.ts";
import type { DatabaseEndpoint } from "./worker-client.ts";
serveDatabaseWorker(globalThis as unknown as DatabaseEndpoint);
