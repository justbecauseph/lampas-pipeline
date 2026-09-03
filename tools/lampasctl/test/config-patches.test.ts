import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildManifests } from "../src/manifest";
import { validatePack } from "../src/validator";
import { validateConfigPatches } from "../src/config-patches";

function setupFixture(options: {
  packTomlContent?: string;
  configPatchesContent?: any;
  clientFiles?: Array<{ path: string; content: string }>;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-patch-test-"));
  const packDir = path.join(dir, "pack");
  const outDir = path.join(dir, "manifest");
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(packDir, "mods"), { recursive: true });

  const packTomlPath = path.join(packDir, "pack.toml");
  const toml =
    options.packTomlContent ||
    `[pack]
name = "Lampas Test"
version = "2.0.0"
minecraft = "26.2"

[loader]
type = "fabric"
version = "0.19.3"

[launcher]
minimum_version = "1.1.0"
protocol = 3
`;
  fs.writeFileSync(packTomlPath, toml, "utf-8");

  const lockFile = path.join(packDir, "pack.lock.json");
  const lockData = {
    schema: 1,
    packName: "Lampas Test",
    packVersion: "2.0.0",
    minecraft: "26.2",
    loader: { type: "fabric", version: "0.19.3" },
    updated: new Date().toISOString(),
    artifacts: {},
  };
  fs.writeFileSync(lockFile, JSON.stringify(lockData, null, 2), "utf-8");

  if (options.clientFiles) {
    for (const f of options.clientFiles) {
      const full = path.join(packDir, "client", f.path);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.content, "utf-8");
    }
  }

  if (options.configPatchesContent) {
    const patchesDir = path.join(packDir, "config-patches");
    fs.mkdirSync(patchesDir, { recursive: true });
    fs.writeFileSync(
      path.join(patchesDir, "client.json"),
      JSON.stringify(options.configPatchesContent, null, 2),
      "utf-8"
    );
  }

  return { dir, packDir, lockFile, outDir };
}

