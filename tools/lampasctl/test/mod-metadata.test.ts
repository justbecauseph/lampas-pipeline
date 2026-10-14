import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as fflate from "fflate";
import {
  compareVersions,
  matchesAnyPredicate,
  parseDependencyPredicates,
  parseVersion,
  parseVersionPredicate,
  testVersionPredicate,
} from "../src/fabric-version";
import { analyzeModSet, lampasBuiltinMods, readModJar, type ModJarNode } from "../src/mod-metadata";
import { validatePack } from "../src/validator";

const FIXTURES = path.join(import.meta.dir, "fixtures", "mod-metadata");
const BUILTINS = lampasBuiltinMods("26.2", "0.19.5");

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, `${name}.fabric.mod.json`), "utf-8");
}

/** A jar holding the fixture's fabric.mod.json, plus nested jars at the given entry paths. */
function jarBytes(fabricModJson: string, nested: Record<string, Uint8Array> = {}): Uint8Array {
  return fflate.zipSync({ "fabric.mod.json": fflate.strToU8(fabricModJson), ...nested });
}

function jar(name: string, nested: Record<string, Uint8Array> = {}, filename = `${name}.jar`): ModJarNode {
  return readModJar(jarBytes(fixture(name), nested), `mods/${filename}`);
}

function modJson(fields: Record<string, unknown>): string {
  return JSON.stringify({ schemaVersion: 1, ...fields });
}

function inlineJar(source: string, fields: Record<string, unknown>, nested: Record<string, Uint8Array> = {}): ModJarNode {
  return readModJar(jarBytes(modJson(fields), nested), `mods/${source}`);
}

function satisfies(version: string, predicate: string): boolean {
  return testVersionPredicate(parseVersionPredicate(predicate), parseVersion(version, false));
}

describe("Fabric version comparison", () => {
  test("compares prerelease identifiers dot-wise, numeric parts numerically", () => {
    expect(compareVersions(parseVersion("26.2-3.6.28+refabricated"), parseVersion("26.2-3.6.6"))).toBe(1);
    expect(compareVersions(parseVersion("26.2-3.6.6"), parseVersion("26.2-3.6.28"))).toBe(-1);
    expect(compareVersions(parseVersion("1.0.0-alpha.1"), parseVersion("1.0.0-alpha.beta"))).toBe(-1);
    expect(compareVersions(parseVersion("1.0.0-rc.1"), parseVersion("1.0.0-rc.1.1"))).toBe(-1);
  });

  test("orders a prerelease below its release and ignores build metadata", () => {
    expect(compareVersions(parseVersion("1.0.0-beta"), parseVersion("1.0.0"))).toBe(-1);
    expect(compareVersions(parseVersion("1.0.0+a"), parseVersion("1.0.0+b"))).toBe(0);
    expect(compareVersions(parseVersion("1.2"), parseVersion("1.2.0"))).toBe(0);
  });

  test("keeps versions Fabric cannot parse as semantic as plain strings", () => {
    expect(parseVersion("1.0.x-beta").kind).toBe("string");
    expect(parseVersion("${version}").kind).toBe("string");
    expect(parseVersion("1.0.5.1").kind).toBe("semantic");
  });
});

