import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { zipSync } from "fflate";
import { deployServer } from "../src/sync";
import { DeploymentTransaction } from "../src/transaction";

describe("lampasctl deploy server deployment workflow", () => {
  let server: ReturnType<typeof Bun.serve>;
  let portalUrl: string;

  function createMockJar(mc: string, loader: string): Buffer {
    const manifest = Buffer.from(
      "Manifest-Version: 1.0\r\nImplementation-Title: FabricInstaller\r\nImplementation-Version: 1.1.2\r\nMain-Class: net.fabricmc.installer.ServerLauncher\r\n\r\n"
    );
    const installProps = Buffer.from(
      `fabric-loader-version=${loader}\r\ngame-version=${mc}\r\n`
    );
    return Buffer.from(
      zipSync({
        "META-INF/MANIFEST.MF": new Uint8Array(manifest),
        "install.properties": new Uint8Array(installProps),
      })
    );
  }

  const v1ModContent = Buffer.from("v1-mod-jar-bytes");
  const v1ModSha = crypto.createHash("sha256").update(v1ModContent).digest("hex");

  const v2ModContent = Buffer.from("v2-updated-mod-jar-bytes");
  const v2ModSha = crypto.createHash("sha256").update(v2ModContent).digest("hex");

  const srpContent = Buffer.from("server-resource-pack-zip-bytes");
  const srpSha256 = crypto.createHash("sha256").update(srpContent).digest("hex");
  const srpSha1 = crypto.createHash("sha1").update(srpContent).digest("hex");

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);

        // Fabric Meta server jar endpoint
        if (url.pathname.includes("/server/jar")) {
          const parts = url.pathname.split("/");
          const loaderIdx = parts.indexOf("loader");
          const mc = loaderIdx !== -1 && parts[loaderIdx + 1] ? parts[loaderIdx + 1] : "26.2";
          const loader = loaderIdx !== -1 && parts[loaderIdx + 2] ? parts[loaderIdx + 2] : "0.19.3";
          return new Response(new Uint8Array(createMockJar(mc, loader)), {
            headers: { "Content-Type": "application/java-archive" },
          });
        }

        // Channel endpoints
        if (url.pathname === "/api/v1/channels/dev") {
          return Response.json({ channel: "dev", version: "2.0.0" });
        }
        if (url.pathname === "/api/v1/channels/stable") {
          return Response.json({ channel: "stable", version: "2.1.0" });
        }

        // Release endpoints
        if (url.pathname === "/api/v1/releases/2.0.0") {
          return Response.json({
            schemaVersion: 1,
            pack: "Lampas 2",
            version: "2.0.0",
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
            minimumLauncherVersion: "1.0.0",
            protocol: 2,
            created: "2026-08-26T00:00:00Z",
            clientManifest: "/api/v1/releases/2.0.0/client-manifest",
            serverManifest: "/api/v1/releases/2.0.0/server-manifest",
          });
        }
        if (url.pathname === "/api/v1/releases/2.0.0/server-manifest") {
          return Response.json({
            schemaVersion: 1,
            pack: "Lampas 2",
            version: "2.0.0",
            target: "server",
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
            protocol: 2,
            resourcePack: {
              artifact: "lampas2-resources",
              required: true,
              filename: "lampas2-resource-pack.zip",
              path: "resourcepacks/lampas2-resource-pack.zip",
              size: srpContent.length,
              url: `http://127.0.0.1:${server.port}/api/v1/blobs/${srpSha256}`,
              sha1: srpSha1,
              sha256: srpSha256,
              id: "11111111-2222-3333-4444-555555555555",
              prompt: '{"text":"Server Textures"}',
            },
            files: [
              {
                path: "mods/fabric-api.jar",
                hashes: { sha256: v1ModSha },
                size: v1ModContent.length,
                download: { url: `/api/v1/blobs/${v1ModSha}`, provider: "lampas" },
                policy: "MANAGED",
              },
            ],
          });
        }

        if (url.pathname === "/api/v1/releases/2.1.0") {
          return Response.json({
            schemaVersion: 1,
            pack: "Lampas 2",
            version: "2.1.0",
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.4" },
            minimumLauncherVersion: "1.0.0",
            protocol: 2,
            created: "2026-08-26T00:00:00Z",
            clientManifest: "/api/v1/releases/2.1.0/client-manifest",
            serverManifest: "/api/v1/releases/2.1.0/server-manifest",
          });
        }
        if (url.pathname === "/api/v1/releases/2.1.0/server-manifest") {
          return Response.json({
            schemaVersion: 1,
            pack: "Lampas 2",
            version: "2.1.0",
            target: "server",
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.4" },
            protocol: 2,
            files: [
              {
                path: "mods/fabric-api.jar",
                hashes: { sha256: v2ModSha },
                size: v2ModContent.length,
                download: { url: `/api/v1/blobs/${v2ModSha}`, provider: "lampas" },
                policy: "MANAGED",
              },
            ],
          });
        }

        // Blob endpoints
        if (url.pathname === `/api/v1/blobs/${v1ModSha}`) {
          return new Response(v1ModContent);
        }
        if (url.pathname === `/api/v1/blobs/${v2ModSha}`) {
          return new Response(v2ModContent);
        }
        if (url.pathname === `/api/v1/blobs/${srpSha256}`) {
          return new Response(srpContent);
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    portalUrl = `http://127.0.0.1:${server.port}`;
    process.env.FABRIC_META_URL = portalUrl;
  });

  afterAll(() => {
    delete process.env.FABRIC_META_URL;
    server.stop(true);
  });

  test("deploys release by channel, creates world backup, updates server.properties and records state", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-deploy-test-"));
    const serverDir = path.join(dir, "minecraft-server");
    fs.mkdirSync(serverDir, { recursive: true });

    // Pre-create server.properties and existing world
    fs.writeFileSync(
      path.join(serverDir, "server.properties"),
      "motd=Lampas Dedicated Server\nserver-port=25565\ndifficulty=hard\nresource-pack=\n"
    );
    const worldDir = path.join(serverDir, "world");
    fs.mkdirSync(worldDir, { recursive: true });
    fs.writeFileSync(path.join(worldDir, "level.dat"), "world-save-data");

    try {
      await deployServer({
        targetDir: serverDir,
        portalUrl,
        channel: "dev",
        backupWorld: true,
      });

      // Verify files deployed
      const modFile = path.join(serverDir, "mods", "fabric-api.jar");
      expect(fs.existsSync(modFile)).toBe(true);
      expect(fs.readFileSync(modFile).equals(v1ModContent)).toBe(true);

      // Verify world backup was created
      const backupsDir = path.join(serverDir, ".backups");
      expect(fs.existsSync(backupsDir)).toBe(true);
      const backupEntries = fs.readdirSync(backupsDir);
      expect(backupEntries.length).toBeGreaterThan(0);
      expect(backupEntries[0]).toStartWith("world_");

      // Verify server.properties has all 5 keys reconciled
      const props = fs.readFileSync(path.join(serverDir, "server.properties"), "utf-8");
      expect(props).toContain("motd=Lampas Dedicated Server");
      expect(props).toContain(`resource-pack=http://127.0.0.1:${server.port}/api/v1/blobs/${srpSha256}`);
      expect(props).toContain(`resource-pack-sha1=${srpSha1}`);
      expect(props).toContain("resource-pack-id=11111111-2222-3333-4444-555555555555");
      expect(props).toContain('resource-pack-prompt={"text":"Server Textures"}');
      expect(props).toContain("require-resource-pack=true");

      // Verify installation.json state
      const stateFile = path.join(serverDir, ".lampas", "installation.json");
      expect(fs.existsSync(stateFile)).toBe(true);
      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.version).toBe("2.0.0");
      expect(state.files["mods/fabric-api.jar"].sha256).toBe(v1ModSha);
      expect(state.serverResourcePack.managed).toBe(true);

      // Deploy next release (2.1.0) with server resource pack removed
      await deployServer({
        targetDir: serverDir,
        portalUrl,
        channel: "stable",
        backupWorld: true,
      });

      // Verify mod updated to v2
      expect(fs.readFileSync(modFile).equals(v2ModContent)).toBe(true);

      // Verify server.properties reset
      const props2 = fs.readFileSync(path.join(serverDir, "server.properties"), "utf-8");
      expect(props2).toContain("resource-pack=");
      expect(props2).toContain("resource-pack-sha1=");
      expect(props2).toContain("resource-pack-id=");
      expect(props2).toContain("resource-pack-prompt=");
      expect(props2).toContain("require-resource-pack=false");

      const state2 = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state2.version).toBe("2.1.0");
      expect(state2.serverResourcePack).toEqual({ managed: false });
      expect(state2.runtime?.loader?.version).toBe("0.19.4");

      const runtimeFile = path.join(serverDir, ".lampas", "runtime", "runtime.json");
      const runtimeState = JSON.parse(fs.readFileSync(runtimeFile, "utf-8"));
      expect(runtimeState.loader.version).toBe("0.19.4");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips world backup when backupWorld is false", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-deploy-nobackup-"));
    const serverDir = path.join(dir, "minecraft-server");
    fs.mkdirSync(serverDir, { recursive: true });

    const worldDir = path.join(serverDir, "world");
    fs.mkdirSync(worldDir, { recursive: true });
    fs.writeFileSync(path.join(worldDir, "level.dat"), "world-save-data");

    try {
      await deployServer({
        targetDir: serverDir,
        portalUrl,
        channel: "dev",
        backupWorld: false,
      });

      const backupsDir = path.join(serverDir, ".backups");
      expect(fs.existsSync(backupsDir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("supports explicit --version override without channel lookup", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-deploy-version-"));
    const serverDir = path.join(dir, "minecraft-server");
    fs.mkdirSync(serverDir, { recursive: true });

    try {
      await deployServer({
        targetDir: serverDir,
        portalUrl,
        version: "2.1.0",
        backupWorld: false,
      });

      const stateFile = path.join(serverDir, ".lampas", "installation.json");
      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.version).toBe("2.1.0");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects server manifest attempting to manage protected server paths", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-deploy-protected-"));
    const serverDir = path.join(dir, "minecraft-server");
    fs.mkdirSync(serverDir, { recursive: true });

    // Mock server returning manifest that attempts to manage server.properties
    const evilServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/channels/dev") {
          return Response.json({ channel: "dev", version: "2.0.0" });
        }
        if (url.pathname === "/api/v1/releases/2.0.0") {
          return Response.json({
            schemaVersion: 1,
            pack: "Lampas 2",
            version: "2.0.0",
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
          });
        }
        if (url.pathname === "/api/v1/releases/2.0.0/server-manifest") {
          return Response.json({
            schemaVersion: 1,
            pack: "Lampas 2",
            version: "2.0.0",
            target: "server",
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
            protocol: 2,
            files: [
              {
                path: "server.properties",
                hashes: { sha256: "a".repeat(64) },
                size: 10,
                download: { url: "/api/v1/blobs/evil" },
                policy: "MANAGED",
              },
            ],
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    try {
      await expect(
        deployServer({
          targetDir: serverDir,
          portalUrl: `http://127.0.0.1:${evilServer.port}`,
          channel: "dev",
        })
      ).rejects.toThrow("Server manifest attempts to manage protected path 'server.properties'");
    } finally {
      evilServer.stop(true);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects when Portal returns a client manifest for server deployment", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-deploy-wrongtarget-"));
    const serverDir = path.join(dir, "minecraft-server");
    fs.mkdirSync(serverDir, { recursive: true });

    const wrongTargetServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/channels/dev") {
          return Response.json({ channel: "dev", version: "2.0.0" });
        }
        if (url.pathname === "/api/v1/releases/2.0.0") {
          return Response.json({
            schemaVersion: 1,
            pack: "Lampas 2",
            version: "2.0.0",
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
          });
        }
        if (url.pathname === "/api/v1/releases/2.0.0/server-manifest") {
          return Response.json({
            schemaVersion: 1,
            pack: "Lampas 2",
            version: "2.0.0",
            target: "client", // BUG on server returning client manifest
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
            protocol: 2,
            files: [],
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    try {
      await expect(
        deployServer({
          targetDir: serverDir,
          portalUrl: `http://127.0.0.1:${wrongTargetServer.port}`,
          channel: "dev",
        })
      ).rejects.toThrow("Manifest target mismatch: expected 'server', got 'client'");
    } finally {
      wrongTargetServer.stop(true);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rapid consecutive world backups create distinct collision-safe directories", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-deploy-collisions-"));
    const serverDir = path.join(dir, "minecraft-server");
    fs.mkdirSync(serverDir, { recursive: true });

    const worldDir = path.join(serverDir, "world");
    fs.mkdirSync(worldDir, { recursive: true });
    fs.writeFileSync(path.join(worldDir, "level.dat"), "world-data");

    try {
      await deployServer({
        targetDir: serverDir,
        portalUrl,
        channel: "dev",
        backupWorld: true,
      });

      await deployServer({
        targetDir: serverDir,
        portalUrl,
        channel: "stable",
        backupWorld: true,
      });

      const backupsDir = path.join(serverDir, ".backups");
      const backupEntries = fs.readdirSync(backupsDir);
      expect(backupEntries.length).toBe(2);
      expect(backupEntries[0]).not.toBe(backupEntries[1]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects server resource pack when SHA-1 is missing or required is non-boolean", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-deploy-srp-validate-"));
    const serverDir = path.join(dir, "minecraft-server");
    fs.mkdirSync(serverDir, { recursive: true });

    const missingSha1Server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/channels/dev") {
          return Response.json({ channel: "dev", version: "2.0.0" });
        }
        if (url.pathname === "/api/v1/releases/2.0.0") {
          return Response.json({
            schemaVersion: 1,
            pack: "Lampas 2",
            version: "2.0.0",
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
          });
        }
        if (url.pathname === "/api/v1/releases/2.0.0/server-manifest") {
          return Response.json({
            schemaVersion: 1,
            pack: "Lampas 2",
            version: "2.0.0",
            target: "server",
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
            protocol: 2,
            resourcePack: {
              artifact: "lampas2-resources",
              required: true,
              filename: "lampas2.zip",
              path: "resourcepacks/lampas2.zip",
              size: 1,
              url: "/api/v1/blobs/srp",
              sha256: "a".repeat(64),
              // sha1 intentionally omitted
            },
            files: [],
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    try {
      await expect(
        deployServer({
          targetDir: serverDir,
          portalUrl: `http://127.0.0.1:${missingSha1Server.port}`,
          channel: "dev",
        })
      ).rejects.toThrow("Invalid server resourcePack: SHA-1 is required and must be 40 hex characters");
    } finally {
      missingSha1Server.stop(true);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects deployment when release descriptor and server manifest loader versions disagree", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-deploy-mismatch-"));
    const serverDir = path.join(dir, "minecraft-server");
    fs.mkdirSync(serverDir, { recursive: true });

    const mismatchServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/channels/dev") {
          return Response.json({ channel: "dev", version: "2.0.0" });
        }
        if (url.pathname === "/api/v1/releases/2.0.0") {
          return Response.json({
            schemaVersion: 1,
            pack: "Lampas 2",
            version: "2.0.0",
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
          });
        }
        if (url.pathname === "/api/v1/releases/2.0.0/server-manifest") {
          return Response.json({
            schemaVersion: 1,
            pack: "Lampas 2",
            version: "2.0.0",
            target: "server",
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.4" }, // Loader version mismatch!
            protocol: 2,
            files: [],
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    try {
      await expect(
        deployServer({
          targetDir: serverDir,
          portalUrl: `http://127.0.0.1:${mismatchServer.port}`,
          channel: "dev",
        })
      ).rejects.toThrow("Invalid Lampas release: release descriptor requires Fabric 0.19.3, server manifest requires Fabric 0.19.4.");
    } finally {
      mismatchServer.stop(true);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("failure atomicity: runtime staging failure aborts deployment before modifying disk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-deploy-atomicity-"));
    const serverDir = path.join(dir, "minecraft-server");
    fs.mkdirSync(serverDir, { recursive: true });

    // Pre-populate with v1 mod and state
    const modsDir = path.join(serverDir, "mods");
    fs.mkdirSync(modsDir, { recursive: true });
    fs.writeFileSync(path.join(modsDir, "existing-mod.jar"), "existing-mod-content");

    const runtimeDir = path.join(serverDir, ".lampas", "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "fabric-server-launch.jar"), "previous-coherent-launcher");
    fs.writeFileSync(
      path.join(runtimeDir, "runtime.json"),
      JSON.stringify({
        minecraft: "26.2",
        loader: { type: "fabric", version: "0.19.3" },
        launcherJar: "fabric-server-launch.jar",
        launcherSha256: "prevhash",
      })
    );

    // Mock server returning release that requires a loader which fails to download
    const failingRuntimeServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/channels/dev") {
          return Response.json({ channel: "dev", version: "2.0.0" });
        }
        if (url.pathname === "/api/v1/releases/2.0.0") {
          return Response.json({
            schemaVersion: 1,
            pack: "Lampas 2",
            version: "2.0.0",
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.99.broken" },
          });
        }
        if (url.pathname === "/api/v1/releases/2.0.0/server-manifest") {
          return Response.json({
            schemaVersion: 1,
            pack: "Lampas 2",
            version: "2.0.0",
            target: "server",
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.99.broken" },
            protocol: 2,
            files: [
              {
                path: "mods/new-mod.jar",
                hashes: { sha256: "b".repeat(64) },
                size: 10,
                download: { url: "/api/v1/blobs/newmod" },
                policy: "MANAGED",
              },
            ],
          });
        }
        // Fabric server download returns 500 error
        if (url.pathname.includes("/server/jar")) {
          return new Response("Fabric Meta Down", { status: 500 });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    try {
      await expect(
        deployServer({
          targetDir: serverDir,
          portalUrl: `http://127.0.0.1:${failingRuntimeServer.port}`,
          fabricMetaUrl: `http://127.0.0.1:${failingRuntimeServer.port}`,
          channel: "dev",
        })
      ).rejects.toThrow("Failed to download Fabric server launcher");

      // Verify that existing mod was NOT deleted, new mod was NOT added, and runtime remained previous coherent version
      expect(fs.existsSync(path.join(modsDir, "existing-mod.jar"))).toBe(true);
      expect(fs.existsSync(path.join(modsDir, "new-mod.jar"))).toBe(false);
      expect(fs.readFileSync(path.join(runtimeDir, "fabric-server-launch.jar"), "utf-8")).toBe("previous-coherent-launcher");
    } finally {
      failingRuntimeServer.stop(true);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("transactional rollback: forced activation failure restores previous coherent release state", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-deploy-tx-rollback-"));
    const serverDir = path.join(dir, "minecraft-server");
    fs.mkdirSync(serverDir, { recursive: true });

    // Initial server.properties
    fs.writeFileSync(
      path.join(serverDir, "server.properties"),
      "motd=Lampas Dedicated Server\nserver-port=25565\ndifficulty=hard\nresource-pack=\n"
    );

    try {
      // 1. Successfully deploy Release 1 (2.0.0, Fabric 0.19.3)
      await deployServer({
        targetDir: serverDir,
        portalUrl,
        channel: "dev",
        backupWorld: false,
      });

      const modFile = path.join(serverDir, "mods", "fabric-api.jar");
      const runtimeJar = path.join(serverDir, ".lampas", "runtime", "fabric-server-launch.jar");
      const runtimeJson = path.join(serverDir, ".lampas", "runtime", "runtime.json");
      const installationJson = path.join(serverDir, ".lampas", "installation.json");
      const serverProps = path.join(serverDir, "server.properties");

      // Verify Release 1 state on disk
      expect(fs.readFileSync(modFile).equals(v1ModContent)).toBe(true);
      const v1RuntimeState = JSON.parse(fs.readFileSync(runtimeJson, "utf-8"));
      expect(v1RuntimeState.loader.version).toBe("0.19.3");
      const v1InstallState = JSON.parse(fs.readFileSync(installationJson, "utf-8"));
      expect(v1InstallState.version).toBe("2.0.0");
      const v1Props = fs.readFileSync(serverProps, "utf-8");
      expect(v1Props).toContain(`resource-pack=http://127.0.0.1:${server.port}/api/v1/blobs/${srpSha256}`);
      expect(v1Props).toContain("require-resource-pack=true");

      const v1JarBytes = fs.readFileSync(runtimeJar);

      // 2. Attempt to deploy Release 2 (2.1.0, Fabric 0.19.4), but force activation failure
      await expect(
        deployServer({
          targetDir: serverDir,
          portalUrl,
          channel: "stable",
          backupWorld: false,
          _testHooks: {
            forceActivationFailure: true,
          },
        })
      ).rejects.toThrow("Forced runtime activation failure for test verification");

      // 3. Verify complete rollback to Release 1 state:
      // - Mod file content rolled back to v1
      expect(fs.readFileSync(modFile).equals(v1ModContent)).toBe(true);

      // - Runtime launcher JAR rolled back to 0.19.3
      expect(fs.readFileSync(runtimeJar).equals(v1JarBytes)).toBe(true);

      // - runtime.json rolled back to 0.19.3
      const rolledBackRuntimeState = JSON.parse(fs.readFileSync(runtimeJson, "utf-8"));
      expect(rolledBackRuntimeState.loader.version).toBe("0.19.3");

      // - installation.json rolled back to 2.0.0
      const rolledBackInstallState = JSON.parse(fs.readFileSync(installationJson, "utf-8"));
      expect(rolledBackInstallState.version).toBe("2.0.0");
      expect(rolledBackInstallState.files["mods/fabric-api.jar"].sha256).toBe(v1ModSha);

      // - server.properties restored to 2.0.0 values (resource pack still configured)
      const rolledBackProps = fs.readFileSync(serverProps, "utf-8");
      expect(rolledBackProps).toContain(`resource-pack=http://127.0.0.1:${server.port}/api/v1/blobs/${srpSha256}`);
      expect(rolledBackProps).toContain("require-resource-pack=true");

      // - Rollback journal and staging directories cleaned up
      expect(fs.existsSync(path.join(serverDir, ".lampas", ".tx-rollback"))).toBe(false);
      expect(fs.existsSync(path.join(serverDir, ".lampas", "runtime", ".tmp-staging"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("transactional rollback: forced activation failure on clean install leaves no orphaned files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-deploy-tx-clean-rollback-"));
    const serverDir = path.join(dir, "minecraft-server");
    fs.mkdirSync(serverDir, { recursive: true });

    const initialProps = "motd=Clean Server\nserver-port=25565\n";
    fs.writeFileSync(path.join(serverDir, "server.properties"), initialProps);

    try {
      await expect(
        deployServer({
          targetDir: serverDir,
          portalUrl,
          channel: "dev",
          backupWorld: false,
          _testHooks: {
            forceActivationFailure: true,
          },
        })
      ).rejects.toThrow("Forced runtime activation failure for test verification");

      // Mod files added by the failed release should be removed
      expect(fs.existsSync(path.join(serverDir, "mods", "fabric-api.jar"))).toBe(false);

      // installation.json should not exist
      expect(fs.existsSync(path.join(serverDir, ".lampas", "installation.json"))).toBe(false);

      // Runtime should not be activated
      expect(fs.existsSync(path.join(serverDir, ".lampas", "runtime", "fabric-server-launch.jar"))).toBe(false);

      // server.properties should be restored to its initial state
      expect(fs.readFileSync(path.join(serverDir, "server.properties"), "utf-8")).toBe(initialProps);

      // Rollback journal and staging directories cleaned up
      expect(fs.existsSync(path.join(serverDir, ".lampas", ".tx-rollback"))).toBe(false);
      expect(fs.existsSync(path.join(serverDir, ".lampas", "runtime", ".tmp-staging"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fail-closed crash recovery: aborts deployment when interrupted transaction recovery fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-deploy-recovery-fail-"));
    const serverDir = path.join(dir, "minecraft-server");
    fs.mkdirSync(serverDir, { recursive: true });

    // Simulate an unrecoverable corrupted journal
    const txDir = path.join(serverDir, ".lampas", ".tx-rollback");
    fs.mkdirSync(txDir, { recursive: true });
    fs.writeFileSync(path.join(txDir, "journal.json"), "{ invalid JSON syntax !!!");

    try {
      await expect(
        deployServer({
          targetDir: serverDir,
          portalUrl,
          channel: "dev",
        })
      ).rejects.toThrow("Cannot recover interrupted deployment transaction:");

      // Verify that no mods were deployed on top of corrupted state
      expect(fs.existsSync(path.join(serverDir, "mods"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("standalone recovery restores interrupted transaction state and deletes journal", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-deploy-recovery-standalone-"));
    const serverDir = path.join(dir, "minecraft-server");
    fs.mkdirSync(path.join(serverDir, "mods"), { recursive: true });

    // Set up corrupted on-disk state from an interrupted hard-crash
    const newModPath = path.join(serverDir, "mods", "interrupted-new-mod.jar");
    const oldModPath = path.join(serverDir, "mods", "existing-mod.jar");
    const propsPath = path.join(serverDir, "server.properties");

    fs.writeFileSync(newModPath, "partial-new-mod-data");
    fs.writeFileSync(oldModPath, "partially-overwritten-mod-data");
    fs.writeFileSync(propsPath, "motd=partially-corrupted-motd\n");

    // Set up transaction journal and backups
    const txDir = path.join(serverDir, ".lampas", ".tx-rollback");
    const overwrittenDir = path.join(txDir, "overwritten", "mods");
    fs.mkdirSync(overwrittenDir, { recursive: true });

    fs.writeFileSync(path.join(overwrittenDir, "existing-mod.jar"), "restored-good-mod-content");
    fs.writeFileSync(path.join(txDir, "server.properties"), "motd=Restored Coherent Server\n");

    const journal = {
      txId: "interrupted-tx-123",
      startedAt: new Date().toISOString(),
      targetDir: serverDir,
      overwrittenFiles: ["mods/existing-mod.jar"],
      deletedFiles: [],
      newFiles: ["mods/interrupted-new-mod.jar"],
      hadServerProperties: true,
      hadInstallationJson: false,
      hadRuntimeJar: false,
      hadRuntimeJson: false,
    };
    fs.writeFileSync(path.join(txDir, "journal.json"), JSON.stringify(journal, null, 2));

    try {
      // 1. First call recovers the interrupted state
      const recovered = await DeploymentTransaction.recoverIfInterrupted(serverDir);
      expect(recovered).toBe(true);

      // Verify files were recovered
      expect(fs.existsSync(newModPath)).toBe(false);
      expect(fs.readFileSync(oldModPath, "utf-8")).toBe("restored-good-mod-content");
      expect(fs.readFileSync(propsPath, "utf-8")).toBe("motd=Restored Coherent Server\n");

      // Verify journal is deleted
      expect(fs.existsSync(txDir)).toBe(false);

      // 2. Second call is a clean no-op
      const secondRecover = await DeploymentTransaction.recoverIfInterrupted(serverDir);
      expect(secondRecover).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("lampasctl recover CLI command restores interrupted transaction state", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-deploy-cli-recovery-"));
    const serverDir = path.join(dir, "minecraft-server");
    fs.mkdirSync(path.join(serverDir, "mods"), { recursive: true });

    const newModPath = path.join(serverDir, "mods", "cli-interrupted-mod.jar");
    const oldModPath = path.join(serverDir, "mods", "cli-existing-mod.jar");

    fs.writeFileSync(newModPath, "partial-new-mod");
    fs.writeFileSync(oldModPath, "corrupted-existing-mod");

    const txDir = path.join(serverDir, ".lampas", ".tx-rollback");
    const overwrittenDir = path.join(txDir, "overwritten", "mods");
    fs.mkdirSync(overwrittenDir, { recursive: true });

    fs.writeFileSync(path.join(overwrittenDir, "cli-existing-mod.jar"), "restored-from-cli");

    const journal = {
      txId: "cli-tx-456",
      startedAt: new Date().toISOString(),
      targetDir: serverDir,
      overwrittenFiles: ["mods/cli-existing-mod.jar"],
      deletedFiles: [],
      newFiles: ["mods/cli-interrupted-mod.jar"],
      hadServerProperties: false,
      hadInstallationJson: false,
      hadRuntimeJar: false,
      hadRuntimeJson: false,
    };
    fs.writeFileSync(path.join(txDir, "journal.json"), JSON.stringify(journal, null, 2));

    try {
      const cliPath = path.resolve("tools", "lampasctl", "src", "cli.ts");
      const res = spawnSync("bun", ["run", cliPath, "recover", "--target", serverDir], {
        encoding: "utf-8",
      });

      expect(res.status).toBe(0);
      expect(res.stderr).toContain("[Deployment Recovery] Detected incomplete deployment transaction");
      expect(res.stdout).toContain("[Recover] Successfully recovered interrupted transaction");

      expect(fs.existsSync(newModPath)).toBe(false);
      expect(fs.readFileSync(oldModPath, "utf-8")).toBe("restored-from-cli");
      expect(fs.existsSync(txDir)).toBe(false);

      // Running again reports no transaction found
      const res2 = spawnSync("bun", ["run", cliPath, "recover", "--target", serverDir], {
        encoding: "utf-8",
      });
      expect(res2.status).toBe(0);
      expect(res2.stdout).toContain("[Recover] No interrupted transaction found");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
