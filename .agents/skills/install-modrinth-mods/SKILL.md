---
name: install-modrinth-mods
description: >-
  Search, add, update, and resolve Modrinth mods for the Lampas modpack pipeline. Use this skill when installing mods from Modrinth (by slug, ID, or URL), pinning mod versions, configuring distribution sides (client, server, both), resolving transitive dependencies, and regenerating modpack manifests.
---

# Install Modrinth Mods Skill

This skill guides the discovery, installation, version-pinning, dependency resolution, and manifest generation for **Modrinth mods, shaders, and resource packs** in the Lampas Modpack Pipeline.

---

## ⚡ Quick Start

### 1. Using `lampasctl add` directly:

```bash
# Add a Modrinth mod (latest compatible release for MC 26.2)
bun run lampasctl add sodium --side client

# Add with pinned version
bun run lampasctl add appleskin@2.5.1 --side client

# Add via Modrinth URL
bun run lampasctl add https://modrinth.com/mod/lithium --side both
```

### 2. Using the Automated Skill Script:

```bash
bun run .agents/skills/install-modrinth-mods/scripts/install-modrinth.ts <slug_or_url> [--side <client|server|both>] [--version <ver>]
```

---

## 🛠️ Step-by-Step Installation Workflow

### Step 1: Identify Mod Identifier or URL

Modrinth mods can be targeted using any of the following formats:
- **Slug**: e.g., `sodium`, `lithium`, `cloth-config`, `ferrite-core`
- **Project ID**: e.g., `AANobbMI`, `9s6osm5g`
- **Web URL**: e.g., `https://modrinth.com/mod/appleskin`
- **Direct Version URL**: e.g., `https://modrinth.com/mod/appleskin/version/mc1.21-2.5.1` or `https://modrinth.com/version/v9e8X1z`

### Step 2: Determine Distribution Side (`--side`)

Always choose the appropriate side constraint to prevent server crashes and optimize client downloads:

| Target Side | Flag | When to Use | Manifest Targets |
| :--- | :--- | :--- | :---: |
| **Client Only** | `--side client` | HUDs, GUI tweaks, mini-maps, visual shaders, audio mods, client rendering optimizations | `client-manifest.json` only |
| **Server Only** | `--side server` | Chunk pre-generators, admin/audit tools, dedicated server performance, server logging | `server-manifest.json` only |
| **Both Sides** | `--side both` | Content mods, entities, blocks, worldgen biomes, synced networking mods, voicechat | Both manifests |

> [!NOTE]
> If `--side` is omitted, `lampasctl` queries the Modrinth API and automatically sets `client`, `server`, or `both` based on the project's upstream metadata.

### Step 3: Execute Installation Command

Run `lampasctl add` with your desired options:

```bash
# Example A: Add client-only rendering mod with pinned version
bun run lampasctl add iris -v 1.7.0 --side client

# Example B: Add shared content mod
bun run lampasctl add fabric-api --side both

# Example C: Add server-only performance mod
bun run lampasctl add chunky --side server
```

#### What `lampasctl add` performs automatically:
1. Queries the Modrinth v2 API for compatible versions matching Minecraft 26.2 and Fabric.
2. Writes the TOML definition to `pack/mods/<slug>.toml` (or `pack/shaderpacks/` / `pack/resourcepacks/`).
3. Recursively resolves and installs all required upstream transitive dependencies.
4. Updates `pack/pack.lock.json` with pinned SHA-256 and SHA-512 hashes.
5. Re-generates distribution manifests in `manifest/`.

### Step 4: Validate Pack Integrity & Dependencies

Run the pack validator to verify Fabric loader compatibility and JiJ integrity:

```bash
bun run lampasctl validate
```

### Step 5: (Optional) Rebuild Manifests & Test Installation

If you edited TOML files manually or need to update output directories:

```bash
# Re-resolve lockfile
bun run lampasctl resolve

# Re-build manifests
bun run lampasctl manifest

# Test installation into local test instance
bun run lampasctl install --manifest ./manifest/client-manifest.json --target ./test-instance/minecraft
```

### Step 6: Upstream Update Auditing

To check if any installed Modrinth mods have newer releases:

```bash
# Preview updates
bun run lampasctl check-updates

# Automatically apply updates to pack/mods/*.toml
bun run lampasctl check-updates --apply
```

---

## 📚 References & Scripts

- [Modrinth Integration Guide & Reference](./references/modrinth-guide.md)
- [Modrinth Install Helper Script](./scripts/install-modrinth.ts)
