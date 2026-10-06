import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validatePack } from "../src/validator";

interface DescriptorFixture {
  directory: "mods" | "shaderpacks" | "shaders" | "resourcepacks";
  filename: string;
  content: string;
}

function setupFixture(options: {
  blacklist?: string;
  descriptors?: DescriptorFixture[];
  lockArtifacts?: Record<string, unknown>;
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-blacklist-test-"));
  const packDir = path.join(dir, "pack");
  fs.mkdirSync(packDir, { recursive: true });
  for (const directory of ["mods", "shaderpacks", "shaders", "resourcepacks"]) {
    fs.mkdirSync(path.join(packDir, directory), { recursive: true });
  }

  const packToml = `${options.blacklist ?? ""}
[pack]
name = "Blacklist Test"
version = "2.0.0"
minecraft = "26.2"

[loader]
type = "fabric"
version = "0.19.3"`;
  fs.writeFileSync(path.join(packDir, "pack.toml"), packToml, "utf-8");

  for (const descriptor of options.descriptors ?? []) {
    fs.writeFileSync(
      path.join(packDir, descriptor.directory, descriptor.filename),
      descriptor.content,
      "utf-8"
    );
  }

  const lockFile = path.join(packDir, "pack.lock.json");
  fs.writeFileSync(lockFile, JSON.stringify({
    schema: 1,
    packName: "Blacklist Test",
    packVersion: "2.0.0",
    minecraft: "26.2",
    loader: { type: "fabric", version: "0.19.3" },
    updated: "2026-10-06T00:00:00.000Z",
    artifacts: options.lockArtifacts ?? {},
  }, null, 2), "utf-8");

  return {
    packDir,
    lockFile,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function descriptorProvider(provider: string, fields: string): string {
  return `name = "Test Artifact"
side = "client"

[provider]
type = "${provider}"
${fields}`;
}

function resolvedArtifact(provider: Record<string, unknown>) {
  return {
    id: "test-artifact",
    name: "Test Artifact",
    side: "client",
    filename: "test-artifact.jar",
    size: 1,
    sha256: "a".repeat(64),
    downloadUrl: "https://example.invalid/test-artifact.jar",
    provider,
  };
}

async function validateOffline(fixture: ReturnType<typeof setupFixture>) {
  return validatePack({
    packDir: fixture.packDir,
    lockFile: fixture.lockFile,
    checkFabricMeta: false,
  });
}

async function captureValidation(fixture: ReturnType<typeof setupFixture>, checkFabricMeta = false) {
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => messages.push(args.map(String).join(" "));
  try {
    return {
      passed: await validatePack({
        packDir: fixture.packDir,
        lockFile: fixture.lockFile,
        checkFabricMeta,
      }),
      messages,
    };
  } finally {
    console.error = originalError;
  }
}

describe("blacklist validation", () => {
  test("keeps absent and empty policy behavior valid in offline validation", async () => {
    for (const blacklist of [undefined, "blacklist = []\n"]) {
      const fixture = setupFixture({
        ...(blacklist === undefined ? {} : { blacklist }),
        descriptors: [{ directory: "mods", filename: "existing.toml", content: "not valid TOML =" }],
        lockArtifacts: { existing: resolvedArtifact({ type: "modrinth", projectId: "p", versionId: "v" }) },
      });
      try {
        expect(await validateOffline(fixture)).toBe(true);
      } finally {
        fixture.cleanup();
      }
    }
  });

  test("rejects malformed policy before attempting Fabric Meta networking", async () => {
    const fixture = setupFixture({
      blacklist: `
[[blacklist]]
scope = "version_id"
id = "missing-provider"`,
    });
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1]
    ): Promise<Response> => {
      fetchCalls += 1;
      throw new Error("unexpected network request");
    }) as unknown as typeof fetch;
    try {
      const result = await captureValidation(fixture, true);
      expect(result.passed).toBe(false);
      expect(result.messages.join("\n")).toContain("[Invalid Blacklist]");
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      fixture.cleanup();
    }
  });

  test("rejects a blacklist declared inside a TOML section", async () => {
    const fixture = setupFixture();
    fs.appendFileSync(path.join(fixture.packDir, "pack.toml"), "\nblacklist = []\n");
    try {
      const result = await captureValidation(fixture);
      expect(result.passed).toBe(false);
      expect(result.messages.join("\n")).toContain("blacklist must be declared at the root");
      expect(result.messages.join("\n")).toContain("loader.blacklist");
    } finally {
      fixture.cleanup();
    }
  });

  test("rejects a descriptor blocked by its provider project ID", async () => {
    const fixture = setupFixture({
      blacklist: `
[[blacklist]]
scope = "project_id"
provider = "modrinth"
id = "blocked-project"
reason = "review pending"`,
      descriptors: [{
        directory: "mods",
        filename: "project-mod.toml",
        content: descriptorProvider("modrinth", `project_id = "blocked-project"\nversion_id = "allowed-version"`),
      }],
      lockArtifacts: {
        "project-mod": resolvedArtifact({ type: "modrinth", projectId: "blocked-project", versionId: "allowed-version" }),
      },
    });
    try {
      const result = await captureValidation(fixture);
      expect(result.passed).toBe(false);
      expect(result.messages.join("\n")).toContain("project_id 'blocked-project' (modrinth)");
      expect(result.messages.join("\n")).toContain("pack/mods/project-mod.toml");
      expect(result.messages.join("\n")).toContain("review pending");
    } finally {
      fixture.cleanup();
    }
  });

  test("rejects a stale blocked version in the lock even when its descriptor version is allowed", async () => {
    const fixture = setupFixture({
      blacklist: `
[[blacklist]]
scope = "version_id"
provider = "modrinth"
id = "blocked-version"`,
      descriptors: [{
        directory: "mods",
        filename: "stale-mod.toml",
        content: descriptorProvider("modrinth", `project_id = "project"\nversion_id = "allowed-version"`),
      }],
      lockArtifacts: {
        "stale-mod": resolvedArtifact({ type: "modrinth", projectId: "project", versionId: "blocked-version" }),
      },
    });
    try {
      const result = await captureValidation(fixture);
      expect(result.passed).toBe(false);
      expect(result.messages.join("\n")).toContain("version_id 'blocked-version' (modrinth)");
      expect(result.messages.join("\n")).toContain("pack.lock.json artifact 'stale-mod'");
      expect(result.messages.join("\n")).not.toContain("pack/mods/stale-mod.toml matches");
    } finally {
      fixture.cleanup();
    }
  });

  test("uses CurseForge fileId as the lock version and rejects inconsistent duplicate IDs", async () => {
    const matchingFixture = setupFixture({
      blacklist: `
[[blacklist]]
scope = "version_id"
provider = "curseforge"
id = 201`,
      lockArtifacts: {
        "curseforge-mod": resolvedArtifact({ type: "curseforge", projectId: 100, fileId: 201 }),
      },
    });
    try {
      const result = await captureValidation(matchingFixture);
      expect(result.passed).toBe(false);
      expect(result.messages.join("\n")).toContain("version_id '201' (curseforge)");
      expect(result.messages.join("\n")).toContain("pack.lock.json artifact 'curseforge-mod'");
    } finally {
      matchingFixture.cleanup();
    }

    const inconsistentFixture = setupFixture({
      blacklist: `
[[blacklist]]
scope = "version_id"
provider = "curseforge"
id = 201`,
      lockArtifacts: {
        "curseforge-mod": resolvedArtifact({ type: "curseforge", projectId: 100, versionId: 999, fileId: 201 }),
      },
    });
    try {
      const result = await captureValidation(inconsistentFixture);
      expect(result.passed).toBe(false);
      expect(result.messages.join("\n")).toContain("[Invalid Provider Identity]");
      expect(result.messages.join("\n")).toContain("versionId must equal its authoritative fileId");
    } finally {
      inconsistentFixture.cleanup();
    }
  });

  test("rejects a string CurseForge file_id instead of coercing it into a match", async () => {
    const fixture = setupFixture({
      blacklist: `
[[blacklist]]
scope = "version_id"
provider = "curseforge"
id = 201`,
      descriptors: [{
        directory: "mods",
        filename: "malformed-cf.toml",
        content: descriptorProvider("curseforge", `project_id = 100\nfile_id = "201"`),
      }],
      lockArtifacts: {
        "malformed-cf": resolvedArtifact({ type: "curseforge", projectId: 100, fileId: 200 }),
      },
    });
    try {
      const result = await captureValidation(fixture);
      expect(result.passed).toBe(false);
      expect(result.messages.join("\n")).toContain("[Invalid Provider Identity]");
      expect(result.messages.join("\n")).toContain("CurseForge file_id must be a positive safe integer");
    } finally {
      fixture.cleanup();
    }
  });

  test("covers resource and shader descriptors and blocks local Lampas IDs", async () => {
    const fixture = setupFixture({
      blacklist: `
[[blacklist]]
scope = "project_id"
provider = "modrinth"
id = "blocked-resource-project"

[[blacklist]]
scope = "version_id"
provider = "curseforge"
id = 777

[[blacklist]]
scope = "mod_id"
id = "local-component"`,
      descriptors: [
        {
          directory: "resourcepacks",
          filename: "blocked-resource.toml",
          content: descriptorProvider("modrinth", `project_id = "blocked-resource-project"\nversion_id = "resource-version"`),
        },
        {
          directory: "shaderpacks",
          filename: "blocked-shader.toml",
          content: descriptorProvider("curseforge", `project_id = 12\nfile_id = 777`),
        },
        {
          directory: "mods",
          filename: "local-component.toml",
          content: descriptorProvider("lampas", `file = "custom/local-component.jar"`),
        },
      ],
      lockArtifacts: {
        "lock-only-shader": resolvedArtifact({ type: "modrinth", projectId: "blocked-resource-project", versionId: "lock-only-version" }),
      },
    });
    try {
      const result = await captureValidation(fixture);
      expect(result.passed).toBe(false);
      const output = result.messages.join("\n");
      expect(output).toContain("pack/resourcepacks/blocked-resource.toml");
      expect(output).toContain("pack/shaderpacks/blocked-shader.toml");
      expect(output).toContain("pack/mods/local-component.toml");
      expect(output).toContain("mod_id 'local-component'");
      expect(output).toContain("pack.lock.json artifact 'lock-only-shader'");
    } finally {
      fixture.cleanup();
    }
  });

  test("allows blocked policy identities that are not present in descriptors or lock", async () => {
    const fixture = setupFixture({
      blacklist: `
[[blacklist]]
scope = "version_id"
provider = "modrinth"
id = "future-release-id"`,
    });
    try {
      expect(await validateOffline(fixture)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});