describe("pipeline: config patch validation and manifest emission", () => {
  test("emits configPatches in client manifest but not in server manifest or files[]", async () => {
    const samplePatch = {
      id: "chatting-global-chat-tabs",
      revision: 1,
      path: "config/chatting.json",
      adapter: "json",
      mode: "enforce" as const,
      missingFile: "defer" as const,
      operations: [
        {
          op: "set" as const,
          path: ["hypixelOnlyChatTabs"],
          value: false,
        },
      ],
    };

    const fixture = setupFixture({
      configPatchesContent: {
        schemaVersion: 1,
        patches: [samplePatch],
      },
    });

    const { clientManifest, serverManifest } = await buildManifests(fixture);

    expect(clientManifest.configPatches).toBeDefined();
    expect(clientManifest.configPatches).toHaveLength(1);
    expect(clientManifest.configPatches![0]).toEqual(samplePatch);
    expect(clientManifest.schemaVersion).toBe(2);

    // Target must NOT be in files[]
    expect(clientManifest.files.some((f) => f.path === "config/chatting.json")).toBe(false);

    // Server manifest must NOT have configPatches
    expect((serverManifest as any).configPatches).toBeUndefined();

    // Validator should also pass
    const valid = await validatePack({ packDir: fixture.packDir, lockFile: fixture.lockFile });
    expect(valid).toBe(true);
  });

  test("rejects unsafe target paths", () => {
    const testCases = [
      "../foo.json",
      "../../secret.txt",
      "C:\\Windows\\System32\\config.json",
      "/etc/shadow",
      ".lampas/installation.json",
      ".lampas/cache/file.bin",
    ];

    for (const targetPath of testCases) {
      expect(() =>
        validateConfigPatches({
          schemaVersion: 1,
          patches: [
            {
              id: "bad-path-patch",
              revision: 1,
              path: targetPath,
              adapter: "json",
              mode: "enforce",
              missingFile: "defer",
              operations: [{ op: "set", path: ["key"], value: 1 }],
            },
          ],
        })
      ).toThrow(/Unsafe target path/);
    }
  });

  test("rejects duplicate patch IDs", () => {
    expect(() =>
      validateConfigPatches({
        schemaVersion: 1,
        patches: [
          {
            id: "same-id",
            revision: 1,
            path: "config/file1.json",
            adapter: "json",
            mode: "enforce",
            missingFile: "defer",
            operations: [{ op: "set", path: ["a"], value: 1 }],
          },
          {
            id: "same-id",
            revision: 1,
            path: "config/file2.json",
            adapter: "json",
            mode: "enforce",
            missingFile: "defer",
            operations: [{ op: "set", path: ["b"], value: 2 }],
          },
        ],
      })
    ).toThrow(/Duplicate config patch id: 'same-id'/);
  });

  test("rejects managed file conflict (whole-file MANAGED + config patch target)", async () => {
    const fixture = setupFixture({
      clientFiles: [
        {
          path: "config/chatting.json",
          content: '{"hypixelOnlyChatTabs": true}',
        },
      ],
      configPatchesContent: {
        schemaVersion: 1,
        patches: [
          {
            id: "chatting-patch",
            revision: 1,
            path: "config/chatting.json",
            adapter: "json",
            mode: "enforce",
            missingFile: "defer",
            operations: [{ op: "set", path: ["hypixelOnlyChatTabs"], value: false }],
          },
        ],
      },
    });

    await expect(buildManifests(fixture)).rejects.toThrow(
      "Config ownership conflict: 'config/chatting.json' is both a MANAGED artifact and a managed config-patch target."
    );

    const valid = await validatePack({ packDir: fixture.packDir, lockFile: fixture.lockFile });
    expect(valid).toBe(false);
  });

  test("rejects unsupported adapters and JSON5 without safe preservation", () => {
    expect(() =>
      validateConfigPatches({
        schemaVersion: 1,
        patches: [
          {
            id: "json5-test",
            revision: 1,
            path: "config/test.json5",
            adapter: "json5",
            mode: "enforce",
            missingFile: "defer",
            operations: [{ op: "set", path: ["foo"], value: "bar" }],
          },
        ],
      })
    ).toThrow(/Adapter 'json5'.*currently unsupported/);

    expect(() =>
      validateConfigPatches({
        schemaVersion: 1,
        patches: [
          {
            id: "random-test",
            revision: 1,
            path: "config/test.conf",
            adapter: "random-unknown",
            mode: "enforce",
            missingFile: "defer",
            operations: [{ op: "set", path: ["foo"], value: "bar" }],
          },
        ],
      })
    ).toThrow(/Unsupported adapter 'random-unknown'/);
  });

  test("rejects malformed operations and text adapter constraints", () => {
    // text adapter cannot have missingFile='create'
    expect(() =>
      validateConfigPatches({
        schemaVersion: 1,
        patches: [
          {
            id: "text-create",
            revision: 1,
            path: "config/test.txt",
            adapter: "text",
            mode: "enforce",
            missingFile: "create",
            operations: [
              {
                op: "replaceLiteral",
                search: "old",
                replacement: "new",
                expectedMatches: 1,
              },
            ],
          },
        ],
      })
    ).toThrow(/cannot have missingFile='create'/);

    // text adapter does not support 'set'
    expect(() =>
      validateConfigPatches({
        schemaVersion: 1,
        patches: [
          {
            id: "text-set",
            revision: 1,
            path: "config/test.txt",
            adapter: "text",
            mode: "enforce",
            missingFile: "defer",
            operations: [{ op: "set", path: ["foo"], value: "bar" }],
          },
        ],
      })
    ).toThrow(/only supports 'replaceLiteral'/);

    // json adapter does not support 'replaceLiteral'
    expect(() =>
      validateConfigPatches({
        schemaVersion: 1,
        patches: [
          {
            id: "json-literal",
            revision: 1,
            path: "config/test.json",
            adapter: "json",
            mode: "enforce",
            missingFile: "defer",
            operations: [
              {
                op: "replaceLiteral",
                search: "a",
                replacement: "b",
                expectedMatches: 1,
              },
            ],
          },
        ],
      })
    ).toThrow(/only supports 'set' and 'remove'/);

    // empty operations path
    expect(() =>
      validateConfigPatches({
        schemaVersion: 1,
        patches: [
          {
            id: "empty-path",
            revision: 1,
            path: "config/test.json",
            adapter: "json",
            mode: "enforce",
            missingFile: "defer",
            operations: [{ op: "set", path: [], value: 1 }],
          },
        ],
      })
    ).toThrow(/Operation path must not be empty/);
  });
});
