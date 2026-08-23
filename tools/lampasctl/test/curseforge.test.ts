import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CurseForgeClient, type CurseForgeFile, type CurseForgeMod } from "../src/curseforge";
import { addMod } from "../src/manager";
import { resolvePack } from "../src/resolver";
import { parseTomlFile, readJsonFile } from "../src/utils";
import type { ModDefinition, PackLock, PackManifest } from "../src/types";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.CURSEFORGE_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.CURSEFORGE_API_KEY;
  else process.env.CURSEFORGE_API_KEY = originalApiKey;
});

function createPackFixture(): { dir: string; packDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-curseforge-"));
  const packDir = path.join(dir, "pack");
  fs.mkdirSync(path.join(packDir, "mods"), { recursive: true });
  fs.writeFileSync(path.join(packDir, "pack.toml"), [
    "[pack]", 'name = "CurseForge Test"', 'version = "1.0.0"', 'minecraft = "26.2"',
    "[loader]", 'type = "fabric"', 'version = "0.19.3"', "",
  ].join("\n"));
  return { dir, packDir };
}

function project(id = 100, slug = "example-mod"): CurseForgeMod {
  return {
    id,
    gameId: 432,
    name: slug === "example-mod" ? "Example Mod" : "Required Library",
    slug,
    summary: "Fixture project",
    isAvailable: true,
    allowModDistribution: true,
    logo: { thumbnailUrl: `https://images.example/${slug}.png` },
    categories: [{ id: 1, name: "Technology", slug: "technology" }],
    authors: [{ id: 1, name: "Fixture Author" }],
    links: { websiteUrl: `https://www.curseforge.com/minecraft/mc-mods/${slug}` },
  };
}

function fileFixture(options: {
  id?: number;
  modId?: number;
  fileName?: string;
  content: Buffer;
  downloadUrl?: string | null;
  dependencies?: Array<{ modId: number; relationType: number }>;
}): CurseForgeFile {
  const id = options.id || 200;
  const modId = options.modId || 100;
  const fileName = options.fileName || "example-mod.jar";
  return {
    id,
    gameId: 432,
    modId,
    isAvailable: true,
    displayName: `${fileName} release`,
    fileName,
    releaseType: 1,
    fileStatus: 4,
    hashes: [{ value: createHash("sha1").update(options.content).digest("hex"), algo: 1 }],
    fileDate: "2026-08-22T00:00:00Z",
    fileLength: options.content.length,
    downloadUrl: options.downloadUrl === undefined ? `https://cdn.example/${fileName}` : options.downloadUrl,
    gameVersions: ["26.2", "Fabric"],
    dependencies: options.dependencies || [],
  };
}

