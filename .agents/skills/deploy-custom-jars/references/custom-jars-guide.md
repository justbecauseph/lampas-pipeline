# Custom JARs Architecture & Reference

This document details how proprietary, in-house, and custom override JARs are managed and served in the Lampas Modpack Pipeline.

---

## 1. Provider Specification (`type = "lampas"`)

Unlike third-party mods sourced from Modrinth or CurseForge CDNs, custom JARs are hosted and distributed directly through the **Lampas Portal content-addressed blob CDN** (`/api/v1/blobs/<sha256>`).

### TOML Definition (`pack/mods/<slug>.toml`)
```toml
name = "Lampas Overrides"
side = "both" # "client" | "server" | "both"

[provider]
type = "lampas"
file = "custom/lampas2-overrides-1.0.0.jar"
```

### Key Properties:
- `name`: Display name rendered in the Launcher and client catalog.
- `side`: Controls which distribution manifests include the mod:
  - `client`: Client-only HUD, visuals, audio, or client mods. Excluded from `server-manifest.json`.
  - `server`: Server-only performance, admin tools, logging, or world generation mods. Excluded from `client-manifest.json`.
  - `both`: Shared mechanics, custom network protocol mods (`lampas-core`), synced items/blocks. Included in both manifests.
- `provider.type`: Must be `"lampas"`.
- `provider.file`: Path relative to the `pack/` directory (conventionally `custom/<filename>.jar`).

---

## 2. Lockfile Representation (`pack.lock.json`)

When `lampasctl resolve` runs, the resolver:
1. Locates the physical `.jar` under `pack/custom/`.
2. Computes the SHA-256 and SHA-512 streaming hashes.
3. Generates the download URL as `/api/v1/blobs/<sha256>`.
4. Writes an artifact entry into `pack.lock.json`:

```json
"lampas2-overrides-1_0_0": {
  "id": "lampas2-overrides-1_0_0",
  "name": "lampas2-overrides-1.0.0",
  "side": "both",
  "filename": "lampas2-overrides-1.0.0.jar",
  "size": 130456,
  "sha256": "3a7c6f...",
  "sha512": "b91e2...",
  "downloadUrl": "/api/v1/blobs/3a7c6f...",
  "artifactType": "mod",
  "targetDir": "mods",
  "provider": {
    "type": "lampas",
    "file": "custom/lampas2-overrides-1.0.0.jar"
  }
}
```

---

## 3. Dual Manifest Generation

Because releases can be published to both local development portal instances (`http://localhost:3000`) and the cloud development environment (`https://dev.lampas.town`), manifests must be generated with appropriate base URLs:

### Localhost 3000:
- Portal URL: `http://localhost:3000`
- Manifest Output: `manifest/localhost/`
- Pointers generated:
  - `clientManifest`: `http://localhost:3000/api/v1/releases/<ver>/client-manifest`
  - `serverManifest`: `http://localhost:3000/api/v1/releases/<ver>/server-manifest`
  - Server Resource Pack: `http://localhost:3000/api/v1/blobs/<sha256>`

### Dev Portal:
- Portal URL: `https://dev.lampas.town`
- Manifest Output: `manifest/dev/`
- Pointers generated:
  - `clientManifest`: `https://dev.lampas.town/api/v1/releases/<ver>/client-manifest`
  - `serverManifest`: `https://dev.lampas.town/api/v1/releases/<ver>/server-manifest`
  - Server Resource Pack: `https://dev.lampas.town/api/v1/blobs/<sha256>`

---

## 4. Portal Blob Publishing

During `lampasctl publish`, all files where `download.provider === "lampas"` have their binary contents extracted, base64 encoded, and uploaded to the portal backend as immutable blobs.
