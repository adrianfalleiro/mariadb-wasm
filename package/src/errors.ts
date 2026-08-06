/* Error type carrying MariaDB's own error number and SQLSTATE. */

export class MariaDbEmbeddedError extends Error {
  readonly code: number;
  readonly sqlState: string;
  readonly sql?: string;

  constructor(
    message: string,
    options: { code?: number; sqlState?: string; sql?: string } = {},
  ) {
    super(message);
    this.name = "MariaDbEmbeddedError";
    this.code = options.code ?? 0;
    this.sqlState = options.sqlState ?? "HY000";
    this.sql = options.sql;
  }
}

/*
  Raised for wrapper-level misuse rather than anything MariaDB said — querying
  a closed connection, using a server after close. Kept distinct so a test
  asserting on a MariaDB error number cannot accidentally be satisfied by a
  bug in this package.
*/
export class MariaDbEmbeddedStateError extends MariaDbEmbeddedError {
  constructor(message: string) {
    super(message);
    this.name = "MariaDbEmbeddedStateError";
  }
}
