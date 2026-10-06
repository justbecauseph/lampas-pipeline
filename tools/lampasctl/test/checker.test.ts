import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkPackUpdates } from "../src/checker";

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalWarn = console.warn;
const originalApiKey = process.env.CURSEFORGE_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.warn = originalWarn;
  if (originalApiKey === undefined) delete process.env.CURSEFORGE_API_KEY;
  else process.env.CURSEFORGE_API_KEY = originalApiKey;
});

interface Fixture {
  dir: string;
  packDir: string;
  modsDir: string;
  descriptor: string;
  markdownOut: string;
  packConfig: string;
}

function createFixture(options: { provider?: "modrinth" | "curseforge"; blacklist?: string } = {}): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-checker-"));
  const packDir = path.join(dir, "pack");
  const modsDir = path.join(packDir, "mods");
  const descriptor = path.join(modsDir, "example-mod.toml");
  const markdownOut = path.join(dir, "updates.md");
  const provider = options.provider || "modrinth";
  const emptyRootBlacklist = options.blacklist?.trim() === "blacklist = []";
  fs.mkdirSync(modsDir, { recursive: true });
  const packConfig = [
    ...(emptyRootBlacklist ? ["blacklist = []"] : []),
    "[pack]", 'name = "Test Pack"', 'version = "1.0.0"', 'minecraft = "26.2"',
    "[loader]", 'type = "fabric"', 'version = "0.19.3"', emptyRootBlacklist ? "" : options.blacklist || "", "",
  ].join("\n");
  fs.writeFileSync(path.join(packDir, "pack.toml"), packConfig);
  fs.writeFileSync(descriptor, provider === "modrinth" ? [
    'name = "Example Mod"', 'side = "both"', "[provider]", 'type = "modrinth"',
    'project_id = "example-project"', 'version_id = "old-version-id"', "",
  ].join("\n") : [
    'name = "Example CF Mod"', 'side = "both"', "[provider]", 'type = "curseforge"',
    "project_id = 100", "file_id = 200", "",
  ].join("\n"));
  return { dir, packDir, modsDir, descriptor, markdownOut, packConfig };
}

function modrinthRelease(id: string, version: string, publishedAt?: string) {
  const publicationDate = publishedAt || (id === "old-version-id" ? "2026-08-20T00:00:00Z" : undefined);
  return {
    id,
    name: `Example Mod ${version}`,
    version_number: version,
    ...(publicationDate ? { date_published: publicationDate } : {}),
    files: [{ filename: `example-mod-${version}.jar`, primary: true }],
  };
}

function useModrinth(
  versions: unknown[],
  current?: unknown,
  projectId = "example-project",
  currentVersionId = "old-version-id"
): { requests: string[] } {
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    requests.push(url.toString());
    if (url.pathname === `/v2/project/${projectId}/version`) return Response.json(versions);
    if (url.pathname === `/v2/version/${currentVersionId}` && current) return Response.json(current);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { requests };
}

