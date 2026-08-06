/*
  Shared case definitions for the differential suite.

  Each case is a list of statements run in order on one fresh connection. The
  cases lean deliberately on the places where a port is most likely to differ
  quietly: exact numerics, binary data, dates, NULL handling, and the error
  numbers a test suite asserts on. Anything nondeterministic — NOW(), UUID(),
  AUTO_INCREMENT values that depend on prior state — is avoided rather than
  normalised away later, because normalisation is where real differences hide.
*/

export const cases = [
  {
    name: "scalar expressions",
    statements: [
      "SELECT 1 AS one, -1 AS neg, 0 AS zero",
      "SELECT 'text' AS s, '' AS empty, NULL AS n",
      "SELECT 1+1 AS sum, 7/2 AS div, 7 DIV 2 AS intdiv, 7%3 AS mod",
      "SELECT CONCAT('a', 'b') AS c, LENGTH('abc') AS len, UPPER('mix') AS up",
      "SELECT NULL IS NULL AS is_null, '' IS NULL AS empty_is_null",
    ],
  },
  {
    name: "integer boundaries",
    statements: [
      `CREATE TABLE ints (
         id INT NOT NULL,
         t TINYINT, tu TINYINT UNSIGNED,
         s SMALLINT, su SMALLINT UNSIGNED,
         i INT, iu INT UNSIGNED,
         b BIGINT, bu BIGINT UNSIGNED,
         PRIMARY KEY (id)
       ) ENGINE=InnoDB`,
      `INSERT INTO ints VALUES
         (1, -128, 0, -32768, 0, -2147483648, 0,
             -9223372036854775808, 0),
         (2, 127, 255, 32767, 65535, 2147483647, 4294967295,
             9223372036854775807, 18446744073709551615)`,
      "SELECT * FROM ints ORDER BY id",
      "SELECT b+0 AS b0, bu+0 AS bu0 FROM ints ORDER BY id",
    ],
  },
  {
    name: "decimal precision",
    statements: [
      `CREATE TABLE dec_t (
         id INT NOT NULL, d DECIMAL(30,10), small DECIMAL(4,2),
         PRIMARY KEY (id)
       ) ENGINE=InnoDB`,
      `INSERT INTO dec_t VALUES
         (1, 12345678901234567890.1234567890, 1.00),
         (2, -0.0000000001, -99.99),
         (3, 0, 0.00)`,
      "SELECT * FROM dec_t ORDER BY id",
      "SELECT d+0 AS sum, d*2 AS doubled FROM dec_t ORDER BY id",
      "SELECT SUM(d) AS total, AVG(small) AS mean FROM dec_t",
    ],
  },
  {
    name: "floating point",
    statements: [
      `CREATE TABLE floats (
         id INT NOT NULL, f FLOAT, d DOUBLE, PRIMARY KEY (id)
       ) ENGINE=InnoDB`,
      "INSERT INTO floats VALUES (1, 0.5, 0.5), (2, -0.25, -1e100), (3, 0, -0.0)",
      "SELECT * FROM floats ORDER BY id",
    ],
  },
  {
    name: "strings, binary and NUL bytes",
    statements: [
      `CREATE TABLE strs (
         id INT NOT NULL,
         v VARCHAR(64), b VARBINARY(64), t TEXT, bl BLOB,
         PRIMARY KEY (id)
       ) ENGINE=InnoDB`,
      `INSERT INTO strs VALUES
         (1, 'ascii', X'00', 'text', X'0001FF'),
         (2, '', X'', '', X''),
         (3, NULL, NULL, NULL, NULL),
         (4, 'héllo wörld ☃', X'DEADBEEF', 'multi\nline', X'00FF00')`,
      "SELECT * FROM strs ORDER BY id",
      "SELECT HEX(b) AS hb, HEX(bl) AS hbl, LENGTH(v) AS lv, CHAR_LENGTH(v) AS cv FROM strs ORDER BY id",
      "SELECT v IS NULL AS v_null, b IS NULL AS b_null FROM strs ORDER BY id",
    ],
  },
  {
    name: "date and time",
    statements: [
      `CREATE TABLE dates (
         id INT NOT NULL,
         d DATE, dt DATETIME, dt6 DATETIME(6),
         ts TIMESTAMP NULL, t TIME, t6 TIME(6), y YEAR,
         PRIMARY KEY (id)
       ) ENGINE=InnoDB`,
      `INSERT INTO dates VALUES
         (1, '2026-01-02', '2026-01-02 03:04:05',
             '2026-01-02 03:04:05.123456', '2026-01-02 03:04:05',
             '03:04:05', '03:04:05.123456', 2026),
         (2, '1000-01-01', '1000-01-01 00:00:00',
             '1000-01-01 00:00:00.000001', NULL,
             '-838:59:59', '838:59:58.999999', 1901)`,
      "SELECT * FROM dates ORDER BY id",
      "SELECT DATE_ADD(dt6, INTERVAL 1 MICROSECOND) AS plus FROM dates ORDER BY id",
      "SELECT EXTRACT(MICROSECOND FROM dt6) AS us, DAYOFWEEK(d) AS dow FROM dates ORDER BY id",
    ],
  },
  {
    name: "transactions and savepoints",
    statements: [
      "CREATE TABLE tx (id INT PRIMARY KEY, v INT NOT NULL) ENGINE=InnoDB",
      "INSERT INTO tx VALUES (1, 10)",
      "START TRANSACTION",
      "UPDATE tx SET v = 20 WHERE id = 1",
      "SELECT v FROM tx WHERE id = 1",
      "SAVEPOINT sp",
      "UPDATE tx SET v = 30 WHERE id = 1",
      "SELECT v FROM tx WHERE id = 1",
      "ROLLBACK TO SAVEPOINT sp",
      "SELECT v FROM tx WHERE id = 1",
      "ROLLBACK",
      "SELECT v FROM tx WHERE id = 1",
      "START TRANSACTION",
      "UPDATE tx SET v = 40 WHERE id = 1",
      "COMMIT",
      "SELECT v FROM tx WHERE id = 1",
    ],
  },
  {
    name: "affected rows and insert id",
    statements: [
      `CREATE TABLE ai (
         id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
         v INT NOT NULL, PRIMARY KEY (id)
       ) ENGINE=InnoDB`,
      "INSERT INTO ai(v) VALUES (1)",
      "INSERT INTO ai(v) VALUES (2), (3), (4)",
      "UPDATE ai SET v = v + 1 WHERE id > 1",
      "UPDATE ai SET v = v WHERE id > 1",
      "DELETE FROM ai WHERE id = 1",
      "REPLACE INTO ai(id, v) VALUES (2, 99)",
      "INSERT INTO ai(id, v) VALUES (2, 5) ON DUPLICATE KEY UPDATE v = 7",
      "SELECT * FROM ai ORDER BY id",
    ],
  },
  {
    name: "errors",
    statements: [
      "CREATE TABLE e (id INT PRIMARY KEY, u VARCHAR(16) UNIQUE) ENGINE=InnoDB",
      "INSERT INTO e VALUES (1, 'a')",
      /* 1062 duplicate key on the primary. */
      "INSERT INTO e VALUES (1, 'b')",
      /* 1062 duplicate key on the unique index. */
      "INSERT INTO e VALUES (2, 'a')",
      /* 1146 no such table. */
      "SELECT * FROM nope",
      /* 1054 unknown column. */
      "SELECT missing FROM e",
      /* 1064 parse error. */
      "SELECT FROM WHERE",
      /* 1364 no default for a NOT NULL column. */
      "INSERT INTO e(u) VALUES ('c')",
      /* 1265/1366 out of range, depending on SQL mode. */
      "INSERT INTO e VALUES (3, 'way too long a value for this column')",
      /* 1051 unknown table on drop. */
      "DROP TABLE definitely_not_here",
      /* The connection must still be usable after all of that. */
      "SELECT COUNT(*) AS n FROM e",
    ],
  },
  {
    name: "foreign keys",
    statements: [
      "CREATE TABLE p (id INT PRIMARY KEY) ENGINE=InnoDB",
      `CREATE TABLE c (
         id INT PRIMARY KEY, pid INT NOT NULL,
         FOREIGN KEY (pid) REFERENCES p(id) ON DELETE CASCADE
       ) ENGINE=InnoDB`,
      "INSERT INTO p VALUES (1), (2)",
      "INSERT INTO c VALUES (1, 1), (2, 2)",
      /* 1452 referenced row missing. */
      "INSERT INTO c VALUES (3, 99)",
      /* 1451 parent row still referenced (no cascade on this direction). */
      "DELETE FROM p WHERE id = 1",
      "SELECT * FROM c ORDER BY id",
      "SELECT COUNT(*) AS n FROM c",
    ],
  },
  {
    name: "joins, grouping and window functions",
    statements: [
      "CREATE TABLE a (id INT PRIMARY KEY, g INT NOT NULL, v INT) ENGINE=InnoDB",
      "CREATE TABLE b (id INT PRIMARY KEY, aid INT) ENGINE=InnoDB",
      "INSERT INTO a VALUES (1,1,10),(2,1,20),(3,2,30),(4,2,NULL)",
      "INSERT INTO b VALUES (1,1),(2,1),(3,3),(4,NULL)",
      "SELECT a.id, b.id AS bid FROM a JOIN b ON b.aid = a.id ORDER BY a.id, bid",
      "SELECT a.id, b.id AS bid FROM a LEFT JOIN b ON b.aid = a.id ORDER BY a.id, bid",
      "SELECT g, COUNT(*) AS n, SUM(v) AS s, AVG(v) AS m, MIN(v) AS lo, MAX(v) AS hi FROM a GROUP BY g ORDER BY g",
      "SELECT g, COUNT(v) AS non_null, COUNT(*) AS all_rows FROM a GROUP BY g ORDER BY g",
      "SELECT id, g, ROW_NUMBER() OVER (PARTITION BY g ORDER BY id) AS rn, SUM(v) OVER (PARTITION BY g) AS gsum FROM a ORDER BY id",
      "WITH cte AS (SELECT g, SUM(v) AS s FROM a GROUP BY g) SELECT * FROM cte ORDER BY g",
    ],
  },
  {
    name: "json and generated columns",
    statements: [
      `CREATE TABLE j (
         id INT PRIMARY KEY,
         doc JSON,
         name VARCHAR(32) AS (JSON_UNQUOTE(JSON_EXTRACT(doc, '$.name'))) STORED,
         n INT AS (JSON_EXTRACT(doc, '$.n')) VIRTUAL
       ) ENGINE=InnoDB`,
      `INSERT INTO j(id, doc) VALUES
         (1, '{"name":"first","n":1}'),
         (2, '{"name":"second","n":2,"nested":{"k":[1,2,3]}}'),
         (3, NULL)`,
      "SELECT id, doc, name, n FROM j ORDER BY id",
      "SELECT id, JSON_VALID(doc) AS ok, JSON_TYPE(doc) AS ty FROM j ORDER BY id",
      "SELECT JSON_EXTRACT(doc, '$.nested.k[1]') AS k FROM j WHERE id = 2",
    ],
  },
  {
    name: "enum, set and bit",
    statements: [
      `CREATE TABLE es (
         id INT PRIMARY KEY,
         e ENUM('a','b','c'),
         s SET('x','y','z'),
         bt BIT(8)
       ) ENGINE=InnoDB`,
      "INSERT INTO es VALUES (1,'b','x,z',b'10101010'), (2,NULL,'',b'0'), (3,'a','x,y,z',b'11111111')",
      "SELECT id, e, s, HEX(bt) AS hb FROM es ORDER BY id",
      "SELECT e+0 AS eord, s+0 AS sbits FROM es ORDER BY id",
    ],
  },
  {
    name: "null ordering and comparison",
    statements: [
      "CREATE TABLE n (id INT PRIMARY KEY, v INT) ENGINE=InnoDB",
      "INSERT INTO n VALUES (1, 1), (2, NULL), (3, 0), (4, NULL)",
      "SELECT * FROM n ORDER BY v, id",
      "SELECT * FROM n ORDER BY v DESC, id",
      "SELECT id, v <=> NULL AS ns, v = NULL AS eq FROM n ORDER BY id",
      "SELECT COUNT(*) AS all_rows, COUNT(v) AS non_null FROM n",
      "SELECT DISTINCT v FROM n ORDER BY v",
    ],
  },
];

/* Hex-encodes the case list into the runner's input format. */
export function encodeCases(list) {
  const encoder = new TextEncoder();
  const chunks = [];
  for (const testCase of list) {
    const lines = testCase.statements.map((sql) =>
      [...encoder.encode(sql)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    );
    chunks.push(lines.join("\n"));
  }
  /* Blank line between cases; the runner treats it as a connection boundary. */
  return chunks.join("\n\n") + "\n";
}
