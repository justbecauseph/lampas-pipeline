import { describe, expect, test } from "bun:test";
import { validateClientPreserveList, validateConfigPatches } from "../src/config-patches";
import {
  MANAGED_SERVER_PROPERTY_KEYS,
  MAX_BUG_REPORT_LINK_LENGTH,
  MAX_MOTD_LENGTH,
  MAX_SERVER_PROPERTY_INT32,
  MAX_SERVER_TICK_SECONDS,
  MAX_SERVER_TICK_TIME,
  validateManifestRules,
} from "../src/manifest-rules";
import { canonicalizeRelativePath } from "../src/utils";

// Expectations follow lampas2-portal lib/pack-manifest-schema.ts and lampas-launcher
// src/metadata-policy.ts, not the lampasctl implementation.

const SHA = (c: string) => c.repeat(64);
const UUID = "3f2b8c1a-5d4e-4f70-9a6b-1c2d3e4f5a6b";

function file(path: string, extra: Record<string, unknown> = {}): any {
  return {
    path,
    size: 1,
    hashes: { sha256: SHA("a") },
    download: { url: "https://cdn.example.com/x.jar", provider: "modrinth" },
    policy: "MANAGED",
    ...extra,
  };
}

function manifest(
  target: "client" | "server",
  files: any[] = [],
  extra: Record<string, unknown> = {},
): any {
  return {
    schemaVersion: 2,
    pack: "Lampas Test",
    version: "2.0.0",
    target,
    minecraft: "26.2",
    loader: { type: "fabric", version: "0.19.3" },
    protocol: 3,
    files,
    ...extra,
  };
}

function patch(overrides: Record<string, unknown> = {}): any {
  return {
    id: "jade-hud",
    revision: 1,
    path: "config/jade/jade.json",
    adapter: "json",
    mode: "enforce",
    missingFile: "defer",
    operations: [{ op: "set", path: ["enabled"], value: false }],
    ...overrides,
  };
}

/** Validates one patch through lampasctl's patch checks, which throw on rejected input. */
function checkPatch(overrides: Record<string, unknown>): void {
  validateConfigPatches({ schemaVersion: 1, patches: [patch(overrides)] });
}

function srp(overrides: Record<string, unknown> = {}): any {
  return {
    artifact: "x",
    required: true,
    filename: "x.zip",
    path: "resourcepacks/x.zip",
    size: 1,
    url: "https://cdn.example.com/x.zip",
    sha1: "c".repeat(40),
    sha256: SHA("d"),
    id: UUID,
    provider: "direct",
    ...overrides,
  };
}

describe("path canonicalization: DEL and whitespace", () => {
  test("rejects DEL (0x7F) in any position, like the other control characters", () => {
    expect(() => canonicalizeRelativePath("mods/a\x7f.jar")).toThrow(
      "prohibited control characters",
    );
    expect(() => canonicalizeRelativePath("\x7fmods/a.jar")).toThrow(
      "prohibited control characters",
    );
  });

  test("rejects leading and trailing whitespace, including Unicode whitespace", () => {
    for (const padded of [
      " mods/a.jar",
      "mods/a.jar ",
      " mods/a.jar",
      "mods/a.jar ",
      "　mods/a.jar",
      "﻿mods/a.jar",
    ]) {
      expect(() => canonicalizeRelativePath(padded)).toThrow("leading or trailing whitespace");
    }
  });

  test("accepts whitespace inside a path, which the Portal's value !== value.trim() rule allows", () => {
    expect(canonicalizeRelativePath("mods/a b.jar")).toBe("mods/a b.jar");
  });

  test("rejects DEL and padding in client and server manifest paths and in patch paths", () => {
    expect(() => validateManifestRules(manifest("client", [file("mods/a\x7f.jar")]))).toThrow(
      "path must be a safe relative path",
    );
    expect(() => validateManifestRules(manifest("client", [file("mods/a.jar ")]))).toThrow(
      "path must be a safe relative path",
    );
    expect(() => validateManifestRules(manifest("server", [file("config/a\x7f.json")]))).toThrow(
      "path must be a safe relative path",
    );
    expect(() => validateManifestRules(manifest("server", [file(" config/x.json")]))).toThrow(
      "path must be a safe relative path",
    );
    expect(() => checkPatch({ path: "config/a\x7f.json" })).toThrow(
      "Unsafe target path for config patch",
    );
    expect(() => checkPatch({ path: " config/jade/jade.json" })).toThrow(
      "Unsafe target path for config patch",
    );
  });

  test("rejects padded and DEL-containing [client].preserve entries", () => {
    const staticFiles = [{ path: "options.txt", origin: "client" as const }];
    expect(() => validateClientPreserveList(["options.txt "], staticFiles)).toThrow(
      "Unsafe [client].preserve path 'options.txt '",
    );
    expect(() => validateClientPreserveList(["options.txt\x7f"], staticFiles)).toThrow(
      "Unsafe [client].preserve path",
    );
    expect(() => validateClientPreserveList([" options.txt"], staticFiles)).toThrow(
      "Unsafe [client].preserve path",
    );
  });
});

