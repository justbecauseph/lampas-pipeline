import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addMod } from "../src/manager";
import { parseTomlFile } from "../src/utils";
import type { ModDefinition } from "../src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createPackFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-manager-"));
  const packDir = path.join(dir, "pack");
  fs.mkdirSync(path.join(packDir, "mods"), { recursive: true });
  fs.writeFileSync(
    path.join(packDir, "pack.toml"),
    [
      "[pack]",
      'name = "Manager Test Pack"',
      'version = "1.0.0"',
      'minecraft = "26.2"',
      "",
      "[loader]",
      'type = "fabric"',
      'version = "0.19.3"',
      "",
    ].join("\n")
  );
  return { dir, packDir };
}

const mockProjectData = {
  id: "4I1XuqiY",
  slug: "entity-model-features",
  title: "[EMF] Entity Model Features",
  project_type: "mod",
  client_side: "required",
  server_side: "unsupported",
};

const mockVersions = [
  {
    id: "jFT7K26t",
    project_id: "4I1XuqiY",
    name: "3.2.6-neoforge-26.2",
    version_number: "3.2.6-neoforge-26.2",
    game_versions: ["26.2"],
    loaders: ["neoforge"],
    files: [{ filename: "entity_model_features-3.2.6-26.2-neoforge.jar", primary: true }],
    dependencies: [],
  },
  {
    id: "xQeW3qQB",
    project_id: "4I1XuqiY",
    name: "3.2.6-fabric-26.2",
    version_number: "3.2.6-fabric-26.2",
    game_versions: ["26.2"],
    loaders: ["fabric", "quilt"],
    files: [{ filename: "entity_model_features-3.2.6-26.2-fabric.jar", primary: true }],
    dependencies: [],
  },
  {
    id: "e3rC4B72",
    project_id: "4I1XuqiY",
    name: "3.3.1-fabric-1.21",
    version_number: "3.3.1-fabric-1.21",
    game_versions: ["1.21", "1.21.1"],
    loaders: ["fabric", "quilt"],
    files: [{ filename: "entity_model_features-3.3.1-1.21-fabric.jar", primary: true }],
    dependencies: [],
  },
];

function setupModrinthFetchMock() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const urlStr = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlStr);

    if (url.pathname === "/v2/project/entity-model-features" || url.pathname === "/v2/project/4I1XuqiY") {
      return Response.json(mockProjectData);
    }
    if (url.pathname === "/v2/project/4I1XuqiY/version" || url.pathname === "/v2/project/entity-model-features/version") {
      return Response.json(mockVersions);
    }
    if (url.pathname === "/v2/version/xQeW3qQB") {
      return Response.json(mockVersions[1]);
    }
    if (url.pathname === "/v2/version/jFT7K26t") {
      return Response.json(mockVersions[0]);
    }
    if (url.pathname === "/v2/version/3.2.6-fabric-26.2") {
      return new Response("Bad Request", { status: 400 });
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
}

describe("Modrinth direct version resolution", () => {
  test("resolves direct version URL (https://modrinth.com/mod/.../version/...) to specific version_id", async () => {
    const { packDir } = createPackFixture();
    setupModrinthFetchMock();

    await addMod({
      packDir,
      query: "https://modrinth.com/mod/entity-model-features/version/3.2.6-fabric-26.2",
      depth: 1, // Skip root resolvePack/buildManifests
    });

    const tomlPath = path.join(packDir, "mods", "entity-model-features.toml");
    expect(fs.existsSync(tomlPath)).toBe(true);

    const def = parseTomlFile<ModDefinition>(tomlPath);
    expect(def.provider.type).toBe("modrinth");
    if (def.provider.type === "modrinth") {
      expect(def.provider.project_id).toBe("4I1XuqiY");
      expect(def.provider.version_id).toBe("xQeW3qQB");
    }
  });

  test("resolves direct version URL with project prefix (https://modrinth.com/project/.../version/...)", async () => {
    const { packDir } = createPackFixture();
    setupModrinthFetchMock();

    await addMod({
      packDir,
      query: "https://modrinth.com/project/entity-model-features/version/3.2.6-fabric-26.2",
      depth: 1,
    });

    const tomlPath = path.join(packDir, "mods", "entity-model-features.toml");
    const def = parseTomlFile<ModDefinition>(tomlPath);
    expect(def.provider.type).toBe("modrinth");
    if (def.provider.type === "modrinth") {
      expect(def.provider.version_id).toBe("xQeW3qQB");
    }
  });

  test("resolves direct version URL (https://modrinth.com/version/{version_id})", async () => {
    const { packDir } = createPackFixture();
    setupModrinthFetchMock();

    await addMod({
      packDir,
      query: "https://modrinth.com/version/xQeW3qQB",
      depth: 1,
    });

    const tomlPath = path.join(packDir, "mods", "entity-model-features.toml");
    const def = parseTomlFile<ModDefinition>(tomlPath);
    expect(def.provider.type).toBe("modrinth");
    if (def.provider.type === "modrinth") {
      expect(def.provider.project_id).toBe("4I1XuqiY");
      expect(def.provider.version_id).toBe("xQeW3qQB");
    }
  });

  test("resolves inline version syntax entity-model-features@3.2.6-fabric-26.2 to specific version_id", async () => {
    const { packDir } = createPackFixture();
    setupModrinthFetchMock();

    await addMod({
      packDir,
      query: "entity-model-features@3.2.6-fabric-26.2",
      depth: 1,
    });

    const tomlPath = path.join(packDir, "mods", "entity-model-features.toml");
    const def = parseTomlFile<ModDefinition>(tomlPath);
    expect(def.provider.type).toBe("modrinth");
    if (def.provider.type === "modrinth") {
      expect(def.provider.version_id).toBe("xQeW3qQB");
    }
  });

  test("selects compatible loader build (Fabric) over NeoForge when version prefix is passed", async () => {
    const { packDir } = createPackFixture();
    setupModrinthFetchMock();

    await addMod({
      packDir,
      query: "entity-model-features",
      versionId: "3.2.6",
      depth: 1,
    });

    const tomlPath = path.join(packDir, "mods", "entity-model-features.toml");
    const def = parseTomlFile<ModDefinition>(tomlPath);
    expect(def.provider.type).toBe("modrinth");
    if (def.provider.type === "modrinth") {
      expect(def.provider.version_id).toBe("xQeW3qQB");
    }
  });

  test("resolves when raw version ID is passed as query", async () => {
    const { packDir } = createPackFixture();
    setupModrinthFetchMock();

    await addMod({
      packDir,
      query: "xQeW3qQB",
      depth: 1,
    });

    const tomlPath = path.join(packDir, "mods", "entity-model-features.toml");
    const def = parseTomlFile<ModDefinition>(tomlPath);
    expect(def.provider.type).toBe("modrinth");
    if (def.provider.type === "modrinth") {
      expect(def.provider.project_id).toBe("4I1XuqiY");
      expect(def.provider.version_id).toBe("xQeW3qQB");
    }
  });
});
