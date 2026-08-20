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
});
