import { workerData } from "node:worker_threads";
import { serveDatabaseWorker } from "./worker-host.ts";
serveDatabaseWorker(workerData.port);
workerData.port.start();
