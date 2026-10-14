import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildManifests } from "../src/manifest";
import { validatePack } from "../src/validator";
import { isValidServerAddress } from "../src/utils";
import {
  clientStaticFilePolicy,
  commonStaticFilePolicy,
  isSeedClientFile,
  validateClientFilePaths,
  validateProtectedClientFiles,
} from "../src/config-patches";

type StaticFile = { path: string; content: string };

function setupFixture(options: {
  packTomlContent: string;
  lockArtifacts?: Record<string, any>;
  staticFiles?: Partial<Record<"common" | "client" | "server", StaticFile[]>>;
  configPatchesContent?: unknown;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-manifest-test-"));
  const packDir = path.join(dir, "pack");
  const outDir = path.join(dir, "manifest");
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(packDir, "mods"), { recursive: true });

  const packTomlPath = path.join(packDir, "pack.toml");
  fs.writeFileSync(packTomlPath, options.packTomlContent, "utf-8");

  const lockFile = path.join(packDir, "pack.lock.json");
  const lockData = {
    schema: 1,
    packName: "Lampas Test",
    packVersion: "2.0.0",
    minecraft: "26.2",
    loader: { type: "fabric", version: "0.19.3" },
    updated: new Date().toISOString(),
    artifacts: options.lockArtifacts || {},
  };
  fs.writeFileSync(lockFile, JSON.stringify(lockData, null, 2), "utf-8");

  for (const [scope, files] of Object.entries(options.staticFiles ?? {})) {
    for (const file of files ?? []) {
      const full = path.join(packDir, scope, file.path);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, file.content, "utf-8");
    }
  }

  if (options.configPatchesContent) {
    const patchesDir = path.join(packDir, "config-patches");
    fs.mkdirSync(patchesDir, { recursive: true });
    fs.writeFileSync(
      path.join(patchesDir, "client.json"),
      JSON.stringify(options.configPatchesContent, null, 2),
      "utf-8"
    );
  }

  return { dir, packDir, lockFile, outDir };
}

describe("server address validation", () => {
  test("accepts valid hostnames and ip addresses with optional ports", () => {
    expect(isValidServerAddress("play.lampas.town")).toBe(true);
    expect(isValidServerAddress("play.lampas.town:25565")).toBe(true);
    expect(isValidServerAddress("127.0.0.1:25565")).toBe(true);
    expect(isValidServerAddress("127.0.0.1")).toBe(true);
    expect(isValidServerAddress("localhost")).toBe(true);
    expect(isValidServerAddress("localhost:25565")).toBe(true);
    expect(isValidServerAddress("[::1]:25565")).toBe(true);
  });

  test("rejects malformed server addresses, schemes, and paths", () => {
    expect(isValidServerAddress("")).toBe(false);
    expect(isValidServerAddress("   ")).toBe(false);
    expect(isValidServerAddress("https://play.lampas.town")).toBe(false);
    expect(isValidServerAddress("http://play.lampas.town:25565")).toBe(false);
    expect(isValidServerAddress("play.lampas.town/path")).toBe(false);
    expect(isValidServerAddress("play.lampas.town:99999")).toBe(false);
    expect(isValidServerAddress("play.lampas.town:0")).toBe(false);
    expect(isValidServerAddress("play.lampas.town:abc")).toBe(false);
    expect(isValidServerAddress("play .lampas.town")).toBe(false);
  });
});

