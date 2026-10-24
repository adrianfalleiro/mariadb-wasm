import { connectCallbackDriver } from "./callback-driver.ts";
import type { DriverOptions } from "./driver.ts";
export function createConnection(options: DriverOptions = {}) {
  return connectCallbackDriver("mysql2", options);
}
export default { createConnection };