describe("Fabric version predicates", () => {
  test("satisfied prerelease comparison: farmersdelight 26.2-3.6.28+refabricated against >=26.2-3.6.6", () => {
    expect(satisfies("26.2-3.6.28+refabricated", ">=26.2-3.6.6")).toBe(true);
    expect(satisfies("26.2-3.6.28+refabricated", ">=26.2-3.6.6+refabricated")).toBe(true);
    expect(satisfies("26.2-3.6.5+refabricated", ">=26.2-3.6.6")).toBe(false);
  });

  test("comparison operators", () => {
    expect(satisfies("1.2.0", ">=1.2.0")).toBe(true);
    expect(satisfies("1.1.9", ">=1.2.0")).toBe(false);
    expect(satisfies("1.2.0", "<=1.2.0")).toBe(true);
    expect(satisfies("1.2.1", "<=1.2.0")).toBe(false);
    expect(satisfies("1.2.0", ">1.2.0")).toBe(false);
    expect(satisfies("1.2.1", ">1.2.0")).toBe(true);
    expect(satisfies("1.2.0-beta", "<1.2.0")).toBe(true);
    expect(satisfies("1.0.5.1", "<1.1.0")).toBe(true);
    expect(satisfies("1.1.0+26.2", "<1.1.0")).toBe(false);
    expect(satisfies("1.2.0+build", "=1.2.0")).toBe(true);
    expect(satisfies("1.2.0+build", "1.2.0")).toBe(true);
    expect(satisfies("1.2.1", "=1.2.0")).toBe(false);
  });

  test("~ allows patch updates and ^ allows minor updates", () => {
    expect(satisfies("1.2.9", "~1.2.3")).toBe(true);
    expect(satisfies("1.2.2", "~1.2.3")).toBe(false);
    expect(satisfies("1.3.0", "~1.2.3")).toBe(false);
    expect(satisfies("26.2", "~26.2")).toBe(true);
    expect(satisfies("1.9.0", "^1.2.3")).toBe(true);
    expect(satisfies("1.2.2", "^1.2.3")).toBe(false);
    expect(satisfies("2.0.0", "^1.2.3")).toBe(false);
  });

  test("x-wildcards", () => {
    expect(satisfies("1.0.0", "1.x")).toBe(true);
    expect(satisfies("1.5.2", "1.X")).toBe(true);
    expect(satisfies("2.0.0", "1.x")).toBe(false);
    expect(satisfies("0.9.0", "1.x")).toBe(false);
    expect(satisfies("1.2.7", "1.2.x")).toBe(true);
    expect(satisfies("1.2.7", "1.2.*")).toBe(true);
    expect(satisfies("1.3.0", "1.2.x")).toBe(false);
    expect(satisfies("26.2", "26.2.x")).toBe(true);
    expect(satisfies("1.2.3.4", "1.2.3.x")).toBe(true);
    expect(satisfies("1.2.4", "1.2.3.x")).toBe(false);
    expect(() => parseVersionPredicate(">=1.x")).toThrow();
    expect(() => parseVersionPredicate("x.x")).toThrow();
  });

  test("* matches every version, including non-semantic ones", () => {
    expect(satisfies("anything", "*")).toBe(true);
    expect(satisfies("1.0.0", "")).toBe(true);
  });

  test("space-separated terms are ANDed and array entries are ORed", () => {
    expect(satisfies("1.5", ">=1.0 <2.0")).toBe(true);
    expect(satisfies("2.0", ">=1.0 <2.0")).toBe(false);
    expect(satisfies("26.2", ">=26.2 <=26.2")).toBe(true);

    const either = parseDependencyPredicates(["<1.0", ">=2.0"]);
    expect(matchesAnyPredicate(either, parseVersion("0.5"))).toBe(true);
    expect(matchesAnyPredicate(either, parseVersion("2.1"))).toBe(true);
    expect(matchesAnyPredicate(either, parseVersion("1.5"))).toBe(false);
    expect(matchesAnyPredicate(parseDependencyPredicates([]), parseVersion("1.0"))).toBe(false);
  });

  test("non-semantic versions only match by exact string with inclusive operators", () => {
    expect(satisfies("abc", "abc")).toBe(true);
    expect(satisfies("abc", ">=abc")).toBe(true);
    expect(satisfies("abd", ">=abc")).toBe(false);
    expect(satisfies("abc", ">=1.0")).toBe(false);
    expect(() => parseVersionPredicate(">abc")).toThrow();
  });
});