describe("config patch limits (launcher caps the Portal does not set)", () => {
  test("patch id: 1 to 128 characters, no control characters or DEL, no padding", () => {
    expect(() => checkPatch({ id: "x".repeat(128) })).not.toThrow();
    expect(() => checkPatch({ id: "x".repeat(129) })).toThrow(
      "Config patch id is longer than 128 characters.",
    );
    expect(() => checkPatch({ id: "jade\x01" })).toThrow("contains a control character");
    expect(() => checkPatch({ id: "jade\x7f" })).toThrow("contains a control character");
    expect(() => checkPatch({ id: "  jade" })).toThrow("has leading or trailing whitespace");
    expect(() => checkPatch({ id: "   " })).toThrow("has leading or trailing whitespace");
  });

  test("patch path: at most 1024 characters", () => {
    expect(() => checkPatch({ path: "config/" + "a".repeat(1017) })).not.toThrow();
    expect(() => checkPatch({ path: "config/" + "a".repeat(1018) })).toThrow(
      "target path is longer than 1024 characters",
    );
  });

  test("operation path: prototype-sensitive segments are rejected at any depth", () => {
    for (const path of [["__proto__"], ["constructor"], ["prototype"], ["a", "__proto__"]]) {
      expect(() => checkPatch({ operations: [{ op: "set", path, value: 1 }] })).toThrow(
        "prohibited key",
      );
    }
  });

  test("operation path: 1 to 64 segments, each a non-empty string of at most 256 characters or a non-negative integer", () => {
    expect(() =>
      checkPatch({ operations: [{ op: "set", path: Array(64).fill("a"), value: 1 }] }),
    ).not.toThrow();
    expect(() =>
      checkPatch({ operations: [{ op: "set", path: Array(65).fill("a"), value: 1 }] }),
    ).toThrow("must have 1 to 64 segments");
    expect(() =>
      checkPatch({ operations: [{ op: "set", path: ["a".repeat(256)], value: 1 }] }),
    ).not.toThrow();
    expect(() =>
      checkPatch({ operations: [{ op: "set", path: ["a".repeat(257)], value: 1 }] }),
    ).toThrow("non-empty strings of at most 256");
    expect(() => checkPatch({ operations: [{ op: "set", path: [""], value: 1 }] })).toThrow(
      "non-empty strings",
    );
    expect(() => checkPatch({ operations: [{ op: "set", path: [0], value: 1 }] })).not.toThrow();
    expect(() => checkPatch({ operations: [{ op: "set", path: [-1], value: 1 }] })).toThrow(
      "must be a non-negative integer",
    );
    expect(() => checkPatch({ operations: [{ op: "set", path: [1.5], value: 1 }] })).toThrow(
      "must be a non-negative integer",
    );
  });

  test("set operations require a value, and values are checked for depth, strings, objects, and prototype keys", () => {
    expect(() => checkPatch({ operations: [{ op: "set", path: ["enabled"] }] })).toThrow(
      "requires a value",
    );

    const nested = (levels: number) => {
      let value: unknown = 1;
      for (let i = 0; i < levels; i++) value = [value];
      return value;
    };
    expect(() =>
      checkPatch({ operations: [{ op: "set", path: ["x"], value: nested(20) }] }),
    ).not.toThrow();
    expect(() =>
      checkPatch({ operations: [{ op: "set", path: ["x"], value: nested(21) }] }),
    ).toThrow("nested deeper than 20 levels");

    expect(() =>
      checkPatch({ operations: [{ op: "set", path: ["x"], value: "a".repeat(4096) }] }),
    ).not.toThrow();
    expect(() =>
      checkPatch({ operations: [{ op: "set", path: ["x"], value: "a".repeat(4097) }] }),
    ).toThrow("longer than 4096");

    const wide = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`k${i}`, i]));
    expect(() => checkPatch({ operations: [{ op: "set", path: ["x"], value: wide }] })).toThrow(
      "more than 256 properties",
    );

    const polluted = JSON.parse('{"__proto__": 1}');
    expect(() => checkPatch({ operations: [{ op: "set", path: ["x"], value: polluted }] })).toThrow(
      "prohibited property key '__proto__'",
    );
  });

  test("replaceLiteral text: 64 KiB limit, launcher control-character rule (tab and newline allowed), expectedMatches up to 100000", () => {
    const text = (overrides: Record<string, unknown>) =>
      checkPatch({
        adapter: "text",
        mode: "once",
        missingFile: "defer",
        operations: [
          { op: "replaceLiteral", search: "a", replacement: "b", expectedMatches: 1, ...overrides },
        ],
      });

    expect(() => text({ replacement: "a\tb\nc" })).not.toThrow();
    expect(() => text({ replacement: "a\x01b" })).toThrow(
      "replacement text contains a control character",
    );
    expect(() => text({ replacement: "a".repeat(64 * 1024) })).not.toThrow();
    expect(() => text({ replacement: "a".repeat(64 * 1024 + 1) })).toThrow(
      "longer than 65536 characters",
    );
    expect(() => text({ expectedMatches: 100000 })).not.toThrow();
    expect(() => text({ expectedMatches: 100001 })).toThrow(
      "expectedMatches must be at most 100000",
    );
  });
});

