import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const scriptPath = path.resolve(__dirname, "../../scripts/deploy-pack.py");

describe("deploy-pack.py server deployment engine", () => {
  test("fails immediately when explicit --manifest path does not exist", () => {
    const res = spawnSync("python", [scriptPath, "--manifest", "non-existent-manifest.json", "--skip-backup"], {
      encoding: "utf-8",
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr + res.stdout).toContain("FileNotFoundError");
  });

  test("validates manifest and fails on path traversal", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-deploy-test-"));
    const manifestPath = path.join(dir, "server-manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        pack: "Lampas 2",
        version: "2.0.0",
        target: "server",
        minecraft: "26.2",
        loader: { type: "fabric", version: "0.19.3" },
        files: [
          {
            path: "../../evil.jar",
            hashes: { sha256: "a".repeat(64) },
            size: 100,
            download: { url: "http://example.com/evil.jar" },
            policy: "MANAGED",
          },
        ],
      })
    );

    try {
      const res = spawnSync("python", [scriptPath, "--manifest", manifestPath, "--skip-backup"], {
        cwd: dir,
        encoding: "utf-8",
      });
      expect(res.status).not.toBe(0);
      expect(res.stderr + res.stdout).toContain("Path traversal detected");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails when server resourcePack has missing SHA-1", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-deploy-test-"));
    const manifestPath = path.join(dir, "server-manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        pack: "Lampas 2",
        version: "2.0.0",
        target: "server",
        minecraft: "26.2",
        loader: { type: "fabric", version: "0.19.3" },
        resourcePack: {
          artifact: "lampas2",
          url: "https://portal.lampas.town/api/v1/blobs/" + "a".repeat(64),
          sha256: "a".repeat(64),
          id: "11111111-2222-3333-4444-555555555555",
          required: true,
        },
        files: [],
      })
    );

    try {
      const res = spawnSync("python", [scriptPath, "--manifest", manifestPath, "--skip-backup"], {
        cwd: dir,
        encoding: "utf-8",
      });
      expect(res.status).not.toBe(0);
      expect(res.stderr + res.stdout).toContain("resourcePack has invalid SHA-1");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("safely synchronizes server files, reconciles server.properties and writes state", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-deploy-test-"));
    const manifestPath = path.join(dir, "server-manifest.json");

    // Pre-create server.properties
    fs.writeFileSync(
      path.join(dir, "server.properties"),
      "motd=Initial MOTD\nserver-port=25565\nresource-pack=\ndifficulty=normal\n"
    );

    // Create a dummy fixture file in local pipeline pack/common to test candidate file copy
    const fixtureDir = path.join(dir, "fake-pipeline", "pack", "common", "config");
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, "test.txt"), "hello world");
    const testSha256 = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

    const srpSha256 = "a".repeat(64);
    const srpSha1 = "b".repeat(40);
    const srpUuid = "12345678-1234-1234-1234-123456789abc";

    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        pack: "Lampas 2",
        version: "2.0.0",
        target: "server",
        minecraft: "26.2",
        loader: { type: "fabric", version: "0.19.3" },
        resourcePack: {
          artifact: "lampas2",
          url: "https://portal.lampas.town/api/v1/blobs/" + srpSha256,
          sha1: srpSha1,
          sha256: srpSha256,
          id: srpUuid,
          required: true,
          prompt: '{"text":"Custom textures"}',
        },
        files: [
          {
            path: "config/test.txt",
            hashes: { sha256: testSha256 },
            size: 11,
            download: { url: "http://example.com/test.txt" },
            policy: "MANAGED",
          },
        ],
      })
    );

    try {
      const res = spawnSync(
        "python",
        [
          scriptPath,
          "--manifest",
          manifestPath,
          "--pipeline-dir",
          path.join(dir, "fake-pipeline"),
          "--skip-backup",
        ],
        { cwd: dir, encoding: "utf-8" }
      );
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("[OK] Server successfully synchronized");

      // Verify file copied to server
      const deployedTestFile = path.join(dir, "config", "test.txt");
      expect(fs.existsSync(deployedTestFile)).toBe(true);
      expect(fs.readFileSync(deployedTestFile, "utf-8")).toBe("hello world");

      // Verify server.properties was updated
      const props = fs.readFileSync(path.join(dir, "server.properties"), "utf-8");
      expect(props).toContain("motd=Initial MOTD");
      expect(props).toContain("server-port=25565");
      expect(props).toContain("resource-pack=https://portal.lampas.town/api/v1/blobs/" + srpSha256);
      expect(props).toContain("resource-pack-sha1=" + srpSha1);
      expect(props).toContain("resource-pack-id=" + srpUuid);
      expect(props).toContain('resource-pack-prompt={"text":"Custom textures"}');
      expect(props).toContain("require-resource-pack=true");

      // Verify installation.json was written with serverResourcePack
      const state = JSON.parse(fs.readFileSync(path.join(dir, ".lampas", "installation.json"), "utf-8"));
      expect(state.version).toBe("2.0.0");
      expect(state.serverResourcePack.managed).toBe(true);
      expect(state.serverResourcePack.artifact).toBe("lampas2");
      expect(state.serverResourcePack.sha1).toBe(srpSha1);
      expect(state.serverResourcePack.sha256).toBe(srpSha256);
      expect(state.serverResourcePack.id).toBe(srpUuid);

      // Test subsequent deploy where prompt is removed
      const manifestNoPromptPath = path.join(dir, "server-manifest-noprompt.json");
      fs.writeFileSync(
        manifestNoPromptPath,
        JSON.stringify({
          schemaVersion: 1,
          pack: "Lampas 2",
          version: "2.1.0",
          target: "server",
          minecraft: "26.2",
          loader: { type: "fabric", version: "0.19.3" },
          resourcePack: {
            artifact: "lampas2",
            url: "https://portal.lampas.town/api/v1/blobs/" + srpSha256,
            sha1: srpSha1,
            sha256: srpSha256,
            id: srpUuid,
            required: true,
            // Prompt omitted / removed in v2.1.0
          },
          files: [
            {
              path: "config/test.txt",
              hashes: { sha256: testSha256 },
              size: 11,
              download: { url: "http://example.com/test.txt" },
              policy: "MANAGED",
            },
          ],
        })
      );

      const res2 = spawnSync(
        "python",
        [
          scriptPath,
          "--manifest",
          manifestNoPromptPath,
          "--pipeline-dir",
          path.join(dir, "fake-pipeline"),
          "--skip-backup",
        ],
        { cwd: dir, encoding: "utf-8" }
      );
      expect(res2.status).toBe(0);

      const props2 = fs.readFileSync(path.join(dir, "server.properties"), "utf-8");
      expect(props2).toContain("resource-pack-prompt=");
      expect(props2).not.toContain('resource-pack-prompt={"text":"Custom textures"}');

      // Test third deploy where server resource pack is completely removed
      const manifestNoPackPath = path.join(dir, "server-manifest-nopack.json");
      fs.writeFileSync(
        manifestNoPackPath,
        JSON.stringify({
          schemaVersion: 1,
          pack: "Lampas 2",
          version: "2.2.0",
          target: "server",
          minecraft: "26.2",
          loader: { type: "fabric", version: "0.19.3" },
          files: [
            {
              path: "config/test.txt",
              hashes: { sha256: testSha256 },
              size: 11,
              download: { url: "http://example.com/test.txt" },
              policy: "MANAGED",
            },
          ],
        })
      );

      const res3 = spawnSync(
        "python",
        [
          scriptPath,
          "--manifest",
          manifestNoPackPath,
          "--pipeline-dir",
          path.join(dir, "fake-pipeline"),
          "--skip-backup",
        ],
        { cwd: dir, encoding: "utf-8" }
      );
      expect(res3.status).toBe(0);

      const props3 = fs.readFileSync(path.join(dir, "server.properties"), "utf-8");
      expect(props3).toContain("resource-pack=");
      expect(props3).toContain("resource-pack-sha1=");
      expect(props3).toContain("resource-pack-id=");
      expect(props3).toContain("resource-pack-prompt=");
      expect(props3).toContain("require-resource-pack=false");

      const state3 = JSON.parse(fs.readFileSync(path.join(dir, ".lampas", "installation.json"), "utf-8"));
      expect(state3.version).toBe("2.2.0");
      expect(state3.serverResourcePack).toEqual({ managed: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