describe("manifest generation with launch & required resource packs", () => {
  test("generates launch metadata for valid launcher resource pack configuration", async () => {
    const packToml = `
[pack]
name = "Lampas 2"
version = "2.0.0"
minecraft = "26.2"

[loader]
type = "fabric"
version = "0.19.3"

[launcher]
minimum_version = "1.1.0"
protocol = 2

[launcher.play]
auto_connect = true
server = "play.lampas.town:25565"

[launcher.resourcepacks]
required = ["lampas-resources"]
`;

    const artifacts = {
      "lampas-resources": {
        id: "lampas-resources",
        name: "Lampas Official Resources",
        side: "client",
        filename: "Lampas-Resources-2.0.0.zip",
        size: 1048576,
        sha256: "a".repeat(64),
        sha1: "b".repeat(40),
        downloadUrl: "/api/v1/blobs/aaaaaaaa",
        artifactType: "resourcepack",
        targetDir: "resourcepacks",
        provider: { type: "lampas", file: "resourcepacks/Lampas-Resources-2.0.0.zip" },
      },
    };

    const fixture = setupFixture({ packTomlContent: packToml, lockArtifacts: artifacts });

    try {
      const result = await buildManifests({
        packDir: fixture.packDir,
        lockFile: fixture.lockFile,
        outDir: fixture.outDir,
        portalBaseUrl: "https://portal.lampas.town",
      });

      // Release descriptor check
      expect(result.release.launch).toBeDefined();
      expect(result.release.launch?.autoConnect).toBe(true);
      expect(result.release.launch?.server).toBe("play.lampas.town:25565");
      expect(result.release.launch?.requiredResourcePacks).toEqual([
        {
          id: "lampas-resources",
          filename: "Lampas-Resources-2.0.0.zip",
          path: "resourcepacks/Lampas-Resources-2.0.0.zip",
          sha256: "a".repeat(64),
          sha1: "b".repeat(40),
        },
      ]);

      // Client manifest check
      const clientResourcePackFile = result.clientManifest.files.find(
        (f) => f.path === "resourcepacks/Lampas-Resources-2.0.0.zip"
      );
      expect(clientResourcePackFile).toBeDefined();
      expect(clientResourcePackFile?.policy).toBe("MANAGED");

      // Server resource pack should NOT be generated implicitly for launcher-only packs
      expect(result.serverManifest.resourcePack).toBeUndefined();
      expect(result.release.serverResourcePack).toBeUndefined();
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("fails build when required resource pack is missing from lockfile", async () => {
    const packToml = `
[pack]
name = "Lampas 2"
version = "2.0.0"
minecraft = "26.2"

[loader]
type = "fabric"
version = "0.19.3"

[launcher.resourcepacks]
required = ["nonexistent-pack"]
`;

    const fixture = setupFixture({ packTomlContent: packToml, lockArtifacts: {} });

    try {
      await expect(
        buildManifests({
          packDir: fixture.packDir,
          lockFile: fixture.lockFile,
          outDir: fixture.outDir,
        })
      ).rejects.toThrow("Required resource pack 'nonexistent-pack' was not found in pack.lock.json.");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("fails build when required resource pack has wrong artifact type", async () => {
    const packToml = `
[pack]
name = "Lampas 2"
version = "2.0.0"
minecraft = "26.2"

[loader]
type = "fabric"
version = "0.19.3"

[launcher.resourcepacks]
required = ["fabric-api"]
`;

    const artifacts = {
      "fabric-api": {
        id: "fabric-api",
        name: "Fabric API",
        side: "both",
        filename: "fabric-api-0.90.0.jar",
        size: 2048,
        sha256: "c".repeat(64),
        downloadUrl: "https://example.com/fabric-api.jar",
        artifactType: "mod",
        targetDir: "mods",
        provider: { type: "direct", url: "https://example.com/fabric-api.jar", sha256: "c".repeat(64) },
      },
    };

    const fixture = setupFixture({ packTomlContent: packToml, lockArtifacts: artifacts });

    try {
      await expect(
        buildManifests({
          packDir: fixture.packDir,
          lockFile: fixture.lockFile,
          outDir: fixture.outDir,
        })
      ).rejects.toThrow("Artifact 'fabric-api' is configured as a required resource pack but has type 'mod'.");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("fails build when server address is malformed", async () => {
    const packToml = `
[pack]
name = "Lampas 2"
version = "2.0.0"
minecraft = "26.2"

[loader]
type = "fabric"
version = "0.19.3"

[launcher.play]
auto_connect = true
server = "https://play.lampas.town"
`;

    const fixture = setupFixture({ packTomlContent: packToml, lockArtifacts: {} });

    try {
      await expect(
        buildManifests({
          packDir: fixture.packDir,
          lockFile: fixture.lockFile,
          outDir: fixture.outDir,
        })
      ).rejects.toThrow("Invalid server address in pack.toml");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("fails build when auto_connect is true but server is missing", async () => {
    const packToml = `
[pack]
name = "Lampas 2"
version = "2.0.0"
minecraft = "26.2"

[loader]
type = "fabric"
version = "0.19.3"

[launcher.play]
auto_connect = true
`;

    const fixture = setupFixture({ packTomlContent: packToml, lockArtifacts: {} });

    try {
      await expect(
        buildManifests({
          packDir: fixture.packDir,
          lockFile: fixture.lockFile,
          outDir: fixture.outDir,
        })
      ).rejects.toThrow("Auto-connect is enabled in pack.toml ([launcher.play] auto_connect = true) but no valid server address was specified.");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("preserves existing behaviour when no launcher section is present", async () => {
    const packToml = `
[pack]
name = "Lampas 2"
version = "2.0.0"
minecraft = "26.2"

[loader]
type = "fabric"
version = "0.19.3"
`;

    const fixture = setupFixture({ packTomlContent: packToml, lockArtifacts: {} });

    try {
      const result = await buildManifests({
        packDir: fixture.packDir,
        lockFile: fixture.lockFile,
        outDir: fixture.outDir,
      });

      expect(result.release.launch).toBeUndefined();
      expect(fs.existsSync(path.join(fixture.outDir, "server-resource-pack.properties"))).toBe(false);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("validatePack fails when launcher play or resourcepack configuration is invalid", async () => {
    const packToml = `
[pack]
name = "Lampas 2"
version = "2.0.0"
minecraft = "26.2"

[loader]
type = "fabric"
version = "0.19.3"

[launcher.play]
auto_connect = true
server = "invalid server with spaces"

[launcher.resourcepacks]
required = ["missing-pack"]
`;

    const fixture = setupFixture({ packTomlContent: packToml, lockArtifacts: {} });

    try {
      const passed = await validatePack({
        packDir: fixture.packDir,
        lockFile: fixture.lockFile,
      });
      expect(passed).toBe(false);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("generates server resource pack metadata for explicit [server.resourcepack] configuration", async () => {
    const packToml = `
[pack]
name = "Lampas 2"
version = "2.0.0"
minecraft = "26.2"

[loader]
type = "fabric"
version = "0.19.3"

[server.resourcepack]
artifact = "lampas-server-pack"
required = true
prompt = "Lampas requires its custom textures."
`;

    const artifacts = {
      "lampas-server-pack": {
        id: "lampas-server-pack",
        name: "Lampas Server Textures",
        side: "both",
        filename: "Lampas-Server-2.0.0.zip",
        size: 2097152,
        sha256: "d".repeat(64),
        sha1: "e".repeat(40),
        downloadUrl: "https://cdn.lampas.gg/resources/Lampas-Server-2.0.0.zip",
        artifactType: "resourcepack",
        targetDir: "resourcepacks",
        provider: { type: "direct", url: "https://cdn.lampas.gg/resources/Lampas-Server-2.0.0.zip", sha256: "d".repeat(64) },
      },
    };

    const fixture = setupFixture({ packTomlContent: packToml, lockArtifacts: artifacts });

    try {
      const result = await buildManifests({
        packDir: fixture.packDir,
        lockFile: fixture.lockFile,
        outDir: fixture.outDir,
      });

      expect(result.serverManifest.resourcePack).toBeDefined();
      expect(result.serverManifest.resourcePack?.artifact).toBe("lampas-server-pack");
      expect(result.serverManifest.resourcePack?.required).toBe(true);
      expect(result.serverManifest.resourcePack?.size).toBe(2097152);
      expect(result.serverManifest.resourcePack?.prompt).toBe('{"text":"Lampas requires its custom textures."}');
      expect(result.release.serverResourcePack).toBeDefined();
      expect(result.release.serverResourcePack?.size).toBe(2097152);
      expect(result.release.serverResourcePack?.url).toBe("https://cdn.lampas.gg/resources/Lampas-Server-2.0.0.zip");

      const serverPropsPath = path.join(fixture.outDir, "server-resource-pack.properties");
      const props = fs.readFileSync(serverPropsPath, "utf-8");
      expect(props).toContain("resource-pack=https://cdn.lampas.gg/resources/Lampas-Server-2.0.0.zip");
      expect(props).toContain(`resource-pack-sha1=${"e".repeat(40)}`);
      expect(props).toContain("require-resource-pack=true");
      expect(props).toContain('resource-pack-prompt={"text":"Lampas requires its custom textures."}');
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("builds server resource pack metadata for client-side resourcepack", async () => {
    const packToml = `
[pack]
name = "Lampas 2"
version = "2.0.0"
minecraft = "26.2"

[loader]
type = "fabric"
version = "0.19.3"

[server.resourcepack]
artifact = "client-pack"
`;

    const artifacts = {
      "client-pack": {
        id: "client-pack",
        name: "Client Pack",
        side: "client",
        filename: "Client-Pack.zip",
        size: 1024,
        sha256: "f".repeat(64),
        sha1: "1".repeat(40),
        downloadUrl: "https://example.com/client.zip",
        artifactType: "resourcepack",
        targetDir: "resourcepacks",
        provider: { type: "direct", url: "https://example.com/client.zip", sha256: "f".repeat(64), sha1: "1".repeat(40) },
      },
    };

    const fixture = setupFixture({ packTomlContent: packToml, lockArtifacts: artifacts });

    try {
      const result = await buildManifests({
        packDir: fixture.packDir,
        lockFile: fixture.lockFile,
        outDir: fixture.outDir,
      });
      expect(result.serverManifest.resourcePack).toBeDefined();
      expect(result.serverManifest.resourcePack?.artifact).toBe("client-pack");
      expect(result.serverManifest.resourcePack?.size).toBe(1024);
      expect(result.serverManifest.resourcePack?.sha1).toBe("1".repeat(40));

      // Client-only artifact must not be in server manifest files[]
      const serverFile = result.serverManifest.files.find((f) => f.path === "resourcepacks/Client-Pack.zip");
      expect(serverFile).toBeUndefined();
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("fails build when [server.resourcepack] artifact has missing sha1", async () => {
    const packToml = `
[pack]
name = "Lampas 2"
version = "2.0.0"
minecraft = "26.2"

[loader]
type = "fabric"
version = "0.19.3"

[server.resourcepack]
artifact = "missing-sha1-pack"
`;

    const artifacts = {
      "missing-sha1-pack": {
        id: "missing-sha1-pack",
        name: "Missing SHA-1 Pack",
        side: "client",
        filename: "Missing-Sha1.zip",
        size: 1024,
        sha256: "f".repeat(64),
        downloadUrl: "https://example.com/missing-sha1.zip",
        artifactType: "resourcepack",
        targetDir: "resourcepacks",
        provider: { type: "direct", url: "https://example.com/missing-sha1.zip", sha256: "f".repeat(64) },
      },
    };

    const fixture = setupFixture({ packTomlContent: packToml, lockArtifacts: artifacts });

    try {
      await expect(
        buildManifests({
          packDir: fixture.packDir,
          lockFile: fixture.lockFile,
          outDir: fixture.outDir,
        })
      ).rejects.toThrow(/requires a valid 40-character SHA-1 hash/);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("fails build when same pack is configured for both launcher and server delivery (dual-delivery error)", async () => {
    const packToml = `
[pack]
name = "Lampas 2"
version = "2.0.0"
minecraft = "26.2"

[loader]
type = "fabric"
version = "0.19.3"

[launcher.resourcepacks]
required = ["lampas2"]

[server.resourcepack]
artifact = "lampas2"
required = true
`;

    const artifacts = {
      lampas2: {
        id: "lampas2",
        name: "Lampas 2 Resources",
        side: "client",
        filename: "lampas2-resource-pack.zip",
        size: 1024,
        sha256: "f".repeat(64),
        sha1: "1".repeat(40),
        downloadUrl: "/api/v1/blobs/" + "f".repeat(64),
        artifactType: "resourcepack",
        targetDir: "resourcepacks",
        provider: { type: "lampas", file: "custom/lampas2-resource-pack.zip" },
      },
    };

    const fixture = setupFixture({ packTomlContent: packToml, lockArtifacts: artifacts });

    try {
      await expect(
        buildManifests({
          packDir: fixture.packDir,
          lockFile: fixture.lockFile,
          outDir: fixture.outDir,
        })
      ).rejects.toThrow("Resource pack 'lampas2' is configured for both launcher-local and server-resource-pack delivery. Choose one delivery mechanism.");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("fails build when [server.resourcepack] is not a resourcepack", async () => {
    const packToml = `
[pack]
name = "Lampas 2"
version = "2.0.0"
minecraft = "26.2"

[loader]
type = "fabric"
version = "0.19.3"

[server.resourcepack]
artifact = "some-mod"
`;

    const artifacts = {
      "some-mod": {
        id: "some-mod",
        name: "Some Mod",
        side: "both",
        filename: "some-mod.jar",
        size: 1024,
        sha256: "f".repeat(64),
        downloadUrl: "https://example.com/mod.jar",
        artifactType: "mod",
        targetDir: "mods",
        provider: { type: "direct", url: "https://example.com/mod.jar", sha256: "f".repeat(64) },
      },
    };

    const fixture = setupFixture({ packTomlContent: packToml, lockArtifacts: artifacts });

    try {
      await expect(
        buildManifests({
          packDir: fixture.packDir,
          lockFile: fixture.lockFile,
          outDir: fixture.outDir,
        })
      ).rejects.toThrow("Artifact 'some-mod' is configured as server resource pack but has type 'mod'.");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("server.resourcepack artifact is absent from client and server installation files", async () => {
    const packToml = `
[pack]
name = "Lampas 2"
version = "2.0.0"
minecraft = "26.2"

[loader]
type = "fabric"
version = "0.19.3"

[server.resourcepack]
artifact = "lampas2-srp"
required = true
`;

    const artifacts = {
      "lampas2-srp": {
        id: "lampas2-srp",
        name: "Lampas 2 Resources",
        side: "client",
        filename: "lampas2-resource-pack.zip",
        size: 1024,
        sha256: "f".repeat(64),
        sha1: "1".repeat(40),
        downloadUrl: "/api/v1/blobs/" + "f".repeat(64),
        artifactType: "resourcepack",
        targetDir: "resourcepacks",
        provider: { type: "lampas", file: "custom/lampas2-resource-pack.zip" },
      },
    };

    const fixture = setupFixture({ packTomlContent: packToml, lockArtifacts: artifacts });

    try {
      const result = await buildManifests({
        packDir: fixture.packDir,
        lockFile: fixture.lockFile,
        outDir: fixture.outDir,
      });

      // Server resource pack must be in serverManifest.resourcePack and release.serverResourcePack
      expect(result.serverManifest.resourcePack).toBeDefined();
      expect(result.serverManifest.resourcePack?.artifact).toBe("lampas2-srp");
      expect(result.serverManifest.resourcePack?.size).toBe(1024);
      expect(result.release.serverResourcePack?.artifact).toBe("lampas2-srp");
      expect(result.release.serverResourcePack?.size).toBe(1024);

      // But strictly ABSENT from clientManifest.files and serverManifest.files
      const clientFile = result.clientManifest.files.find((f) => f.path === "resourcepacks/lampas2-resource-pack.zip");
      expect(clientFile).toBeUndefined();
      const serverFile = result.serverManifest.files.find((f) => f.path === "resourcepacks/lampas2-resource-pack.zip");
      expect(serverFile).toBeUndefined();

      // And absent from mod catalogs
      expect(result.clientManifest.mods?.find((m) => m.id === "lampas2-srp")).toBeUndefined();
      expect(result.serverManifest.mods?.find((m) => m.id === "lampas2-srp")).toBeUndefined();
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("server-resource-pack.properties has empty prompt when prompt is not configured", async () => {
    const packToml = `
[pack]
name = "Lampas 2"
version = "2.0.0"
minecraft = "26.2"

[loader]
type = "fabric"
version = "0.19.3"

[server.resourcepack]
artifact = "srp-no-prompt"
required = true
`;

    const artifacts = {
      "srp-no-prompt": {
        id: "srp-no-prompt",
        name: "SRP No Prompt",
        side: "client",
        filename: "no-prompt.zip",
        size: 1024,
        sha256: "f".repeat(64),
        sha1: "1".repeat(40),
        downloadUrl: "https://example.com/no-prompt.zip",
        artifactType: "resourcepack",
        targetDir: "resourcepacks",
        provider: { type: "direct", url: "https://example.com/no-prompt.zip", sha256: "f".repeat(64), sha1: "1".repeat(40) },
      },
    };

    const fixture = setupFixture({ packTomlContent: packToml, lockArtifacts: artifacts });

    try {
      await buildManifests({
        packDir: fixture.packDir,
        lockFile: fixture.lockFile,
        outDir: fixture.outDir,
      });

      const serverPropsPath = path.join(fixture.outDir, "server-resource-pack.properties");
      const props = fs.readFileSync(serverPropsPath, "utf-8");
      expect(props).toContain("resource-pack-prompt=");
      expect(props).not.toContain("resource-pack-prompt=undefined");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

describe("loader ownership, propagation, and consistency", () => {
  test("propagates loader and minecraft metadata to client, server manifests, and release descriptor", async () => {
    const packToml = `
[pack]
name = "Lampas Test"
version = "2.0.0"
minecraft = "26.2"

[loader]
type = "fabric"
version = "0.19.3"
`;
    const fixture = setupFixture({ packTomlContent: packToml });

    try {
      const { clientManifest, serverManifest, release } = await buildManifests({
        packDir: fixture.packDir,
        lockFile: fixture.lockFile,
        outDir: fixture.outDir,
      });

      expect(clientManifest.minecraft).toBe("26.2");
      expect(clientManifest.loader).toEqual({ type: "fabric", version: "0.19.3" });

      expect(serverManifest.minecraft).toBe("26.2");
      expect(serverManifest.loader).toEqual({ type: "fabric", version: "0.19.3" });

      expect(release.minecraft).toBe("26.2");
      expect(release.loader).toEqual({ type: "fabric", version: "0.19.3" });
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("propagates non-default synthetic loader version to prove dynamic propagation (no hardcoding)", async () => {
    const nonDefaultLoaderVersion = "0.99.123-test";
    const packToml = `
[pack]
name = "Lampas Synthetic"
version = "2.0.0"
minecraft = "26.2"

[loader]
type = "fabric"
version = "${nonDefaultLoaderVersion}"
`;
    const fixture = setupFixture({ packTomlContent: packToml });

    // Update lockfile to match the synthetic loader version
    const lockData = JSON.parse(fs.readFileSync(fixture.lockFile, "utf-8"));
    lockData.loader = { type: "fabric", version: nonDefaultLoaderVersion };
    fs.writeFileSync(fixture.lockFile, JSON.stringify(lockData, null, 2), "utf-8");

    try {
      const { clientManifest, serverManifest, release } = await buildManifests({
        packDir: fixture.packDir,
        lockFile: fixture.lockFile,
        outDir: fixture.outDir,
      });

      expect(clientManifest.loader).toEqual({ type: "fabric", version: "0.99.123-test" });
      expect(serverManifest.loader).toEqual({ type: "fabric", version: "0.99.123-test" });
      expect(release.loader).toEqual({ type: "fabric", version: "0.99.123-test" });

      // Also verify written JSON files on disk
      const clientDisk = JSON.parse(fs.readFileSync(path.join(fixture.outDir, "client-manifest.json"), "utf-8"));
      const serverDisk = JSON.parse(fs.readFileSync(path.join(fixture.outDir, "server-manifest.json"), "utf-8"));
      const releaseDisk = JSON.parse(fs.readFileSync(path.join(fixture.outDir, "release.json"), "utf-8"));

      expect(clientDisk.loader).toEqual({ type: "fabric", version: "0.99.123-test" });
      expect(serverDisk.loader).toEqual({ type: "fabric", version: "0.99.123-test" });
      expect(releaseDisk.loader).toEqual({ type: "fabric", version: "0.99.123-test" });
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("rejects manifest build when lock loader version differs from pack.toml", async () => {
    const packToml = `
[pack]
name = "Lampas Mismatch"
version = "2.0.0"
minecraft = "26.2"

[loader]
type = "fabric"
version = "0.19.4"
`;
    // Lock was created with 0.19.3 by default
    const fixture = setupFixture({ packTomlContent: packToml });

    try {
      await expect(
        buildManifests({
          packDir: fixture.packDir,
          lockFile: fixture.lockFile,
          outDir: fixture.outDir,
        })
      ).rejects.toThrow(
        /pack\.lock\.json was generated for Fabric Loader 0\.19\.3, but pack\.toml requires 0\.19\.4/
      );
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("rejects manifest build when lock minecraft version differs from pack.toml", async () => {
    const packToml = `
[pack]
name = "Lampas Mismatch"
version = "2.0.0"
minecraft = "26.3"

[loader]
type = "fabric"
version = "0.19.3"
`;
    // Lock was created with 26.2 by default
    const fixture = setupFixture({ packTomlContent: packToml });

    try {
      await expect(
        buildManifests({
          packDir: fixture.packDir,
          lockFile: fixture.lockFile,
          outDir: fixture.outDir,
        })
      ).rejects.toThrow(
        /pack\.lock\.json was generated for Minecraft 26\.2, but pack\.toml requires 26\.3/
      );
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("rejects empty or invalid loader definition in pack.toml", async () => {
    const emptyVersionToml = `
[pack]
name = "Lampas Empty Loader"
version = "2.0.0"
minecraft = "26.2"

[loader]
type = "fabric"
version = ""
`;
    const fixture1 = setupFixture({ packTomlContent: emptyVersionToml });
    try {
      await expect(
        buildManifests({
          packDir: fixture1.packDir,
          lockFile: fixture1.lockFile,
          outDir: fixture1.outDir,
        })
      ).rejects.toThrow(/Invalid loader version: 'loader\.version' must be a non-empty string/);
    } finally {
      fs.rmSync(fixture1.dir, { recursive: true, force: true });
    }

    const unsupportedLoaderToml = `
[pack]
name = "Lampas Neoforge"
version = "2.0.0"
minecraft = "26.2"

[loader]
type = "neoforge"
version = "20.4.80"
`;
    const fixture2 = setupFixture({ packTomlContent: unsupportedLoaderToml });
    try {
      await expect(
        buildManifests({
          packDir: fixture2.packDir,
          lockFile: fixture2.lockFile,
          outDir: fixture2.outDir,
        })
      ).rejects.toThrow(/Unsupported mod loader 'neoforge'/);
    } finally {
      fs.rmSync(fixture2.dir, { recursive: true, force: true });
    }
  });

  test("validatePack catches loader mismatch and invalid loader definition", async () => {
    const mismatchToml = `
[pack]
name = "Lampas Mismatch"
version = "2.0.0"
minecraft = "26.2"

[loader]
type = "fabric"
version = "0.19.4"
`;
    const fixture = setupFixture({ packTomlContent: mismatchToml });
    try {
      const valid = await validatePack({
        packDir: fixture.packDir,
        lockFile: fixture.lockFile,
        checkFabricMeta: false,
      });
      expect(valid).toBe(false);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

const STATIC_PACK_TOML = `
[pack]
name = "Lampas Test"
version = "2.0.0"
minecraft = "26.2"

[loader]
type = "fabric"
version = "0.19.3"

[launcher]
minimum_version = "1.1.0"
protocol = 3
`;

const KEYBIND_PATCHES = {
  schemaVersion: 1,
  patches: [
    {
      id: "snappy-tappy-keybind",
      revision: 1,
      path: "options.txt",
      adapter: "properties",
      mode: "once",
      missingFile: "defer",
      operations: [{ op: "set", path: ["key_key.snappy_tappy.toggle"], value: "key.keyboard.unknown" }],
    },
  ],
};

describe("client static files and launcher-protected paths", () => {
  test("ships client options.txt as PRESERVE and keeps other client and common files MANAGED", async () => {
    const fixture = setupFixture({
      packTomlContent: STATIC_PACK_TOML,
      staticFiles: {
        client: [
          { path: "options.txt", content: "version:4000\n" },
          { path: "config/jade/jade.json", content: "{}" },
        ],
        common: [{ path: "config/common.json", content: "{}" }],
      },
    });

    try {
      const { clientManifest } = await buildManifests(fixture);

      expect(clientManifest.files.find((f) => f.path === "options.txt")?.policy).toBe("PRESERVE");
      expect(clientManifest.files.find((f) => f.path === "config/jade/jade.json")?.policy).toBe("MANAGED");
      expect(clientManifest.files.find((f) => f.path === "config/common.json")?.policy).toBe("MANAGED");

      const valid = await validatePack({ packDir: fixture.packDir, lockFile: fixture.lockFile, checkFabricMeta: false });
      expect(valid).toBe(true);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("server static files keep MANAGED policy and are not checked against client protected paths", async () => {
    const fixture = setupFixture({
      packTomlContent: STATIC_PACK_TOML,
      staticFiles: {
        server: [
          { path: "options.txt", content: "version:4000\n" },
          { path: "servers.dat", content: "x" },
        ],
      },
    });

    try {
      const { serverManifest, clientManifest } = await buildManifests(fixture);

      expect(serverManifest.files.find((f) => f.path === "options.txt")?.policy).toBe("MANAGED");
      expect(serverManifest.files.find((f) => f.path === "servers.dat")?.policy).toBe("MANAGED");
      expect(clientManifest.files.some((f) => f.path === "options.txt")).toBe(false);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("rejects client static files on other launcher-protected paths", async () => {
    const cases: Array<{ scope: "client" | "common"; path: string }> = [
      { scope: "client", path: "Servers.dat" },
      { scope: "client", path: "usercache.json" },
      { scope: "client", path: "saves/world/level.dat" },
      { scope: "client", path: "Logs/latest.log" },
      { scope: "client", path: ".lampas/installation.json" },
      { scope: "client", path: ".lampas-moving-x/file.bin" },
      // common/ also ships to the client manifest, and seed names from common/ stay MANAGED
      { scope: "common", path: "options.txt" },
      { scope: "common", path: "servers.dat" },
    ];

    for (const testCase of cases) {
      const file = { path: testCase.path, content: "x" };
      const fixture = setupFixture({
        packTomlContent: STATIC_PACK_TOML,
        staticFiles: testCase.scope === "client" ? { client: [file] } : { common: [file] },
      });

      try {
        await expect(buildManifests(fixture)).rejects.toThrow(
          `Client file '${testCase.path}' targets a launcher-protected path`
        );

        const valid = await validatePack({ packDir: fixture.packDir, lockFile: fixture.lockFile, checkFabricMeta: false });
        expect(valid).toBe(false);
      } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
      }
    }
  });

  test("accepts a keybind rebind patch on a shipped PRESERVE options.txt without an ownership conflict", async () => {
    const fixture = setupFixture({
      packTomlContent: STATIC_PACK_TOML,
      staticFiles: {
        client: [{ path: "options.txt", content: "version:4000\nkey_key.snappy_tappy.toggle:key.keyboard.x\n" }],
      },
      configPatchesContent: KEYBIND_PATCHES,
    });

    try {
      const { clientManifest } = await buildManifests(fixture);

      expect(clientManifest.files.find((f) => f.path === "options.txt")?.policy).toBe("PRESERVE");
      expect(clientManifest.configPatches).toHaveLength(1);
      expect(clientManifest.configPatches![0].path).toBe("options.txt");

      const valid = await validatePack({ packDir: fixture.packDir, lockFile: fixture.lockFile, checkFabricMeta: false });
      expect(valid).toBe(true);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("clientStaticFilePolicy and validateProtectedClientFiles allow only a PRESERVE options.txt", () => {
    expect(clientStaticFilePolicy("options.txt")).toBe("PRESERVE");
    expect(clientStaticFilePolicy("Options.TXT")).toBe("MANAGED");
    expect(clientStaticFilePolicy("config/options.txt")).toBe("MANAGED");

    expect(() => validateProtectedClientFiles([{ path: "options.txt", policy: "PRESERVE" }])).not.toThrow();
    expect(() => validateProtectedClientFiles([{ path: "options.txt", policy: "MANAGED" }])).toThrow(
      "Client file 'options.txt' targets a launcher-protected path"
    );
    expect(() => validateProtectedClientFiles([{ path: "servers.dat", policy: "PRESERVE" }])).not.toThrow();
    expect(() => validateProtectedClientFiles([{ path: "servers.dat", policy: "MANAGED" }])).toThrow(
      "Client file 'servers.dat' targets a launcher-protected path"
    );
    expect(() => validateProtectedClientFiles([{ path: "usercache.json", policy: "PRESERVE" }])).toThrow(
      "Client file 'usercache.json' targets a launcher-protected path"
    );
  });
});

describe("[client].preserve seed files", () => {
  const AMECS = "options.amecs.key_modifiers.txt";

  function clientPackToml(preserve: unknown): string {
    return `${STATIC_PACK_TOML}\n[client]\npreserve = ${JSON.stringify(preserve)}\n`;
  }

  const JADE_PATCH = {
    schemaVersion: 1,
    patches: [
      {
        id: "jade-hud",
        revision: 1,
        path: "config/jade/jade.json",
        adapter: "json",
        mode: "enforce",
        missingFile: "defer",
        operations: [{ op: "set", path: ["enabled"], value: false }],
      },
    ],
  };

  test("a listed client file is PRESERVE; unlisted client and common files stay MANAGED", async () => {
    const fixture = setupFixture({
      packTomlContent: clientPackToml([AMECS]),
      staticFiles: {
        client: [
          { path: AMECS, content: "key_modifier=x" },
          { path: "options.txt", content: "version:4000\n" },
          { path: "config/jade/jade.json", content: "{}" },
        ],
        common: [{ path: "config/common.json", content: "{}" }],
      },
    });

    try {
      const { clientManifest } = await buildManifests(fixture);

      expect(clientManifest.files.find((f) => f.path === AMECS)?.policy).toBe("PRESERVE");
      expect(clientManifest.files.find((f) => f.path === "options.txt")?.policy).toBe("PRESERVE");
      expect(clientManifest.files.find((f) => f.path === "config/jade/jade.json")?.policy).toBe("MANAGED");
      expect(clientManifest.files.find((f) => f.path === "config/common.json")?.policy).toBe("MANAGED");

      const valid = await validatePack({ packDir: fixture.packDir, lockFile: fixture.lockFile, checkFabricMeta: false });
      expect(valid).toBe(true);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("list entries match client file paths case-insensitively", async () => {
    const fixture = setupFixture({
      packTomlContent: clientPackToml(["Options.Amecs.Key_Modifiers.TXT"]),
      staticFiles: { client: [{ path: AMECS, content: "key_modifier=x" }] },
    });

    try {
      const { clientManifest } = await buildManifests(fixture);
      expect(clientManifest.files.find((f) => f.path === AMECS)?.policy).toBe("PRESERVE");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("a listed common file is PRESERVE in the client manifest and MANAGED in the server manifest", async () => {
    const fixture = setupFixture({
      packTomlContent: clientPackToml(["config/shared.json"]),
      staticFiles: { common: [{ path: "config/shared.json", content: "{}" }] },
    });

    try {
      const { clientManifest, serverManifest } = await buildManifests(fixture);
      expect(clientManifest.files.find((f) => f.path === "config/shared.json")?.policy).toBe("PRESERVE");
      expect(serverManifest.files.find((f) => f.path === "config/shared.json")?.policy).toBe("MANAGED");

      const valid = await validatePack({ packDir: fixture.packDir, lockFile: fixture.lockFile, checkFabricMeta: false });
      expect(valid).toBe(true);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("a listed file that does not exist fails the build and validation", async () => {
    const fixture = setupFixture({
      packTomlContent: clientPackToml([AMECS]),
      staticFiles: { client: [{ path: "config/jade/jade.json", content: "{}" }] },
    });

    try {
      await expect(buildManifests(fixture)).rejects.toThrow(
        `[client].preserve path '${AMECS}' does not match a file in pack/client/ or pack/common/.`
      );
      const valid = await validatePack({ packDir: fixture.packDir, lockFile: fixture.lockFile, checkFabricMeta: false });
      expect(valid).toBe(false);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("a listed launcher-protected path fails even when the file exists", async () => {
    for (const protectedPath of ["usercache.json", "saves/world/level.dat", "SERVERS.DAT"]) {
      const fixture = setupFixture({
        packTomlContent: clientPackToml([protectedPath]),
        staticFiles: { client: [{ path: protectedPath, content: "x" }] },
      });

      try {
        await expect(buildManifests(fixture)).rejects.toThrow(
          `[client].preserve path '${protectedPath}' is a launcher-protected path`
        );
        const valid = await validatePack({ packDir: fixture.packDir, lockFile: fixture.lockFile, checkFabricMeta: false });
        expect(valid).toBe(false);
      } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
      }
    }
  });

  test("an unsafe listed path fails", async () => {
    for (const unsafePath of ["../options.amecs.key_modifiers.txt", "/abs/options.amecs.key_modifiers.txt"]) {
      const fixture = setupFixture({
        packTomlContent: clientPackToml([unsafePath]),
        staticFiles: { client: [{ path: AMECS, content: "x" }] },
      });

      try {
        await expect(buildManifests(fixture)).rejects.toThrow(`Unsafe [client].preserve path '${unsafePath}'`);
        const valid = await validatePack({ packDir: fixture.packDir, lockFile: fixture.lockFile, checkFabricMeta: false });
        expect(valid).toBe(false);
      } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
      }
    }
  });

  test("a [client].preserve value that is not an array of non-empty strings fails", async () => {
    for (const badValue of ["options.amecs.key_modifiers.txt", [""]]) {
      const fixture = setupFixture({
        packTomlContent: clientPackToml(badValue),
        staticFiles: { client: [{ path: AMECS, content: "x" }] },
      });

      try {
        await expect(buildManifests(fixture)).rejects.toThrow(
          "[client].preserve in pack.toml must be an array of non-empty path strings."
        );
      } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
      }
    }
  });

  test("without a preserve list, client files keep the previous policies", async () => {
    for (const packTomlContent of [STATIC_PACK_TOML, `${STATIC_PACK_TOML}\n[client]\n`]) {
      const fixture = setupFixture({
        packTomlContent,
        staticFiles: {
          client: [
            { path: AMECS, content: "x" },
            { path: "options.txt", content: "version:4000\n" },
            { path: "config/jade/jade.json", content: "{}" },
          ],
        },
      });

      try {
        const { clientManifest } = await buildManifests(fixture);
        expect(clientManifest.files.find((f) => f.path === AMECS)?.policy).toBe("MANAGED");
        expect(clientManifest.files.find((f) => f.path === "options.txt")?.policy).toBe("PRESERVE");
        expect(clientManifest.files.find((f) => f.path === "config/jade/jade.json")?.policy).toBe("MANAGED");
      } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
      }
    }
  });

  test("a config patch on a listed PRESERVE file fails the ownership check", async () => {
    const fixture = setupFixture({
      packTomlContent: clientPackToml(["config/jade/jade.json"]),
      staticFiles: { client: [{ path: "config/jade/jade.json", content: "{}" }] },
      configPatchesContent: JADE_PATCH,
    });

    try {
      await expect(buildManifests(fixture)).rejects.toThrow(
        "Config ownership conflict: 'config/jade/jade.json' is both a PRESERVE whole-file entry"
      );

      const valid = await validatePack({ packDir: fixture.packDir, lockFile: fixture.lockFile, checkFabricMeta: false });
      expect(valid).toBe(false);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

describe("launcher parity: canonical paths, options.txt origin, and duplicates", () => {
  const AMECS = "options.amecs.key_modifiers.txt";

  function preservePackToml(preserve: unknown): string {
    return `${STATIC_PACK_TOML}\n[client]\npreserve = ${JSON.stringify(preserve)}\n`;
  }

  const ENFORCE_KEYBIND_PATCHES = {
    schemaVersion: 1,
    patches: [
      {
        id: "snappy-tappy-keybind",
        revision: 1,
        path: "options.txt",
        adapter: "properties",
        mode: "enforce",
        missingFile: "defer",
        operations: [{ op: "set", path: ["key_key.snappy_tappy.toggle"], value: "key.keyboard.unknown" }],
      },
    ],
  };

  test("rejects pack/common/options.txt even when it is listed in [client].preserve", async () => {
    const fixture = setupFixture({
      packTomlContent: preservePackToml(["options.txt"]),
      staticFiles: { common: [{ path: "options.txt", content: "version:4000\n" }] },
    });

    try {
      await expect(buildManifests(fixture)).rejects.toThrow(
        "[client].preserve path 'options.txt' must come from pack/client/. options.txt is only allowed from pack/client/."
      );
      const valid = await validatePack({ packDir: fixture.packDir, lockFile: fixture.lockFile, checkFabricMeta: false });
      expect(valid).toBe(false);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("[client].preserve entries must be launcher-canonical and the exact options.txt", async () => {
    const probes: Array<[string, string]> = [
      ["./options.txt", "Unsafe [client].preserve path './options.txt'"],
      ["options.txt.", "Unsafe [client].preserve path 'options.txt.'"],
      ["options.txt/", "[client].preserve path 'options.txt/' is a launcher-protected path"],
      ["OPTIONS.TXT", "[client].preserve path 'OPTIONS.TXT' is a launcher-protected path"],
    ];

    for (const [entry, message] of probes) {
      const fixture = setupFixture({
        packTomlContent: preservePackToml([entry]),
        staticFiles: { client: [{ path: "options.txt", content: "version:4000\n" }] },
      });

      try {
        await expect(buildManifests(fixture)).rejects.toThrow(message);
        const valid = await validatePack({ packDir: fixture.packDir, lockFile: fixture.lockFile, checkFabricMeta: false });
        expect(valid).toBe(false);
      } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
      }
    }
  });

  test("a canonical [client].preserve entry with a backslash matches its client file", async () => {
    const fixture = setupFixture({
      packTomlContent: preservePackToml(["config\\jade\\jade.json"]),
      staticFiles: { client: [{ path: "config/jade/jade.json", content: "{}" }] },
    });

    try {
      const { clientManifest } = await buildManifests(fixture);
      expect(clientManifest.files.find((f) => f.path === "config/jade/jade.json")?.policy).toBe("PRESERVE");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("a config patch written with backslashes collides with a MANAGED file at its canonical path", async () => {
    const fixture = setupFixture({
      packTomlContent: STATIC_PACK_TOML,
      staticFiles: { client: [{ path: "config/jade/jade.json", content: "{}" }] },
      configPatchesContent: {
        schemaVersion: 1,
        patches: [
          {
            id: "jade-hud",
            revision: 1,
            path: "config\\jade\\jade.json",
            adapter: "json",
            mode: "enforce",
            missingFile: "defer",
            operations: [{ op: "set", path: ["enabled"], value: false }],
          },
        ],
      },
    });

    try {
      await expect(buildManifests(fixture)).rejects.toThrow(
        "Config ownership conflict: 'config/jade/jade.json' is both a MANAGED artifact"
      );
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("a PRESERVE options.txt with an enforce-mode keybind patch fails", async () => {
    const fixture = setupFixture({
      packTomlContent: STATIC_PACK_TOML,
      staticFiles: { client: [{ path: "options.txt", content: "version:4000\n" }] },
      configPatchesContent: ENFORCE_KEYBIND_PATCHES,
    });

    try {
      await expect(buildManifests(fixture)).rejects.toThrow(
        "is both a PRESERVE whole-file entry and a config-patch target"
      );
      const valid = await validatePack({ packDir: fixture.packDir, lockFile: fixture.lockFile, checkFabricMeta: false });
      expect(valid).toBe(false);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("rejects client manifest paths that collide case-insensitively", async () => {
    const fixture = setupFixture({
      packTomlContent: STATIC_PACK_TOML,
      staticFiles: {
        client: [{ path: "config/dup.json", content: "{}" }],
        common: [{ path: "config/DUP.json", content: "{}" }],
      },
    });

    try {
      await expect(buildManifests(fixture)).rejects.toThrow("Duplicate client manifest path");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("validateClientFilePaths rejects paths the launcher rejects and case-insensitive duplicates", () => {
    for (const bad of ["a/./b", "a/../b", "file.txt.", "x/ ", "con.txt", "stream.txt:ads", "/rooted.txt"]) {
      expect(() => validateClientFilePaths([{ path: bad }])).toThrow(`Client file '${bad}' has a path the launcher rejects`);
    }

    expect(() => validateClientFilePaths([{ path: "config/a.json" }, { path: "Config/A.json" }])).toThrow(
      "Duplicate client manifest path 'Config/A.json'"
    );
    expect(() => validateClientFilePaths([{ path: "config/a.json" }, { path: "config/b.json" }])).not.toThrow();
  });
});

describe("servers.dat seed files", () => {
  const SERVERS_PATCH = {
    schemaVersion: 1,
    patches: [
      {
        id: "servers-name",
        revision: 1,
        path: "servers.dat",
        adapter: "json",
        mode: "once",
        missingFile: "defer",
        operations: [{ op: "set", path: ["name"], value: "Lampas" }],
      },
    ],
  };

  function listPackToml(preserve: unknown): string {
    return `${STATIC_PACK_TOML}\n[client]\npreserve = ${JSON.stringify(preserve)}\n`;
  }

  test("client servers.dat is PRESERVE without a [client].preserve entry, and the manifest validates", async () => {
    const fixture = setupFixture({
      packTomlContent: STATIC_PACK_TOML,
      staticFiles: {
        client: [{ path: "servers.dat", content: "binary-nbt" }],
        server: [{ path: "config/server.json", content: "{}" }],
      },
    });

    try {
      const { clientManifest, serverManifest } = await buildManifests(fixture);
      expect(clientManifest.files.find((f) => f.path === "servers.dat")?.policy).toBe("PRESERVE");
      expect(serverManifest.files.find((f) => f.path === "config/server.json")?.policy).toBe("MANAGED");
      expect(serverManifest.files.some((f) => f.path === "servers.dat")).toBe(false);

      const valid = await validatePack({ packDir: fixture.packDir, lockFile: fixture.lockFile, checkFabricMeta: false });
      expect(valid).toBe(true);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("a [client].preserve entry naming servers.dat is accepted when the client file exists", async () => {
    const fixture = setupFixture({
      packTomlContent: listPackToml(["servers.dat"]),
      staticFiles: { client: [{ path: "servers.dat", content: "binary-nbt" }] },
    });

    try {
      const { clientManifest } = await buildManifests(fixture);
      expect(clientManifest.files.find((f) => f.path === "servers.dat")?.policy).toBe("PRESERVE");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("servers.dat from pack/common is never PRESERVE", async () => {
    // Unlisted: stays MANAGED, which is a protected-path error
    const unlisted = setupFixture({
      packTomlContent: STATIC_PACK_TOML,
      staticFiles: { common: [{ path: "servers.dat", content: "x" }] },
    });
    try {
      await expect(buildManifests(unlisted)).rejects.toThrow(
        "Client file 'servers.dat' targets a launcher-protected path"
      );
    } finally {
      fs.rmSync(unlisted.dir, { recursive: true, force: true });
    }

    // Listed with only a common copy: the list validator rejects it
    const listedCommonOnly = setupFixture({
      packTomlContent: listPackToml(["servers.dat"]),
      staticFiles: { common: [{ path: "servers.dat", content: "x" }] },
    });
    try {
      await expect(buildManifests(listedCommonOnly)).rejects.toThrow(
        "[client].preserve path 'servers.dat' must come from pack/client/. servers.dat is only allowed from pack/client/."
      );
    } finally {
      fs.rmSync(listedCommonOnly.dir, { recursive: true, force: true });
    }

    // Listed with a client copy and a common copy: the common copy stays MANAGED and collides
    const bothOrigins = setupFixture({
      packTomlContent: listPackToml(["servers.dat"]),
      staticFiles: {
        client: [{ path: "servers.dat", content: "client" }],
        common: [{ path: "servers.dat", content: "common" }],
      },
    });
    try {
      await expect(buildManifests(bothOrigins)).rejects.toThrow("Duplicate client manifest path");
    } finally {
      fs.rmSync(bothOrigins.dir, { recursive: true, force: true });
    }
  });

  test("other spellings and policies of servers.dat are rejected", async () => {
    // Unlisted spelling: MANAGED and protected
    const spelled = setupFixture({
      packTomlContent: STATIC_PACK_TOML,
      staticFiles: { client: [{ path: "Servers.dat", content: "x" }] },
    });
    try {
      await expect(buildManifests(spelled)).rejects.toThrow("Client file 'Servers.dat' targets a launcher-protected path");
    } finally {
      fs.rmSync(spelled.dir, { recursive: true, force: true });
    }

    // Listed spellings: the list validator rejects each one
    const listProbes: Array<[string, string]> = [
      ["SERVERS.DAT", "[client].preserve path 'SERVERS.DAT' is a launcher-protected path"],
      ["servers.dat/", "[client].preserve path 'servers.dat/' is a launcher-protected path"],
      ["./servers.dat", "Unsafe [client].preserve path './servers.dat'"],
    ];
    for (const [entry, message] of listProbes) {
      const fixture = setupFixture({
        packTomlContent: listPackToml([entry]),
        staticFiles: { client: [{ path: "servers.dat", content: "x" }] },
      });
      try {
        await expect(buildManifests(fixture)).rejects.toThrow(message);
        const valid = await validatePack({ packDir: fixture.packDir, lockFile: fixture.lockFile, checkFabricMeta: false });
        expect(valid).toBe(false);
      } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
      }
    }
  });

  test("a config patch on a PRESERVE servers.dat is an ownership collision", async () => {
    const fixture = setupFixture({
      packTomlContent: STATIC_PACK_TOML,
      staticFiles: { client: [{ path: "servers.dat", content: "x" }] },
      configPatchesContent: SERVERS_PATCH,
    });

    try {
      await expect(buildManifests(fixture)).rejects.toThrow(
        "Config ownership conflict: 'servers.dat' is both a PRESERVE whole-file entry and a config-patch target."
      );
      const valid = await validatePack({ packDir: fixture.packDir, lockFile: fixture.lockFile, checkFabricMeta: false });
      expect(valid).toBe(false);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("seed policy helpers and the protected-file rule accept only the exact PRESERVE seeds", () => {
    expect(isSeedClientFile("options.txt")).toBe(true);
    expect(isSeedClientFile("servers.dat")).toBe(true);
    expect(isSeedClientFile("Servers.dat")).toBe(false);

    expect(clientStaticFilePolicy("servers.dat")).toBe("PRESERVE");
    expect(clientStaticFilePolicy("Servers.dat")).toBe("MANAGED");
    expect(commonStaticFilePolicy("servers.dat", ["servers.dat"])).toBe("MANAGED");
    expect(commonStaticFilePolicy("config/x.json", ["config/x.json"])).toBe("PRESERVE");

    expect(() => validateProtectedClientFiles([{ path: "servers.dat", policy: "PRESERVE" }])).not.toThrow();
    for (const policy of ["MANAGED", "OPTIONAL", "GENERATED"] as const) {
      expect(() => validateProtectedClientFiles([{ path: "servers.dat", policy }])).toThrow(
        "Client file 'servers.dat' targets a launcher-protected path"
      );
    }
    expect(() => validateProtectedClientFiles([{ path: "Servers.dat", policy: "PRESERVE" }])).toThrow(
      "Client file 'Servers.dat' targets a launcher-protected path"
    );
  });
});

describe("validate applies the manifest rules", () => {
  test("a pack whose manifest the Portal would reject fails validatePack as well as buildManifests", async () => {
    const fixture = setupFixture({
      packTomlContent: STATIC_PACK_TOML.replace("protocol = 3", "protocol = 4"),
      staticFiles: { client: [{ path: "config/x.json", content: "{}" }] },
    });

    try {
      await expect(buildManifests(fixture)).rejects.toThrow("protocol must be an integer from 0 to 3");
      const valid = await validatePack({ packDir: fixture.packDir, lockFile: fixture.lockFile, checkFabricMeta: false });
      expect(valid).toBe(false);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

describe("keybind multi-key warning", () => {
  test("validate prints the multi-key keybind warning once, not once per check", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const fixture = setupFixture({
      packTomlContent: STATIC_PACK_TOML,
      staticFiles: { client: [{ path: "options.txt", content: "version:4000\n" }] },
      configPatchesContent: {
        schemaVersion: 1,
        patches: [
          {
            id: "two-keys",
            revision: 1,
            path: "options.txt",
            adapter: "properties",
            mode: "once",
            missingFile: "defer",
            operations: [
              { op: "set", path: ["key_key.snappy_tappy.toggle"], value: "key.keyboard.unknown" },
              { op: "set", path: ["key_key.mod.dash"], value: "key.keyboard.x" },
            ],
          },
        ],
      },
    });

    try {
      const valid = await validatePack({ packDir: fixture.packDir, lockFile: fixture.lockFile, checkFabricMeta: false });
      expect(valid).toBe(true);
      const multiKeyWarnings = warn.mock.calls.filter((call) => String(call[0]).includes("keys in options.txt"));
      expect(multiKeyWarnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});
