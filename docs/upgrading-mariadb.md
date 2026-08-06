# Upgrading the pinned MariaDB revision

The revision is pinned in `scripts/01-fetch-mariadb.sh` (`MARIADB_TAG`), and
recorded in `docs/source-inventory.md` and every `dist/build-manifest.json`.

## Steps

1. **Change the pin.**

   ```bash
   MARIADB_TAG=mariadb-11.4.5 bash scripts/01-fetch-mariadb.sh
   ```

   Against an existing checkout, fetch and check out the tag by hand — the
   script only clones when `mariadb/.git` is absent.

2. **Re-apply the patches.** `scripts/02b-patch-mariadb.sh` is idempotent and
   anchor-based: it reports each patch as applied or already applied, and exits
   non-zero with `PATCH FAILED - anchor not found` if upstream moved the code.
   That failure is the signal to re-derive the patch, and it is deliberately
   loud rather than a silent no-op.

3. **Rebuild the host generators.** They embed version-specific data —
   `errmsg.sys` in particular must match the server:

   ```bash
   rm -rf build/host && bash scripts/02-build-host-tools.sh
   ```

4. **Rebuild the native reference and confirm it is still green** before
   touching wasm. A behaviour change here is upstream's, not the port's:

   ```bash
   rm -rf build/native
   bash scripts/10-build-native-reference.sh
   bash scripts/11-run-native-smoke.sh
   bash scripts/12-run-abi-smoke.sh
   ```

5. **Reconfigure and rebuild wasm.** `03` deletes `build/wasm` itself.

   ```bash
   bash scripts/03-configure-wasm.sh
   bash scripts/04-build-wasm.sh
   bash scripts/05-link-wasm-module.sh release
   ```

6. **Rebuild the datadir template** — not yet applicable, since the datadir is
   currently empty by design. Once a template exists it is version-specific and
   must be regenerated here.

7. **Run the differential suite.** This is the real acceptance gate for an
   upgrade: it compares the new native build against the new wasm build, so a
   behaviour change that affects both is *not* flagged.

   ```bash
   bash scripts/13-run-differential.sh
   ( cd package && npm test )
   ```

## What to review after an upgrade

- **Newly enabled plugins.** Diff the merge list against
  `docs/plugin-matrix.md`:

  ```bash
  grep -o 'lib[a-z0-9_]*\.a' build/wasm/build.ninja | sort -u
  ```

  A new engine appearing silently is how artifact size grows and how an
  untested code path gets shipped.

- **ABI changes.** `native/include/mariadb_wasm.h` is ours and does not move,
  but the MariaDB C API it wraps can. Watch for changes to `MYSQL_FIELD`,
  `MYSQL_BIND` and the statement API.

- **New detection results.** Diff `build/wasm/include/my_config.h` against the
  previous build. A `HAVE_*` that flipped is the most likely source of a new
  compile failure, and the most likely source of a silent behaviour change.

- **The manifest.** `dist/build-manifest.json` records the revision, toolchain
  versions and a hash of the build scripts. Any cache keyed on it invalidates
  automatically.
