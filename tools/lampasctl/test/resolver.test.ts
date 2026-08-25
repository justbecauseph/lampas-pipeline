import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolvePack } from "../src/resolver";

describe("bulk Modrinth resolution", () => {
  test("resolves 125 pinned versions in two requests", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-resolver-"));
    const packDir = path.join(dir, "pack");
    const modsDir = path.join(packDir, "mods");
    fs.mkdirSync(modsDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, "pack.toml"), [
      "[pack]", 'name = "Batch Test"', 'version = "1.0.0"', 'minecraft = "26.2"',
      "[loader]", 'type = "fabric"', 'version = "0.19.3"', "",
    ].join("\n"));
    for (let i = 0; i < 125; i++) {
      fs.writeFileSync(path.join(modsDir, `mod-${i}.toml`), [
        `name = "Mod ${i}"`, 'side = "both"', "[provider]", 'type = "modrinth"',
        `project_id = "p${i}"`, `version_id = "v${i}"`, "",
      ].join("\n"));
    }

    const originalFetch = globalThis.fetch;
    const versionBatchSizes: number[] = [];
    let projectBatchCount = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      const ids = JSON.parse(url.searchParams.get("ids") || "[]") as string[];
      if (url.pathname.endsWith("/versions")) {
        versionBatchSizes.push(ids.length);
        return Response.json(ids.map((id) => {
          const index = Number(id.slice(1));
          return {
            id,
            project_id: `p${index}`,
            name: `Version ${index}`,
            version_number: "1.0.0",
            game_versions: ["26.2"],
            loaders: ["fabric"],
            files: [{
              hashes: { sha1: "1".repeat(40), sha256: "2".repeat(64), sha512: "3".repeat(128) },
              url: `https://cdn.example/mod-${index}.jar`,
              filename: `mod-${index}.jar`,
              primary: true,
              size: 1024,
            }],
          };
        }));
      }
      if (url.pathname.endsWith("/projects")) {
        projectBatchCount++;
        return Response.json(ids.map((id) => ({
          id,
          slug: id,
          title: id,
          description: "fixture",
          categories: [],
        })));
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const lock = await resolvePack({ packDir, lockFile: path.join(packDir, "pack.lock.json") });
      expect(Object.keys(lock.artifacts)).toHaveLength(125);
      expect(versionBatchSizes).toEqual([80, 45]);
      expect(projectBatchCount).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("downloads and calculates sha256 when Modrinth API only supplies sha512", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-resolver-stream-"));
    const packDir = path.join(dir, "pack");
    const modsDir = path.join(packDir, "mods");
    fs.mkdirSync(modsDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, "pack.toml"), [
      "[pack]", 'name = "Stream Test"', 'version = "1.0.0"', 'minecraft = "26.2"',
      "[loader]", 'type = "fabric"', 'version = "0.19.3"', "",
    ].join("\n"));
    fs.writeFileSync(path.join(modsDir, "better-end.toml"), [
      'name = "BetterEnd"', 'side = "both"', "[provider]", 'type = "modrinth"',
      'project_id = "gc8OEnCC"', 'version_id = "tBdZGZeX"', "",
    ].join("\n"));

    const sampleData = Buffer.from("simulated jar content for better-end mod");
    const crypto = await import("node:crypto");
    const sampleSha1 = crypto.createHash("sha1").update(sampleData).digest("hex");
    const sampleSha256 = crypto.createHash("sha256").update(sampleData).digest("hex");
    const sampleSha512 = crypto.createHash("sha512").update(sampleData).digest("hex");

    let downloadCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
      if (url.includes("/versions?ids=")) {
        return Response.json([{
          id: "tBdZGZeX",
          project_id: "gc8OEnCC",
          name: "better-end-26.101.2",
          version_number: "26.101.2",
          game_versions: ["26.2"],
          loaders: ["fabric"],
          files: [{
            hashes: { sha1: sampleSha1, sha512: sampleSha512 }, // Note: sha256 omitted as Modrinth does
            url: "https://cdn.example/better-end-26.101.2.jar",
            filename: "better-end-26.101.2.jar",
            primary: true,
            size: sampleData.length,
          }],
        }]);
      }
      if (url.includes("/projects?ids=")) {
        return Response.json([{
          id: "gc8OEnCC",
          slug: "betterend",
          title: "BetterEnd",
          description: "End overhaul",
          categories: ["worldgen"],
        }]);
      }
      if (url === "https://cdn.example/better-end-26.101.2.jar") {
        downloadCount++;
        return new Response(sampleData, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const lockFile = path.join(packDir, "pack.lock.json");
      const lock = await resolvePack({ packDir, lockFile });
      expect(lock.artifacts["better-end"]).toBeDefined();
      expect(lock.artifacts["better-end"].sha256).toBe(sampleSha256);
      expect(lock.artifacts["better-end"].sha512).toBe(sampleSha512);
      expect(downloadCount).toBe(1);

      // Verify cached on disk
      const cachePath = path.resolve(dir, ".lampas", "cache", "modrinth", "gc8OEnCC", "tBdZGZeX", "better-end-26.101.2.jar");
      expect(fs.existsSync(cachePath)).toBe(true);

      // Resolving again should reuse existingLock / disk cache without re-downloading
      const secondLock = await resolvePack({ packDir, lockFile });
      expect(secondLock.artifacts["better-end"].sha256).toBe(sampleSha256);
      expect(downloadCount).toBe(1); // No new network downloads
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
