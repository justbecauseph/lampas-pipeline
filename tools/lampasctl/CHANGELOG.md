# lampasctl Changelog

All notable changes to the `lampasctl` command-line distribution tool are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.7] - 2026-10-10

### Fixed
- `lampasctl check-updates` now checks shader (`shaderpacks/`, `shaders/`) and resource pack (`resourcepacks/`) descriptors, not only `mods/`.
- Modrinth update queries use the loader tag for each artifact type (`iris` for shaders, `minecraft` for resource packs). CurseForge queries for non-mod artifacts no longer filter by the Fabric loader. Update links point to the matching shader or resource pack section.

## [1.0.6] - 2026-10-06

### Added
- Typed `pack.toml` blacklist rules for descriptor, upstream project, and exact release IDs in `lampasctl check-updates`.
- `lampasctl validate` checks blacklist structure and placement and rejects matching descriptor pins and lockfile artifacts.
- `lampasctl check-updates --force` to ignore blacklist matches for one invocation, with explicit console and Markdown diagnostics.
- Fresh Markdown update reports for zero-update scans and workflow update detection based on changed mod descriptors.

## [1.0.5] - 2026-09-05

### Added
- Dedicated server Fabric runtime provisioning (`tools/lampasctl/src/fabric-runtime.ts`):
  - Resolves exact-version Fabric server launcher JAR from Fabric Meta `/v2/versions/loader/{minecraft}/{loaderVersion}/{installerVersion}/server/jar`.
  - Pinned default Fabric server installer version to latest stable (`1.1.2`).
  - Strict Minecraft 26.2 scope boundary enforcement (fails closed on unsupported Minecraft versions).
  - Deep archive structure validation (`validateFabricServerLauncherJar`): verifies valid ZIP format, checks `META-INF/MANIFEST.MF` declaring `Main-Class: net.fabricmc.installer.ServerLauncher`, and strictly parses mandatory `install.properties` verifying matching `fabric-loader-version` and `game-version`.
  - Staged atomic deployment into `.lampas/runtime/.tmp-staging/` before activating to `<serverDir>/.lampas/runtime/fabric-server-launch.jar`.
  - Server runtime state tracking in `<serverDir>/.lampas/runtime/runtime.json` and `.lampas/installation.json`.
  - Fast/full verification modes for server runtime: fast reuses matching metadata and file; full recomputes SHA-256 and re-downloads if corrupt.
- Transactional deployment rollback architecture (`tools/lampasctl/src/transaction.ts`):
  - Added `DeploymentTransaction` managing `.lampas/.tx-rollback/`.
  - Mandatory atomic journal persistence via temporary sibling and atomic file replacement before disk mutations.
  - Snapshots modified files, deleted files, `server.properties`, `installation.json`, and `.lampas/runtime/` prior to mutations.
  - Automatically rolls back changes on mid-flight failure, restoring previous coherent release state (reverting modified files, purging newly added files, restoring previous runtime JAR, runtime.json, installation.json, and server.properties).
  - Explicit commit point: unlinks `journal.json` as the atomic transaction commit point before cleaning up rollback directories.
  - Fail-closed crash recovery: `validateJournalData` strictly verifies journal structure, target directory, boolean properties, relative paths, and forbids path traversal (`..`, `.`) or `.lampas` directory tampering before performing disk mutations.
  - Preflight backup validation: `rollbackFromDir` verifies that all backups for overwritten/deleted files, `server.properties`, runtime JAR/state, and `installation.json` exist and are regular readable files before the first restoration mutation; missing backups abort rollback immediately and preserve `journal.json`.
  - Non-swallowed rollback errors: file removal and restoration errors throw rather than being caught and ignored, preserving `journal.json` on disk to fail closed.
  - Standalone `lampasctl recover --target <path>` command for operators and automated recovery.
  - Defers writing `installation.json` until *after* runtime activation succeeds.
- Cross-validation between release descriptor and server manifest in `deployServer()` preventing runtime version mismatches.
- Unit and integration tests for Fabric server runtime resolver, upgrade flow, failure atomicity, transactional rollback on activation failure, standalone/fail-closed crash recovery, and `start.py` managed runtime launch.
- Authoritative loader definition validation (`validateLoaderDefinition`): ensures `pack.toml [loader]` defines valid type (`fabric`) and non-empty `version`.
- Fabric Meta API compatibility verification (`verifyFabricLoaderCompatibility`): queries `/v2/versions/loader/{minecraft}/{loaderVersion}` to guarantee loader and Minecraft compatibility before publishing releases.
- Strict `loader.maven` and `intermediary.maven` coordinate validation for Fabric Meta API responses.
- Differentiated Fabric Meta error responses: 404 (non-existent pair, fails immediately without retry), 5xx (transient service unavailability, automatic retry), and network/timeout failures (automatic retry).
- Finite timeout and retry policy for upstream Fabric Meta queries.
- Lockfile and manifest consistency enforcement: rejects manifest generation and validation if `pack.lock.json` runtime metadata differs from `pack.toml`.
- Descriptor consistency assertion in release publishing: verifies client manifest, server manifest, and release descriptor declare identical Minecraft and Fabric Loader versions.
- Extended schema test suite asserting runtime invariants across pack definitions, manifests, lockfile, and release descriptors.

