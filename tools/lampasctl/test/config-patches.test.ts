import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildManifests } from "../src/manifest";
import { validatePack } from "../src/validator";
import { isProtectedClientPath, validateConfigPatches } from "../src/config-patches";

// Valid options.txt keybind rebind; tests override one field at a time.
function keybindPatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "snappy-tappy-keybind",
    revision: 1,
    path: "options.txt",
    adapter: "properties",
    mode: "once",
    missingFile: "defer",
    operations: [
      { op: "set", path: ["key_key.snappy_tappy.toggle"], value: "key.keyboard.unknown" },
    ],
    ...overrides,
  };
}

function validateSingle(patch: Record<string, unknown>) {
  return validateConfigPatches({ schemaVersion: 1, patches: [patch] });
}

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
    expect(serverManifest.schemaVersion).toBe(2);
    expect(clientManifest.schemaVersion).toBe(serverManifest.schemaVersion);

    // Target must NOT be in files[]
    expect(clientManifest.files.some((f) => f.path === "config/chatting.json")).toBe(false);

    // Server manifest must NOT have configPatches
    expect((serverManifest as any).configPatches).toBeUndefined();

    // Validator should also pass
    const valid = await validatePack({ packDir: fixture.packDir, lockFile: fixture.lockFile });
    expect(valid).toBe(true);
  });

  test("manifests without config patches still emit schemaVersion 2 on both client and server", async () => {
    const fixtureWithoutPatches = setupFixture({});
    const { clientManifest, serverManifest } = await buildManifests(fixtureWithoutPatches);

    expect(clientManifest.schemaVersion).toBe(2);
    expect(serverManifest.schemaVersion).toBe(2);
    expect(clientManifest.schemaVersion).toBe(serverManifest.schemaVersion);
    expect(clientManifest.configPatches).toBeUndefined();
    expect(serverManifest.configPatches).toBeUndefined();
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

  test("accepts a once-mode keybind rebind in options.txt", () => {
    const patches = validateSingle(keybindPatch());
    expect(patches).toHaveLength(1);
    expect(patches[0].path).toBe("options.txt");
  });

  test("rejects options.txt patches that are not keybind rebinds", () => {
    const rejected = [
      keybindPatch({
        id: "non-key-option",
        operations: [{ op: "set", path: ["guiScale"], value: "2" }],
      }),
      keybindPatch({
        id: "value-not-key-name",
        operations: [{ op: "set", path: ["key_key.snappy_tappy.toggle"], value: "2" }],
      }),
      keybindPatch({
        id: "value-without-key-name",
        operations: [{ op: "set", path: ["key_key.snappy_tappy.toggle"], value: "key.keyboard" }],
      }),
      keybindPatch({
        id: "remove-operation",
        operations: [{ op: "remove", path: ["key_key.snappy_tappy.toggle"] }],
      }),
      keybindPatch({ id: "missing-file-create", missingFile: "create" }),
      keybindPatch({ id: "json-adapter", adapter: "json" }),
      keybindPatch({ id: "enforce-mode", mode: "enforce" }),
      keybindPatch({
        id: "mixed-operations",
        operations: [
          { op: "set", path: ["key_key.snappy_tappy.toggle"], value: "key.keyboard.unknown" },
          { op: "set", path: ["guiScale"], value: "2" },
        ],
      }),
    ];

    for (const patch of rejected) {
      expect(() => validateSingle(patch)).toThrow(
        `Config patch '${patch.id}' targets launcher-protected path 'options.txt'`
      );
    }
  });

  test("rejects keybind-shaped patches on other protected player data and launcher state", () => {
    const protectedPaths = [
      "servers.dat",
      "usercache.json",
      "hotbar.nbt",
      "realms_persistence.json",
      "saves/world/level.dat",
      "Logs/latest.log",
      "screenshots/shot.png",
      "crash-reports/crash.txt",
      "saves\\world\\level.dat",
      ".lampas-moving-x",
    ];

    for (const targetPath of protectedPaths) {
      expect(() => validateSingle(keybindPatch({ id: "protected-target", path: targetPath }))).toThrow(
        `Config patch 'protected-target' targets launcher-protected path '${targetPath}'`
      );
    }
  });

  test("still accepts ordinary config paths", () => {
    const patches = validateSingle({
      id: "jade-config",
      revision: 1,
      path: "config/jade/jade.json",
      adapter: "json",
      mode: "enforce",
      missingFile: "defer",
      operations: [{ op: "set", path: ["enabled"], value: false }],
    });
    expect(patches).toHaveLength(1);
    expect(patches[0].path).toBe("config/jade/jade.json");
  });

  test("isProtectedClientPath matches top-level files and whole directory names only", () => {
    expect(isProtectedClientPath("options.txt")).toBe(true);
    expect(isProtectedClientPath("./options.txt")).toBe(true);
    expect(isProtectedClientPath("saves")).toBe(true);
    expect(isProtectedClientPath(".lampas")).toBe(true);
    expect(isProtectedClientPath(".lampas/installation.json")).toBe(true);

    expect(isProtectedClientPath("config/options.txt")).toBe(false);
    expect(isProtectedClientPath("savesfolder/world.dat")).toBe(false);
    expect(isProtectedClientPath("log/latest.log")).toBe(false);
    expect(isProtectedClientPath("config/jade/jade.json")).toBe(false);
  });

  test("canonicalizes config patch paths the way the launcher does", () => {
    // Paths the launcher rejects during canonicalization
    const unsafe = [
      "./options.txt",
      "config/../options.txt",
      "options.txt.",
      "options.txt ",
      "mods/../saves/world/level.dat",
    ];
    for (const targetPath of unsafe) {
      expect(() => validateSingle(keybindPatch({ id: "probe", path: targetPath }))).toThrow(
        `Unsafe target path for config patch 'probe': '${targetPath}'`
      );
    }

    // Canonical after trailing-slash removal, but not the exact options.txt the exception requires
    expect(() => validateSingle(keybindPatch({ id: "probe", path: "options.txt/" }))).toThrow(
      "Config patch 'probe' targets launcher-protected path 'options.txt/'"
    );
    expect(() => validateSingle(keybindPatch({ id: "probe", path: "OPTIONS.TXT" }))).toThrow(
      "Config patch 'probe' targets launcher-protected path 'OPTIONS.TXT'"
    );
  });

  test("emits canonical config patch paths", () => {
    const patches = validateSingle({
      id: "jade-config",
      revision: 1,
      path: "config\\jade\\jade.json",
      adapter: "json",
      mode: "enforce",
      missingFile: "defer",
      operations: [{ op: "set", path: ["enabled"], value: false }],
    });
    expect(patches[0].path).toBe("config/jade/jade.json");
  });

  test("warns, without failing, when one keybind patch sets more than one key", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const twoKeys = validateSingle(
        keybindPatch({
          id: "two-keys",
          operations: [
            { op: "set", path: ["key_key.snappy_tappy.toggle"], value: "key.keyboard.unknown" },
            { op: "set", path: ["key_key.mod.dash"], value: "key.keyboard.x" },
          ],
        })
      );
      expect(twoKeys).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("'two-keys' sets 2 keys in options.txt");

      warn.mockClear();
      validateSingle(keybindPatch());
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("whole-file entries of either policy conflict with a config patch, except a PRESERVE options.txt keybind patch", () => {
    const preserved = (p: string) => ({ path: p, policy: "PRESERVE" }) as any;
    const managed = (p: string) => ({ path: p, policy: "MANAGED" }) as any;

    const jadePatch = {
      id: "jade-hud",
      revision: 1,
      path: "config/jade/jade.json",
      adapter: "json",
      mode: "enforce",
      missingFile: "defer",
      operations: [{ op: "set", path: ["enabled"], value: false }],
    };

    expect(() =>
      validateConfigPatches({ schemaVersion: 1, patches: [jadePatch] }, [preserved("config/jade/jade.json")])
    ).toThrow("Config ownership conflict: 'config/jade/jade.json' is both a PRESERVE whole-file entry");

    // Case-insensitive collision, as the launcher's destination keys are case-folded on Windows
    expect(() =>
      validateConfigPatches({ schemaVersion: 1, patches: [jadePatch] }, [preserved("Config/Jade/Jade.json")])
    ).toThrow("is both a PRESERVE whole-file entry");

    expect(() =>
      validateConfigPatches({ schemaVersion: 1, patches: [jadePatch] }, [managed("config/jade/jade.json")])
    ).toThrow("is both a MANAGED artifact and a managed config-patch target.");

    // A PRESERVE options.txt with a once keybind patch is the one allowed collision
    const allowed = validateConfigPatches({ schemaVersion: 1, patches: [keybindPatch()] }, [preserved("options.txt")]);
    expect(allowed).toHaveLength(1);

    // A MANAGED options.txt is never allowed a config patch
    expect(() => validateConfigPatches({ schemaVersion: 1, patches: [keybindPatch()] }, [managed("options.txt")])).toThrow(
      "Config ownership conflict: 'options.txt' is both a MANAGED artifact"
    );

    // An enforce-mode keybind patch is not the exception, so it collides with the PRESERVE entry
    expect(() =>
      validateConfigPatches({ schemaVersion: 1, patches: [keybindPatch({ mode: "enforce" })] }, [preserved("options.txt")])
    ).toThrow("is both a PRESERVE whole-file entry and a config-patch target");

    // servers.dat is a seed with no keybind exception: any patch on a PRESERVE servers.dat collides
    const serversPatch = {
      id: "servers-name",
      revision: 1,
      path: "servers.dat",
      adapter: "json",
      mode: "enforce",
      missingFile: "defer",
      operations: [{ op: "set", path: ["name"], value: "x" }],
    };
    expect(() =>
      validateConfigPatches({ schemaVersion: 1, patches: [serversPatch] }, [preserved("servers.dat")])
    ).toThrow("Config ownership conflict: 'servers.dat' is both a PRESERVE whole-file entry");
    expect(() =>
      validateConfigPatches({ schemaVersion: 1, patches: [keybindPatch({ path: "servers.dat" })] }, [preserved("servers.dat")])
    ).toThrow("Config ownership conflict: 'servers.dat' is both a PRESERVE whole-file entry");

    // Without a whole-file entry, a patch on servers.dat is a protected-path error
    expect(() => validateConfigPatches({ schemaVersion: 1, patches: [serversPatch] }, [])).toThrow(
      "targets launcher-protected path 'servers.dat'"
    );
  });
});