describe("mod metadata analysis", () => {
  test("a matching breaks rule fails: WalksyLib 2.0.2 with Crossbow & Bow Optimizer 1.0.5.1", () => {
    const report = analyzeModSet(
      "client",
      [jar("fabric-api"), jar("walksylib-2.0.2"), jar("crossbow-bow-optimizer-1.0.5.1")],
      BUILTINS
    );
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].kind).toBe("breaks");
    expect(report.issues[0].message).toContain("walksylib 2.0.2+26.2");
    expect(report.issues[0].message).toContain("crossbowoptimizer <1.1.0");
    expect(report.issues[0].message).toContain("crossbowoptimizer 1.0.5.1");
  });

  test("the same pack with Crossbow Optimizer 1.1.0 passes", () => {
    const report = analyzeModSet(
      "client",
      [jar("fabric-api"), jar("walksylib-2.0.2"), jar("crossbowoptimizer-1.1.0")],
      BUILTINS
    );
    expect(report.issues).toEqual([]);
    expect(report.modCount).toBe(3);
  });

  test("two top-level jars with one mod ID are duplicates, keyed by jar path", () => {
    const report = analyzeModSet(
      "client",
      [jar("fabric-api"), jar("walksylib-2.0.2"), jar("crossbowoptimizer-1.1.0"), jar("crossbow-bow-optimizer-1.0.5.1")],
      BUILTINS
    );
    // Fabric Loader loads one copy per ID; it can pick 1.1.0, which walksylib does not break.
    expect(report.issues.map((i) => i.kind)).toEqual(["duplicate"]);
    const duplicate = report.issues.find((i) => i.kind === "duplicate")!;
    expect(duplicate.message).toContain("'crossbowoptimizer'");
    expect(duplicate.message).toContain("mods/crossbowoptimizer-1.1.0.jar");
    expect(duplicate.message).toContain("mods/crossbow-bow-optimizer-1.0.5.1.jar");
  });

  test("provides counts toward top-level duplicates, a mod providing its own ID does not", () => {
    const report = analyzeModSet(
      "client",
      [
        inlineJar("a.jar", { id: "alpha", version: "1.0.0", provides: ["alpha"] }),
        inlineJar("b.jar", { id: "beta", version: "1.0.0", provides: ["alpha"] }),
      ],
      BUILTINS
    );
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].kind).toBe("duplicate");
    expect(report.issues[0].message).toContain("'alpha' is provided by 2 jars");
  });

  test("a mod sharing a builtin ID is reported", () => {
    const report = analyzeModSet("client", [inlineJar("fake.jar", { id: "fakejava", version: "1.0.0", provides: ["java"] })], BUILTINS);
    expect(report.issues.map((i) => i.kind)).toEqual(["duplicate"]);
  });

  test("a satisfied prerelease dependency passes, nested jar-in-jar mods included", () => {
    const midnightlib = jarBytes(fixture("midnightlib-1.9.3"));
    const report = analyzeModSet(
      "server",
      [
        jar("fabric-api"),
        jar("farmersdelight-26.2-3.6.28"),
        jar("ubesdelight-0.4.15", { "META-INF/jars/midnightlib-1.9.3+26.2-fabric.jar": midnightlib }),
      ],
      BUILTINS
    );
    expect(report.issues).toEqual([]);
    expect(report.modCount).toBe(4);
  });

  test("an unmet version predicate and a missing dependency are reported", () => {
    const olderDelight = fixture("farmersdelight-26.2-3.6.28").replace("26.2-3.6.28+refabricated", "26.2-3.6.5+refabricated");
    const report = analyzeModSet(
      "client",
      [
        readModJar(jarBytes(olderDelight), "mods/farmersdelight.jar"),
        jar("ubesdelight-0.4.15", { "META-INF/jars/midnightlib-1.9.3+26.2-fabric.jar": jarBytes(fixture("midnightlib-1.9.3")) }),
      ],
      BUILTINS
    );
    const kinds = report.issues.map((i) => i.kind).sort();
    // fabric-api is absent for both mods; farmersdelight is too old for ubesdelight.
    expect(kinds).toEqual(["missing-dependency", "missing-dependency", "unsatisfied-dependency"]);
    expect(report.issues.find((i) => i.kind === "unsatisfied-dependency")!.message).toContain("farmersdelight 26.2-3.6.5+refabricated");
  });

  test("a nested mod whose rules cannot be met is skipped unless a top-level mod needs it", () => {
    const inner = jarBytes(modJson({ id: "inner", version: "1.0.0", depends: { "missing-lib": "*" } }));
    const outer = () =>
      inlineJar("outer.jar", { id: "outer", version: "1.0.0", jars: [{ file: "META-INF/jars/inner.jar" }] }, { "META-INF/jars/inner.jar": inner });
    expect(analyzeModSet("client", [outer()], BUILTINS).issues).toEqual([]);

    const report = analyzeModSet("client", [outer(), inlineJar("user.jar", { id: "user", version: "1.0.0", depends: { inner: "*" } })], BUILTINS);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].kind).toBe("unsatisfied-dependency");
    expect(report.issues[0].message).toContain(
      "inner 1.0.0 (mods/outer.jar!/META-INF/jars/inner.jar), which cannot load because it depends on missing-lib *"
    );
  });

  test("an older nested copy loads when the newest one cannot", () => {
    const newLib = jarBytes(modJson({ id: "lib", version: "2.0.0", depends: { fabricloader: ">=0.20.0" } }));
    const oldLib = jarBytes(modJson({ id: "lib", version: "1.0.0" }));
    const report = analyzeModSet(
      "client",
      [
        inlineJar("x.jar", { id: "xmod", version: "1.0.0", jars: [{ file: "META-INF/jars/lib.jar" }] }, { "META-INF/jars/lib.jar": newLib }),
        inlineJar("y.jar", { id: "ymod", version: "1.0.0", jars: [{ file: "META-INF/jars/lib.jar" }] }, { "META-INF/jars/lib.jar": oldLib }),
        inlineJar("z.jar", { id: "zmod", version: "1.0.0", depends: { lib: "*" } }),
      ],
      BUILTINS
    );
    expect(report.issues).toEqual([]);
  });

  test("one nested copy has to satisfy every top-level mod that depends on it", () => {
    const lib1 = jarBytes(modJson({ id: "lib", version: "1.0.0" }));
    const lib2 = jarBytes(modJson({ id: "lib", version: "2.0.0" }));
    const report = analyzeModSet(
      "client",
      [
        inlineJar("x.jar", { id: "xmod", version: "1.0.0", depends: { lib: "<2.0.0" }, jars: [{ file: "META-INF/jars/lib.jar" }] }, { "META-INF/jars/lib.jar": lib1 }),
        inlineJar("y.jar", { id: "ymod", version: "1.0.0", depends: { lib: ">=2.0.0" }, jars: [{ file: "META-INF/jars/lib.jar" }] }, { "META-INF/jars/lib.jar": lib2 }),
      ],
      BUILTINS
    );
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].kind).toBe("unsatisfied-dependency");
    expect(report.issues[0].message).toContain("no single copy of lib satisfies");
  });

  test("a top-level breaks rule excludes matching nested copies without failing", () => {
    const lib = jarBytes(modJson({ id: "lib", version: "1.0.0" }));
    const report = analyzeModSet(
      "client",
      [
        inlineJar("x.jar", { id: "xmod", version: "1.0.0", jars: [{ file: "META-INF/jars/lib.jar" }] }, { "META-INF/jars/lib.jar": lib }),
        inlineJar("guard.jar", { id: "guard", version: "1.0.0", breaks: { lib: "<2.0.0" } }),
      ],
      BUILTINS
    );
    expect(report.issues).toEqual([]);
  });

  test("a mod that breaks its own ID fails", () => {
    const report = analyzeModSet(
      "client",
      [inlineJar("self.jar", { id: "self", version: "1.0.0", provides: ["alias"], breaks: { alias: "*" } })],
      BUILTINS
    );
    expect(report.issues.map((i) => i.kind)).toEqual(["breaks"]);
  });

  test("a nested copy of fabricloader loses to the loader instead of colliding", () => {
    const loaderCopy = jarBytes(modJson({ id: "fabricloader", version: "0.16.0" }));
    const report = analyzeModSet(
      "client",
      [
        inlineJar(
          "bundler.jar",
          { id: "bundler", version: "1.0.0", depends: { fabricloader: ">=0.19.5" }, jars: [{ file: "META-INF/jars/loader.jar" }] },
          { "META-INF/jars/loader.jar": loaderCopy }
        ),
      ],
      BUILTINS
    );
    expect(report.issues).toEqual([]);
  });

  test("schema 0 metadata is read with its own field names", () => {
    const report = analyzeModSet(
      "server",
      [
        readModJar(jarBytes(JSON.stringify({ id: "legacy", version: "1.0.0", side: "client", requires: { absent: "*" } })), "mods/legacy-client.jar"),
        readModJar(jarBytes(JSON.stringify({ id: "legacy-common", version: "1.0.0", requires: { absent: "*" } })), "mods/legacy.jar"),
      ],
      BUILTINS
    );
    expect(report.issues.map((i) => i.message)).toEqual([
      "legacy-common 1.0.0 (mods/legacy.jar) depends on absent *, which is not present",
    ]);
  });

  test("a top-level mod overrides nested copies of the same ID without a duplicate", () => {
    const nestedOld = jarBytes(modJson({ id: "lib", version: "1.0.0" }));
    const report = analyzeModSet(
      "client",
      [
        inlineJar("lib.jar", { id: "lib", version: "2.0.0" }),
        inlineJar("user.jar", { id: "user", version: "1.0.0", depends: { lib: ">=2.0.0" }, jars: [{ file: "META-INF/jars/lib.jar" }] }, { "META-INF/jars/lib.jar": nestedOld }),
      ],
      BUILTINS
    );
    expect(report.issues).toEqual([]);
  });

  test("mods are filtered by environment, and a dependency on an environment-disabled mod is softened", () => {
    const jars = [
      inlineJar("menu.jar", { id: "modmenu", version: "20.0.3", environment: "client" }),
      inlineJar("village.jar", { id: "underground_village", version: "2.1.1", depends: { modmenu: "*" } }),
      inlineJar("hud.jar", { id: "hud", version: "1.0.0", environment: "client", depends: { "client-only-lib": "*" } }),
    ];
    const server = analyzeModSet("server", jars, BUILTINS);
    expect(server.issues).toEqual([]);
    expect(server.modCount).toBe(1);

    const client = analyzeModSet("client", jars, BUILTINS);
    expect(client.issues.map((i) => i.message)).toEqual([
      "hud 1.0.0 (mods/hud.jar) depends on client-only-lib *, which is not present",
    ]);
  });

  test("builtin mods satisfy minecraft, fabricloader and java dependencies", () => {
    const report = analyzeModSet(
      "client",
      [inlineJar("needs.jar", { id: "needs", version: "1.0.0", depends: { minecraft: "26.2.x", fabricloader: ">=0.19.5", java: ">=21" } })],
      BUILTINS
    );
    expect(report.issues).toEqual([]);

    const tooNew = analyzeModSet("client", [inlineJar("needs.jar", { id: "needs", version: "1.0.0", depends: { java: ">=26" } })], BUILTINS);
    expect(tooNew.issues.map((i) => i.kind)).toEqual(["unsatisfied-dependency"]);
  });

  test("fabric.mod.json is read the way Fabric Loader's JSON reader accepts it", () => {
    const text = `{"schemaVersion": 1, "id": "lenient", "version": "1.0.0", "description": "line one\nline two\twith a \\' quote"}`;
    const node = readModJar(jarBytes(text), "mods/lenient.jar");
    expect(node.error).toBeUndefined();
    expect(node.mod?.id).toBe("lenient");
  });

  test("metadata Fabric Loader's parser rejects is reported", () => {
    const report = analyzeModSet(
      "client",
      [
        readModJar(jarBytes("{ not json"), "mods/broken.jar"),
        inlineJar("bad-predicate.jar", { id: "bad", version: "1.0.0", depends: { other: ">=1.x" } }),
        inlineJar("bad-id.jar", { id: "MyMod", version: "1.0.0" }),
        inlineJar("bad-provides.jar", { id: "fine", version: "1.0.0", provides: ["x"] }),
        inlineJar("schema-2.jar", { schemaVersion: 2, id: "future", version: "1.0.0" }),
      ],
      BUILTINS
    );
    expect(report.issues.map((i) => i.kind)).toEqual(Array(5).fill("invalid-metadata"));
  });

  test("listed nested jars that are missing are skipped, as Fabric Loader skips them", () => {
    const report = analyzeModSet(
      "client",
      [inlineJar("outer.jar", { id: "outer", version: "1.0.0", jars: [{ file: "META-INF/jars/gone.jar" }] })],
      BUILTINS
    );
    expect(report.issues).toEqual([]);
    expect(report.modCount).toBe(1);
  });

  test("jars without fabric.mod.json are skipped", () => {
    const node = readModJar(fflate.zipSync({ "META-INF/MANIFEST.MF": fflate.strToU8("Manifest-Version: 1.0\n") }), "mods/plain.jar");
    expect(node.mod).toBeUndefined();
    expect(analyzeModSet("client", [node], BUILTINS)).toEqual({ side: "client", modCount: 0, jarCount: 1, issues: [] });
  });
});

