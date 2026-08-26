import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deployServer } from "../src/sync";

describe("lampasctl deploy server deployment workflow", () => {
  let server: ReturnType<typeof Bun.serve>;
  let portalUrl: string;

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
            loader: { type: "fabric", version: "0.19.3" },
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
            loader: { type: "fabric", version: "0.19.3" },
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
  });

  afterAll(() => {
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
});
