# Licensing checkpoint

Recorded, not concluded. Nothing here is legal advice and none of it should be
read as clearance to publish.

## What the artifact contains

`dist/mariadb.wasm` is statically linked from MariaDB Server sources. MariaDB
Server's repository states the server is licensed under **GPLv2**. The wasm
module therefore contains GPLv2-licensed code, and so does the native
reference build.

Also linked in: MariaDB Connector/C (LGPL 2.1), wolfSSL (GPLv2 in this
configuration), PCRE2 (BSD), zlib (zlib licence). The Connector/C and wolfSSL
copies come from MariaDB's own bundled trees at the pinned revision.

`native/`, `package/`, `scripts/`, `tests/` and `docs/` in this repository are
original work.

## Current status

| Question | Answer today |
|---|---|
| Is the artifact internal-only? | **Yes.** Nothing is published. There is no npm publish step, and `package/package.json` sets `"private": true` |
| Will it be published? | **Not decided.** This must not happen by accident |
| Is the source available? | Yes. MariaDB is fetched from upstream at a pinned tag, and every modification is a reviewable patch in `scripts/02b-patch-mariadb.sh` rather than an edit buried in a vendored tree |
| Are the modifications documented? | Yes — `docs/portability-matrix.md`, and each patch carries its rationale inline |
| Licence metadata | `package/package.json` declares `"license": "GPL-2.0-only"` |
| Licence notices shipped with the artifact | Yes. `dist/licenses/` carries GPLv2, LGPL 2.1, wolfSSL, zlib and MariaDB's THIRDPARTY, with a README naming each component |
| Reviewed by counsel or under an organisation licensing policy | **No** |

## Before anything is published

1. Remove `"private": true` only as a deliberate act, never as a side effect.
2. ~~Ship the MariaDB `COPYING` file and the third-party notices alongside
   `dist/`.~~ Done — `dist/licenses/`.
3. Confirm how the GPLv2 obligations apply to a statically linked WebAssembly
   artifact distributed via npm, and how the corresponding source is offered.
4. Get that confirmation from qualified counsel or the organisation's
   licensing policy, and record the outcome here.

This checkpoint deliberately does not block internal technical work, which is
all that has happened so far.
