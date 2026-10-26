import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "../src/cli";
import { setVerbose } from "../src/log";
import { getExistingModIdentifiers } from "../src/manager";
import { resolvePack } from "../src/resolver";

const cliPath = path.resolve(__dirname, "../src/cli.ts");
const originalFetch = globalThis.fetch;
const originalLog = console.log;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  setVerbose(false);
});

function writePack(dir: string, modCount: number): string {
  const packDir = path.join(dir, "pack");
  const modsDir = path.join(packDir, "mods");
  fs.mkdirSync(modsDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, "pack.toml"), [
    "[pack]", 'name = "Verbosity Test"', 'version = "1.0.0"', 'minecraft = "26.2"',
    "[loader]", 'type = "fabric"', 'version = "0.19.3"', "",
  ].join("\n"));
  for (let i = 0; i < modCount; i++) {
    fs.writeFileSync(path.join(modsDir, `mod-${i}.toml`), [
      `name = "Mod ${i}"`, 'side = "both"', "[provider]", 'type = "modrinth"',
      `project_id = "p${i}"`, `version_id = "v${i}"`, "",
    ].join("\n"));
  }
  return packDir;
}

function mockModrinth() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    const ids = JSON.parse(url.searchParams.get("ids") || "[]") as string[];
    if (url.pathname.endsWith("/versions")) {
      return Response.json(ids.map((id) => ({
        id,
        project_id: `p${id.slice(1)}`,
        name: id,
        version_number: "1.0.0",
        game_versions: ["26.2"],
        loaders: ["fabric"],
        files: [{
          hashes: { sha1: "1".repeat(40), sha256: "2".repeat(64), sha512: "3".repeat(128) },
          url: `https://cdn.example/${id}.jar`,
          filename: `${id}.jar`,
          primary: true,
          size: 1024,
        }],
      })));
    }
    if (url.pathname.endsWith("/projects")) {
      return Response.json(ids.map((id) => ({ id, slug: id, title: id, description: "", categories: [] })));
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function resolveAndCapture(verbose: boolean): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-verbosity-"));
  const packDir = writePack(dir, 3);
  mockModrinth();
  setVerbose(verbose);
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    await resolvePack({ packDir, lockFile: path.join(packDir, "pack.lock.json") });
  } finally {
    console.log = originalLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return lines;
}

describe("--verbose", () => {
  test("parseArgs reads --verbose as a boolean that does not consume the next argument", () => {
    const { positional, flags } = parseArgs(["add", "--verbose", "appleskin", "--side", "client"]);
    expect(flags.verbose).toBe("true");
    expect(flags.side).toBe("client");
    expect(positional).toEqual(["appleskin"]);
  });

  test("parseArgs accepts --verbose before the command", () => {
    const { command, positional, flags } = parseArgs(["--verbose", "resolve", "--pack", "./pack"]);
    expect(command).toBe("resolve");
    expect(flags.verbose).toBe("true");
    expect(flags.pack).toBe("./pack");
    expect(positional).toEqual([]);
  });

  test("parseArgs passes --verbose after -- through to extra args", () => {
    const { flags, extra } = parseArgs(["start", "--", "--verbose"]);
    expect(flags.verbose).toBeUndefined();
    expect(extra).toEqual(["--verbose"]);
  });

  test("resolver hides per-artifact lines by default and keeps the summary", async () => {
    const lines = await resolveAndCapture(false);
    expect(lines.some((l) => l.includes("[Resolved]"))).toBe(false);
    expect(lines.some((l) => l.includes("Resolving 3 artifact definitions"))).toBe(true);
    expect(lines.some((l) => l.includes("Successfully resolved 3 artifacts"))).toBe(true);
  });

  test("resolver prints one line per artifact with --verbose", async () => {
    const lines = await resolveAndCapture(true);
    expect(lines.filter((l) => l.includes("[Resolved]"))).toHaveLength(3);
  });

  test("commands with strict flag checks accept the global --verbose", () => {
    const res = spawnSync("bun", ["run", cliPath, "self-update", "--verbose", "--bogus"], { encoding: "utf-8" });
    expect(res.status).toBe(1);
    const output = res.stdout + res.stderr;
    expect(output).toContain("--bogus");
    expect(output).not.toContain("--verbose");
  });
});

describe("dependency names", () => {
  test("maps slugs and provider project IDs to the descriptor name", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-depnames-"));
    try {
      fs.writeFileSync(path.join(dir, "fabric-api.toml"), [
        'name = "Fabric API"', 'side = "both"', "[provider]", 'type = "modrinth"',
        'project_id = "P7dR8mSH"', 'version_id = "abc"', "",
      ].join("\n"));
      fs.writeFileSync(path.join(dir, "jei.toml"), [
        'name = "Just Enough Items"', 'side = "both"', "[provider]", 'type = "curseforge"',
        "project_id = 238222", "file_id = 1", "",
      ].join("\n"));

      const ids = getExistingModIdentifiers(dir);
      expect(ids.get("p7dr8msh")).toBe("Fabric API");
      expect(ids.get("fabric-api")).toBe("Fabric API");
      expect(ids.get("238222")).toBe("Just Enough Items");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
