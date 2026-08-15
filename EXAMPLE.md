# 🛠️ Lampas Pipeline: Developer & Operations Example Workflows

Practical, step-by-step recipes and workflows for maintaining the modpack, managing dependencies with **Bun**, promoting release channels, and deploying dedicated servers.

> [!NOTE]
> Automated CI/CD pipelines are implemented in [`.github/workflows/`](file:///.github/workflows/):
> - [`validate-pack.yml`](file:///.github/workflows/validate-pack.yml): PR smoke testing & validation
> - [`release-pack.yml`](file:///.github/workflows/release-pack.yml): Tagged release & multi-platform launcher compilation
> - [`update-check.yml`](file:///.github/workflows/update-check.yml): Automated daily upstream mod updates PR
> - [`deploy-server.yml`](file:///.github/workflows/deploy-server.yml): Continuous deployment to dedicated servers
> - [`smoke-test-jvm.yml`](file:///.github/workflows/smoke-test-jvm.yml): Headless JVM & KnotClient boot validation

---

## 📋 Table of Contents

1. [Modpack Maintenance Workflows](#1-modpack-maintenance-workflows)
   - [Workflow A: Adding a Mod with Version Pinning](#workflow-a-adding-a-mod-with-version-pinning)
   - [Workflow B: Adding a Client-Only or Server-Only Mod](#workflow-b-adding-a-client-only-or-server-only-mod)
   - [Workflow C: Adding In-House Custom Override JARs](#workflow-c-adding-in-house-custom-override-jars)
   - [Workflow D: Removing a Mod and Re-synchronizing](#workflow-d-removing-a-mod-and-re-synchronizing)
2. [Upstream Update & Audit Workflows](#2-upstream-update--audit-workflows)
   - [Workflow E: Checking & Applying Mod Updates](#workflow-e-checking--applying-mod-updates)
   - [Workflow F: Visualizing Changes with Manifest Diff](#workflow-f-visualizing-changes-with-manifest-diff)
3. [Release & Channel Promotion Workflows](#3-release--channel-promotion-workflows)
   - [Workflow G: Publishing a Staging / Dev Release](#workflow-g-publishing-a-staging--dev-release)
   - [Workflow H: Promoting Dev to Beta or Stable](#workflow-h-promoting-dev-to-beta-or-stable)
4. [Dedicated Server Deployment Workflows](#4-dedicated-server-deployment-workflows)
   - [Workflow I: Live Server Deployment with World Backup](#workflow-i-live-server-deployment-with-world-backup)
   - [Workflow J: Headless Sync to a Local Test Instance](#workflow-j-headless-sync-to-a-local-test-instance)
5. [Desktop Launcher Workflows](#5-desktop-launcher-workflows)
   - [Workflow K: Running the Launcher in Development](#workflow-k-running-the-launcher-in-development)
   - [Workflow L: Packaging Windows & Linux Binaries](#workflow-l-packaging-windows--linux-binaries)

---

## 1. Modpack Maintenance Workflows

### Workflow A: Adding a Mod with Version Pinning

When adding a mod from Modrinth, you can specify the target version using command flags, inline package syntax, or full Modrinth URLs:

```bash
# 1. Using explicit flag (-v or --version)
bun run lampasctl add sodium -v 0.5.11
bun run lampasctl add lithium --version AAbbCCdd

# 2. Using inline version syntax (@version, :version, ==version)
bun run lampasctl add appleskin@2.5.1
bun run lampasctl add iris:1.7.0
bun run lampasctl add ferritetoggle==1.1.0

# 3. Using direct Modrinth version URL
bun run lampasctl add https://modrinth.com/mod/appleskin/version/mc1.21-2.5.1
bun run lampasctl add https://modrinth.com/version/v9e8X1z

# 4. Default to latest compatible release on MC 26.2
bun run lampasctl add cloth-config
```

`lampasctl` will:
1. Fetch metadata from Modrinth API.
2. Resolve and write `pack/mods/<slug>.toml`.
3. Auto-discover and install required transitive dependencies.
4. Update `pack/pack.lock.json` with pinned SHA-256 hashes.
5. Re-generate `manifest/client-manifest.json` and `manifest/server-manifest.json`.

---

### Workflow B: Adding a Client-Only or Server-Only Mod

Control distribution target using the `-s` / `--side` flag:

```bash
# Client-only HUD / Rendering mod (excluded from dedicated server manifest)
bun run lampasctl add xaeros-minimap --side client

# Server-only administration or performance mod (excluded from client manifest)
bun run lampasctl add chunky --side server

# Explicitly mark as needed on both sides
bun run lampasctl add voicechat --side both
```

---

### Workflow C: Adding In-House Custom Override JARs

For proprietary mods or internal patches:

```bash
# Places the file into pack/custom/, creates the TOML definition, and rebuilds manifests
bun run lampasctl add ./lampas2-overrides.jar --side both
```

---

### Workflow D: Removing a Mod and Re-synchronizing

```bash
# Deletes descriptor, removes artifact from pack.lock.json, and rebuilds manifests
bun run lampasctl remove appleskin

# Or using the shorthand alias
bun run lampasctl rm appleskin
```

---

## 2. Upstream Update & Audit Workflows

### Workflow E: Checking & Applying Mod Updates

Scan all 150+ pack mods concurrently for newer upstream releases:

```bash
# 1. Preview available updates without making changes
bun run lampasctl check-updates

# 2. Automatically apply updates to pack/mods/*.toml descriptors
bun run lampasctl check-updates --apply

# 3. Re-resolve lockfile and rebuild distribution manifests
bun run lampasctl resolve
bun run lampasctl validate
bun run lampasctl manifest

# 4. Export Markdown changelog (useful for PR descriptions)
bun run lampasctl check-updates --markdown update_summary.md
```

---

### Workflow F: Visualizing Changes with Manifest Diff

Compare two manifests before promoting a release to verify size deltas and mod changes:

```bash
# Compare previous release manifest vs new release manifest
bun run lampasctl diff --from manifest/client-manifest.json.bak --to manifest/client-manifest.json

# Compare client vs server manifests
bun run lampasctl diff --from manifest/client-manifest.json --to manifest/server-manifest.json
```

---

## 3. Release & Channel Promotion Workflows

### Workflow G: Publishing a Staging / Dev Release

Publish your local manifests and upload config/custom blobs to the Lampas Portal API:

```bash
bun run lampasctl publish \
  --portal http://localhost:3000 \
  --channel dev \
  --secret "lampas-secret-key"
```

---

### Workflow H: Promoting Dev to Beta or Stable

Once verified by testing, promote the channel pointer instantaneously without re-uploading blobs:

```bash
# Promote current release to beta
bun run lampasctl publish \
  --portal https://portal.lampas.gg \
  --channel beta \
  --secret "$PORTAL_SECRET"

# Promote to production stable
bun run lampasctl publish \
  --portal https://portal.lampas.gg \
  --channel stable \
  --secret "$PORTAL_SECRET"
```

---

## 4. Dedicated Server Deployment Workflows

### Workflow I: Live Server Deployment with World Backup

Run the self-contained deployment engine on the dedicated server host:

```bash
# 1. Full deployment with automatic timestamped world backup to world_backups/
python deploy_pack.py

# 2. Skip backup (for automated CI/CD deployments)
python deploy_pack.py --skip-backup

# 3. Synchronize directly from a remote Lampas Portal instance and release channel
python deploy_pack.py --portal-url https://portal.lampas.gg --channel stable
```

---

### Workflow J: Headless Sync to a Local Test Instance

```bash
# Synchronize a client test folder directly against a manifest
bun run lampasctl install \
  --manifest ./manifest/client-manifest.json \
  --target ./test-instance/minecraft

# Synchronize a dedicated server test folder
bun run lampasctl install \
  --manifest ./manifest/server-manifest.json \
  --target ./test-instance/server
```

---

## 5. Desktop Launcher Workflows

### Workflow K: Running the Launcher in Development

```bash
cd launcher

# Install dependencies using Bun
bun install

# Start Electron in development mode
bun run start
```

---

### Workflow L: Packaging Windows & Linux Binaries

```bash
cd launcher

# 1. Compile TypeScript
bun run build

# 2. Package Windows 1-Click NSIS Installer (.exe) & Portable Executable
bun run package:win

# 3. Package Linux AppImage & tar.gz
bun run package:linux

# 4. Package all target platforms concurrently
bun run package:all
```
All binaries will be generated inside [`launcher/release/`](file:///C:/Users/markj/source/repos/lampas-pipeline/launcher/release).
