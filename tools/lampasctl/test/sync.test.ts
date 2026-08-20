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
});
