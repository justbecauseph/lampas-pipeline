import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const rootDir = path.resolve(__dirname, "../../..");
const schemasDir = path.join(rootDir, "schemas");
const vscodeSettingsPath = path.join(rootDir, ".vscode/settings.json");

describe("schemas and IDE validation configuration", () => {
  const expectedSchemas = [
    "config-patches.schema.json",
    "pack-manifest.schema.json",
    "release.schema.json",
    "pack-lock.schema.json",
    "pack.schema.json",
    "mod.schema.json",
    "artifact-definition.schema.json",
  ];

  test("all 7 JSON schemas exist and are valid JSON with standard draft-2020-12 header", () => {
    for (const schemaFile of expectedSchemas) {
      const fullPath = path.join(schemasDir, schemaFile);
      expect(fs.existsSync(fullPath)).toBe(true);

      const parsed = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
      expect(parsed.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(parsed.$id).toBeDefined();
      expect(typeof parsed.$id).toBe("string");
      expect(parsed.title).toBeDefined();
      expect(parsed.type).toBe("object");
    }
  });

  test(".vscode/settings.json maps all schemas to appropriate file patterns", () => {
    expect(fs.existsSync(vscodeSettingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(vscodeSettingsPath, "utf-8"));

    expect(settings["json.schemas"]).toBeDefined();
    expect(Array.isArray(settings["json.schemas"])).toBe(true);

    const jsonMappings = settings["json.schemas"] as Array<{ fileMatch: string[]; url: string }>;
    const mappedUrls = jsonMappings.map((m) => m.url);

    expect(mappedUrls).toContain("./schemas/config-patches.schema.json");
    expect(mappedUrls).toContain("./schemas/pack-manifest.schema.json");
    expect(mappedUrls).toContain("./schemas/release.schema.json");
    expect(mappedUrls).toContain("./schemas/pack-lock.schema.json");

    expect(settings["evenBetterToml.schema.associations"]).toBeDefined();
    const tomlMappings = settings["evenBetterToml.schema.associations"];
    expect(tomlMappings["pack/pack\\.toml"]).toBe("./schemas/pack.schema.json");
    expect(tomlMappings["pack/mods/.*\\.toml"]).toBe("./schemas/artifact-definition.schema.json");
    expect(tomlMappings["pack/resourcepacks/.*\\.toml"]).toBe("./schemas/artifact-definition.schema.json");
    expect(tomlMappings["pack/shaderpacks/.*\\.toml"]).toBe("./schemas/artifact-definition.schema.json");
  });

  test("repository files match their corresponding schema definitions", () => {
    // 1. config-patches/client.json
    const clientPatchesPath = path.join(rootDir, "pack/config-patches/client.json");
    if (fs.existsSync(clientPatchesPath)) {
      const patchesData = JSON.parse(fs.readFileSync(clientPatchesPath, "utf-8"));
      expect(patchesData.schemaVersion).toBe(1);
      expect(Array.isArray(patchesData.patches)).toBe(true);
      expect(patchesData.patches.length).toBeGreaterThan(0);
      for (const p of patchesData.patches) {
        expect(p.id).toBeDefined();
        expect(p.revision).toBeGreaterThanOrEqual(1);
        expect(p.path).toBeDefined();
        expect(["json", "jsonc", "yaml", "toml", "properties", "ini", "text"]).toContain(p.adapter);
        expect(["enforce", "once"]).toContain(p.mode);
        expect(["defer", "create"]).toContain(p.missingFile);
        expect(Array.isArray(p.operations)).toBe(true);
      }
    }

    // 2. manifest/client-manifest.json & server-manifest.json
    const clientManifestPath = path.join(rootDir, "manifest/client-manifest.json");
    const serverManifestPath = path.join(rootDir, "manifest/server-manifest.json");
    if (fs.existsSync(clientManifestPath) && fs.existsSync(serverManifestPath)) {
      const client = JSON.parse(fs.readFileSync(clientManifestPath, "utf-8"));
      const server = JSON.parse(fs.readFileSync(serverManifestPath, "utf-8"));

      expect(client.schemaVersion).toBe(2);
      expect(server.schemaVersion).toBe(2);
      expect(client.target).toBe("client");
      expect(server.target).toBe("server");
      expect(Array.isArray(client.files)).toBe(true);
      expect(Array.isArray(server.files)).toBe(true);
    }

    // 3. manifest/release.json
    const releasePath = path.join(rootDir, "manifest/release.json");
    if (fs.existsSync(releasePath)) {
      const release = JSON.parse(fs.readFileSync(releasePath, "utf-8"));
      expect(release.schemaVersion).toBe(1);
      expect(release.pack).toBeDefined();
      expect(release.version).toBeDefined();
      expect(release.clientManifest).toBeDefined();
      expect(release.serverManifest).toBeDefined();
    }

    // 4. pack/pack.lock.json
    const lockPath = path.join(rootDir, "pack/pack.lock.json");
    if (fs.existsSync(lockPath)) {
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      expect(lock.schema).toBe(1);
      expect(lock.packName).toBeDefined();
      expect(typeof lock.artifacts).toBe("object");
    }

    // 5. pack/pack.toml has schema header
    const packTomlPath = path.join(rootDir, "pack/pack.toml");
    if (fs.existsSync(packTomlPath)) {
      const packTomlContent = fs.readFileSync(packTomlPath, "utf-8");
      expect(packTomlContent.startsWith("#:schema ../schemas/pack.schema.json")).toBe(true);
    }

    // 6. All pack artifact TOMLs have schema header
    const artifactDirs = ["pack/mods", "pack/resourcepacks", "pack/shaderpacks"];
    for (const relDir of artifactDirs) {
      const fullDir = path.join(rootDir, relDir);
      if (!fs.existsSync(fullDir)) continue;
      for (const f of fs.readdirSync(fullDir)) {
        if (!f.endsWith(".toml")) continue;
        const fileContent = fs.readFileSync(path.join(fullDir, f), "utf-8");
        expect(fileContent.startsWith("#:schema ../../schemas/artifact-definition.schema.json")).toBe(true);
      }
    }
  });

  test("writeTomlFile automatically prepends #:schema header for pipeline configuration TOMLs", async () => {
    const { inferTomlSchemaHeader, writeTomlFile } = await import("../src/utils");

    expect(inferTomlSchemaHeader("pack/pack.toml")).toBe("#:schema ../schemas/pack.schema.json\n\n");
    expect(inferTomlSchemaHeader("C:\\Users\\user\\repo\\pack\\pack.toml")).toBe("#:schema ../schemas/pack.schema.json\n\n");
    expect(inferTomlSchemaHeader("pack/mods/sodium.toml")).toBe("#:schema ../../schemas/artifact-definition.schema.json\n\n");
    expect(inferTomlSchemaHeader("pack/resourcepacks/lampas2.toml")).toBe("#:schema ../../schemas/artifact-definition.schema.json\n\n");
    expect(inferTomlSchemaHeader("pack/shaderpacks/photon.toml")).toBe("#:schema ../../schemas/artifact-definition.schema.json\n\n");

    // Distributed configs should NOT have schema injected
    expect(inferTomlSchemaHeader("pack/client/config/c2me.toml")).toBeNull();
    expect(inferTomlSchemaHeader("pack/common/config/pyrite.toml")).toBeNull();

    // Verify file write prepends header
    const tmpFile = path.join(rootDir, "pack/mods/_test_schema_write.toml");
    try {
      writeTomlFile(tmpFile, { name: "Test Mod", side: "client" });
      const written = fs.readFileSync(tmpFile, "utf-8");
      expect(written.startsWith("#:schema ../../schemas/artifact-definition.schema.json\n\n")).toBe(true);
      expect(written).toContain('name = "Test Mod"');
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });
});
