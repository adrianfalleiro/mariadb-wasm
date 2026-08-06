/*
  Turns MariaDB's wire values into JavaScript ones.

  Every value arrives as bytes plus column metadata. The rule throughout is
  that a conversion which cannot round-trip is not the default: BIGINT and
  DECIMAL do not silently become doubles, and binary columns do not become
  strings.
*/
import {
  BINARY_CHARSET,
  FieldFlag,
  FieldType,
  type ConversionOptions,
  type FieldMetadata,
} from "./types.ts";

const decoder = new TextDecoder("utf-8", { fatal: false });

export function describeColumn(raw: {
  name: string;
  type: number;
  flags: number;
  decimals: number;
  charsetnr: number;
}): FieldMetadata {
  return {
    name: raw.name,
    type: raw.type,
    flags: raw.flags,
    decimals: raw.decimals,
    charsetnr: raw.charsetnr,
    binary: raw.charsetnr === BINARY_CHARSET,
    unsigned: (raw.flags & FieldFlag.UNSIGNED) !== 0,
    nullable: (raw.flags & FieldFlag.NOT_NULL) === 0,
  };
}

const BLOB_TYPES = new Set<number>([
  FieldType.TINY_BLOB,
  FieldType.MEDIUM_BLOB,
  FieldType.LONG_BLOB,
  FieldType.BLOB,
]);

const SMALL_INT_TYPES = new Set<number>([
  FieldType.TINY,
  FieldType.SHORT,
  FieldType.LONG,
  FieldType.INT24,
  FieldType.YEAR,
]);

const TEMPORAL_TYPES = new Set<number>([
  FieldType.DATE,
  FieldType.NEWDATE,
  FieldType.DATETIME,
  FieldType.TIMESTAMP,
]);

export function decodeValue(
  bytes: Uint8Array | null,
  field: FieldMetadata,
  options: Required<ConversionOptions>,
): unknown {
  if (bytes === null) return null;

  /*
    Binary first, before any text decoding. BLOB and TEXT share a type code
    and are told apart only by charsetnr, so deciding on type alone would turn
    arbitrary bytes into replacement characters. BIT is bytes too.
  */
  if (field.type === FieldType.BIT) return bytes;
  if (field.binary && (BLOB_TYPES.has(field.type) ||
      field.type === FieldType.STRING ||
      field.type === FieldType.VAR_STRING ||
      field.type === FieldType.VARCHAR ||
      field.type === FieldType.GEOMETRY)) {
    return bytes;
  }

  const text = decoder.decode(bytes);

  switch (field.type) {
    case FieldType.TINY:
    case FieldType.SHORT:
    case FieldType.LONG:
    case FieldType.INT24:
    case FieldType.YEAR:
      /* These all fit a double exactly, even unsigned. */
      return Number(text);

    case FieldType.LONGLONG:
      /* BIGINT can exceed 2^53 in either direction, and BIGINT UNSIGNED goes
         past 2^63, so a number is only safe by accident. */
      return options.bigIntMode === "bigint" ? BigInt(text) : text;

    case FieldType.FLOAT:
    case FieldType.DOUBLE:
      return Number(text);

    case FieldType.DECIMAL:
    case FieldType.NEWDECIMAL:
      /* DECIMAL is exact by definition; a double is not. Text preserves the
         declared scale, including trailing zeros. */
      return options.decimalMode === "number" ? Number(text) : text;

    case FieldType.DATE:
    case FieldType.NEWDATE:
    case FieldType.DATETIME:
    case FieldType.TIMESTAMP:
      return options.dateMode === "date" ? toDate(text) : text;

    case FieldType.TIME:
      /* Never a Date: TIME is a signed duration that can exceed 24 hours and
         go negative, so there is no instant to convert it to. */
      return text;

    default:
      return text;
  }
}

/*
  MariaDB hands back "YYYY-MM-DD HH:MM:SS[.ffffff]" with no zone. Parsing it
  with the Date constructor would apply the host timezone inconsistently
  across engines, so the components are read explicitly and interpreted as
  UTC. Zero dates ("0000-00-00"), which MariaDB permits under a permissive
  SQL mode, have no Date representation and are left as text rather than
  silently becoming 1899 or Invalid Date.
*/
function toDate(text: string): Date | string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?)?$/.exec(text);
  if (!match) return text;

  const [, year, month, day, hour, minute, second, fraction] = match;
  if (year === "0000" || month === "00" || day === "00") return text;

  const ms = fraction ? Number(fraction.padEnd(3, "0").slice(0, 3)) : 0;
  return new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour ?? 0),
      Number(minute ?? 0),
      Number(second ?? 0),
      ms,
    ),
  );
}

const encoder = new TextEncoder();

export interface EncodedParameter {
  kind: "null" | "double" | "text" | "binary";
  bytes?: Uint8Array;
  value?: number;
}

/*
  Parameter encoding. Integers go as text so the server parses them in the
  column's own type — exact for BIGINT, and the same path the text protocol
  takes. Only genuinely fractional numbers are bound as doubles, where the
  double is already the value's true precision.
*/
export function encodeParameter(value: unknown): EncodedParameter {
  if (value === null || value === undefined) return { kind: "null" };

  if (typeof value === "bigint")
    return { kind: "text", bytes: encoder.encode(value.toString()) };

  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError(
        `cannot bind ${value}: MariaDB has no representation for it`,
      );
    if (Number.isInteger(value))
      return { kind: "text", bytes: encoder.encode(value.toFixed(0)) };
    return { kind: "double", value };
  }

  if (typeof value === "boolean")
    return { kind: "text", bytes: encoder.encode(value ? "1" : "0") };

  if (typeof value === "string")
    return { kind: "text", bytes: encoder.encode(value) };

  if (value instanceof Uint8Array) return { kind: "binary", bytes: value };

  if (value instanceof ArrayBuffer)
    return { kind: "binary", bytes: new Uint8Array(value) };

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime()))
      throw new TypeError("cannot bind an Invalid Date");
    /* UTC, matching how dateMode: "date" decodes, so a value read back and
       written again is unchanged. Microseconds are not representable in a JS
       Date, so millisecond precision is the honest limit here. */
    const iso = value.toISOString();
    return {
      kind: "text",
      bytes: encoder.encode(`${iso.slice(0, 10)} ${iso.slice(11, 23)}`),
    };
  }

  throw new TypeError(
    `cannot bind a value of type ${Object.prototype.toString.call(value)}`,
  );
}

export function resolveConversion(
  options: ConversionOptions,
): Required<ConversionOptions> {
  return {
    bigIntMode: options.bigIntMode ?? "bigint",
    decimalMode: options.decimalMode ?? "string",
    dateMode: options.dateMode ?? "string",
  };
}