### Changed
- Refactored `deployServer()` to stage Fabric server runtime prior to server pack synchronization and manage file changes under a `DeploymentTransaction`. If runtime activation fails, deployment cleanly rolls back to the previous coherent state.
- Updated `tools/scripts/start.py` to launch exclusively from Lampas-managed `.lampas/runtime/fabric-server-launch.jar`, completely removing legacy glob-first JAR discovery (`fabric-server-*.jar` and `server.jar`).
- Ensured all launch paths (including `--no-sync` and `--allow-stale`) check for interrupted deployment transaction journals, executing `lampasctl recover` and failing closed if recovery fails or `lampasctl` is missing.
- Ensured `--no-sync` strictly respects managed runtime location and launches existing coherent installation.
- Tightened `schemas/pack.schema.json` with `minLength: 1` and `additionalProperties: false` on loader object.
- Added `checkFabricMeta` verification to `lampasctl validate` and `lampasctl manifest`, and documented `--skip-meta-check` in CLI help.
- Converted unit test suite to be hermetic with mocked Fabric Meta responses, providing an optional live network smoke test (`RUN_LIVE_FABRIC_META_TESTS=true`).

## [1.0.4] - 2026-09-04

### Added
- Comprehensive JSON schema definitions for modpack artifacts, definitions, lockfiles, manifests, releases, and config patches (`schemas/`).
- Automated in-file `#:schema` header injection in `writeTomlFile` and `inferTomlSchemaHeader` for `pack.toml` and artifact definitions (`pack/mods/`, `pack/resourcepacks/`, `pack/shaderpacks/`).
- Automatic `$schema` reference inclusion in generated lockfiles (`pack.lock.json`).
- Schema validation test coverage asserting schema conformity for all repository definitions and IDE configurations (`test/schemas.test.ts`).

### Changed
- Unconditionally emit `PackManifest` schema version 2 across both client and server manifests (`PACK_MANIFEST_SCHEMA_VERSION = 2`).

## [1.0.3] - 2026-09-04

### Added
- Managed client configuration patch architecture supporting property-level config modifications without overwriting entire files (`pack/config-patches/client.json`).
- Config patch adapters for `json`, `jsonc`, `yaml`, `toml`, `properties`, `ini`, and `text` formats.
- Support for `set`, `remove`, and literal string replacement (`replaceLiteral`) operations.
- Granular patch modes (`enforce` and `once`) and missing-file policies (`defer` and `create`).
- Strict config patch validation (`validateConfigPatches`): path traversal guards, unique patch ID assertions, and adapter-specific constraints.
- Strict config ownership conflict detection preventing files from simultaneously existing as a whole-file `MANAGED` artifact and a managed config-patch target.

### Changed
- Manifest generation (`buildManifests`) now validates and emits `configPatches` into `client-manifest.json` while excluding patch targets from the client `files` list.

## [1.0.2] - 2026-09-01

### Added
- Unit tests for mod addition and version resolution in `test/manager.test.ts`.

### Changed
- Improved Modrinth version resolution in `lampasctl add` by prioritizing game version (`targetMc`) and loader (`targetLoader`) compatibility across candidate matches.

### Fixed
- Fixed exact version ID matching for Modrinth base62 version identifiers.
- Added direct API fallback (`/v2/version/<id>`) when candidate matching does not locate an explicit version ID.

## [1.0.1] - 2026-08-27

### Added
- Automated world backup retention management with `maxBackups` limit (defaults to retaining the 2 newest backups per label and pruning expired archives).

## [1.0.0] - 2026-08-26

### Added
- Unified server deployment command `lampasctl deploy` with `--channel`, `--version`, `--target`, `--portal`, `--verify`, and `--no-backup` options.
- Remote release channel resolution (`dev`, `beta`, `stable`) and version resolution against Lampas Portal (`release-resolver.ts`).
- Automated pre-mutation world backups (`backup.ts`) with collision-safe millisecond timestamps and disambiguation indexes.
- Direct-to-S3 presigned PUT blob uploads with immutable cache-control headers (`public, max-age=31536000, immutable`).
- Target-aware path safety rules (`CLIENT_PROTECTED` and `SERVER_PROTECTED`) preventing managed files from overwriting critical server paths (such as `server.properties`, `eula.txt`, `whitelist.json`, `ops.json`, `world/`, `logs/`, `crash-reports/`, and `.backups/`).
- Strict runtime manifest validation (`validateManifestForSync`) asserting target alignment, schema integrity, and valid hash formats.

### Changed
- Replaced and retired legacy `deploy-pack.py` script in favor of unified `lampasctl deploy`.
- Enforced mandatory 40-character hex SHA-1 and boolean `required` validation on server resource pack definitions.
- Aligned runtime `FilePolicy` validator to recognize `MANAGED`, `PRESERVE`, `OPTIONAL`, and `GENERATED` file policies.

### Fixed
- Fixed potential timestamp collisions during rapid sequential world backup operations.
- Enforced fail-closed behavior during server startup when `lampasctl` binary is absent, eliminating unsafe Python fallback.

## [0.1.0] - 2026-08-26

### Added
- Multi-platform standalone executable distribution for Linux (x64 baseline, ARM64, musl), Windows (x64 baseline, ARM64), and macOS (x64, ARM64).
- Dedicated version commands (`lampasctl --version`, `lampasctl version`, `lampasctl -v`).
- Server resource-pack separation architecture with native CAS discovery and server-only deployment.
- Dual-target manifest generation (`localhost:3000` and `https://dev.lampas.town`).
- Post-mutation file integrity and size verification across client and server sync operations.
- Deterministic pack resolving, mod additions (`lampasctl add`), removals (`lampasctl remove`), and upstream update checking (`lampasctl check-updates`).
- Full SHA-256 integrity checks and `.lampas/installation.json` state tracking.
