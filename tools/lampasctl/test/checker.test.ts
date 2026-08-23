import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkPackUpdates } from "../src/checker";

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalApiKey = process.env.CURSEFORGE_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  if (originalApiKey === undefined) delete process.env.CURSEFORGE_API_KEY;
  else process.env.CURSEFORGE_API_KEY = originalApiKey;
});

describe("update checker output", () => {
  test("shows the mod ID and version transition in console and Markdown output", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-checker-"));
    const packDir = path.join(dir, "pack");
    const modsDir = path.join(packDir, "mods");
    const markdownOut = path.join(dir, "updates.md");
    fs.mkdirSync(modsDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, "pack.toml"), [
      "[pack]", 'name = "Test Pack"', 'version = "1.0.0"', 'minecraft = "26.2"',
      "[loader]", 'type = "fabric"', 'version = "0.19.3"', "",
    ].join("\n"));
    fs.writeFileSync(path.join(modsDir, "example-mod.toml"), [
      'name = "Example Mod"', 'side = "both"', "[provider]", 'type = "modrinth"',
      'project_id = "example-project"', 'version_id = "old-version-id"', "",
    ].join("\n"));

    globalThis.fetch = (async (_input: string | URL | Request) => Response.json([
      {
        id: "new-version-id",
        name: "Example Mod 2.0.0",
        version_number: "2.0.0",
        date_published: "2026-08-20T00:00:00Z",
        files: [{ filename: "example-mod-2.0.0.jar", primary: true }],
      },
      {
        id: "old-version-id",
        name: "Example Mod 1.0.0",
        version_number: "1.0.0",
        files: [{ filename: "example-mod-1.0.0.jar", primary: true }],
      },
    ])) as typeof fetch;

    const logs: string[] = [];
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const updates = await checkPackUpdates({ packDir, markdownOut, concurrency: 1 });
      const markdown = fs.readFileSync(markdownOut, "utf-8");

      expect(updates).toHaveLength(1);
      expect(logs).toContain("     Mod ID: example-mod");
      expect(logs).toContain("     Project ID: example-project");
      expect(logs).toContain("     Version: 1.0.0 -> 2.0.0");
      expect(logs).toContain("     Updated version: https://modrinth.com/mod/example-project/version/new-version-id");
      expect(markdown).toContain("| **Example Mod** | `example-mod` | `example-project` | **1.0.0** → [**2.0.0**](https://modrinth.com/mod/example-project/version/new-version-id) |");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("checks and applies compatible CurseForge file updates", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-checker-cf-"));
    const packDir = path.join(dir, "pack");
    const modsDir = path.join(packDir, "mods");
    const markdownOut = path.join(dir, "updates.md");
    fs.mkdirSync(modsDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, "pack.toml"), [
      "[pack]", 'name = "Test Pack"', 'version = "1.0.0"', 'minecraft = "26.2"',
      "[loader]", 'type = "fabric"', 'version = "0.19.3"', "",
    ].join("\n"));
    fs.writeFileSync(path.join(modsDir, "example-cf.toml"), [
      'name = "Example CF Mod"', 'side = "both"', "[provider]", 'type = "curseforge"',
      "project_id = 100", "file_id = 200", "",
    ].join("\n"));
    process.env.CURSEFORGE_API_KEY = "test-api-key";

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      if (url.pathname === "/v1/mods/100/files") {
        return Response.json({ data: [
          {
            id: 201, modId: 100, isAvailable: true, displayName: "2.0.0", fileName: "example-2.jar",
            fileDate: "2026-08-22T00:00:00Z", fileLength: 2, hashes: [], gameVersions: ["26.2", "Fabric"],
          },
          {
            id: 200, modId: 100, isAvailable: true, displayName: "1.0.0", fileName: "example-1.jar",
            fileDate: "2026-08-20T00:00:00Z", fileLength: 1, hashes: [], gameVersions: ["26.2", "Fabric"],
          },
        ] });
      }
      if (url.pathname === "/v1/mods/100") {
        return Response.json({ data: {
          id: 100, gameId: 432, name: "Example CF Mod", slug: "example-cf", isAvailable: true,
        } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const updates = await checkPackUpdates({ packDir, markdownOut, concurrency: 1, apply: true });
      const descriptor = fs.readFileSync(path.join(modsDir, "example-cf.toml"), "utf-8");
      const markdown = fs.readFileSync(markdownOut, "utf-8");

      expect(updates).toHaveLength(1);
      expect(descriptor).toContain("file_id = 201");
      expect(markdown).toContain("https://www.curseforge.com/minecraft/mc-mods/example-cf/files/201");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
