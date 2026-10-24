/* Public types, plus the protocol constants the decoder needs. */

export type StorageMode = { type: "memory" } | { type: "node"; directory: string };

/*
  Conversion policy. Defaults are lossless: MariaDB values that JavaScript's
  number cannot represent exactly do not become numbers unless asked for.
  BIGINT above 2^53 and DECIMAL are the two that bite in practice — a balance
  column silently losing its last digits is the kind of bug a test suite is
  supposed to catch, not cause.
*/
export interface ConversionOptions {
  bigIntMode?: "bigint" | "string";
  decimalMode?: "string" | "number";
  dateMode?: "date" | "string";
}

export interface EmbeddedMariaDbOptions extends ConversionOptions {
  storage?: StorageMode;
  serverOptions?: readonly string[];
  debug?: boolean;
  /* Overrides the built module location; mainly for tests in this repo. */
  modulePath?: string;
}

export interface FieldMetadata {
  /** MariaDB extended format metadata; absent for ordinary text. */
  json?: boolean;
  name: string;
  /* Raw MariaDB type code, kept so callers can tell exactly what came back. */
  type: number;
  flags: number;
  decimals: number;
  charsetnr: number;
  /* charsetnr 63 — the only way to tell VARBINARY from VARCHAR, which share
     a type code. */
  binary: boolean;
  unsigned: boolean;
  nullable: boolean;
}

export type Row = Record<string, unknown>;

export interface QueryResult {
  rows: Row[];
  fields: FieldMetadata[];
  affectedRows: number;
  insertId: bigint;
  warningCount: number;
}

export interface EmbeddedMariaDbConnection {
  query(sql: string): Promise<[Row[], FieldMetadata[]]>;
  execute(sql: string, parameters?: readonly unknown[]): Promise<[Row[], FieldMetadata[]]>;
  /* The full result, for callers that need affectedRows or insertId. */
  run(sql: string, parameters?: readonly unknown[]): Promise<QueryResult>;

  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}

export interface EmbeddedMariaDbServer {
  connect(options?: { database?: string }): Promise<EmbeddedMariaDbConnection>;
  reset(): Promise<void>;
  close(): Promise<void>;
  readonly state: RuntimeState;
}

export type RuntimeState =
  | "UNINITIALIZED"
  | "INITIALIZING"
  | "READY"
  | "SHUTTING_DOWN"
  | "CLOSED"
  | "FAILED";

/* --- protocol constants -------------------------------------------------- */

/* mdb_status, from native/include/mariadb_wasm.h. */
export const MDB_OK = 0;
export const MDB_ERR_MYSQL = 1;
export const MDB_ERR_BAD_HANDLE = 2;
export const MDB_ERR_BAD_STATE = 3;
export const MDB_ERR_NO_MEMORY = 4;
export const MDB_ERR_INTERNAL = 5;

/* enum_field_types. Object-with-as-const rather than a TS enum: Node strips
   types rather than compiling them, so enums are not erasable syntax. */
export const FieldType = {
  DECIMAL: 0,
  TINY: 1,
  SHORT: 2,
  LONG: 3,
  FLOAT: 4,
  DOUBLE: 5,
  NULL: 6,
  TIMESTAMP: 7,
  LONGLONG: 8,
  INT24: 9,
  DATE: 10,
  TIME: 11,
  DATETIME: 12,
  YEAR: 13,
  NEWDATE: 14,
  VARCHAR: 15,
  BIT: 16,
  JSON: 245,
  NEWDECIMAL: 246,
  ENUM: 247,
  SET: 248,
  TINY_BLOB: 249,
  MEDIUM_BLOB: 250,
  LONG_BLOB: 251,
  BLOB: 252,
  VAR_STRING: 253,
  STRING: 254,
  GEOMETRY: 255,
} as const;

export const FieldFlag = {
  NOT_NULL: 1,
  PRI_KEY: 2,
  UNIQUE_KEY: 4,
  MULTIPLE_KEY: 8,
  BLOB: 16,
  UNSIGNED: 32,
  ZEROFILL: 64,
  BINARY: 128,
  ENUM: 256,
  AUTO_INCREMENT: 512,
  TIMESTAMP: 1024,
  SET: 2048,
  NUM: 32768,
} as const;

/* MariaDB's collation id for the binary charset. */
export const BINARY_CHARSET = 63;
