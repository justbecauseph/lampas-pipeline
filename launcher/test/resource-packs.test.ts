import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureRequiredResourcePacks, reconcileResourcePacks, isValidServerAddress } from "../src/resource-packs";
import type { RequiredResourcePack } from "../src/types";

describe("reconcileResourcePacks helper", () => {
  test("adds required pack to default vanilla list", () => {
    const existing = ["vanilla"];
    const current = ["file/Lampas-Resources-2.0.0.zip"];
    const old: string[] = [];
    expect(reconcileResourcePacks(existing, current, old)).toEqual([
      "vanilla",
      "file/Lampas-Resources-2.0.0.zip",
    ]);
  });

  test("preserves existing unrelated user packs and their ordering", () => {
    const existing = ["vanilla", "file/Faithful32.zip", "file/CustomAudio.zip"];
    const current = ["file/Lampas-Resources-2.0.0.zip"];
    const old: string[] = [];
    expect(reconcileResourcePacks(existing, current, old)).toEqual([
      "vanilla",
      "file/Faithful32.zip",
      "file/CustomAudio.zip",
      "file/Lampas-Resources-2.0.0.zip",
    ]);
  });

  test("replaces old managed version with new version and preserves user packs", () => {
    const existing = ["vanilla", "file/Faithful32.zip", "file/Lampas-Resources-2.0.0.zip", "file/CustomAudio.zip"];
    const current = ["file/Lampas-Resources-2.1.0.zip"];
    const old = ["file/Lampas-Resources-2.0.0.zip"];
    expect(reconcileResourcePacks(existing, current, old)).toEqual([
      "vanilla",
      "file/Faithful32.zip",
      "file/CustomAudio.zip",
      "file/Lampas-Resources-2.1.0.zip",
    ]);
  });

  test("does not duplicate if already enabled", () => {
    const existing = ["vanilla", "file/Lampas-Resources-2.0.0.zip"];
    const current = ["file/Lampas-Resources-2.0.0.zip"];
    const old = ["file/Lampas-Resources-2.0.0.zip"];
    expect(reconcileResourcePacks(existing, current, old)).toEqual([
      "vanilla",
      "file/Lampas-Resources-2.0.0.zip",
    ]);
  });
});

