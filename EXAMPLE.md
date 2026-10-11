# Lampas Pipeline Examples

These recipes cover pack maintenance, pack publication, standalone `lampasctl` releases, and explicit server deployment. Run them from the `lampas-pipeline` repository root unless a command says otherwise.

The desktop launcher is maintained separately at [justbecauseph/lampas-launcher](https://github.com/justbecauseph/lampas-launcher). This repository owns the manifests consumed by that launcher, but it does not build or release the launcher.

## Before making changes

Inspect the repository before running a generator:

```powershell
git status --short --branch
git log -1 --oneline
bun run lampasctl help
```

Use only the top-level `help` command. Do not run forms such as `lampasctl manifest --help` or `lampasctl deploy --help`; this CLI parses and executes the named subcommand.

The current example pack version is `2.0.2`, and the current standalone CLI release is `1.0.0`. Note that `pack/` and `manifest/` are local workspaces excluded from Git tracking via `.gitignore`. Treat those versions as examples, not defaults for a future release.

The active automation is:

- [`validate-pack.yml`](.github/workflows/validate-pack.yml) validates branch and pull-request changes.
- [`update-check.yml`](.github/workflows/update-check.yml) checks upstream mod releases and opens update pull requests.
- [`release-lampasctl.yml`](.github/workflows/release-lampasctl.yml) builds and publishes namespaced `lampasctl-v*` CLI tags.

There is no pack-tag publication workflow in this repository. Pack publication is an explicit `lampasctl publish` operation.

## Maintain the pack

### Add, change, or remove a mod

```powershell
# Add from Modrinth.
bun run lampasctl add sodium --side client

# Add from CurseForge. CURSEFORGE_API_KEY must already be in the environment.
bun run lampasctl add appleskin --provider curseforge --side both

# Add an owned local JAR.
bun run lampasctl add C:\builds\lampas2-overrides.jar --side both

# Remove a descriptor and regenerate derived data.
bun run lampasctl remove appleskin
```

Use `side = "client"`, `"server"`, or `"both"` to control which manifest receives an artifact. Keep shared configuration under [`pack/common/`](pack/common/), client-only configuration under [`pack/client/`](pack/client/), and server-only configuration under [`pack/server/`](pack/server/).

### Check upstream releases

```powershell
# Read-only report.
bun run lampasctl check-updates

# Apply selected upstream updates, then review all generated changes.
bun run lampasctl check-updates --apply
bun run lampasctl resolve
bun run lampasctl manifest
bun run lampasctl validate
git diff --check
git status --short

# Compare generated manifest deltas using lampasctl diff
bun run lampasctl diff --from <prior-manifest.json> --to manifest/client-manifest.json
```

Review generated changes in local workspaces (`pack/` and `manifest/` are gitignored) and preserve unrelated worktree changes.

## Prepare a pack release

Update `[pack].version` in [`pack/pack.toml`](pack/pack.toml) only when a new version is intended. Portal releases are immutable, so changed content requires a new version.

Run the release gates:

```powershell
bun install --frozen-lockfile

# Resolve when descriptors, version metadata, or lock data changed.
bun run lampasctl resolve

# Generate URLs for the Portal that will serve the release.
bun run lampasctl manifest --portal https://portal.lampas.town

bun run lampasctl validate
bun run typecheck
bun test
git diff --check
git status --short
```

Before publication, confirm that the version agrees across local workspace files:

- `pack/pack.toml`
- `pack/pack.lock.json`
- `manifest/client-manifest.json`
- `manifest/server-manifest.json`
- `manifest/release.json`

Also confirm that `[launcher].minimum_version` in `pack/pack.toml` agrees with `minimumLauncherVersion` in `manifest/release.json` after regeneration.

The dedicated-server resource pack is deliberately stored at `serverManifest.resourcePack`, not in either manifest's `files` array. A Lampas-owned resource pack must include:

```json
{
  "artifact": "lampas2",
  "required": true,
  "filename": "lampas2-resource-pack.zip",
  "path": "resourcepacks/lampas2-resource-pack.zip",
  "size": 208331,
  "url": "/api/v1/blobs/47ce079bb26176a1bc869e79fe5d49a9cbbba8fd2be4e5ec8381e44aeff560b0",
  "sha1": "6f087e5414025491e079bd60b9bb43623cc7e337",
  "sha256": "47ce079bb26176a1bc869e79fe5d49a9cbbba8fd2be4e5ec8381e44aeff560b0",
  "prompt": "{\"text\":\"The Lampas 2 resource pack\"}",
  "id": "7af14f5a-e521-443a-9275-265decab3edc",
  "provider": "lampas"
}
```

Verify that its path and filename are safe and agree, `size` is the ZIP byte length, hashes use lowercase hexadecimal, and the SHA-256 in `url` exactly matches `sha256`.

## Publish a pack to Portal

Supply credentials through the shell or CI secret store; never put a real token in source control or command history. Choose a channel explicitly for normal releases:

```powershell
$env:PACK_PORTAL_URL = "https://portal.lampas.town"
$env:PACK_PUBLISH_SECRET = "<injected-secret>"

bun run lampasctl publish --channel dev
```

Multiple channels may be moved atomically:

```powershell
bun run lampasctl publish --channel dev,beta
```

Omitting `--channel` points `dev`, `beta`, and `stable` to the release, so use that form only when moving all three is intentional.

Publication performs four operations:

1. Hash and size-check local Lampas-owned files, including `serverManifest.resourcePack`.
2. Ask `POST /api/v1/blobs/prepare` which CAS objects are missing.
3. Upload only missing bytes through short-lived presigned PUT URLs.
4. Ask `POST /api/v1/releases/publish` to register blobs, create the immutable release, and move the requested channel pointers.

An identical retry is idempotent. Different content under an existing version returns `409`; increase the pack version instead of overwriting it. An unconfigured channel resolves as `404` and has no implicit version fallback.

## Commit and tag a pack release

Commit, tag, branch push, tag push, Portal publication, and server deployment are separate actions. Perform only the actions currently authorized.

Use a namespaced pack tag as a traceability marker:

```powershell
$packVersion = (Get-Content -Raw -LiteralPath manifest/release.json | ConvertFrom-Json).version
$packTag = "lampas-pack-v$packVersion"
$releaseCommit = git rev-parse HEAD

$localTag = git tag --list $packTag
$remoteTag = git ls-remote --tags origin "refs/tags/$packTag"
if ($localTag -or $remoteTag) {
  throw "Release tag already exists: $packTag"
}

git tag $packTag $releaseCommit
git rev-list -n 1 $packTag
```

For the current checkout, the collision guard stops at the existing `lampas-pack-v2.0.2` tag. Never move an existing release tag and never use a generic `v<version>` tag.

If branch and tag pushes are explicitly authorized:

```powershell
git push origin main
git push origin $packTag
git ls-remote origin refs/heads/main "refs/tags/$packTag"
```

Pushing a pack tag does not publish to Portal; run the explicit publication command separately when authorized.

## Release the standalone lampasctl CLI

The CLI has its own version stream and canonical `lampasctl-v<version>` tag. It does not inherit the pack version.

```powershell
$cliVersion = "<requested-cli-version>"

bun install --frozen-lockfile
bun run typecheck
bun test
# Build a versioned host package for local smoke testing. The tag workflow
# independently builds and tests its Linux x64 and Windows x64 packages.
bun run tools/lampasctl/scripts/build-release.ts --target host --version $cliVersion --out dist --package --checksum
.\dist\lampasctl.exe --version
.\dist\lampasctl.exe help

$cliTag = "lampasctl-v$cliVersion"
$localTag = git tag --list $cliTag
$remoteTag = git ls-remote --tags origin "refs/tags/$cliTag"
if ($localTag -or $remoteTag) {
  throw "Release tag already exists: $cliTag"
}
```

Replace `<requested-cli-version>` with the authorized version. `lampasctl-v1.0.0` already exists; use the requested new version for the next release. When authorized, create the tag on the verified release commit, push the branch first, then push the tag:

```powershell
$releaseCommit = git rev-parse HEAD
git tag $cliTag $releaseCommit
git push origin main
git push origin $cliTag
git ls-remote origin refs/heads/main "refs/tags/$cliTag"
```

Pushing `lampasctl-v*` starts [`release-lampasctl.yml`](.github/workflows/release-lampasctl.yml), which builds Linux and Windows packages, smoke-tests them, generates checksums, and creates the GitHub release.

## Dedicated server operations

Deployment and server management actions must always name a target outside this repository.

### Deploy an exact server state (`lampasctl deploy`)

```powershell
# Resolve the configured dev channel and perform the normal world backup.
lampasctl deploy --target C:\servers\lampas2 --portal https://portal.lampas.town --channel dev

# Deploy one immutable release with full on-disk verification.
lampasctl deploy --target C:\servers\lampas2 --portal https://portal.lampas.town --version 2.0.2 --verify full

# Skip the backup only when another verified backup policy covers the deployment.
lampasctl deploy --target C:\servers\lampas2 --portal https://portal.lampas.town --channel dev --no-backup
```

Never rely on `deploy`'s current-directory default. A missing channel, release, or server manifest aborts deployment; there is no fallback to a default, latest, or prior release.

### Start the dedicated server (`lampasctl start`)

```powershell
# Synchronize pack changes via Portal and launch with adaptive JVM sizing
lampasctl start --target C:\servers\lampas2 --portal https://portal.lampas.town --channel dev

# Launch immediately without Portal deployment synchronization (fast reboot)
lampasctl start --target C:\servers\lampas2 --no-sync

# Launch with transactional rollback recovery fallback if Portal deployment fails
lampasctl start --target C:\servers\lampas2 --allow-stale

# Inspect adaptive JVM sizing, flags, and Java binary without launching
lampasctl start --target C:\servers\lampas2 --dry-run

# Override memory allocation or select generational ZGC
lampasctl start --target C:\servers\lampas2 --memory 6G --gc zgc
```

### Monitor server health & Discord notifications (`lampasctl monitor`)

```powershell
# Run the monitoring daemon with 10s interval and 2-failure debouncing threshold
lampasctl monitor --port 25576 --webhook $env:DISCORD_WEBHOOK_URL

# Perform a single-shot diagnostic probe (returns exit code 0 if online, 1 if offline)
lampasctl monitor --port 25576 --once
```

### Scheduled server restarts (`lampasctl restart`)

```powershell
# Run 5-minute graceful countdown with in-game broadcasts, save-all, and systemd service restart
lampasctl restart --target /home/server --service lampas-server.service

# Emergency immediate restart without countdown warnings
lampasctl restart --target /home/server --immediate

# Test RCON connection, countdown, and save-all without restarting the systemd service
lampasctl restart --target /home/server --dry-run
```

For launcher development and packaging, use the [lampas-launcher repository](https://github.com/justbecauseph/lampas-launcher).
