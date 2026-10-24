import { connectDriver } from "./driver.ts";
import type { DriverOptions } from "./driver.ts";
export function createConnection(options: DriverOptions = {}) {
  return connectDriver("mysql2", options);
}
export default { createConnection };