describe("validate reads fabric.mod.json from lockfile artifacts", () => {
  function setupPack(jars: Array<{ id: string; fixture: string; side: "client" | "server" | "both" }>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-mod-metadata-test-"));
    const packDir = path.join(dir, "pack");
    fs.mkdirSync(path.join(packDir, "mods"), { recursive: true });
    fs.mkdirSync(path.join(packDir, "custom"), { recursive: true });
    fs.writeFileSync(
      path.join(packDir, "pack.toml"),
      `[pack]\nname = "Metadata Test"\nversion = "2.0.0"\nminecraft = "26.2"\n\n[loader]\ntype = "fabric"\nversion = "0.19.5"\n`,
      "utf-8"
    );

    const artifacts: Record<string, unknown> = {};
    for (const entry of jars) {
      const filename = `${entry.fixture}.jar`;
      const bytes = jarBytes(fixture(entry.fixture));
      fs.writeFileSync(path.join(packDir, "custom", filename), bytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      artifacts[entry.id] = {
        id: entry.id,
        name: entry.id,
        side: entry.side,
        filename,
        size: bytes.length,
        sha256,
        downloadUrl: `/api/v1/blobs/${sha256}`,
        artifactType: "mod",
        targetDir: "mods",
        provider: { type: "lampas", file: `custom/${filename}` },
      };
    }

    const lockFile = path.join(packDir, "pack.lock.json");
    fs.writeFileSync(lockFile, JSON.stringify({
      schema: 1,
      packName: "Metadata Test",
      packVersion: "2.0.0",
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.19.5" },
      updated: "2026-10-14T00:00:00.000Z",
      artifacts,
    }, null, 2), "utf-8");

    return { packDir, lockFile, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  async function capture(packDir: string, lockFile: string) {
    const messages: string[] = [];
    const originalError = console.error;
    const originalLog = console.log;
    console.error = (...args: unknown[]) => messages.push(args.map(String).join(" "));
    console.log = (...args: unknown[]) => messages.push(args.map(String).join(" "));
    try {
      return { passed: await validatePack({ packDir, lockFile, checkFabricMeta: false }), messages };
    } finally {
      console.error = originalError;
      console.log = originalLog;
    }
  }

  test("fails when a breaks rule matches a present mod", async () => {
    const pack = setupPack([
      { id: "fabric-api", fixture: "fabric-api", side: "both" },
      { id: "walksylib", fixture: "walksylib-2.0.2", side: "client" },
      { id: "crossbow-bow-optimizer", fixture: "crossbow-bow-optimizer-1.0.5.1", side: "client" },
    ]);
    try {
      const { passed, messages } = await capture(pack.packDir, pack.lockFile);
      expect(passed).toBe(false);
      expect(messages.some((m) => m.includes("[Breaking Mod] client: walksylib 2.0.2+26.2"))).toBe(true);
      expect(messages.some((m) => m.includes("[Mod Metadata] server: 1 mods from 1 jars (nested included), 0 issues"))).toBe(true);
    } finally {
      pack.cleanup();
    }
  });

  test("passes with the compatible Crossbow Optimizer", async () => {
    const pack = setupPack([
      { id: "fabric-api", fixture: "fabric-api", side: "both" },
      { id: "walksylib", fixture: "walksylib-2.0.2", side: "client" },
      { id: "crossbow-optimizer", fixture: "crossbowoptimizer-1.1.0", side: "client" },
    ]);
    try {
      const { passed, messages } = await capture(pack.packDir, pack.lockFile);
      expect(passed).toBe(true);
      expect(messages.some((m) => m.includes("[Mod Metadata] client: 3 mods from 3 jars (nested included), 0 issues"))).toBe(true);
    } finally {
      pack.cleanup();
    }
  });

  test("fails when a lampas jar no longer matches the lockfile", async () => {
    const pack = setupPack([{ id: "fabric-api", fixture: "fabric-api", side: "both" }]);
    try {
      fs.appendFileSync(path.join(pack.packDir, "custom", "fabric-api.jar"), "tampered");
      const { passed, messages } = await capture(pack.packDir, pack.lockFile);
      expect(passed).toBe(false);
      expect(messages.some((m) => m.includes("[Mod Jar Unavailable] 'fabric-api'"))).toBe(true);
    } finally {
      pack.cleanup();
    }
  });
});
