# lampasctl Changelog

All notable changes to the `lampasctl` command-line distribution tool are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `lampasctl restart` logs why RCON failed instead of "RCON unreachable or server offline": the connection error (for example `RCON authentication failed: invalid password` or `connect ECONNREFUSED 127.0.0.1:25575`) when connecting, and the error with each skipped or failed broadcast and `save-all`. It also logs the server directory, the RCON address and where the password came from, never the password itself. On 16 Oct 2026 the countdown restart unit ran without `--target`, read no `server.properties` from `/`, sent an empty password and skipped every broadcast and `save-all` behind the generic notice. When the connection drops after RCON authenticates, each skipped broadcast or command names the socket error, or `RCON socket closed by remote server`, instead of saying the client is not connected.
- `lampasctl restart` warns, naming the directory, when the target directory has no `server.properties` and no password came from `--rcon-password`, `RCON_PASSWORD` or `.minecraft-env`. Pass `--target <server directory>` when it runs from elsewhere, such as a systemd unit. A first argument that starts with `-`, such as a password after `--rcon-password` that starts with a dash, exits with code 2 without printing it, and the message says to write the value as `--option=<value>` and pass the directory with `--target`.

## [1.3.1] - 2026-10-15

The `lampasctl-v1.3.0` tag has no release: its workflow failed in the test gate. 1.3.1 is the first release with `self-update`.

### Added
- `lampasctl self-update` replaces the running standalone binary with the newest `lampasctl-v*` release from GitHub Releases (`justbecauseph/lampas-pipeline`). `--check` only reports, `--version <ver>` installs an exact version (including downgrades), `--prerelease` includes prereleases and `--force` reinstalls the current version. Versions compare by semver precedence; a build newer than the newest release is not downgraded, with or without `--force`. Other arguments are rejected and `--help` prints usage. The host archive must match its `SHA256SUMS` entry, the asset size and the GitHub asset digest, and the extracted binary must report the expected version before it replaces the current one. POSIX installs rename over the binary and keep its mode; Windows moves the running exe to `lampasctl.old-<pid>-<time>.exe`, which a later run deletes, and restores it if the swap fails. `GITHUB_TOKEN`/`GH_TOKEN` is sent to the GitHub API only. Running from source refuses to install.

### Changed
- Release target definitions moved from `scripts/build-release.ts` to `src/release-targets.ts`; `build-release.ts` re-exports them and builds the same archives. Compiled builds embed their target id (`LAMPASCTL_TARGET`), which `self-update` downloads; it detects the host only when that is missing.

