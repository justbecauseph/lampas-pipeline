import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { syncInstance } from "../src/sync";

describe("sync verification modes", () => {
  test("fast trusts matching metadata while full verification repairs content", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-sync-"));
    const target = path.join(dir, "instance");
    const managedPath = path.join(target, "config", "fixture.txt");
    const stateDir = path.join(target, ".lampas");
    fs.mkdirSync(path.dirname(managedPath), { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    const desired = "good";
    const corrupted = "evil";
    const sha256 = createHash("sha256").update(desired).digest("hex");
    fs.writeFileSync(managedPath, corrupted);
    const stat = fs.statSync(managedPath);

    const manifestPath = path.join(dir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      pack: "Test",
      version: "1.0.0",
      target: "client",
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.19.3" },
      protocol: 1,
      files: [{
        path: "config/fixture.txt",
        size: desired.length,
        hashes: { sha256 },
        download: { url: `data:text/plain;base64,${Buffer.from(desired).toString("base64")}`, provider: "direct" },
        policy: "MANAGED",
      }],
    }));
    fs.writeFileSync(path.join(stateDir, "installation.json"), JSON.stringify({
      pack: "Test",
      version: "1.0.0",
      installedAt: new Date().toISOString(),
      files: { "config/fixture.txt": { sha256, size: desired.length, policy: "MANAGED", mtimeMs: stat.mtimeMs } },
    }));

    try {
      await syncInstance({ manifestPath, targetDir: target, verificationMode: "fast" });
      expect(fs.readFileSync(managedPath, "utf-8")).toBe(corrupted);
      await syncInstance({ manifestPath, targetDir: target, verificationMode: "full" });
      expect(fs.readFileSync(managedPath, "utf-8")).toBe(desired);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("server sync updates server.properties with resource pack metadata", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-server-sync-"));
    const target = path.join(dir, "server");
    fs.mkdirSync(target, { recursive: true });

    const initialProps = [
      "# Minecraft server properties",
      "server-port=25565",
      "motd=Lampas SMP",
      "resource-pack=",
      "difficulty=hard",
    ].join("\n");
    fs.writeFileSync(path.join(target, "server.properties"), initialProps, "utf-8");

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
        protocol: 2,
        resourcePack: {
          artifact: "lampas",
          required: true,
          filename: "Lampas-Resources-2.0.0.zip",
          path: "resourcepacks/Lampas-Resources-2.0.0.zip",
          url: "https://cdn.lampas.gg/resources/Lampas-Resources-2.0.0.zip",
          sha1: "abc1234567890123456789012345678901234567",
          sha256: "a".repeat(64),
          prompt: "Lampas requires its resource pack.",
        },
        files: [],
      })
    );

    try {
      await syncInstance({ manifestPath, targetDir: target });
      const propsContent = fs.readFileSync(path.join(target, "server.properties"), "utf-8");
      expect(propsContent).toContain("server-port=25565");
      expect(propsContent).toContain("motd=Lampas SMP");
      expect(propsContent).toContain("difficulty=hard");
      expect(propsContent).toContain("resource-pack=https://cdn.lampas.gg/resources/Lampas-Resources-2.0.0.zip");
      expect(propsContent).toContain("resource-pack-sha1=abc1234567890123456789012345678901234567");
      expect(propsContent).toContain("require-resource-pack=true");
      expect(propsContent).toContain('resource-pack-prompt={"text":"Lampas requires its resource pack."}');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