describe("emitted manifest rules (Portal and launcher)", () => {
  test("protocol is an integer from 0 to 3", () => {
    expect(() => validateManifestRules(manifest("client", [], { protocol: 3 }))).not.toThrow();
    expect(() => validateManifestRules(manifest("client", [], { protocol: 4 }))).toThrow(
      "protocol must be an integer from 0 to 3",
    );
    expect(() => validateManifestRules(manifest("client", [], { protocol: 2.5 }))).toThrow(
      "protocol must be an integer",
    );
  });

  test("version matches the launcher-compatible pattern", () => {
    for (const version of ["2.3.34", "2.0.0-beta+1"]) {
      expect(() => validateManifestRules(manifest("client", [], { version }))).not.toThrow();
    }
    for (const version of ["-x", "2.0 beta", ""]) {
      expect(() => validateManifestRules(manifest("client", [], { version }))).toThrow(
        "launcher-compatible version",
      );
    }
  });

  test("pack, minecraft, and loader version are bounded strings (256, 128, 128 characters)", () => {
    expect(() =>
      validateManifestRules(manifest("client", [], { pack: "a".repeat(256) })),
    ).not.toThrow();
    expect(() => validateManifestRules(manifest("client", [], { pack: "a".repeat(257) }))).toThrow(
      "pack must be a string of 1 to 256",
    );
    expect(() =>
      validateManifestRules(manifest("client", [], { minecraft: "a".repeat(129) })),
    ).toThrow("minecraft must be a string of 1 to 128");
    expect(() =>
      validateManifestRules(
        manifest("client", [], { loader: { type: "fabric", version: "a".repeat(129) } }),
      ),
    ).toThrow("loader.version must be a string of 1 to 128");
  });

  test("mod catalog entries follow the launcher's validateMod limits", () => {
    const mod = (overrides: Record<string, unknown> = {}) => ({
      id: "m",
      name: "M",
      side: "client",
      filename: "m.jar",
      size: 1,
      ...overrides,
    });
    const check = (entry: Record<string, unknown>) =>
      validateManifestRules(manifest("client", [], { mods: [mod(entry)] }));

    expect(() => check({})).not.toThrow();
    expect(() => check({ name: "a".repeat(513) })).toThrow("name must be a string of 1 to 512");
    expect(() => check({ filename: "x/m.jar" })).toThrow("filename must be a basename");
    expect(() => check({ description: "a".repeat(4096) })).not.toThrow();
    expect(() => check({ description: "a".repeat(4097) })).toThrow(
      "description must be text of at most 4096",
    );
    expect(() => check({ description: "a\x01b" })).toThrow(
      "description must be text of at most 4096",
    );
    expect(() => check({ sourceUrl: "ftp://example.com/m" })).toThrow(
      "sourceUrl must be an HTTP(S) URL",
    );
    expect(() => check({ categories: ["a\tb"] })).toThrow("categories[0]");
    expect(() => check({ categories: ["a".repeat(129)] })).toThrow("categories[0]");
  });

  test("file paths are at most 1024 characters on both targets", () => {
    expect(() =>
      validateManifestRules(manifest("client", [file("mods/" + "a".repeat(1019))])),
    ).not.toThrow();
    expect(() =>
      validateManifestRules(manifest("client", [file("mods/" + "a".repeat(1020))])),
    ).toThrow("path is longer than 1024");
    expect(() =>
      validateManifestRules(manifest("server", [file("config/" + "a".repeat(1017))])),
    ).not.toThrow();
    expect(() =>
      validateManifestRules(manifest("server", [file("config/" + "a".repeat(1018))])),
    ).toThrow("path is longer than 1024");
  });

  test("file sizes are at most 2 GiB, and client files total at most 64 GiB", () => {
    const twoGiB = 2 * 1024 * 1024 * 1024;
    expect(() =>
      validateManifestRules(manifest("server", [file("config/x.json", { size: twoGiB })])),
    ).not.toThrow();
    expect(() =>
      validateManifestRules(manifest("server", [file("config/x.json", { size: twoGiB + 1 })])),
    ).toThrow("size exceeds");

    const thirtyThree = Array.from({ length: 33 }, (_, i) =>
      file(`mods/f${i}.jar`, { size: twoGiB }),
    );
    expect(() => validateManifestRules(manifest("client", thirtyThree))).toThrow("files total");
    expect(() => validateManifestRules(manifest("client", thirtyThree.slice(0, 32)))).not.toThrow();
  });

  test("download URLs: 2048 characters at most, no control characters or DEL", () => {
    expect(() =>
      validateManifestRules(
        manifest("client", [
          file("mods/a.jar", {
            download: { url: "https://cdn.example.com/a\x7f.jar", provider: "modrinth" },
          }),
        ]),
      ),
    ).toThrow("control characters, or DEL");
    expect(() =>
      validateManifestRules(
        manifest("client", [
          file("mods/a.jar", {
            download: { url: "https://cdn.example.com/" + "a".repeat(2049), provider: "modrinth" },
          }),
        ]),
      ),
    ).toThrow("at most 2048 characters");
  });

  test("server MANAGED files may not sit on protected server paths; PRESERVE may", () => {
    expect(() => validateManifestRules(manifest("server", [file("server.properties")]))).toThrow(
      "protected server path",
    );
    expect(() => validateManifestRules(manifest("server", [file("world/level.dat")]))).toThrow(
      "protected server path",
    );
    expect(() =>
      validateManifestRules(
        manifest("server", [file("server.properties", { policy: "PRESERVE" })]),
      ),
    ).not.toThrow();
  });

  test("duplicate file paths are rejected case-insensitively on both targets", () => {
    expect(() =>
      validateManifestRules(manifest("server", [file("config/X.json"), file("config/x.json")])),
    ).toThrow("duplicate file path");
    expect(() =>
      validateManifestRules(manifest("client", [file("mods/A.jar"), file("mods/a.jar")])),
    ).toThrow("duplicate file path");
  });

  test("a resource pack needs a UUID, valid JSON prompt, and the Lampas blob URL path", () => {
    const server = (rp: Record<string, unknown>) =>
      manifest("server", [], { resourcePack: srp(rp) });
    expect(() => validateManifestRules(server({}))).not.toThrow();
    expect(() => validateManifestRules(server({ id: "not-a-uuid" }))).toThrow(
      "id must be a valid UUID",
    );
    expect(() => validateManifestRules(server({ prompt: "{bad" }))).toThrow(
      "prompt must contain valid JSON",
    );
    expect(() =>
      validateManifestRules(server({ provider: "lampas", url: "https://cdn.example.com/x.zip" })),
    ).toThrow("Lampas url path must be /api/v1/blobs/<sha256>");
  });

  test("enforce operations may not share a path across patches, but once operations may", () => {
    const enforce = (id: string) =>
      patch({
        id,
        path: "config/jade/jade.json",
        mode: "enforce",
        operations: [{ op: "set", path: ["enabled"], value: false }],
      });
    const once = (id: string) =>
      patch({
        id,
        path: "config/jade/jade.json",
        mode: "once",
        operations: [{ op: "set", path: ["enabled"], value: false }],
      });

    const conflicting = validateConfigPatches({
      schemaVersion: 1,
      patches: [enforce("a"), enforce("b")],
    });
    expect(() =>
      validateManifestRules(manifest("client", [], { configPatches: conflicting })),
    ).toThrow("conflicting enforce operation");

    const shared = validateConfigPatches({ schemaVersion: 1, patches: [once("a"), once("b")] });
    expect(() =>
      validateManifestRules(manifest("client", [], { configPatches: shared })),
    ).not.toThrow();
  });
});

