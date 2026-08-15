# Lampas Modpack Distribution Pipeline

Declarative, immutable Minecraft modpack distribution pipeline and release automation for the Lampas SMP.

## Architecture

* **Source of Truth**: `pack/pack.toml` and human-maintained mod definitions in `pack/mods/*.toml`.
* **Resolved Lockfile**: `pack/pack.lock.json` pinning exact hashes, file sizes, and provider version IDs.
* **Published Manifests**: `manifest/client-manifest.json` and `manifest/server-manifest.json`.
* **Portal & Control Plane**: Integrated with [`lampas2-portal`](https://github.com/justbecauseph/lampas2-portal) for Discord OAuth2 PKCE launcher authentication, channel pointers (`stable`, `beta`, `dev`), and blob delivery.

## Tooling (`lampasctl`)

`lampasctl` is the CLI tool for pack maintenance, validation, and installation.

### Commands

```bash
# Validate pack definitions and lockfile
bun run lampasctl validate

# Resolve upstream mod IDs and update lockfile
bun run lampasctl resolve

# Build published client and server manifests
bun run lampasctl manifest

# Synchronize a local instance directory to a manifest
bun run lampasctl install --manifest ./manifest/client-manifest.json --target ./instance

# Publish release to Lampas Portal
bun run lampasctl publish --portal https://portal.lampas.gg --channel stable
```

### Building Standalone Binary

```bash
bun run build:cli
# Produces ./lampasctl.exe (Windows) or ./lampasctl (Linux)
```