describe("ensureRequiredResourcePacks integration", () => {
  function createTestEnvironment() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-rp-test-"));
    const rpDir = path.join(dir, "resourcepacks");
    const stateDir = path.join(dir, ".lampas");
    fs.mkdirSync(rpDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    return {
      dir,
      rpDir,
      stateDir,
      optionsPath: path.join(dir, "options.txt"),
      statePath: path.join(stateDir, "installation.json"),
      createPackFile: (filename: string) => {
        const filePath = path.join(rpDir, filename);
        fs.writeFileSync(filePath, "dummy zip content");
        return filePath;
      },
    };
  }

  test("creates options.txt when it does not exist", async () => {
    const env = createTestEnvironment();
    try {
      env.createPackFile("Lampas-Resources-2.0.0.zip");
      const required: RequiredResourcePack[] = [
        {
          id: "lampas",
          filename: "Lampas-Resources-2.0.0.zip",
          path: "resourcepacks/Lampas-Resources-2.0.0.zip",
          sha256: "a".repeat(64),
        },
      ];

      await ensureRequiredResourcePacks(env.dir, required);

      expect(fs.existsSync(env.optionsPath)).toBe(true);
      const content = fs.readFileSync(env.optionsPath, "utf-8");
      expect(content).toContain('resourcePacks:["vanilla","file/Lampas-Resources-2.0.0.zip"]');

      // State check
      const state = JSON.parse(fs.readFileSync(env.statePath, "utf-8"));
      expect(state.managedResourcePacks).toEqual(["Lampas-Resources-2.0.0.zip"]);
    } finally {
      fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });

  test("leaves existing options and unrelated settings unchanged", async () => {
    const env = createTestEnvironment();
    try {
      env.createPackFile("Lampas-Resources-2.0.0.zip");
      const initialOptions = [
        "gamma:1.0",
        "fov:70.0",
        'resourcePacks:["vanilla","file/Faithful.zip"]',
        "soundCategory_master:0.8",
      ].join("\n");
      fs.writeFileSync(env.optionsPath, initialOptions, "utf-8");

      const required: RequiredResourcePack[] = [
        {
          id: "lampas",
          filename: "Lampas-Resources-2.0.0.zip",
          path: "resourcepacks/Lampas-Resources-2.0.0.zip",
          sha256: "a".repeat(64),
        },
      ];

      await ensureRequiredResourcePacks(env.dir, required);

      const content = fs.readFileSync(env.optionsPath, "utf-8");
      expect(content).toContain("gamma:1.0");
      expect(content).toContain("fov:70.0");
      expect(content).toContain("soundCategory_master:0.8");
      expect(content).toContain('resourcePacks:["vanilla","file/Faithful.zip","file/Lampas-Resources-2.0.0.zip"]');
    } finally {
      fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });

  test("handles version update cleanly removing old managed pack", async () => {
    const env = createTestEnvironment();
    try {
      env.createPackFile("Lampas-Resources-2.1.0.zip");
      // Simulate state from previous v2.0.0 install
      fs.writeFileSync(
        env.statePath,
        JSON.stringify({
          pack: "Lampas 2",
          version: "2.0.0",
          managedResourcePacks: ["Lampas-Resources-2.0.0.zip"],
          files: {},
        }),
        "utf-8"
      );

      const initialOptions = [
        'resourcePacks:["vanilla","file/CustomTextures.zip","file/Lampas-Resources-2.0.0.zip"]',
        "fov:80.0",
      ].join("\n");
      fs.writeFileSync(env.optionsPath, initialOptions, "utf-8");

      const required: RequiredResourcePack[] = [
        {
          id: "lampas",
          filename: "Lampas-Resources-2.1.0.zip",
          path: "resourcepacks/Lampas-Resources-2.1.0.zip",
          sha256: "b".repeat(64),
        },
      ];

      await ensureRequiredResourcePacks(env.dir, required);

      const content = fs.readFileSync(env.optionsPath, "utf-8");
      expect(content).not.toContain("Lampas-Resources-2.0.0.zip");
      expect(content).toContain('resourcePacks:["vanilla","file/CustomTextures.zip","file/Lampas-Resources-2.1.0.zip"]');
      expect(content).toContain("fov:80.0");

      const state = JSON.parse(fs.readFileSync(env.statePath, "utf-8"));
      expect(state.managedResourcePacks).toEqual(["Lampas-Resources-2.1.0.zip"]);
    } finally {
      fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });

  test("re-enables required pack if user had disabled it", async () => {
    const env = createTestEnvironment();
    try {
      env.createPackFile("Lampas-Resources-2.0.0.zip");
      fs.writeFileSync(
        env.statePath,
        JSON.stringify({
          pack: "Lampas 2",
          version: "2.0.0",
          managedResourcePacks: ["Lampas-Resources-2.0.0.zip"],
          files: {},
        }),
        "utf-8"
      );

      // User manually removed the pack from active packs in options.txt
      const optionsWithoutPack = 'resourcePacks:["vanilla"]\ngamma:0.5\n';
      fs.writeFileSync(env.optionsPath, optionsWithoutPack, "utf-8");

      const required: RequiredResourcePack[] = [
        {
          id: "lampas",
          filename: "Lampas-Resources-2.0.0.zip",
          path: "resourcepacks/Lampas-Resources-2.0.0.zip",
          sha256: "a".repeat(64),
        },
      ];

      await ensureRequiredResourcePacks(env.dir, required);

      const content = fs.readFileSync(env.optionsPath, "utf-8");
      expect(content).toContain('resourcePacks:["vanilla","file/Lampas-Resources-2.0.0.zip"]');
      expect(content).toContain("gamma:0.5");
    } finally {
      fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });

  test("backs up and safely reconstructs malformed resourcePacks line without destroying other settings", async () => {
    const env = createTestEnvironment();
    try {
      env.createPackFile("Lampas-Resources-2.0.0.zip");
      const malformedOptions = [
        "gamma:1.0",
        "resourcePacks:[INVALID_JSON{{{",
        "fullscreen:true",
      ].join("\n");
      fs.writeFileSync(env.optionsPath, malformedOptions, "utf-8");

      const required: RequiredResourcePack[] = [
        {
          id: "lampas",
          filename: "Lampas-Resources-2.0.0.zip",
          path: "resourcepacks/Lampas-Resources-2.0.0.zip",
          sha256: "a".repeat(64),
        },
      ];

      await ensureRequiredResourcePacks(env.dir, required);

      // Backup created
      const backupPath = path.join(env.dir, "options.txt.lampas-backup");
      expect(fs.existsSync(backupPath)).toBe(true);
      expect(fs.readFileSync(backupPath, "utf-8")).toBe(malformedOptions);

      // options.txt reconstructed safely
      const content = fs.readFileSync(env.optionsPath, "utf-8");
      expect(content).toContain("gamma:1.0");
      expect(content).toContain("fullscreen:true");
      expect(content).toContain('resourcePacks:["vanilla","file/Lampas-Resources-2.0.0.zip"]');
    } finally {
      fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });

  test("throws error when required resource pack file is missing on disk", async () => {
    const env = createTestEnvironment();
    try {
      const required: RequiredResourcePack[] = [
        {
          id: "lampas",
          filename: "Lampas-Missing.zip",
          path: "resourcepacks/Lampas-Missing.zip",
          sha256: "a".repeat(64),
        },
      ];

      await expect(ensureRequiredResourcePacks(env.dir, required)).rejects.toThrow(
        "Unable to prepare required Lampas resource pack (lampas): File missing at resourcepacks/Lampas-Missing.zip. Run Repair and try again."
      );
    } finally {
      fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });

  test("supports multiple required packs", async () => {
    const env = createTestEnvironment();
    try {
      env.createPackFile("Lampas-Core-2.0.0.zip");
      env.createPackFile("Lampas-Audio-2.0.0.zip");

      const required: RequiredResourcePack[] = [
        {
          id: "lampas-core",
          filename: "Lampas-Core-2.0.0.zip",
          path: "resourcepacks/Lampas-Core-2.0.0.zip",
          sha256: "a".repeat(64),
        },
        {
          id: "lampas-audio",
          filename: "Lampas-Audio-2.0.0.zip",
          path: "resourcepacks/Lampas-Audio-2.0.0.zip",
          sha256: "b".repeat(64),
        },
      ];

      await ensureRequiredResourcePacks(env.dir, required);

      const content = fs.readFileSync(env.optionsPath, "utf-8");
      expect(content).toContain(
        'resourcePacks:["vanilla","file/Lampas-Core-2.0.0.zip","file/Lampas-Audio-2.0.0.zip"]'
      );
    } finally {
      fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });
});