describe("server motd rules", () => {
  test("motd is server-only and follows the shared Portal rules", () => {
    const server = (motd: unknown) => manifest("server", [], { motd });
    expect(() => validateManifestRules(server("\u00a76Lampas 2: ???\nLorem ipsum"))).not.toThrow();
    expect(() => validateManifestRules(server("x".repeat(MAX_MOTD_LENGTH)))).not.toThrow();
    expect(() => validateManifestRules(manifest("client", [], { motd: "Hi" }))).toThrow(
      "motd is only valid on a server manifest",
    );
    expect(() => validateManifestRules(server(""))).toThrow("non-empty string");
    expect(() => validateManifestRules(server(42))).toThrow("non-empty string");
    expect(() => validateManifestRules(server("x".repeat(MAX_MOTD_LENGTH + 1)))).toThrow(
      "above the 512 limit",
    );
    expect(() => validateManifestRules(server("a\nb\nc"))).toThrow("at most two lines");
    expect(() => validateManifestRules(server("a\r\nb"))).toThrow("control characters");
    expect(() => validateManifestRules(server("a\tb"))).toThrow("control characters");
    expect(() => validateManifestRules(server("a\u007fb"))).toThrow("control characters");
    expect(() => validateManifestRules(server(" padded"))).toThrow("whitespace");
    expect(() => validateManifestRules(server("Lampas 2\n"))).toThrow("whitespace");
    expect(() => validateManifestRules(server("Lampas "))).toThrow("whitespace");
  });
});

