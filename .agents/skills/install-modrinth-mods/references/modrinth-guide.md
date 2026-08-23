# Modrinth Integration Guide & Reference

This document details how Modrinth mods, shaders, and resource packs are resolved, version-pinned, side-configured, and synchronized in the Lampas Pipeline.

---

## 1. Modrinth Provider Definition (`type = "modrinth"`)

In the declarative pack configuration, each Modrinth mod is declared as a small TOML file under `pack/mods/<slug>.toml` (or `pack/shaderpacks/` / `pack/resourcepacks/`).

```toml
name = "Sodium"
side = "client"

[provider]
type = "modrinth"
project_id = "AANobbMI"
version_id = "1.0.0+mc26.2"
```

### Properties:
- `name`: Display name of the mod.
- `side`: `"client" | "server" | "both"`. Controls manifest inclusion.
- `type`: (Optional) `"mod" | "shader" | "resourcepack"`. If omitted, defaults to `"mod"`.
- `provider.type`: Must be `"modrinth"`.
- `provider.project_id`: 8-character base62 Modrinth project ID or project slug.
- `provider.version_id`: 8-character base62 Modrinth version ID or version number string.

---

## 2. Version Pinning Syntax Supported by `lampasctl add`

`lampasctl add` supports several convenient ways to pin a specific upstream version:

| Method | Example Command | Notes |
| :--- | :--- | :--- |
| **Inline `@` syntax** | `bun run lampasctl add appleskin@2.5.1` | Pinned to version 2.5.1 |
| **Inline `:` syntax** | `bun run lampasctl add iris:1.7.0` | Pinned to version 1.7.0 |
| **Inline `==` syntax** | `bun run lampasctl add ferritecore==6.0.1` | Pinned to version 6.0.1 |
| **Version Flag (`-v` / `--version`)** | `bun run lampasctl add sodium -v 0.5.11` | Pinned to version string or Modrinth version ID |
| **Direct Version URL** | `bun run lampasctl add https://modrinth.com/version/v9e8X1z` | Auto-detects project ID and version ID |
| **Project Version URL** | `bun run lampasctl add https://modrinth.com/mod/sodium/version/mc1.21-0.5.11` | Auto-extracts slug and version number |
| **Omitted Version** | `bun run lampasctl add sodium` | Resolves latest compatible release for Minecraft 26.2 and Fabric |

---

## 3. Side Detection & Target Directories

When `--side` is omitted, `lampasctl` inspects the project's metadata returned by the Modrinth API:
- If `server_side == "unsupported"` -> side becomes `client`.
- If `client_side == "unsupported"` -> side becomes `server`.
- Otherwise -> side defaults to `both`.

### Non-Mod Artifact Types:
- **Shaders (`project_type == "shader"`)**:
  - Saved to `pack/shaderpacks/<slug>.toml`
  - Side is forced to `client`
  - Resolved to `shaderpacks/<filename>.zip`
- **Resource Packs (`project_type == "resourcepack"`)**:
  - Saved to `pack/resourcepacks/<slug>.toml`
  - Side is forced to `client`
  - Resolved to `resourcepacks/<filename>.zip`

---

## 4. Transitive Dependency Resolution

When `lampasctl add` executes:
1. It inspects the `dependencies` array on the chosen Modrinth version object.
2. For each dependency marked `dependency_type === "required"`:
   - It checks whether the dependency already exists in `pack/mods/`.
   - If not installed, it recursively triggers `addMod` to fetch and configure the missing dependency matching the same target side.

---

## 5. Lockfile and CDN Direct Streaming

During `lampasctl resolve`:
- Modrinth files are verified using SHA-512 / SHA-1 hashes directly from the Modrinth API.
- Download URLs point to original Modrinth CDN edge nodes (e.g. `https://cdn.modrinth.com/data/...`).
- Manifest files stream binaries directly from the CDN with zero load on the Lampas Portal backend.
