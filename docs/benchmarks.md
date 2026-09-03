# Test-suite benchmark

Does this actually make a test suite faster than running a MySQL server? Run
`node bench/run.mjs`.

The comparison is deliberately about **deployment model, not engine**: the same
SQL, the same isolation strategy, the same relaxed durability on both sides.
Raw query throughput is not measured, because it is not what dominates a test
suite — obtaining an isolated database is.

## Setup

| | |
|---|---|
| Baseline | MySQL 8.0.42 in Docker, `--innodb-flush-log-at-trx-commit=0 --innodb-doublewrite=0 --skip-log-bin --performance-schema=OFF` |
| Client | `mysql2`, i.e. what a real suite uses |
| Workload | 5 tables with foreign keys and indexes; 12 statements per test — writes across four tables, an indexed read, a join with an aggregate, an update, a cascading delete |
| Isolation | Transaction-rollback per test, identical on both sides |
| Partitioning | Server: one database per worker. Embedded: one instance per worker |
| Host | macOS 26.5.2, arm64, Node 26.5.0 |

Durability is levelled down to the embedded build's settings so the server is
not penalised for guarantees the embedded build does not offer.

## Results

| suite | backend | cold | setup | tests | wall | **total** | peak RSS |
|---|---|---|---|---|---|---|---|
| 100 tests, 1 worker | embedded | — | 271 ms | 390 ms | 897 ms | **0.90 s** | 642 MB |
| 100 tests, 1 worker | mysql | 5790 ms | 78 ms | 146 ms | 240 ms | **6.03 s** | 1281 MB |
| 400 tests, 4 workers | embedded | — | 529 ms | 327 ms | 1092 ms | **1.09 s** | 1749 MB |
| 400 tests, 4 workers | mysql | 5790 ms | 151 ms | 238 ms | 412 ms | **6.20 s** | 1305 MB |
| 2000 tests, 4 workers | embedded | — | 608 ms | 1125 ms | 1971 ms | **1.97 s** | 1834 MB |
| 2000 tests, 4 workers | mysql | 6523 ms | 150 ms | 990 ms | 1160 ms | **7.68 s** | 1338 MB |

`cold` is from `docker run` to the first query a test could issue — polled with
a real connection, because "container started" and "accepts queries" are
different moments and the gap is most of the cost.

## What it says

**The embedded build wins on total wall clock, by 4–7x, entirely because of
cold start.** 5.8–6.5 seconds of container startup is paid on every CI run and
never amortises. The embedded build has no equivalent: its module load is
inside per-worker setup, ~270–600 ms.

**The server is faster per test, but by less than expected, and the gap
closes.** Per-test cost:

| suite | embedded | mysql | ratio |
|---|---|---|---|
| 100 tests, 1 worker | 3.90 ms | 1.46 ms | 2.7x |
| 400 tests, 4 workers | 3.27 ms | 2.38 ms | 1.4x |
| 2000 tests, 4 workers | 2.25 ms | 1.98 ms | 1.1x |

Two effects pull in opposite directions: the embedded build has a fixed warm-up
that amortises over more tests, while the server contends more as workers are
added. By 2000 tests they are within 14% of each other.

**Memory is comparable.** ~1.8 GB peak for four embedded workers against
~1.3 GB for the Node process plus the container. Not the advantage, but not the
obstacle it looked like either.

**Break-even is far out and moves.** The tool prints an extrapolation, but at
these sizes it lands between ~2,000 and ~90,000 tests depending on suite size
and worker count — precisely because both per-test figures shift. Treat it as
"you are unlikely to reach it", not as a threshold. Run your own sizes.

## When it is not the right choice

- **A long-lived shared server you never restart.** If the container is already
  up and stays up across many runs, cold start disappears from the comparison
  and the server is modestly faster per test.
- **Suites that need features the embedded build does not have** — enforced
  privileges, named time zones, replication. See
  `docs/unsupported-features.md`.
- **Very high worker counts.** Each embedded instance is ~230 MB, so memory
  becomes the limit before CPU does.

## Caveats

- One host, one run each. No repetition or confidence intervals; treat single
  figures as indicative.
- MySQL 8.0 against MariaDB 11.4 — different engines. That is deliberate (it is
  what you would actually be replacing) but it means per-test differences are
  not purely attributable to wasm.
- Docker on macOS runs in a VM, which inflates both cold start and network
  round trips relative to Linux CI. On a Linux runner with a warm image cache,
  expect the server's cold start to be lower and its per-test cost better.
  This is the most important caveat if your CI is Linux.
