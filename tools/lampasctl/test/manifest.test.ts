import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildManifests } from "../src/manifest";
import { validatePack } from "../src/validator";
import { isValidServerAddress } from "../src/utils";

function setupFixture(options: {
  packTomlContent: string;
  lockArtifacts?: Record<string, any>;
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

