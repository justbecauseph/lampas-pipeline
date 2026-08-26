---
name: deploy-custom-jars
description: >-
  Deploy custom JAR mods and override libraries to the Lampas modpack pipeline and generate release manifests for both localhost:3000 and https://dev.lampas.town. Use this skill when adding, updating, or packaging local or in-house custom JAR files, resolving lockfiles, generating dual-target manifests (localhost and dev.lampas.town), and publishing to portal environments.
---

# Deploy Custom JARs Skill

This skill guides the process of adding, updating, and deploying custom or in-house `.jar` mods to the Lampas Modpack Pipeline, and generating distribution manifests for both **`localhost:3000`** and **`https://dev.lampas.town`**.

---

## ⚡ Quick Start (Automated Helper)

To deploy a custom JAR and generate manifests for both environments in one step:

```bash
bun run .agents/skills/deploy-custom-jars/scripts/deploy-custom-jar.ts <path-to-jar> --side <client|server|both>
```

Or to regenerate manifests for both `localhost:3000` and `https://dev.lampas.town` without adding a new JAR:

```bash
bun run .agents/skills/deploy-custom-jars/scripts/generate-manifests.ts
```

---

## 🛠️ Step-by-Step Manual Workflow

### Step 1: Place the Custom JAR File

Copy the `.jar` binary into the `pack/custom/` directory:

```bash
# Example: Copying a custom mod jar
cp ./my-custom-mod-1.0.0.jar pack/custom/
```

Alternatively, use the CLI shortcut which copies the file and creates the TOML definition automatically:

```bash
bun run lampasctl add ./path/to/my-custom-mod.jar --side both
```

### Step 2: Define or Verify the Mod TOML

Ensure a corresponding descriptor exists in `pack/mods/<mod-id>.toml`:

```toml
name = "My Custom Mod"
side = "both" # Options: "both" | "client" | "server"

[provider]
type = "lampas"
file = "custom/my-custom-mod-1.0.0.jar"
```

#### Side Selection Guidelines:
- **`side = "both"`**: Synced gameplay mechanics, custom network protocol mods (`lampas-core`), blocks, entities, items.
- **`side = "client"`**: Client-only visual tweaks, HUD enhancements, GUI mods, sound filters.
- **`side = "server"`**: Server-side optimization patches, admin tools, logging, dedicated server worldgen.

### Step 3: Resolve Lockfile & Compute Hashes

Resolve all descriptors to update `pack/pack.lock.json` with streaming SHA-256 and SHA-512 hashes:

```bash
bun run lampasctl resolve
```

### Step 4: Validate Modpack Integrity

Check Fabric metadata, compatibility constraints, and lockfile consistency:

```bash
bun run lampasctl validate
```

### Step 5: Dual Manifest Generation

Generate release manifests for **both** the local portal instance (`http://localhost:3000`) and the dev cloud portal (`https://dev.lampas.town`):

```bash
# 1. Generate for localhost:3000
bun run lampasctl manifest --portal http://localhost:3000 --out ./manifest/localhost

# 2. Generate for https://dev.lampas.town
bun run lampasctl manifest --portal https://dev.lampas.town --out ./manifest/dev

# 3. Update root manifest/ directory (targeting dev portal)
bun run lampasctl manifest --portal https://dev.lampas.town --out ./manifest
```

### Step 6: Verify and Test Local Sync

Test headless installation against a local test instance to ensure the JAR is properly synced:

```bash
# Test client synchronization
bun run lampasctl install --manifest ./manifest/client-manifest.json --target ./test-instance/minecraft --verify full

# Test server synchronization
bun run lampasctl install --manifest ./manifest/server-manifest.json --target ./test-instance/server --verify full
```

### Step 7: (Optional) Publish to Portal Channels

Publish the release and upload custom JAR blobs to the target portal:

```bash
# Publish to Local Portal
bun run lampasctl publish --portal http://localhost:3000 --channel dev --secret "$LOCAL_PORTAL_SECRET"

# Publish to Dev Portal
bun run lampasctl publish --portal https://dev.lampas.town --channel dev --secret "$DEV_PORTAL_SECRET"
```

---

## 📚 References & Scripts

- [Custom JARs Architecture & Reference](./references/custom-jars-guide.md)
- [Dual Manifest Generator Script](./scripts/generate-manifests.ts)
- [Deploy Custom JAR Script](./scripts/deploy-custom-jar.ts)