describe("CurseForge provider", () => {
  test("requires an API key without leaking a credential into descriptors", async () => {
    delete process.env.CURSEFORGE_API_KEY;
    await expect(CurseForgeClient.findMod("example-mod")).rejects.toThrow("CURSEFORGE_API_KEY");
  });

  test("adds a CurseForge URL, resolves verified hashes, and reuses the cache", async () => {
    const fixture = createPackFixture();
    const content = Buffer.from("verified CurseForge fixture");
    const mod = project();
    const file = fileFixture({ content });
    let downloadCount = 0;
    process.env.CURSEFORGE_API_KEY = "test-api-key";

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      const method = init?.method || "GET";
      if (url.hostname === "cdn.example") {
        downloadCount++;
        return new Response(content);
      }

      expect(new Headers(init?.headers).get("x-api-key")).toBe("test-api-key");
      if (url.pathname === "/v1/mods/search") {
        expect(url.searchParams.get("gameId")).toBe("432");
        expect(url.searchParams.get("classId")).toBe("6");
        expect(url.searchParams.get("slug")).toBe("example-mod");
        return Response.json({ data: [mod] });
      }
      if (url.pathname === "/v1/mods/100/files/200") return Response.json({ data: file });
      if (url.pathname === "/v1/mods/files" && method === "POST") return Response.json({ data: [file] });
      if (url.pathname === "/v1/mods" && method === "POST") return Response.json({ data: [mod] });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      await addMod({
        packDir: fixture.packDir,
        query: "https://www.curseforge.com/minecraft/mc-mods/example-mod/files/200",
        side: "client",
      });

      const descriptorPath = path.join(fixture.packDir, "mods", "example-mod.toml");
      const descriptor = parseTomlFile<ModDefinition>(descriptorPath);
      expect(descriptor.provider).toEqual({ type: "curseforge", project_id: 100, file_id: 200 });

      const lockPath = path.join(fixture.packDir, "pack.lock.json");
      const lock = readJsonFile<PackLock>(lockPath);
      const artifact = lock.artifacts["example-mod"];
      expect(artifact.provider).toEqual({ type: "curseforge", projectId: 100, fileId: 200 });
      expect(artifact.sha1).toBe(createHash("sha1").update(content).digest("hex"));
      expect(artifact.sha256).toBe(createHash("sha256").update(content).digest("hex"));
      expect(artifact.metadata?.author).toBe("Fixture Author");

      const manifest = readJsonFile<PackManifest>(path.join(fixture.dir, "manifest", "client-manifest.json"));
      const manifestFile = manifest.files.find((entry) => entry.path === "mods/example-mod.jar");
      expect(manifestFile?.download).toEqual({
        url: "https://cdn.example/example-mod.jar",
        provider: "curseforge",
      });
      expect(downloadCount).toBe(1);

      await resolvePack({ packDir: fixture.packDir, lockFile: lockPath });
      expect(downloadCount).toBe(1);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("recursively adds required CurseForge dependencies", async () => {
    const fixture = createPackFixture();
    const parentContent = Buffer.from("parent");
    const dependencyContent = Buffer.from("dependency");
    const parentProject = project(100, "example-mod");
    const dependencyProject = project(101, "required-library");
    const parentFile = fileFixture({
      content: parentContent,
      dependencies: [{ modId: 101, relationType: 3 }],
    });
    const dependencyFile = fileFixture({
      id: 201,
      modId: 101,
      fileName: "required-library.jar",
      content: dependencyContent,
    });
    process.env.CURSEFORGE_API_KEY = "test-api-key";

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      if (url.pathname === "/v1/mods/100") return Response.json({ data: parentProject });
      if (url.pathname === "/v1/mods/101") return Response.json({ data: dependencyProject });
      if (url.pathname === "/v1/mods/100/files") return Response.json({ data: [parentFile] });
      if (url.pathname === "/v1/mods/101/files") return Response.json({ data: [dependencyFile] });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      await addMod({
        packDir: fixture.packDir,
        query: "100",
        provider: "curseforge",
        side: "both",
        depth: 1,
      });

      const parent = parseTomlFile<ModDefinition>(path.join(fixture.packDir, "mods", "example-mod.toml"));
      const dependency = parseTomlFile<ModDefinition>(
        path.join(fixture.packDir, "mods", "required-library.toml")
      );
      expect(parent.provider).toEqual({ type: "curseforge", project_id: 100, file_id: 200 });
      expect(dependency.provider).toEqual({ type: "curseforge", project_id: 101, file_id: 201 });
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("rejects files that disable third-party downloads before writing a descriptor", async () => {
    const fixture = createPackFixture();
    const content = Buffer.from("restricted");
    const restrictedProject = project();
    process.env.CURSEFORGE_API_KEY = "test-api-key";

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      if (url.pathname === "/v1/mods/100") return Response.json({ data: restrictedProject });
      if (url.pathname === "/v1/mods/100/files") {
        return Response.json({ data: [fileFixture({ content, downloadUrl: null })] });
      }
      if (url.pathname === "/v1/mods/100/files/200/download-url") {
        return new Response("not found", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      await expect(addMod({
        packDir: fixture.packDir,
        query: "100",
        provider: "curseforge",
        depth: 1,
      })).rejects.toThrow("does not permit third-party downloads");
      expect(fs.existsSync(path.join(fixture.packDir, "mods", "example-mod.toml"))).toBe(false);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});
