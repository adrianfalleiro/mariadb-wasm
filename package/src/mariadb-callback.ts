import { connectCallbackDriver } from "./callback-driver.ts";
import type { DriverOptions } from "./driver.ts";
export function createConnection(options: DriverOptions = {}) {
  return connectCallbackDriver("mariadb", options);
}
export default { createConnection };