describe("serverProperties rules", () => {
  const serverProps = (serverProperties: unknown) => manifest("server", [], { serverProperties });

  test("accepts all 14 allowlisted properties and enforces server-only and non-empty rules", () => {
    const allValid = {
      "allow-flight": true,
      "bug-report-link": "https://lampas.town/bugs?src=mc#new",
      "chat-spam-threshold-seconds": 10,
      "command-spam-threshold-seconds": 0,
      difficulty: "hard",
      "enable-code-of-conduct": false,
      "force-gamemode": false,
      gamemode: "survival",
      hardcore: false,
      "hide-online-players": true,
      "max-tick-time": -1,
      "pause-when-empty-seconds": -1,
      "player-idle-timeout": 0,
      "spawn-protection": 16,
    };
    expect(Object.keys(allValid).sort()).toEqual([...MANAGED_SERVER_PROPERTY_KEYS]);
    expect(() => validateManifestRules(serverProps(allValid))).not.toThrow();

    expect(() =>
      validateManifestRules(manifest("client", [], { serverProperties: { "allow-flight": true } })),
    ).toThrow("serverProperties is only valid on a server manifest");

    expect(() => validateManifestRules(serverProps({}))).toThrow("at least one property");
    expect(() => validateManifestRules(serverProps([]))).toThrow("must be an object");
    expect(() => validateManifestRules(serverProps(null))).toThrow("must be an object");
  });

  test("rejects host-owned, unknown, and prototype keys", () => {
    const rejectedKeys = [
      "motd",
      "resource-pack",
      "rcon.password",
      "view-distance",
      "simulation-distance",
      "level-name",
      "server-name",
      "constructor",
    ];
    for (const key of rejectedKeys) {
      expect(() => validateManifestRules(serverProps({ [key]: "x" }))).toThrow(
        `unsupported property '${key}'`,
      );
    }
    const withProto = JSON.parse('{"__proto__":{"allow-flight":true}}');
    expect(() => validateManifestRules(serverProps(withProto))).toThrow(
      "unsupported property '__proto__'",
    );
  });

  test("rejects wrong types, numeric difficulty/gamemode, and out-of-range integers", () => {
    expect(() => validateManifestRules(serverProps({ "allow-flight": "true" }))).toThrow(
      "must be a boolean",
    );
    expect(() => validateManifestRules(serverProps({ difficulty: 3 }))).toThrow("must be one of");
    expect(() => validateManifestRules(serverProps({ difficulty: "HARD" }))).toThrow(
      "must be one of",
    );
    expect(() => validateManifestRules(serverProps({ gamemode: "creative2" }))).toThrow(
      "must be one of",
    );
    expect(() => validateManifestRules(serverProps({ "spawn-protection": 1.5 }))).toThrow(
      "must be an integer",
    );

    // Boundaries accepted
    expect(() =>
      validateManifestRules(
        serverProps({
          "pause-when-empty-seconds": -1,
          "max-tick-time": -1,
          "spawn-protection": 0,
          "player-idle-timeout": MAX_SERVER_PROPERTY_INT32,
          "chat-spam-threshold-seconds": MAX_SERVER_TICK_SECONDS,
          "command-spam-threshold-seconds": 0,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateManifestRules(
        serverProps({
          "pause-when-empty-seconds": MAX_SERVER_TICK_SECONDS,
          "max-tick-time": MAX_SERVER_TICK_TIME,
        }),
      ),
    ).not.toThrow();

    // Out-of-range rejected
    expect(() => validateManifestRules(serverProps({ "pause-when-empty-seconds": -2 }))).toThrow(
      `between -1 and ${MAX_SERVER_TICK_SECONDS}`,
    );
    expect(() =>
      validateManifestRules(
        serverProps({ "pause-when-empty-seconds": MAX_SERVER_TICK_SECONDS + 1 }),
      ),
    ).toThrow(`between -1 and ${MAX_SERVER_TICK_SECONDS}`);
    expect(() => validateManifestRules(serverProps({ "max-tick-time": -2 }))).toThrow(
      `between -1 and ${MAX_SERVER_TICK_TIME}`,
    );
    expect(() =>
      validateManifestRules(serverProps({ "max-tick-time": MAX_SERVER_TICK_TIME + 1 })),
    ).toThrow(`between -1 and ${MAX_SERVER_TICK_TIME}`);
    expect(() => validateManifestRules(serverProps({ "spawn-protection": -1 }))).toThrow(
      "between 0 and 2147483647",
    );
    expect(() => validateManifestRules(serverProps({ "player-idle-timeout": -1 }))).toThrow(
      "between 0 and 2147483647",
    );
    expect(() =>
      validateManifestRules(
        serverProps({ "chat-spam-threshold-seconds": MAX_SERVER_TICK_SECONDS + 1 }),
      ),
    ).toThrow(`between 0 and ${MAX_SERVER_TICK_SECONDS}`);
    expect(() =>
      validateManifestRules(
        serverProps({ "command-spam-threshold-seconds": MAX_SERVER_TICK_SECONDS + 1 }),
      ),
    ).toThrow(`between 0 and ${MAX_SERVER_TICK_SECONDS}`);
  });

  test("validates bug-report-link empty string, HTTP(S) URLs, whitespace, controls, and UTF-16 length", () => {
    expect(() => validateManifestRules(serverProps({ "bug-report-link": "" }))).not.toThrow();
    expect(() =>
      validateManifestRules(serverProps({ "bug-report-link": "http://localhost:3000/report" })),
    ).not.toThrow();
    expect(() =>
      validateManifestRules(serverProps({ "bug-report-link": "https://lampas.town/bugs" })),
    ).not.toThrow();
    expect(() =>
      validateManifestRules(serverProps({ "bug-report-link": "https://[::1]:8443/bugs" })),
    ).not.toThrow();
    expect(() =>
      validateManifestRules(
        serverProps({ "bug-report-link": "https://lampas.town/bugs?pct=100%25" }),
      ),
    ).not.toThrow();

    const exactLimit = `https://example.com/${"a".repeat(MAX_BUG_REPORT_LINK_LENGTH - "https://example.com/".length)}`;
    expect(exactLimit.length).toBe(MAX_BUG_REPORT_LINK_LENGTH);
    expect(() =>
      validateManifestRules(serverProps({ "bug-report-link": exactLimit })),
    ).not.toThrow();

    expect(() =>
      validateManifestRules(serverProps({ "bug-report-link": `${exactLimit}a` })),
    ).toThrow(`above the ${MAX_BUG_REPORT_LINK_LENGTH} limit`);

    const surrogateLimit = `https://example.com/${"a".repeat(MAX_BUG_REPORT_LINK_LENGTH - "https://example.com/".length - 1)}\u{1F600}`;
    expect(surrogateLimit.length).toBe(MAX_BUG_REPORT_LINK_LENGTH + 1);
    expect(() => validateManifestRules(serverProps({ "bug-report-link": surrogateLimit }))).toThrow(
      `above the ${MAX_BUG_REPORT_LINK_LENGTH} limit`,
    );

    for (const bad of [
      "ftp://example.com/bugs",
      "javascript:alert(1)",
      "/bugs",
      "http:///path",
      "https:example.com/bugs",
      "https://example.com/100%",
      "https://example.com/a\\b",
      "https://example.com/<tag>",
      "https://example.com/{id}",
      "https://example.com/?a[0]=1",
      "https://example.com/\u0085",
      "https://example.com/\u009f",
      "https://example.com/a b",
      " https://example.com",
      "https://example.com ",
      "https://example.com/\t",
      "https://example.com/\n",
    ]) {
      expect(() => validateManifestRules(serverProps({ "bug-report-link": bad }))).toThrow();
    }
  });
});