function useCurseForge(options: { files: Array<Record<string, unknown>>; current?: Record<string, unknown> }) {
  const requests: string[] = [];
  process.env.CURSEFORGE_API_KEY = "test-api-key";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    requests.push(url.toString());
    if (url.pathname === "/v1/mods/100/files") return Response.json({ data: options.files });
    if (url.pathname === "/v1/mods/100/files/200" && options.current) return Response.json({ data: options.current });
    if (url.pathname === "/v1/mods/100") {
      return Response.json({ data: { id: 100, gameId: 432, name: "Example CF Mod", slug: "example-cf", isAvailable: true } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { requests };
}

function curseForgeFile(id: number, version: string, fileDate: string) {
  return {
    id, modId: 100, isAvailable: true, displayName: version, fileName: `example-${version}.jar`,
    fileDate, fileLength: 1, hashes: [], gameVersions: ["26.2", "Fabric"],
  };
}

function versionRule(id: string, provider: "modrinth" | "curseforge" = "modrinth"): string {
  return [
    "[[blacklist]]", 'scope = "version_id"', `provider = "${provider}"`,
    `id = ${provider === "modrinth" ? JSON.stringify(id) : id}`, 'reason = "known incompatible release"', "",
  ].join("\n");
}

describe("update checker output and blacklist handling", () => {
  test("chooses the newest allowed Modrinth release after a blocked latest release", async () => {
    const fixture = createFixture({ blacklist: versionRule("blocked-latest") });
    useModrinth([
      modrinthRelease("blocked-latest", "3.0.0", "2026-08-22T00:00:00Z"),
      modrinthRelease("allowed-middle", "2.0.0", "2026-08-21T00:00:00Z"),
      modrinthRelease("old-version-id", "1.0.0"),
    ]);
    const logs: string[] = [];
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.warn = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      const updates = await checkPackUpdates({ packDir: fixture.packDir, markdownOut: fixture.markdownOut, concurrency: 1 });
      const markdown = fs.readFileSync(fixture.markdownOut, "utf-8");
      expect(updates.map((update) => update.latestVersionId)).toEqual(["allowed-middle"]);
      expect(logs.some((line) => line.includes("[Blocked by Blacklist]") && line.includes("blocked-latest"))).toBe(true);
      expect(markdown).toContain("known incompatible release");
      expect(markdown).toContain("blocked-latest");
      expect(markdown).toContain("allowed-middle");
      expect(markdown).not.toContain("→ [**3.0.0**]");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("does not downgrade or write when every newer Modrinth release is blocked", async () => {
    const fixture = createFixture({ blacklist: `${versionRule("blocked-newest")}${versionRule("blocked-next")}` });
    useModrinth([
      modrinthRelease("blocked-newest", "3.0.0", "2026-08-22T00:00:00Z"),
      modrinthRelease("blocked-next", "2.0.0", "2026-08-21T00:00:00Z"),
      modrinthRelease("old-version-id", "1.0.0"),
    ]);
    const before = fs.readFileSync(fixture.descriptor, "utf-8");
    try {
      const updates = await checkPackUpdates({ packDir: fixture.packDir, markdownOut: fixture.markdownOut, apply: true, concurrency: 1 });
      const markdown = fs.readFileSync(fixture.markdownOut, "utf-8");
      expect(updates).toHaveLength(0);
      expect(fs.readFileSync(fixture.descriptor, "utf-8")).toBe(before);
      expect(markdown).toContain("Blocked Releases (2)");
      expect(markdown).toContain("blocked-newest");
      expect(markdown).toContain("blocked-next");
      expect(markdown).not.toContain("old-version-id →");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("reports a blacklisted current pin and does not fall back to an older release", async () => {
    const fixture = createFixture({ blacklist: versionRule("old-version-id") });
    useModrinth([
      modrinthRelease("old-version-id", "1.0.0"),
      modrinthRelease("older-version-id", "0.9.0"),
    ]);
    const logs: string[] = [];
    console.warn = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      const updates = await checkPackUpdates({ packDir: fixture.packDir, markdownOut: fixture.markdownOut, concurrency: 1 });
      const markdown = fs.readFileSync(fixture.markdownOut, "utf-8");
      expect(updates).toHaveLength(0);
      expect(logs.some((line) => line.includes("current_pin") || line.includes("old-version-id"))).toBe(true);
      expect(markdown).toContain("old-version-id");
      expect(markdown).toContain("current pin");
      expect(markdown).not.toContain("0.9.0");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("reports a blacklisted current pin even when upstream metadata is unavailable", async () => {
    const fixture = createFixture({ blacklist: versionRule("old-version-id") });
    const before = fs.readFileSync(fixture.descriptor, "utf-8");
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      return new Response("upstream unavailable", { status: 503 });
    }) as typeof fetch;
    const logs: string[] = [];
    console.warn = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      const updates = await checkPackUpdates({ packDir: fixture.packDir, markdownOut: fixture.markdownOut, apply: true, concurrency: 1 });
      expect(updates).toHaveLength(0);
      expect(requests).toHaveLength(1);
      expect(logs.some((line) => line.includes("old-version-id"))).toBe(true);
      const markdown = fs.readFileSync(fixture.markdownOut, "utf-8");
      expect(markdown).toContain("old-version-id");
      expect(markdown).toContain("Skipped Checks (1)");
      expect(markdown).toContain("HTTP 503");
      expect(fs.readFileSync(fixture.descriptor, "utf-8")).toBe(before);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("blocks the exact SnappyTappy 26.3 version ID while retaining the Lampas 26.2 pin", async () => {
    const fixture = createFixture({ blacklist: versionRule("ER3HfIOr") });
    const descriptor = fs.readFileSync(fixture.descriptor, "utf-8")
      .replace('project_id = "example-project"', 'project_id = "dWOPoahl"')
      .replace('version_id = "old-version-id"', 'version_id = "ISW3ltTi"');
    fs.writeFileSync(fixture.descriptor, descriptor);
    useModrinth([
      modrinthRelease("ER3HfIOr", "26.3", "2026-08-22T00:00:00Z"),
      modrinthRelease("ISW3ltTi", "26.2", "2026-08-20T00:00:00Z"),
    ], undefined, "dWOPoahl", "ISW3ltTi");
    try {
      const updates = await checkPackUpdates({ packDir: fixture.packDir, markdownOut: fixture.markdownOut, apply: true, concurrency: 1 });
      expect(updates).toHaveLength(0);
      expect(fs.readFileSync(fixture.descriptor, "utf-8")).toContain('version_id = "ISW3ltTi"');
      expect(fs.readFileSync(fixture.markdownOut, "utf-8")).toContain("ER3HfIOr");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("mod_id and project_id rules skip the descriptor before any upstream request", async () => {
    for (const { rule, expected } of [
      {
        rule: ["[[blacklist]]", 'scope = "mod_id"', 'id = "example-mod"', 'reason = "skip descriptor"', ""].join("\n"),
        expected: "mod_id 'example-mod'",
      },
      {
        rule: ["[[blacklist]]", 'scope = "project_id"', 'provider = "modrinth"', 'id = "example-project"', 'reason = "skip project"', ""].join("\n"),
        expected: "project_id 'example-project'",
      },
    ]) {
      const fixture = createFixture({ blacklist: rule });
      const mock = useModrinth([modrinthRelease("new-version-id", "2.0.0", "2026-08-22T00:00:00Z")]);
      try {
        const updates = await checkPackUpdates({ packDir: fixture.packDir, markdownOut: fixture.markdownOut, concurrency: 1 });
        expect(updates).toHaveLength(0);
        expect(mock.requests).toHaveLength(0);
        const markdown = fs.readFileSync(fixture.markdownOut, "utf-8");
        expect(markdown).toContain("Entire descriptor skipped");
        expect(markdown).toContain(expected);
      } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
      }
    }
  });

  test("--force bypasses a descriptor-level rule and reports the selected update", async () => {
    const fixture = createFixture({ blacklist: [
      "[[blacklist]]", 'scope = "mod_id"', 'id = "example-mod"', 'reason = "temporarily excluded"', "",
    ].join("\n") });
    useModrinth([
      modrinthRelease("new-version-id", "2.0.0", "2026-08-22T00:00:00Z"),
      modrinthRelease("old-version-id", "1.0.0"),
    ]);
    try {
      const updates = await checkPackUpdates({ packDir: fixture.packDir, markdownOut: fixture.markdownOut, force: true, apply: true, concurrency: 1 });
      expect(updates.map((update) => update.latestVersionId)).toEqual(["new-version-id"]);
      expect(fs.readFileSync(fixture.descriptor, "utf-8")).toContain('version_id = "new-version-id"');
      expect(fs.readFileSync(path.join(fixture.packDir, "pack.toml"), "utf-8")).toBe(fixture.packConfig);
      const markdown = fs.readFileSync(fixture.markdownOut, "utf-8");
      expect(markdown).toContain("Blacklist Overrides (1)");
      expect(markdown).toContain("mod_id 'example-mod'");
      expect(markdown).toContain("temporarily excluded");
      expect(markdown).toContain("new-version-id");
      expect(markdown).toContain("selected update");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("matches exact case-sensitive IDs, with absent and empty policies preserving ordinary behavior", async () => {
    const fixture = createFixture({ blacklist: `${versionRule("NEW-VERSION-ID")}` });
    useModrinth([
      modrinthRelease("new-version-id", "2.0.0", "2026-08-22T00:00:00Z"),
      modrinthRelease("old-version-id", "1.0.0"),
    ]);
    try {
      const updates = await checkPackUpdates({ packDir: fixture.packDir, concurrency: 1 });
      expect(updates).toHaveLength(1);
      expect(updates[0].latestVersionId).toBe("new-version-id");
      const empty = createFixture({ blacklist: "blacklist = []" });
      try {
        useModrinth([
          modrinthRelease("new-version-id", "2.0.0", "2026-08-22T00:00:00Z"),
          modrinthRelease("old-version-id", "1.0.0"),
        ]);
        const emptyUpdates = await checkPackUpdates({ packDir: empty.packDir, concurrency: 1 });
        expect(emptyUpdates).toHaveLength(1);
      } finally {
        fs.rmSync(empty.dir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("compares dates when the pinned Modrinth release is absent from the compatible list", async () => {
    const fixture = createFixture();
    useModrinth([
      modrinthRelease("newer", "2.0.0", "2026-08-22T00:00:00Z"),
      modrinthRelease("older", "0.9.0", "2026-08-18T00:00:00Z"),
    ], { id: "old-version-id", version_number: "1.0.0", date_published: "2026-08-20T00:00:00Z" });
    try {
      const updates = await checkPackUpdates({ packDir: fixture.packDir, concurrency: 1 });
      expect(updates.map((update) => update.latestVersionId)).toEqual(["newer"]);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("skips conservatively when the absent Modrinth pin has unknown publication metadata", async () => {
    const fixture = createFixture();
    const mock = useModrinth([modrinthRelease("newer", "2.0.0", "2026-08-22T00:00:00Z")]);
    try {
      const updates = await checkPackUpdates({ packDir: fixture.packDir, markdownOut: fixture.markdownOut, concurrency: 1 });
      expect(updates).toHaveLength(0);
      expect(mock.requests.some((url) => url.includes("/v2/version/old-version-id"))).toBe(true);
      expect(fs.readFileSync(fixture.markdownOut, "utf-8")).toContain("no valid publication date");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("never applies a dated older release when any Modrinth candidate lacks a date", async () => {
    for (const force of [false, true]) {
      const fixture = createFixture();
      useModrinth([
        modrinthRelease("dated-older", "0.9.0", "2026-08-18T00:00:00Z"),
        modrinthRelease("old-version-id", "1.0.0", "2026-08-20T00:00:00Z"),
        modrinthRelease("missing-date", "2.0.0"),
      ]);
      const before = fs.readFileSync(fixture.descriptor, "utf-8");
      try {
        const updates = await checkPackUpdates({ packDir: fixture.packDir, apply: true, force, markdownOut: fixture.markdownOut, concurrency: 1 });
        expect(updates).toHaveLength(0);
        expect(fs.readFileSync(fixture.descriptor, "utf-8")).toBe(before);
        expect(fs.readFileSync(fixture.markdownOut, "utf-8")).toContain("newness could not be established");
      } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
      }
    }
  });

  test("applies a Modrinth update without changing pack blacklist policy", async () => {
    const fixture = createFixture({ blacklist: versionRule("not-this-update") });
    useModrinth([
      modrinthRelease("new-version-id", "2.0.0", "2026-08-22T00:00:00Z"),
      modrinthRelease("old-version-id", "1.0.0"),
    ]);
    try {
      await checkPackUpdates({ packDir: fixture.packDir, apply: true, concurrency: 1 });
      expect(fs.readFileSync(fixture.descriptor, "utf-8")).toContain('version_id = "new-version-id"');
      expect(fs.readFileSync(path.join(fixture.packDir, "pack.toml"), "utf-8")).toBe(fixture.packConfig);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("applies CurseForge updates while preserving the typed blacklist policy", async () => {
    const fixture = createFixture({ provider: "curseforge", blacklist: versionRule("999", "curseforge") });
    useCurseForge({ files: [curseForgeFile(201, "2.0.0", "2026-08-22T00:00:00Z"), curseForgeFile(200, "1.0.0", "2026-08-20T00:00:00Z")] });
    try {
      const updates = await checkPackUpdates({ packDir: fixture.packDir, markdownOut: fixture.markdownOut, apply: true, concurrency: 1 });
      const descriptor = fs.readFileSync(fixture.descriptor, "utf-8");
      const markdown = fs.readFileSync(fixture.markdownOut, "utf-8");
      expect(updates.map((update) => update.latestVersionId)).toEqual(["201"]);
      expect(descriptor).toContain("file_id = 201");
      expect(markdown).toContain("https://www.curseforge.com/minecraft/mc-mods/example-cf/files/201");
      expect(fs.readFileSync(path.join(fixture.packDir, "pack.toml"), "utf-8")).toBe(fixture.packConfig);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("rejects malformed CurseForge candidate IDs before blacklist matching or applying", async () => {
    const fixture = createFixture({ provider: "curseforge", blacklist: versionRule("201", "curseforge") });
    useCurseForge({ files: [curseForgeFile(200, "1.0.0", "2026-08-20T00:00:00Z"), { ...curseForgeFile(201, "2.0.0", "2026-08-22T00:00:00Z"), id: "201" }] });
    const before = fs.readFileSync(fixture.descriptor, "utf-8");
    try {
      const updates = await checkPackUpdates({ packDir: fixture.packDir, apply: true, concurrency: 1 });
      expect(updates).toHaveLength(0);
      expect(fs.readFileSync(fixture.descriptor, "utf-8")).toBe(before);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("--force selects and applies a blacklisted Modrinth release with an override report", async () => {
    const fixture = createFixture({ blacklist: versionRule("new-version-id") });
    useModrinth([
      modrinthRelease("new-version-id", "2.0.0", "2026-08-22T00:00:00Z"),
      modrinthRelease("old-version-id", "1.0.0"),
    ]);
    const logs: string[] = [];
    console.warn = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      const updates = await checkPackUpdates({ packDir: fixture.packDir, markdownOut: fixture.markdownOut, apply: true, force: true, concurrency: 1 });
      const markdown = fs.readFileSync(fixture.markdownOut, "utf-8");
      expect(updates.map((update) => update.latestVersionId)).toEqual(["new-version-id"]);
      expect(fs.readFileSync(fixture.descriptor, "utf-8")).toContain('version_id = "new-version-id"');
      expect(logs.some((line) => line.includes("[Blacklist Override]") && line.includes("new-version-id"))).toBe(true);
      expect(markdown).toContain("Blacklist Overrides (1)");
      expect(markdown).toContain("selected update");
      expect(markdown).toContain("Blocked Releases (0)");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("--force selects and applies a blacklisted CurseForge file with an override report", async () => {
    const fixture = createFixture({ provider: "curseforge", blacklist: versionRule("201", "curseforge") });
    useCurseForge({ files: [curseForgeFile(201, "2.0.0", "2026-08-22T00:00:00Z"), curseForgeFile(200, "1.0.0", "2026-08-20T00:00:00Z")] });
    try {
      const updates = await checkPackUpdates({ packDir: fixture.packDir, markdownOut: fixture.markdownOut, apply: true, force: true, concurrency: 1 });
      expect(updates.map((update) => update.latestVersionId)).toEqual(["201"]);
      expect(fs.readFileSync(fixture.descriptor, "utf-8")).toContain("file_id = 201");
      expect(fs.readFileSync(fixture.markdownOut, "utf-8")).toContain("selected update");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("--force does not choose an older release and does not bypass malformed blacklist preflight", async () => {
    const fixture = createFixture({ blacklist: versionRule("old-version-id") });
    useModrinth([
      modrinthRelease("old-version-id", "1.0.0"),
      modrinthRelease("older-version-id", "0.9.0"),
    ]);
    const updates = await checkPackUpdates({ packDir: fixture.packDir, force: true, concurrency: 1 });
    expect(updates).toHaveLength(0);

    const malformed = createFixture({ blacklist: [
      "[[blacklist]]", 'scope = "version_id"', 'provider = "modrinth"', 'id = "   "', "",
    ].join("\n") });
    const before = fs.readFileSync(malformed.descriptor, "utf-8");
    const noRequests = useModrinth([modrinthRelease("new-version-id", "2.0.0", "2026-08-22T00:00:00Z")]);
    try {
      await expect(checkPackUpdates({ packDir: malformed.packDir, force: true, apply: true, concurrency: 1 })).rejects.toThrow();
      expect(noRequests.requests).toHaveLength(0);
      expect(fs.readFileSync(malformed.descriptor, "utf-8")).toBe(before);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
      fs.rmSync(malformed.dir, { recursive: true, force: true });
    }
  });

  test("malformed policy preflight prevents all requests and partial descriptor writes", async () => {
    const fixture = createFixture({ blacklist: [
      "[[blacklist]]", 'scope = "version_id"', 'provider = "curseforge"', "id = 0", "",
    ].join("\n") });
    const before = fs.readFileSync(fixture.descriptor, "utf-8");
    const mock = useModrinth([modrinthRelease("new-version-id", "2.0.0", "2026-08-22T00:00:00Z")]);
    try {
      await expect(checkPackUpdates({ packDir: fixture.packDir, apply: true, concurrency: 1 })).rejects.toThrow();
      expect(mock.requests).toHaveLength(0);
      expect(fs.readFileSync(fixture.descriptor, "utf-8")).toBe(before);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("rejects a blacklist placed under a TOML section instead of at the pack root", async () => {
    const fixture = createFixture();
    fs.appendFileSync(path.join(fixture.packDir, "pack.toml"), "blacklist = []\n");
    const mock = useModrinth([modrinthRelease("new-version-id", "2.0.0", "2026-08-22T00:00:00Z")]);
    try {
      await expect(checkPackUpdates({ packDir: fixture.packDir, force: true, concurrency: 1 })).rejects.toThrow("at the root");
      expect(mock.requests).toHaveLength(0);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("rejects malformed provider IDs before network access or applying, including under --force", async () => {
    const cases = [
      {
        provider: "modrinth" as const,
        blacklist: versionRule("new-version-id"),
        replace: ['project_id = "example-project"', 'project_id = " "'],
      },
      {
        provider: "curseforge" as const,
        blacklist: versionRule("201", "curseforge"),
        replace: ["project_id = 100", 'project_id = "100"'],
      },
      {
        provider: "curseforge" as const,
        blacklist: versionRule("201", "curseforge"),
        replace: ["file_id = 200", 'file_id = "200"'],
      },
      {
        provider: "modrinth" as const,
        blacklist: versionRule("123"),
        replace: ['version_id = "old-version-id"', "version_id = 123"],
      },
    ];
    for (const item of cases) {
      const fixture = createFixture({ provider: item.provider, blacklist: item.blacklist });
      fs.writeFileSync(fixture.descriptor, fs.readFileSync(fixture.descriptor, "utf-8").replace(item.replace[0], item.replace[1]));
      const before = fs.readFileSync(fixture.descriptor, "utf-8");
      const mock = useModrinth([modrinthRelease("new-version-id", "2.0.0", "2026-08-22T00:00:00Z")]);
      try {
        await expect(checkPackUpdates({ packDir: fixture.packDir, force: true, apply: true, concurrency: 1 })).rejects.toThrow();
        expect(mock.requests).toHaveLength(0);
        expect(fs.readFileSync(fixture.descriptor, "utf-8")).toBe(before);
      } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
      }
    }
  });

  test("writes a fresh Markdown report when no updates or blacklist matches exist", async () => {
    const fixture = createFixture({ blacklist: "blacklist = []" });
    fs.writeFileSync(fixture.markdownOut, "stale previous report");
    useModrinth([modrinthRelease("old-version-id", "1.0.0")]);
    try {
      const updates = await checkPackUpdates({ packDir: fixture.packDir, markdownOut: fixture.markdownOut, concurrency: 1 });
      const markdown = fs.readFileSync(fixture.markdownOut, "utf-8");
      expect(updates).toHaveLength(0);
      expect(markdown).toContain("Upstream Mod Updates Available (0)");
      expect(markdown).toContain("Blocked Releases (0)");
      expect(markdown).not.toContain("stale previous report");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});
