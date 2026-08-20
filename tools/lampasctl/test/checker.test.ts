import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkPackUpdates } from "../src/checker";

const originalFetch = globalThis.fetch;
const originalLog = console.log;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
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
});
