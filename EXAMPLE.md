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
   - [Workflow B: Adding & Changing Mod Distribution Sides (Client vs Server)](#workflow-b-adding--changing-mod-distribution-sides-client-vs-server)
   - [Workflow C: Adding In-House Custom Override JARs](#workflow-c-adding-in-house-custom-override-jars)
   - [Workflow D: Removing a Mod and Re-synchronizing](#workflow-d-removing-a-mod-and-re-synchronizing)
   - [Workflow E: Updating Client, Server, or Shared Configurations](#workflow-e-updating-client-server-or-shared-configurations)
2. [Upstream Update & Audit Workflows](#2-upstream-update--audit-workflows)
   - [Workflow F: Checking & Applying Mod Updates](#workflow-f-checking--applying-mod-updates)
   - [Workflow G: Visualizing Changes with Manifest Diff](#workflow-g-visualizing-changes-with-manifest-diff)
3. [Release & Channel Promotion Workflows](#3-release--channel-promotion-workflows)
   - [Workflow H: Publishing a Staging / Dev Release](#workflow-h-publishing-a-staging--dev-release)
   - [Workflow I: Promoting Dev to Beta or Stable](#workflow-i-promoting-dev-to-beta-or-stable)
4. [Dedicated Server Deployment Workflows](#4-dedicated-server-deployment-workflows)
   - [Workflow J: Live Server Deployment with World Backup](#workflow-j-live-server-deployment-with-world-backup)
   - [Workflow K: Headless Sync to a Local Test Instance](#workflow-k-headless-sync-to-a-local-test-instance)
5. [Desktop Launcher Workflows](#5-desktop-launcher-workflows)
   - [Workflow L: Running the Launcher in Development](#workflow-l-running-the-launcher-in-development)
   - [Workflow M: Packaging Windows & Linux Binaries](#workflow-m-packaging-windows--linux-binaries)

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

### Workflow B: Adding & Changing Mod Distribution Sides (Client vs Server)

Control mod distribution target using the `-s` / `--side` CLI flag, or by updating `side` in `pack/mods/<slug>.toml`:

| Target Side | Client Manifest | Server Manifest | Behavior & Purpose |
| :--- | :---: | :---: | :--- |
| `side = "client"` | ✅ Included | ❌ Excluded | Client-only HUD, rendering, GUI, or audio mods. Prevents server startup crashes. |
| `side = "server"` | ❌ Excluded | ✅ Included | Server-only worldgen, admin tools, performance mods. Saves player RAM & disk space. |
| `side = "both"` | ✅ Included | ✅ Included | Shared gameplay mods, entities, blocks, and synced network protocols. |

#### 1. Setting or Changing Side via CLI (Recommended)
`lampasctl add` updates the TOML descriptor, lockfile, and rebuilds manifests automatically:

```bash
# Set as client-only (excluded from dedicated server manifest)
bun run lampasctl add xaeros-minimap --side client
bun run lampasctl add lambdynamiclights --side client

# Set as server-only (excluded from client manifest)
bun run lampasctl add chunky --side server
bun run lampasctl add tectonic --side server

# Set as synchronized on both sides
bun run lampasctl add voicechat --side both
```

#### 2. Changing Side Manually in `pack/mods/*.toml`
If you edit `side = "client" | "server" | "both"` directly in `pack/mods/*.toml`, you **must run `resolve` before `manifest`** so `pack.lock.json` reflects the change:

```bash
# 1. Update pack.lock.json with the new side definitions from TOML files
bun run lampasctl resolve

# 2. Re-generate client-manifest.json and server-manifest.json
bun run lampasctl manifest

# 3. (Optional) Validate integrity and publish
bun run lampasctl validate
bun run lampasctl publish --channel dev
```

#### 3. Automatic Obsolete File Cleanup During Sync
The sync engines on both the desktop launcher and dedicated server automatically prune obsolete files:
- **Changed to `client`**: On the dedicated server, the next `lampasctl deploy` detects the mod is missing from `server-manifest.json` and **automatically deletes the old `.jar`** from `mods/`, preventing server crashes.
- **Changed to `server`**: On the client launcher, the next sync detects the mod is missing from `client-manifest.json` and **automatically deletes the `.jar`** from `.minecraft/mods/`.
- **Changed to `both`**: The missing side will download and install the `.jar` on its next sync.

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

### Workflow E: Updating Client, Server, or Shared Configurations

Static configuration files (`.json`, `.json5`, `.toml`, `.properties`) and custom assets are declarative files tracked in Git and distributed as content-addressed SHA-256 blobs:

| Directory | Scope | Purpose |
| :--- | :--- | :--- |
| [`pack/common/config/`](file:///pack/common/config) | **Both Sides** | Shared configs, datapacks, and scripts synced to both clients and dedicated servers. |
| `pack/client/config/` | **Client Only** | HUD, visual, or keybinding configs (e.g. `options.txt`, minimap) excluded from servers. |
| `pack/server/config/` | **Server Only** | Server-specific rules, optimization, and admin configs excluded from clients. |

```bash
# 1. Edit, add, or delete configuration files in the target directory
# (e.g. pack/common/config/Adorn.json5 or pack/client/config/custom-hud.json)

# 2. (Optional) Validate pack dependencies and TOML schemas
bun run lampasctl validate

# 3. Rebuild client and server manifests with updated SHA-256 checksums and sizes
bun run lampasctl manifest

# 4. (Optional) Test synchronization against local client or server test instances
bun run lampasctl install --manifest ./manifest/client-manifest.json --target ./test-instance/minecraft
bun run lampasctl install --manifest ./manifest/server-manifest.json --target ./test-instance/server

# 5. Commit modified configs and generated manifests to Git
git add pack/ manifest/
git commit -m "chore(config): update mod configurations"
```

---

## 2. Upstream Update & Audit Workflows

### Workflow F: Checking & Applying Mod Updates

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

### Workflow G: Visualizing Changes with Manifest Diff

Compare two manifests before promoting a release to verify size deltas and mod changes:

```bash
# Compare previous release manifest vs new release manifest
bun run lampasctl diff --from manifest/client-manifest.json.bak --to manifest/client-manifest.json

# Compare client vs server manifests
bun run lampasctl diff --from manifest/client-manifest.json --to manifest/server-manifest.json
```

---

## 3. Release & Channel Promotion Workflows

### Workflow H: Publishing Releases to Channels

Publish your local manifests and upload config/custom blobs to the Lampas Portal API.

#### Publish to All Environments (`dev`, `beta`, `stable`)
Omit the `--channel` parameter to publish and update channel pointers across all environments at once:

```bash
bun run lampasctl publish \
  --portal http://localhost:3000 \
  --secret "lampas-secret-key"
```

#### Publish to a Specific Channel (`dev`, `beta`, or `stable`)

```bash
bun run lampasctl publish \
  --portal http://localhost:3000 \
  --channel dev \
  --secret "lampas-secret-key"
```

---

### Workflow I: Promoting Dev to Beta or Stable

Once verified by testing, promote the channel pointer instantaneously without re-uploading blobs:

```bash
# Promote current release to beta
bun run lampasctl publish \
  --portal https://portal.lampas.town \
  --channel beta \
  --secret "$PORTAL_SECRET"

# Promote to production stable
bun run lampasctl publish \
  --portal https://portal.lampas.town \
  --channel stable \
  --secret "$PORTAL_SECRET"
```

---

## 4. Dedicated Server Deployment Workflows

### Workflow J: Live Server Deployment with World Backup

Run the compiled, standalone deployment engine on the dedicated server host:

```bash
# 1. Full deployment with automatic timestamped world backup to .backups/
lampasctl deploy --target /srv/minecraft --portal https://portal.lampas.town --channel dev

# 2. Skip backup (for automated CI/CD deployments)
lampasctl deploy --target /srv/minecraft --no-backup

# 3. Synchronize specific release version
lampasctl deploy --target /srv/minecraft --portal https://portal.lampas.town --version 2.0.0
```

---

### Workflow K: Headless Sync to a Local Test Instance

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

### Workflow L: Running the Launcher in Development

```bash
cd launcher

# Install dependencies using Bun
bun install

# Start Electron in development mode
bun run start
```

---

### Workflow M: Packaging Windows & Linux Binaries

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
