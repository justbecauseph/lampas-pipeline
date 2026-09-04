# ⚡ Lampas Modpack Distribution Pipeline

[![Minecraft](https://img.shields.io/badge/Minecraft-26.2-brightgreen.svg)](https://minecraft.net)
[![Fabric Loader](https://img.shields.io/badge/Fabric-Manifest--Defined-blue.svg)](https://fabricmc.net)
[![Java](https://img.shields.io/badge/OpenJDK-25%20(epsilon)-orange.svg)](https://adoptium.net)
[![Runtime](https://img.shields.io/badge/Runtime-Bun-black.svg)](https://bun.sh)
[![License](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

The **Lampas Pipeline** is a declarative, immutable Minecraft modpack distribution engine and release automation framework designed for high-performance SMP environments.

It guarantees **zero drift between clients and dedicated servers** by managing both from a single Git repository, eliminating runtime synchronization mods and third-party launcher dependencies.

---

## 🌟 Key Architecture & Tenets

```mermaid
graph TD
    subgraph Git ["1. Authoritative Source of Truth"]
        Pipeline["lampas-pipeline (Git)<br/>• pack.toml<br/>• mods/*.toml<br/>• client/ & server/ configs"]
    end

    subgraph CI ["2. CI & Manifest Build"]
        Lampasctl["lampasctl validate + manifest<br/>• SHA-256 Checksums<br/>• Dependency/JiJ Validation<br/>• File Policy Engine"]
    end

    subgraph PortalLayer ["3. Lampas Portal (lampas2-portal)"]
        PortalAPI["Lampas Portal<br/>• Release & Channel APIs<br/>• Portal Blob Routing<br/>• Presigned URL Generation<br/>• /auth/launcher (OAuth PKCE)"]
    end

    subgraph Storage ["4. Content-Addressed Blob Storage"]
        RailwayBucket["Railway Bucket (Object Storage)<br/>• Immutable SHA-256 Addressed Blobs<br/>• Configs & Custom JARs<br/>• Lampas-Owned Artifacts"]
    end

    subgraph CDNs ["5. Upstream Mod CDNs"]
        Modrinth["Modrinth CDN<br/>(3rd-party mods)"]
        CurseForge["CurseForge CDN<br/>(3rd-party mods)"]
    end

    subgraph ClientLayer ["6. Client Ecosystem"]
        Launcher["lampas-launcher (separate repository)<br/>• OpenJDK 25 Auto-Discovery<br/>• Web OAuth PKCE Login<br/>• Dynamic Fabric Bootstrap"]
        ClientMC["Minecraft 26.2 Client<br/>• Manifest-Defined Fabric Loader<br/>• Synchronized Mods"]
    end

    subgraph ServerLayer ["7. Dedicated Server Ecosystem"]
        ServerScript["lampasctl deploy / Server Sync<br/>• Transactional Rollback Engine<br/>• Managed Runtime Resolver<br/>• Timestamped World Backup"]
        ServerMC["lampas-server-fabric<br/>• Manifest-Defined Fabric Server<br/>• OpenJDK 25 JVM"]
    end

    Pipeline -->|Validation / explicit release| Lampasctl
    Lampasctl -->|"1. POST /api/v1/blobs/prepare"| PortalAPI
    PortalAPI -.->|"2. Presigned PUT URLs"| Lampasctl
    Lampasctl -->|"3. Direct PUT raw bytes (missing only)"| RailwayBucket
    Lampasctl -->|"4. POST /api/v1/releases/publish"| PortalAPI

    PortalAPI -->|Channel Pointers & Manifests| Launcher
    PortalAPI -->|Server Manifests| ServerScript

    Launcher -.->|Download 3rd-party| Modrinth
    Launcher -.->|Download 3rd-party| CurseForge
    Launcher -.->|"GET /api/v1/blobs/<sha256>"| PortalAPI
    PortalAPI -.->|"302 Redirect (presigned GET)"| RailwayBucket
    Launcher -.->|Download Lampas bytes| RailwayBucket

    ServerScript -.->|Download 3rd-party| Modrinth
    ServerScript -.->|Download 3rd-party| CurseForge
    ServerScript -.->|"GET /api/v1/blobs/<sha256>"| PortalAPI
    PortalAPI -.->|"302 Redirect (presigned GET)"| RailwayBucket
    ServerScript -.->|Download Lampas bytes| RailwayBucket

    Launcher -->|Spawns JVM| ClientMC
    ServerScript -->|Deploys & Starts| ServerMC

    ClientMC <===>|"Fabric Handshake & Protocol Verification (lampas-core)"| ServerMC
```

1. **Deterministic Single Source of Truth**: Every client and server release is strictly generated from declarative TOML descriptors committed to Git.
2. **Decentralized Byte Delivery**: Third-party artifacts are downloaded directly from upstream CDNs (Modrinth / CurseForge). Lampas-owned artifacts (configs, custom JARs, resource packs) use immutable SHA-256 content addressing stored in Railway Bucket, with the Portal providing stable blob URLs and redirecting clients to short-lived presigned downloads.
3. **Content-Addressed Blob Storage & Deduplication**: Lampas-owned files are keyed by SHA-256. Publishing an unchanged artifact does not upload it again; only hashes missing from object storage are transferred.
4. **Standalone Desktop Launcher**: 100% independent of PrismLauncher, CurseForge App, or MultiMC. Bundles automatic **OpenJDK 25 (`java-runtime-epsilon`)** discovery and direct `KnotClient` JVM execution.
5. **Web OAuth2 PKCE Authentication**: Desktop login delegates to the web portal via a browser loopback OAuth2 flow, linking Discord roles, SMP whitelist verification, and official Minecraft Java UUIDs in one click.
6. **Zero-Downtime Rollbacks & Gated Channels**: Channels (`stable`, `beta`, `dev`) are mutable pointers to immutable releases, so promotion and rollback are atomic pointer updates.
7. **Automated Upstream Updater**: Scheduled CI jobs monitor all pack mods and automatically open Pull Requests with changelogs when updates are released.
8. **Authoritative Loader Contract**: `pack.toml [loader]` defines the mod loader required by the release. Generated locks, manifests, and release descriptors derive their loader metadata from this definition and must never independently choose a loader version. Releases are verified against Fabric Meta to guarantee Minecraft/Loader compatibility before publication.

---

## 🔄 Distribution Flow

```mermaid
flowchart LR
    subgraph Authoring ["1. Authoritative Descriptors"]
        Git["Git Repository<br/>(TOML Descriptors)"] --> Lampasctl["lampasctl manifest"]
        Lampasctl --> Manifests["Client & Server<br/>Manifests"]
    end

    subgraph Publishing ["2. Direct-to-Bucket Publication"]
        Lampasctl -->|"1. /api/v1/blobs/prepare"| Portal["Lampas Portal"]
        Portal -.->|"2. Presigned PUT URLs"| Lampasctl
        Lampasctl -->|"3. Direct Upload (missing blobs)"| Bucket[("Railway Bucket<br/>(Immutable Blobs)")]
        Lampasctl -->|"4. /api/v1/releases/publish"| Portal
    end

    subgraph Distribution ["3. Dual Byte Delivery"]
        Manifests -->|"Third-Party Mods"| CDNs["Modrinth / CurseForge"]
        Portal -.->|"Stable Blob URLs (302 Presigned Redirects)"| Bucket
    end

    subgraph Consumption ["4. Verified Runtimes"]
        Portal -->|"Channel Pointer & Manifest"| Client["Launcher / lampasctl deploy"]
        CDNs -->|"Parallel Stream"| Client
        Bucket -->|"Presigned GET Stream"| Client
        Client -->|"Hash & Size Validated"| Instance["Minecraft Instance"]
    end
```

### 1. Publication Flow (`lampasctl publish`)
1. **Discover & Verify**: `lampasctl` scans manifests for `provider = "lampas"` artifacts and computes local SHA-256 hashes and file sizes.
2. **Prepare**: Sends `POST /api/v1/blobs/prepare` to the Portal. The Portal checks object storage and returns presigned PUT URLs *only* for missing SHA-256 hashes.
3. **Direct Upload**: `lampasctl` uploads missing blobs directly to Railway Bucket via presigned PUT with bounded concurrency and retry logic.
4. **Publish Release**: Sends `POST /api/v1/releases/publish` with release metadata and target channels.
5. **Atomic Commit**: The Portal verifies that all referenced blobs exist in object storage with the declared sizes, records the release, and atomically updates the target channel pointers.

### 2. Client & Server Sync Flow

```mermaid
sequenceDiagram
    autonumber
    participant Runtime as Launcher / lampasctl deploy
    participant Portal as Lampas Portal
    participant S3 as Railway Bucket
    participant Upstream as Modrinth / CurseForge

    Runtime->>Portal: GET /api/v1/channels/{channel}
    Portal-->>Runtime: 200 OK (channel pointer: version + release URL)
    Runtime->>Portal: GET /api/v1/releases/{version}
    Portal-->>Runtime: Release descriptor
    Runtime->>Portal: GET /api/v1/releases/{version}/{target}-manifest
    Portal-->>Runtime: Target manifest

    par Stream Third-Party Mods
        Runtime->>Upstream: GET mod artifact URL
        Upstream-->>Runtime: Binary bytes stream
    and Stream Lampas-Owned Blobs
        Runtime->>Portal: GET /api/v1/blobs/{sha256}
        Portal-->>Runtime: 302 Found (Location: presigned GET URL)
        Runtime->>S3: GET presigned URL
        S3-->>Runtime: Blob bytes stream
    end

    Note over Runtime: Verify file size & SHA-256 hash against manifest
    Note over Runtime: Write to content-addressed cache & link to instance
```

1. **Release Resolution**: The Launcher or `lampasctl deploy` queries `/api/v1/channels/<channel>` for a pointer, then fetches the immutable release descriptor and target manifest for the returned version.
2. **Parallel Downloads**:
   - Upstream mods stream directly from Modrinth or CurseForge.
   - Lampas-owned artifacts query the stable Portal blob URL (`/api/v1/blobs/<sha256>`), receive a `302` redirect to a short-lived presigned GET URL on Railway Bucket, and stream the raw bytes.
3. **Integrity Validation**: Every downloaded file is verified against its declared size and SHA-256 hash before being added to the local content-addressed cache.
4. **Atomic Instance Reconciliation**: The runtime instance directory is updated atomically, removing obsolete files and linking verified artifacts.

---

## 📁 Repository Structure

```text
lampas-pipeline/
├── pack/
│   ├── pack.toml                 # Root pack descriptor (MC 26.2, Fabric 0.19.3, Pack vX.X.X, [launcher.play], [launcher.resourcepacks])
│   ├── pack.lock.json            # Lockfile with pinned upstream version IDs & SHA-256 hashes
│   ├── mods/                     # Declarative mod TOML definitions
│   ├── custom/                   # Lampas-owned local JAR inputs
│   ├── resourcepacks/            # Declarative resource pack TOML definitions (e.g. lampas2.toml)
│   ├── shaderpacks/              # Declarative shader-pack TOML definitions
│   ├── common/                   # Shared configs, scripts, and assets (synced to both client & server)
│   ├── client/                   # Client-only mods and configs
│   ├── server/                   # Server-only mods and configs
├── manifest/                     # Generated release artifacts
│   ├── client-manifest.json      # Client distribution manifest
│   ├── server-manifest.json      # Dedicated server distribution manifest
│   └── release.json              # Canonical release descriptor
│
├── tools/lampasctl/              # High-performance pipeline CLI (Bun + TypeScript)
│   └── src/
│       ├── blob-publisher.ts     # Lampas blob discovery, verification, prepare + direct PUT
│       ├── checker.ts            # Concurrent upstream update checker for Modrinth/CurseForge
│       ├── diff.ts               # Release & manifest visual diff tool
│       ├── manifest.ts           # Manifest builder for client/server distribution
│       ├── publisher.ts          # Release publication and multi-channel metadata publishing
│       ├── release-resolver.ts   # Remote Portal channel and release resolver
│       ├── resolver.ts           # Upstream API dependency resolver
│       ├── validator.ts          # Fabric metadata & JiJ integrity validator
│       ├── sync.ts               # Headless installation and server deployment engine
│       └── backup.ts             # World backup utility
│
├── tools/scripts/                # Server operations & automation scripts
    └── start.py                  # Dedicated server launcher & auto-deployer
│
└── .github/workflows/
    ├── validate-pack.yml         # PR automated smoke testing & lockfile validation
    ├── release-lampasctl.yml     # Tagged lampasctl CLI builds, smoke tests, & GitHub release
    └── update-check.yml          # Daily cron job for upstream mod update PRs
```

---

## 🛠️ CLI Tooling (`lampasctl`)

`lampasctl` is the single CLI driving pack maintenance, validation, and deployment.

### 1. 1-Click Mod Management (`add` & `remove`)
Add or remove mods directly from the command line. Automatically detects project metadata, fetches latest compatible releases for Minecraft 26.2, updates `pack/mods/*.toml`, updates `pack.lock.json`, and rebuilds manifests in one step:

```bash
# Add a Modrinth mod (by slug, ID, or web URL)
bun run lampasctl add appleskin --side client
bun run lampasctl add 5sy6g3kz --side both
bun run lampasctl add https://modrinth.com/mod/sodium --side client

# Add a CurseForge mod (URL auto-detection, slug, project ID, or pinned file URL)
bun run lampasctl add https://www.curseforge.com/minecraft/mc-mods/appleskin
bun run lampasctl add appleskin --provider curseforge --side client
bun run lampasctl add 248787 --provider curseforge --version 5604145
bun run lampasctl add https://www.curseforge.com/minecraft/mc-mods/appleskin/files/5604145

# Add a custom local JAR
bun run lampasctl add ./my-custom-mod.jar --side both

# Remove a mod and re-synchronize manifests
bun run lampasctl remove appleskin
```

CurseForge authoring commands require a Core API key. Put it in the process environment or an ignored local `.env`
file; the key is used only by `lampasctl add`, `resolve`, `enrich`, and `check-updates` and is never written to pack
descriptors, lockfiles, or manifests:

```dotenv
CURSEFORGE_API_KEY=replace-with-your-curseforge-core-api-key
```

CurseForge artifacts remain on the upstream CDN. During resolution, `lampasctl` verifies the upstream SHA-1 and file
size, calculates the SHA-256/SHA-512 hashes required by Lampas, and keeps a verified local copy under the ignored
`.lampas/cache/curseforge/` directory. Projects that disable third-party distribution must be downloaded manually and
added as a local JAR instead.

### 2. Daily Upstream Update Checker
Scan all pack mods concurrently against Modrinth / CurseForge APIs:
```bash
# Check for newer compatible releases on Minecraft 26.2
bun run lampasctl check-updates

# Automatically apply updates to pack/mods/*.toml
bun run lampasctl check-updates --apply

# Export Markdown changelog (used in GitHub Actions)
bun run lampasctl check-updates --markdown update_summary.md
```

### 3. Lockfile & Manifest Generation
```bash
# Resolve all TOML descriptors into pack.lock.json
bun run lampasctl resolve

# Validate Fabric metadata, dependencies, and environment constraints
bun run lampasctl validate

# Build client-manifest.json and server-manifest.json
bun run lampasctl manifest
```

### 4. Managed Configuration Patches
In addition to distributing whole files, Lampas supports **property-level / targeted config management** defined in `pack/config-patches/client.json`.

#### Ownership Levels:
- **`MANAGED`**: Lampas owns the whole file. Any local modifications are overwritten on synchronization, and obsolete files are deleted.
- **`PRESERVE`**: The mod or player owns the whole file. Lampas places initial defaults only if missing.
- **`CONFIG PATCH / enforce`**: The mod or player owns the file; Lampas owns selected values. If the player changes an enforced value, the next synchronization restores the Lampas value while preserving unrelated settings and comments.
- **`CONFIG PATCH / once`**: Lampas supplies selected initial values, then permanently relinquishes ownership to the player. Re-applies only when the patch revision is incremented.

> **Syntax Adapters**: The `adapter` property describes internal file syntax (`json`, `jsonc`, `yaml`, `toml`, `properties`, `ini`, `text`). **File extension does not determine the adapter.**

Supported adapters:
- **JSON / JSONC** (`adapter: "json"` / `"jsonc"`): Preserves unrelated whitespace, ordering, and comments.
- **YAML** (`adapter: "yaml"`): AST-based targeted editing preserving comments and formatting.
- **TOML** (`adapter: "toml"`): Conservative in-place scalar editor for tables and keys.
- **Java Properties** (`adapter: "properties"`): Line-preserving key-value modifier.
- **INI** (`adapter: "ini"`): Section/key modifier preserving comments.
- **Generic Text** (`adapter: "text"`): Literal search/replace with strict `expectedMatches` validation.

### 5. Release Diff Tool
Compare two manifests to inspect added, removed, or updated mods along with size deltas:
```bash
bun run lampasctl diff --from manifest/client-manifest.json --to manifest/server-manifest.json
```

### 5. Portal Release Publishing
Publish Lampas-owned artifacts to content-addressed object storage and atomically publish release metadata to [`lampas2-portal`](https://github.com/justbecauseph/lampas2-portal):

```bash
# Supply these through the shell or CI secret store; never commit the token.
export PACK_PORTAL_URL=https://portal.lampas.town
export PACK_PUBLISH_SECRET="<PUBLISH_TOKEN>"

# Publish release and simultaneously update all channels (dev, beta, stable):
bun run lampasctl publish

# Publish release to a specific channel:
bun run lampasctl publish --channel stable

# Publish release to multiple selected channels:
bun run lampasctl publish --channel dev,beta
```

#### Publishing Sequence:

```mermaid
sequenceDiagram
    autonumber
    actor CI as Developer / CI
    participant CLI as lampasctl
    participant Portal as Lampas Portal
    participant S3 as Railway Bucket
    participant DB as Postgres DB

    CI->>CLI: lampasctl publish (authenticated, explicit channels)
    Note over CLI: Discover local Lampas blobs<br/>Verify size & SHA-256 hashes
    CLI->>Portal: POST /api/v1/blobs/prepare (hashes, sizes, MIME types)
    Portal->>S3: Check existing objects
    Portal-->>CLI: Return upload status & presigned PUT URLs (missing only)

    loop Upload Missing Blobs (Bounded Concurrency)
        CLI->>S3: PUT raw binary bytes (presigned upload)
        S3-->>CLI: 200 OK
    end

    CLI->>Portal: POST /api/v1/releases/publish (release metadata + target channels)
    Portal->>S3: Verify storage metadata for all referenced Lampas blobs
    S3-->>Portal: Presence and declared sizes verified
    Portal->>DB: Atomic transaction: create PackRelease & update channel pointers
    Portal-->>CLI: 200 OK (channels updated: dev, beta, stable)
    CLI-->>CI: ✓ Release Published
```

#### Multi-Channel Publishing:
Invoking `lampasctl publish` without `--channel` (or with `--channel all`) publishes the release metadata once and atomically points `dev`, `beta`, and `stable` to the new release in a single operation. `--channel dev,beta` selects multiple channels. Publication is an explicit CLI operation; this repository does not currently contain a pack-tag publication workflow.

#### Publishing Guarantees:
- **Local Pre-validation**: Lampas blobs are verified for existence, byte size, and SHA-256 hash before any network transfer.
- **Content-Addressed Deduplication**: Existing SHA-256 objects in object storage are detected during prepare and never re-uploaded.
- **Direct Object Storage Upload**: Missing blobs upload directly to object storage via presigned PUT URLs.
- **Resilient Transfers**: Blob uploads use bounded concurrency and automatically retry transient network errors with backoff.
- **Integrity Gate**: Release metadata is committed only after the Portal verifies storage metadata for every referenced Lampas blob (existence and declared size).
- **Atomic Pointer Updates**: Release creation and channel pointer updates are committed in a single atomic database transaction.

#### Immutable Portal Publication Contract:
- `lampasctl publish` sends a bearer token to `/api/v1/blobs/prepare` and `/api/v1/releases/publish`; inline/base64 blob publishing is not supported.
- The prepare response identifies missing SHA-256 blobs and supplies short-lived presigned PUT URLs. Existing content-addressed objects are reused.
- The publish request contains the release metadata plus both schema-version-1 manifests. The Portal validates target/version parity, verifies every Lampas blob reference and declared size in object storage, then commits the release and requested channel pointers atomically.
- A release version is immutable: publishing different content under an existing version returns HTTP 409. Repeating an identical publication is idempotent and may move channel pointers without rewriting the release.
- Blob URLs are stable and content-addressed (`/api/v1/blobs/<sha256>`). The redirect response is not cached because its presigned `Location` expires; the underlying blob identity remains the SHA-256 path. Bucket credentials remain in the Portal; `lampasctl` receives only presigned upload URLs, and launchers/server deployments use public blob redirects without publish credentials.

#### Blob Storage Security Model:
- **Railway Bucket Credentials**: Held exclusively by the Portal backend.
- **`lampasctl`**: Requires `PACK_PUBLISH_SECRET`; receives short-lived presigned PUT URLs for missing hashes from `/api/v1/blobs/prepare`.
- **Launcher / Server Deployments**: Require zero S3 or publish credentials; interact only with public Lampas API endpoints and follow short-lived presigned GET redirects.

### 6. Headless Client / Server Sync
```bash
bun run lampasctl install --manifest manifest/client-manifest.json --target ./my-instance

# Force a complete SHA-256 verification instead of the metadata fast path
bun run lampasctl install --manifest manifest/client-manifest.json --target ./my-instance --verify full
```

Normal installs use the `fast` verification mode, which trusts unchanged size and modification-time metadata recorded in `.lampas/installation.json`. Use `--verify full` (or the launcher's Repair action) to hash every managed file.

---

## 🌐 Resource Pack Delivery Architecture & Direct Connect

Lampas implements two clearly separated delivery mechanisms for resource packs to ensure clean asset ownership, immutable CAS hashing, and zero duplicate downloads:

```text
Launcher-Managed Resource Packs
    ↓
Downloaded into <gameDir>/resourcepacks/
    ↓
SHA-256 validated by Lampas sync engine
    ↓
Enabled deterministically in options.txt

Server-Enforced Resource Pack
    ↓
Published as immutable CAS blob (SHA-256 + SHA-1)
    ↓
lampasctl deploy configures server.properties
    ↓
Minecraft native server-resource-pack protocol downloads on join
```

> [!IMPORTANT]
> **Dual-Delivery Prohibition**: Every managed resource pack has exactly one delivery owner. The same resource pack must never be configured for both launcher-local and server-resource-pack delivery.

### Current Configuration

| Resource Pack | Delivery Owner | Target Location | Configuration |
|---|---|---|---|
| `fa-player-extension` | **Launcher-Managed** | `<gameDir>/resourcepacks/` | `[launcher.resourcepacks] required = ["fa-player-extension"]` |
| `lampas2` | **Server-Enforced** | `server.properties` | `[server.resourcepack] artifact = "lampas2"` |

### 1. Launcher-Managed Resource Packs (`[launcher.resourcepacks]`)

Configured in `pack/pack.toml`:
```toml
[launcher.resourcepacks]
required = ["fa-player-extension"]
```
- **Sync & Verification**: The launcher synchronizes required packs into `<gameDir>/resourcepacks/` and validates their SHA-256 checksums. If a local file has modified content with the same filename, the launcher detects the hash mismatch, downloads the updated revision, and replaces it atomically.
- **Activation in `options.txt`**: Prior to bootstrapping the game, the launcher reconciles `options.txt`, deterministically placing managed packs into the active resource pack array while strictly preserving user-installed packs, ordering, comments, and game settings.
- **Cleanup**: If a pack is removed from the required set, it is cleanly removed from `options.txt` on the next launch.

### 2. Server-Enforced Resource Pack (`[server.resourcepack]`)

Configured in `pack/pack.toml`:
```toml
[server.resourcepack]
artifact = "lampas2"
required = true
prompt = '{"text":"The Lampas 2 resource pack"}'
```
- **Server-only CAS descriptor**: The generated `server-manifest.json` is the authoritative desired server state and carries the resource pack descriptor; it is deliberately absent from `files[]` and from the client manifest. For a Lampas resource pack, the descriptor must include `provider = "lampas"`, a safe `path` under `resourcepacks/`, `size` in bytes, a 40-character `sha1`, a 64-character `sha256`, and a URL whose path is exactly `/api/v1/blobs/<sha256>`. See [`manifest/server-resource-pack.json`](manifest/server-resource-pack.json) for the generated descriptor and current values.
- **CAS Blob Address**: Published to the Portal under stable, content-addressed URL `/api/v1/blobs/<sha256>`; the redirect target is short-lived. The Portal release descriptor links consumers to the published server manifest rather than maintaining a separate resource-pack definition. The pipeline's generated `release.json` may mirror build metadata, including the resource-pack descriptor, for publication and artifact inspection.
- **`server.properties` Reconciliation**: During server deployment (`lampasctl deploy` or `lampasctl install`), the engine reconciles exactly 5 managed properties:
  - `resource-pack=<url>`
  - `resource-pack-sha1=<sha1>` (40-char SHA-1 required by vanilla Minecraft server)
  - `resource-pack-id=<uuid>` (stable deterministic UUID)
  - `resource-pack-prompt=<json>`
  - `require-resource-pack=true`
- **Zero Local Client Footprint**: The launcher does not manage this pack in its local `resourcepacks/` directory. The vanilla Minecraft client downloads it through the dedicated server resource-pack prompt on join.

### 3. Direct Connect Auto-Connection (`[launcher.play]`)

```toml
[launcher.play]
auto_connect = true
server = "play.lampas.town:25576"
```
When `auto_connect = true` and a valid server address is specified:
- The launcher UI displays the connection target directly beneath the **PLAY** button (`Connecting to: play.lampas.town:25576`).
- The game runner launches Minecraft Java Edition passing `--quickPlayMultiplayer <server>` to join the server automatically on boot.

---

## 🎮 Desktop Launcher (`lampas-launcher`)

The official desktop client launcher is maintained in its dedicated repository:
👉 **[justbecauseph/lampas-launcher](https://github.com/justbecauseph/lampas-launcher)**

### Features:
- **Zero Third-Party Dependencies**: Completely standalone Electron + TypeScript desktop app. No PrismLauncher, MultiMC, or vanilla launcher required.
- **Embedded OpenJDK 25 Discovery**: Auto-detects local Java 25 or seamlessly provisions Mojang's official `java-runtime-epsilon` on first boot.
- **One-Click Portal Login**: Single unified login button using OAuth2 PKCE via the default web browser.
- **Direct JVM Spawner**: Direct `KnotClient` boot with automatic argument parsing, asset hashing, and memory allocation.
- **Built-in Console**: Real-time log streaming with search and error highlighting.
- **Channel Switching**: Instant switching between `Stable`, `Beta`, and `Dev` channels based on player roles.
- **Stable Blob URL Resolution**: Queries `/api/v1/blobs/<sha256>` and transparently follows `302` redirects to presigned object storage URLs.
- **Verified Content Reconciliation**: Performs chunked streaming, file size verification, SHA-256 hash checks, content-addressed caching, and atomic file replacement on disk.

---

## 🖥️ Dedicated Server Deployment (`lampasctl deploy`)

Dedicated servers synchronize using the compiled, standalone `lampasctl deploy` command (or low-level `lampasctl install`).

`lampasctl deploy` operates on a uniform download abstraction:

```mermaid
flowchart LR
    Manifest["Pack Manifest<br/>(client / server)"] --> URL["Uniform download.url<br/>(Modrinth / CurseForge / Lampas Blob)"]
    URL --> Verified["Verified Local Artifact<br/>(SHA-256 Validated)"]
```
It consumes manifest URLs directly, without needing to know whether bytes originate from Modrinth, CurseForge, or Lampas content-addressed blob storage.

```bash
# Full deployment with an automatic timestamped world backup (latest two retained)
lampasctl deploy --target /srv/minecraft --portal https://portal.lampas.town --channel dev

# Skip backup (for automated CI/CD runs)
lampasctl deploy --target /srv/minecraft --portal https://portal.lampas.town --channel dev --no-backup

# Deploy specific release version
lampasctl deploy --target /srv/minecraft --portal https://portal.lampas.town --version 2.0.2
```

When `--version` is omitted, `deploy` resolves the selected channel (default: `dev`) through the Portal, then fetches that exact release descriptor and server manifest. Resolution is fail-closed: an invalid channel, non-success response, missing channel pointer/version, missing release, or missing manifest aborts deployment. There is no fallback to a latest release. Supplying `--version` bypasses the channel pointer but still fetches and validates the immutable release from the Portal.

### Safeguards:
- **Chunked Streaming**: Downloads are streamed directly to temporary files.
- **Dual Validation**: Validates both total byte count and SHA-256 hash before replacing files.
- **Transparent Redirect Handling**: Seamlessly follows `302` redirects from Portal blob URLs to presigned Railway Bucket download links.
- **Automatic Recovery**: Corrupted or truncated files (e.g. incomplete network aborts) are detected on disk and automatically re-downloaded.
- **Protected Paths**: Never overwrites runtime data such as `world/`, `whitelist.json`, `ops.json`, or player logs. `server.properties` is preserved except for the five explicitly managed server-resource-pack keys, which are reconciled and verified from the manifest.

### ⚙️ Dedicated Server Runtime Provisioning & Transactional Safety

Dedicated servers use an immutable, manifest-defined runtime managed exclusively by `lampasctl`:

1. **Manifest-Defined Fabric Server Runtime**:
   - `lampasctl deploy` resolves the exact Fabric server launcher JAR from Fabric Meta (`/v2/versions/loader/{minecraft}/{loaderVersion}/{installerVersion}/server/jar`) matching the release contract.
   - Fabric installer version is pinned to `1.1.2`, and runtime provisioning is bounded to supported Minecraft versions (`26.2`).
   - Deep archive validation (`validateFabricServerLauncherJar`) verifies ZIP structure, confirms `META-INF/MANIFEST.MF` declares `Main-Class: net.fabricmc.installer.ServerLauncher`, and strictly validates `install.properties` declaring the exact Minecraft and Loader versions.
   - The launcher is staged into `.lampas/runtime/.tmp-staging/` and atomically activated to `.lampas/runtime/fabric-server-launch.jar` alongside `.lampas/runtime/runtime.json`.

2. **Transactional Deployment & Rollback (`.lampas/.tx-rollback/`)**:
   - Before applying any pack changes, `DeploymentTransaction` snapshots modified files, deleted files, `server.properties`, `installation.json`, and previous runtime files.
   - An atomic journal (`journal.json`) is persisted to disk before any target mutations.
   - If runtime activation fails or an unhandled exception occurs, the transaction automatically rolls back: restores modified/deleted files, purges newly added files, restores previous server properties, and restores the previous coherent runtime.
   - Writing `.lampas/installation.json` is deferred until *after* runtime activation succeeds.
   - **Explicit Commit Point**: Once deployment is fully coherent, unlinking `journal.json` commits the transaction. Presence of `journal.json` unambiguously indicates an interrupted deployment requiring recovery; its absence indicates successful commitment.

3. **Fail-Closed Crash Recovery**:
   - Preflight backup validation: `rollbackFromDir` validates that all required backups for overwritten/deleted files, server properties, and runtime state exist as regular readable files before the first restoration mutation.
   - If an interrupted transaction is detected upon startup or subsequent deploy, `recoverIfInterrupted()` validates the journal schema, strictly enforces path safety (forbidding `.` or `..` traversal segments and `.lampas` directory tampering), and executes the rollback.
   - Operators can also run `lampasctl recover --target <path>` directly.

4. **Managed Server Startup (`tools/scripts/start.py`)**:
   - `start.py` launches exclusively from the canonical Lampas-managed `.lampas/runtime/fabric-server-launch.jar` (legacy glob-first discovery of `fabric-server-*.jar` and root `server.jar` is removed).
   - Pre-launch recovery guard: Every startup path (including `--no-sync` and normal boot) checks for an interrupted transaction journal. If present, it executes `lampasctl recover` and fails closed if recovery fails or `lampasctl` is missing.
   - `--allow-stale`: If `lampasctl deploy` fails on startup, attempts transaction recovery before launching the recovered coherent runtime.

---

## 🔒 Custom Protocol Mod (`lampas-core`)

Packaged inside `lampas2-overrides`, **`lampas-core`** provides protocol verification:
- On multiplayer join, the client transmits a `lampas:handshake_c2s` payload with its pack semantic version.
- The server validates the version against its required release.
- If a mismatch is detected, the server displays an informative disconnection prompt directing the player to launch their Lampas Launcher to auto-update.

---

## 🤖 CI/CD Automation

- **[`validate-pack.yml`](.github/workflows/validate-pack.yml)**: On selected branch pushes and pull requests, typechecks the codebase, validates the pack and lockfile, regenerates manifests, and performs a headless client installation.
- **[`release-lampasctl.yml`](.github/workflows/release-lampasctl.yml)**: Builds and publishes the standalone `lampasctl` CLI for Linux and Windows, with typecheck, full Bun tests, CLI sanity checks, artifact smoke tests, and SHA-256 checksums.
- **[`update-check.yml`](.github/workflows/update-check.yml)**: Daily cron job checking upstream mod repositories for Minecraft 26.2 updates and opening automated PRs. Configure the repository secret `CURSEFORGE_API_KEY` before adding CurseForge-backed descriptors.

### Release gates and version tags

The pack version is authoritative in `pack/pack.toml` and must match the generated lockfile and manifests. For a pack release, run the same gates locally before authorizing publication:

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run lampasctl validate
bun run lampasctl manifest
```

The canonical pack tag is `lampas-pack-v<pack-version>` (currently `lampas-pack-v2.0.2`). It is a traceability marker; creating or pushing it does not publish the pack. Portal publication is performed explicitly with `lampasctl publish` and an explicitly selected channel. The canonical CLI tag is `lampasctl-v<cli-version>` (currently `lampasctl-v1.0.0`); pushing it triggers [`release-lampasctl.yml`](.github/workflows/release-lampasctl.yml). Keep the two version streams independent and do not use a generic `v<version>` tag.

Commit, tag, push, Portal publication, and server deployment are separate authorization boundaries. A successful validation or build does not authorize any of the others. Publishing requires the Portal URL and `PACK_PUBLISH_SECRET`; deployment requires its own explicit `lampasctl deploy` action against a target server.

For end-to-end maintenance, pack publication, CLI release, and deployment recipes, see [`EXAMPLE.md`](EXAMPLE.md).

---

## 📄 License

This repository is licensed under the **MIT License**. Mod binaries and assets belong to their respective creators under their individual licenses.
