import { describe, expect, test } from "bun:test";
import {
  describeBlacklistRule,
  matchingBlacklistRules,
  parsePackBlacklistRules,
  parseBlacklistRules,
} from "../src/blacklist";
import type { BlacklistRule } from "../src/types";

describe("blacklist rule parsing and matching", () => {
  test("allows an absent or empty blacklist and parses every supported identity kind", () => {
    expect(parseBlacklistRules(undefined)).toEqual([]);
    expect(parseBlacklistRules([])).toEqual([]);
    expect(
      parseBlacklistRules([
        { scope: "mod_id", id: "descriptor-id" },
        { scope: "project_id", provider: "modrinth", id: "project-id", reason: "review" },
        { scope: "version_id", provider: "modrinth", id: "exact-version" },
        { scope: "project_id", provider: "curseforge", id: 42 },
        { scope: "version_id", provider: "curseforge", id: 43, reason: "bad file" },
      ])
    ).toEqual([
      { scope: "mod_id", id: "descriptor-id" },
      { scope: "project_id", provider: "modrinth", id: "project-id", reason: "review" },
      { scope: "version_id", provider: "modrinth", id: "exact-version" },
      { scope: "project_id", provider: "curseforge", id: 42 },
      { scope: "version_id", provider: "curseforge", id: 43, reason: "bad file" },
    ]);
  });

  test("accepts root blacklist policy and rejects blacklist nested under pack configuration sections", () => {
    expect(parsePackBlacklistRules({
      pack: { name: "test" },
      loader: { type: "fabric" },
      blacklist: [{ scope: "mod_id", id: "blocked" }],
    }, "root.toml")).toEqual([{ scope: "mod_id", id: "blocked" }]);

    for (const section of [
      { pack: { blacklist: [] } },
      { loader: { blacklist: [] } },
      { launcher: { resourcepacks: { blacklist: [] } } },
      { server: { resourcepack: { blacklist: [] } } },
    ]) {
      expect(() => parsePackBlacklistRules(section, "nested.toml")).toThrow("must be declared at the root");
    }
  });

  test("rejects malformed rules, scope/provider mismatches, whitespace IDs, reasons, and unknown fields", () => {
    const invalidRules: unknown[] = [
      null,
      { scope: "unknown", id: "id" },
      { scope: "mod_id", id: "id", provider: "modrinth" },
      { scope: "project_id", id: "project" },
      { scope: "project_id", provider: "direct", id: "project" },
      { scope: "project_id", provider: "modrinth", id: 42 },
      { scope: "version_id", provider: "curseforge", id: "42" },
      { scope: "version_id", provider: "curseforge", id: 0 },
      { scope: "version_id", provider: "curseforge", id: 1.5 },
      { scope: "version_id", provider: "modrinth", id: "   " },
      { scope: "mod_id", id: "has whitespace" },
      { scope: "mod_id", id: "id", reason: "  " },
      { scope: "mod_id", id: "id", unexpected: true },
    ];

    for (const rule of invalidRules) {
      expect(() => parseBlacklistRules([rule], "test pack.toml")).toThrow("Invalid blacklist configuration in test pack.toml[0]");
    }
    expect(() => parseBlacklistRules({})).toThrow("must be an array");
  });

  test("matches exact scopes and provider identities without cross-scope or cross-provider collisions", () => {
    const rules: BlacklistRule[] = [
      { scope: "mod_id", id: "shared-value" },
      { scope: "project_id", provider: "modrinth", id: "shared-value" },
      { scope: "version_id", provider: "modrinth", id: "shared-value" },
      { scope: "project_id", provider: "curseforge", id: 100 },
      { scope: "version_id", provider: "curseforge", id: 200 },
    ];

    expect(matchingBlacklistRules(rules, {
      modId: "other-mod",
      provider: "modrinth",
      projectId: "shared-value",
      versionId: "different-version",
    })).toEqual([rules[1]]);
    expect(matchingBlacklistRules(rules, {
      modId: "shared-value",
      provider: "modrinth",
      projectId: "different-project",
      versionId: "different-version",
    })).toEqual([rules[0]]);
    expect(matchingBlacklistRules(rules, {
      modId: "other-mod",
      provider: "curseforge",
      projectId: 100,
      versionId: 200,
    })).toEqual([rules[3], rules[4]]);
    expect(matchingBlacklistRules(rules, {
      modId: "other-mod",
      provider: "curseforge",
      projectId: "100",
      versionId: "200",
    })).toEqual([]);
    expect(describeBlacklistRule({ scope: "version_id", provider: "modrinth", id: "bad", reason: "unsafe" }))
      .toContain("version_id 'bad' (modrinth)");
    expect(describeBlacklistRule({ scope: "mod_id", id: "blocked", reason: "unsafe" })).toContain("unsafe");
  });
});
