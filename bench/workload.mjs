/*
  The workload, shared by both backends so the only variable is the platform.

  Shaped like an application test suite rather than a throughput benchmark:
  a schema with foreign keys and indexes, then many small tests that each do a
  handful of writes and reads inside a transaction that is rolled back. That
  rollback-per-test pattern is what most suites actually use, and it is
  available identically on a server and on the embedded build, so neither side
  is being handicapped.

  Deliberately *not* measured here: 1000 x SELECT 1. Raw query throughput is
  not what dominates a test suite — obtaining an isolated database is.
*/

export const SCHEMA = [
  `CREATE TABLE orgs (
     id INT UNSIGNED NOT NULL AUTO_INCREMENT,
     name VARCHAR(128) NOT NULL,
     created_at DATETIME(6) NOT NULL,
     PRIMARY KEY (id),
     UNIQUE KEY uq_orgs_name (name)
   ) ENGINE=InnoDB`,

  `CREATE TABLE users (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     org_id INT UNSIGNED NOT NULL,
     email VARCHAR(255) NOT NULL,
     display_name VARCHAR(128),
     balance DECIMAL(20,4) NOT NULL DEFAULT 0,
     created_at DATETIME(6) NOT NULL,
     PRIMARY KEY (id),
     UNIQUE KEY uq_users_email (email),
     KEY ix_users_org (org_id),
     CONSTRAINT fk_users_org FOREIGN KEY (org_id) REFERENCES orgs(id)
       ON DELETE CASCADE
   ) ENGINE=InnoDB`,

  `CREATE TABLE memberships (
     user_id BIGINT UNSIGNED NOT NULL,
     org_id INT UNSIGNED NOT NULL,
     role ENUM('owner','admin','member') NOT NULL DEFAULT 'member',
     PRIMARY KEY (user_id, org_id),
     KEY ix_memberships_org (org_id),
     CONSTRAINT fk_mem_user FOREIGN KEY (user_id) REFERENCES users(id)
       ON DELETE CASCADE,
     CONSTRAINT fk_mem_org FOREIGN KEY (org_id) REFERENCES orgs(id)
       ON DELETE CASCADE
   ) ENGINE=InnoDB`,

  `CREATE TABLE events (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     user_id BIGINT UNSIGNED NOT NULL,
     kind VARCHAR(64) NOT NULL,
     payload VARBINARY(256),
     at DATETIME(6) NOT NULL,
     PRIMARY KEY (id),
     KEY ix_events_user_at (user_id, at),
     CONSTRAINT fk_events_user FOREIGN KEY (user_id) REFERENCES users(id)
       ON DELETE CASCADE
   ) ENGINE=InnoDB`,

  `CREATE TABLE sessions (
     token CHAR(43) NOT NULL,
     user_id BIGINT UNSIGNED NOT NULL,
     expires_at DATETIME NOT NULL,
     PRIMARY KEY (token),
     KEY ix_sessions_user (user_id),
     CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id)
       ON DELETE CASCADE
   ) ENGINE=InnoDB`,
];

/* Seed rows every test builds on, inserted once per worker after the schema. */
export const SEED = [
  ["INSERT INTO orgs(name, created_at) VALUES (?, ?)", ["acme", "2026-01-01 00:00:00.000000"]],
];

/*
  One test. 12 statements: writes across four tables with foreign keys, an
  indexed read, a join, an aggregate, an update and a cascading delete.

  `db` is the adapter interface: query(sql), execute(sql, params), begin(),
  rollback(). Both backends implement it, and the SQL is byte-identical.
*/
export async function runTest(db, n) {
  await db.begin();
  try {
    const email = `user${n}@example.com`;

    await db.execute(
      "INSERT INTO users(org_id, email, display_name, balance, created_at)" +
        " VALUES (1, ?, ?, ?, ?)",
      [email, `User ${n}`, "10.2500", "2026-01-02 03:04:05.123456"],
    );

    const [found] = await db.execute(
      "SELECT id, balance FROM users WHERE email = ?",
      [email],
    );
    const userId = found[0].id;

    await db.execute(
      "INSERT INTO memberships(user_id, org_id, role) VALUES (?, 1, ?)",
      [userId, "admin"],
    );

    for (let i = 0; i < 3; i++) {
      await db.execute(
        "INSERT INTO events(user_id, kind, payload, at) VALUES (?, ?, ?, ?)",
        [userId, `kind.${i}`, Buffer.from([0, 1, 2, 255]), "2026-01-02 03:04:05.000001"],
      );
    }

    await db.execute(
      "INSERT INTO sessions(token, user_id, expires_at) VALUES (?, ?, ?)",
      [String(n).padStart(43, "t"), userId, "2026-02-01 00:00:00"],
    );

    /* A join with an aggregate — the shape most app queries actually take. */
    await db.execute(
      "SELECT u.id, u.email, o.name, COUNT(e.id) AS events" +
        " FROM users u" +
        " JOIN orgs o ON o.id = u.org_id" +
        " LEFT JOIN events e ON e.user_id = u.id" +
        " WHERE u.id = ? GROUP BY u.id, u.email, o.name",
      [userId],
    );

    await db.execute(
      "UPDATE users SET balance = balance + ? WHERE id = ?",
      ["5.5000", userId],
    );

    await db.execute("SELECT COUNT(*) AS n FROM events WHERE user_id = ?", [userId]);

    /* Exercises ON DELETE CASCADE across three child tables. */
    await db.execute("DELETE FROM users WHERE id = ?", [userId]);
  } finally {
    /* Every test rolls back — this is the isolation mechanism, and it is the
       same on both sides. */
    await db.rollback();
  }
}

export const STATEMENTS_PER_TEST = 12;