### Fixed
- The check that keeps `self-update` from replacing the `bun` or `node` runtime now splits paths on both `/` and `\`, so it gives the same result on every platform. The 1.3.0 release workflow failed on this in its Linux test run.

## [1.2.0] - 2026-10-15

### Added
- `lampasctl validate` reads `fabric.mod.json` from every mod jar in the lockfile, including nested jar-in-jar entries listed under `jars`, and checks the client and server mod sets separately, following Fabric Loader's resolver (environment filtering, optional nested mods, one copy per mod ID). It fails on top-level duplicate mod IDs (including `provides` and builtin IDs), top-level `depends` that no loadable mod satisfies, top-level `breaks` that match a mod that has to load, and `fabric.mod.json` files Fabric Loader's parser rejects (JSON, `schemaVersion`, mod ID format, `version`, `environment`, version predicates). Builtins are `minecraft` from `[pack] minecraft`, `fabricloader` from `[loader] version` and `java` 25. Version predicates follow Fabric Loader's semantics, so prerelease parts compare numerically (`26.2-3.6.28` > `26.2-3.6.6`). Pack 2.3.36 passed validation but crashed every client because WalksyLib 2.0.2 `breaks` `crossbowoptimizer <1.1.0` and an unrelated mod reused that ID; `validate` now rejects WalksyLib 2.0.2 with that mod.
- Jars come from the `lampas` file in the pack, the `resolve` download cache or `.lampas/cache/sha256/` next to `pack/`, and are otherwise downloaded into the cache with SHA-256 and size verification. A fresh checkout needs network access for its first `validate`.

### Changed
- `resolve` and `sync` compute their cache paths through shared helpers (`providerCachePath`, `lampasArtifactPath`, `blobCachePath`); the paths are unchanged.

## [1.1.0] - 2026-10-14

### Added
- `pack/client/options.txt` and `pack/client/servers.dat` ship as seed-only defaults. `manifest` gives each `policy: "PRESERVE"`, so the launcher places a file only when the player has none. Shipping them requires a launcher release that accepts PRESERVE for both files.
- `[client].preserve` in `pack.toml` lists client files from `pack/client/` or `pack/common/` that ship as seed-only PRESERVE defaults in the client manifest. Entries are client-relative paths, matched case-insensitively. `manifest` and `validate` reject an entry that does not canonicalize, is a launcher-protected path other than the exact seed paths `options.txt` and `servers.dat`, or matches no client file. They also reject a seed path listed from `pack/common/`. A listed file cannot be a config patch target. Without the table, client policies are unchanged. `schemas/pack.schema.json` documents the key.

### Changed
- `lampasctl validate` and `manifest` check the manifests they write against the Portal's pack manifest schema and the launcher's limits, in memory before anything is written. Added checks: DEL and leading or trailing whitespace in paths; config patch ids of 1 to 128 characters without control characters or padding; patch paths of at most 1024 characters; operation paths of 1 to 64 segments, with no prototype-sensitive keys; set values within depth 20, strings of 4096 characters, and 256 object keys; `replaceLiteral` text of at most 64 KiB; `expectedMatches` of at most 100000; `protocol` of at most 3; the version pattern and pack, Minecraft, and loader version lengths; mod catalog field limits; file paths of at most 1024 characters; file sizes of at most 2 GiB and client totals of at most 64 GiB; download URLs of at most 2048 characters without control characters; MANAGED server files on protected server paths; and enforce operations that share a path across patches. The Portal sets some of these bounds, and the launcher sets the rest.
- `lampasctl validate` and `manifest` reject client files on launcher-protected paths, including files under `pack/common/`. The only allowed protected files are the exact seed paths `options.txt` and `servers.dat` from `pack/client/`, with `policy: "PRESERVE"`. Other spellings and policies are rejected. Server manifests are unchanged.
- `lampasctl validate` and `manifest` apply the launcher's canonical path rules to config patch paths, `[client].preserve` entries, and client manifest paths, and emit canonical patch paths. Client manifest paths that differ only by case are errors. A config patch may not target any whole-file entry, MANAGED or PRESERVE, except a keybind rebind of exactly `options.txt` that accompanies a PRESERVE `options.txt`. No config patch may target `servers.dat`.
- `lampasctl validate` and `manifest` warn, without failing, when one keybind patch sets more than one key. The launcher defers the whole patch while any one key line is missing from `options.txt`, so keep one keybind patch per mod.
- `lampasctl validate` and `manifest` reject config patches that target launcher-protected paths: player data (`options.txt`, `servers.dat`, `usercache.json`, `hotbar.nbt`, `realms_persistence.json`, `saves/`, `screenshots/`, `logs/`, `crash-reports/`) and launcher state (`.lampas-moving-*`). The client launcher refuses such patches and fails the whole sync. The only exception is a `mode: "once"` keybind rebind of exactly `options.txt`: `adapter: "properties"`, `missingFile: "defer"`, and only `set` operations on a `key_*` option with a `key.keyboard.*` or `key.mouse.*` value. `enforce`-mode patches on `options.txt` are rejected. These patches require a launcher version that supports the exception.

## [1.0.10] - 2026-10-14

### Added
- `lampasctl manifest` prints a Portal comparison after building the manifests: the `dev`, `beta` and `stable` channel versions, whether the local version is already published (including revoked), and per-target (client, server) file and top-level field diffs against the release the selected channel points to. When the local version is already published, it compares the generated manifests and release metadata (status, minimum launcher version, launch settings, Minecraft/loader versions, git commit, signature) with that stored release the way the Portal does, and either warns that publishing would be rejected (409), naming the differing fields, or notes that publishing only moves channel pointers. A revoked version always warns. `--channel dev|beta|stable` selects the channel (default `stable`) and `--no-portal-diff` skips the comparison. Portal failures are reported in the summary and never change the exit code.

### Changed
- Dedicated server operations documentation and operational recipes updated across `README.md` and `EXAMPLE.md` covering native commands (`lampasctl start`, `monitor`, `restart`) and gitignored local workspaces (`pack/`, `manifest/`).

### Fixed
- Portal channel, release descriptor and manifest requests (`deploy`, `manifest`) now apply their timeout to the response body as well as the headers, so a Portal that stalls mid-response no longer hangs the command. Invalid JSON responses fail with a descriptive error.

## [1.0.9] - 2026-10-11

### Removed
- Removed legacy dedicated server automation scripts `tools/scripts/lampas-discord-monitor.py` and `tools/scripts/lampas-scheduled-restart.sh` (retiring `tools/scripts/` directory) in favor of native `lampasctl monitor` and `lampasctl restart`.
- Removed external Python 3 and `rcon-cli` requirements from dedicated server templates and deployments; dedicated servers now require only Java (OpenJDK 25) and the standalone `lampasctl` executable.
- Removed legacy dedicated server launcher scripts `tools/scripts/start.py` and `tools/scripts/start.sh` in favor of native `lampasctl start`. Legacy launcher files remain in `SERVER_PROTECTED` so `lampasctl deploy` never deletes them on existing servers.
- Removed Python-based launcher test suites (`start-sizing.test.ts` and `start-script.test.ts`), now fully covered natively in TypeScript by `launcher-sizing.test.ts` and `start-command.test.ts`.

### Changed
- `lampasctl start` sizes the JVM dynamically from the host environment. It detects usable CPUs and RAM, honoring cgroup v1/v2 CPU quotas and `memory.max`/`memory.high` limits, with a Windows fallback. The heap is RAM minus an OS reserve and max(1.5 GiB, 15%) for non-heap memory, capped at 16 GiB for G1, and the launcher refuses to start below 2 GiB. `--memory`/`JAVA_MEMORY` still override it.
- GC and JIT thread counts are left to JDK 25 ergonomics: `ParallelGCThreads`, `ConcGCThreads` and `CICompilerCount` are no longer pinned.
- G1 uses Aikar's profile with `G1ReservePercent=15` and `MaxTenuringThreshold=1`, and switches to the large-heap values above a 12 GiB heap. The restated defaults `ParallelRefProcEnabled` and `MaxGCPauseMillis=200` are dropped.
- `-Djdk.graal.TuneInlinerExploration=1` replaces the deprecated `-Dgraal.` form and is only added on Oracle GraalVM, detected from the runtime `release` file. GraalVM CE rejects that option.

### Added
- `lampasctl restart` command: scheduled and immediate server restart sequencer replacing `tools/scripts/lampas-scheduled-restart.sh`.
  - Built-in native Minecraft RCON client (`tools/lampasctl/src/restart/rcon.ts`) implementing Source RCON protocol over TCP with Type 3 login authentication, Type 2 command execution, multi-packet response support, and automatic configuration resolution (`--rcon-*` flags, env vars, `.minecraft-env`, `server.properties`).
  - Phased in-game countdown warnings at T-5m, T-3m, T-1m, and T-0m (`say [Scheduled Restart] ...`) with `save-all` world preservation.
  - Integration with systemd service lifecycle (`systemctl restart <service>` and `systemctl is-active`).
  - `--immediate` flag for rapid restarts without countdown warnings, and `--dry-run` flag to test sequences without restarting the systemd service.
- `lampasctl monitor` command: native Minecraft status monitor and Discord webhook notifier replacing `tools/scripts/lampas-discord-monitor.py`.
  - Built-in native Minecraft Server List Ping (SLP) client (`tools/lampasctl/src/monitor/slp.ts`) with VarInt encoding/decoding and Protocol 767 (Minecraft 1.21.x / 26.2) handshake.
  - Rich Discord embed notifications (`tools/lampasctl/src/monitor/discord.ts`) dispatching green online embeds with player count and version, and red offline embeds with dynamic relative downtime timestamps.
  - Automatic webhook discovery checking explicit flags, `DISCORD_WEBHOOK_URL`, `<targetDir>/.minecraft-env`, and `/home/server/.minecraft-env`.
  - Debounced failure thresholding and state persistence (`~/.lampas-monitor-state.json`) preventing false alerts during tick stalls.
  - One-shot diagnostic probe mode (`--once`) returning exit code 0 if online and 1 if offline.
- `lampasctl start` command: synchronize and launch dedicated Minecraft servers directly with adaptive host JVM sizing, `.minecraft-env` loading, in-process pack sync, transactional rollback recovery, signal forwarding, and `--` extra JVM args passthrough.
- Launcher host detection and JVM flag planning ported to TypeScript (`tools/lampasctl/src/launcher/`) ahead of `lampasctl start`.
- `--gc zgc` / `LAMPAS_GC` to opt in to generational ZGC, and `--dry-run` to print the Java command without launching.
- `-XX:+UseTransparentHugePages` when THP is `always` or `madvise` (ZGC also needs `shmem_enabled`), and a rotated GC log at `logs/gc.log` when `logs/` is writable.
- `LAMPAS_RAM`, `LAMPAS_CPUS` (sets `-XX:ActiveProcessorCount`), `LAMPAS_EXTRA_RESERVE` (RAM kept for co-located services such as PostgreSQL) and `LAMPAS_COMPACT_HEADERS=0`.
- `chunky.maxWorkingCount` scales with CPU count, as on the live server.
- Dedicated server systemd service templates (`tools/templates/lampas-discord-monitor.service`, `tools/templates/lampas-server-restart.service`) updated to invoke `lampasctl monitor` and `lampasctl restart` natively, replacing all Python and bash script wrappers.

## [1.0.8] - 2026-10-10

### Added
- `[portal] base_url` in `pack.toml` sets the Portal base URL. `lampasctl manifest`, `add`, `remove` and `enrich` use it for blob and release URLs. `lampasctl publish` uses it as the default target. `--portal`, `PORTAL_BASE_URL` (manifest) and `PACK_PORTAL_URL` (publish) still override it.
- `lampasctl validate` and manifest generation reject a portal base URL that is not http(s) or has a query or fragment. Trailing slashes are removed.

### Fixed
- `lampasctl add` and `remove` now write absolute release manifest URLs when `pack.toml` defines a portal. Previously they wrote relative `/api/v1/...` paths.

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
