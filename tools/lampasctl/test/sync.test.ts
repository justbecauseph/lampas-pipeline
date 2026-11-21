import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { escapePropertiesValue, syncInstance, validateManifestForSync } from "../src/sync";

describe("escapePropertiesValue", () => {
  // Expected strings decode back to the input under java.util.Properties.load rules: "\ " keeps a
  // leading space, = : # ! need no escape after the key, \uXXXX is one UTF-16 unit.
  test("escapes a leading space, separators stay literal, astral chars become surrogate escapes", () => {
    expect(escapePropertiesValue(" a")).toBe("\\ a");
    expect(escapePropertiesValue("a b")).toBe("a b");
    expect(escapePropertiesValue("=:#!")).toBe("=:#!");
    expect(escapePropertiesValue("\u{1F600}")).toBe("\\uD83D\\uDE00");
    expect(escapePropertiesValue("tab\there")).toBe("tab\\there");
  });
});

describe("server resource-pack manifest validation", () => {
  const manifestWithSize = (size: unknown) => ({
    schemaVersion: 1,
    pack: "Lampas 2",
    version: "2.0.0",
    target: "server",
    minecraft: "26.2",
    loader: { type: "fabric", version: "0.19.3" },
    protocol: 2,
    resourcePack: {
      artifact: "lampas2",
      required: true,
      filename: "lampas2.zip",
      path: "resourcepacks/lampas2.zip",
      size,
      url: "https://example.test/lampas2.zip",
      sha1: "1".repeat(40),
      sha256: "a".repeat(64),
    },
    files: [],
  });

  test("requires a non-negative integer resource-pack size", () => {
    for (const size of [undefined, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => validateManifestForSync(manifestWithSize(size) as any)).toThrow(
        "Invalid server resourcePack: 'size' must be a non-negative integer",
      );
    }
    expect(() => validateManifestForSync(manifestWithSize(0) as any)).not.toThrow();
  });
});

describe("sync verification modes", () => {
  test("fast trusts matching metadata while full verification repairs content", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-sync-"));
    const target = path.join(dir, "instance");
    const managedPath = path.join(target, "config", "fixture.txt");
    const stateDir = path.join(target, ".lampas");
    fs.mkdirSync(path.dirname(managedPath), { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    const desired = "good";
    const corrupted = "evil";
    const sha256 = createHash("sha256").update(desired).digest("hex");
    fs.writeFileSync(managedPath, corrupted);
    const stat = fs.statSync(managedPath);

    const manifestPath = path.join(dir, "manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        pack: "Test",
        version: "1.0.0",
        target: "client",
        minecraft: "26.2",
        loader: { type: "fabric", version: "0.19.3" },
        protocol: 1,
        files: [
          {
            path: "config/fixture.txt",
            size: desired.length,
            hashes: { sha256 },
            download: {
              url: `data:text/plain;base64,${Buffer.from(desired).toString("base64")}`,
              provider: "direct",
            },
            policy: "MANAGED",
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(stateDir, "installation.json"),
      JSON.stringify({
        pack: "Test",
        version: "1.0.0",
        installedAt: new Date().toISOString(),
        files: {
          "config/fixture.txt": {
            sha256,
            size: desired.length,
            policy: "MANAGED",
            mtimeMs: stat.mtimeMs,
          },
        },
      }),
    );

    try {
      await syncInstance({ manifestPath, targetDir: target, verificationMode: "fast" });
      expect(fs.readFileSync(managedPath, "utf-8")).toBe(corrupted);
      await syncInstance({ manifestPath, targetDir: target, verificationMode: "full" });
      expect(fs.readFileSync(managedPath, "utf-8")).toBe(desired);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("server sync updates server.properties with resource pack metadata", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-server-sync-"));
    const target = path.join(dir, "server");
    fs.mkdirSync(target, { recursive: true });

    const initialProps = [
      "# Minecraft server properties",
      "server-port=25565",
      "motd=Lampas SMP",
      "resource-pack=",
      "difficulty=hard",
    ].join("\n");
    fs.writeFileSync(path.join(target, "server.properties"), initialProps, "utf-8");

    const manifestPath = path.join(dir, "server-manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        pack: "Lampas 2",
        version: "2.0.0",
        target: "server",
        minecraft: "26.2",
        loader: { type: "fabric", version: "0.19.3" },
        protocol: 2,
        resourcePack: {
          artifact: "lampas",
          required: true,
          filename: "Lampas-Resources-2.0.0.zip",
          path: "resourcepacks/Lampas-Resources-2.0.0.zip",
          size: 1,
          url: "https://cdn.lampas.gg/resources/Lampas-Resources-2.0.0.zip",
          sha1: "abc1234567890123456789012345678901234567",
          sha256: "a".repeat(64),
          prompt: "Lampas requires its resource pack.",
        },
        files: [],
      }),
    );

    try {
      await syncInstance({ manifestPath, targetDir: target });
      const propsContent = fs.readFileSync(path.join(target, "server.properties"), "utf-8");
      expect(propsContent).toContain("server-port=25565");
      expect(propsContent).toContain("motd=Lampas SMP");
      expect(propsContent).toContain("difficulty=hard");
      expect(propsContent).toContain(
        "resource-pack=https://cdn.lampas.gg/resources/Lampas-Resources-2.0.0.zip",
      );
      expect(propsContent).toContain("resource-pack-sha1=abc1234567890123456789012345678901234567");
      expect(propsContent).toContain("require-resource-pack=true");
      expect(propsContent).toContain(
        'resource-pack-prompt={"text":"Lampas requires its resource pack."}',
      );

      // Test sync where prompt is removed
      const manifestNoPrompt = path.join(dir, "server-manifest-noprompt.json");
      fs.writeFileSync(
        manifestNoPrompt,
        JSON.stringify({
          schemaVersion: 1,
          pack: "Lampas 2",
          version: "2.0.1",
          target: "server",
          minecraft: "26.2",
          loader: { type: "fabric", version: "0.19.3" },
          protocol: 2,
          resourcePack: {
            artifact: "lampas",
            required: true,
            filename: "Lampas-Resources-2.0.0.zip",
            path: "resourcepacks/Lampas-Resources-2.0.0.zip",
            size: 1,
            url: "https://cdn.lampas.gg/resources/Lampas-Resources-2.0.0.zip",
            sha1: "abc1234567890123456789012345678901234567",
            sha256: "a".repeat(64),
            // prompt omitted
          },
          files: [],
        }),
      );

      await syncInstance({ manifestPath: manifestNoPrompt, targetDir: target });
      const noPromptProps = fs.readFileSync(path.join(target, "server.properties"), "utf-8");
      expect(noPromptProps).toContain("resource-pack-prompt=");
      expect(noPromptProps).not.toContain(
        'resource-pack-prompt={"text":"Lampas requires its resource pack."}',
      );

      // Test subsequent sync where resource pack is removed
      const manifestWithoutPack = path.join(dir, "server-manifest-nopack.json");
      fs.writeFileSync(
        manifestWithoutPack,
        JSON.stringify({
          schemaVersion: 1,
          pack: "Lampas 2",
          version: "2.1.0",
          target: "server",
          minecraft: "26.2",
          loader: { type: "fabric", version: "0.19.3" },
          protocol: 2,
          files: [],
        }),
      );

      await syncInstance({ manifestPath: manifestWithoutPack, targetDir: target });
      const resetPropsContent = fs.readFileSync(path.join(target, "server.properties"), "utf-8");
      expect(resetPropsContent).toContain("server-port=25565");
      expect(resetPropsContent).toContain("resource-pack=");
      expect(resetPropsContent).toContain("resource-pack-sha1=");
      expect(resetPropsContent).toContain("resource-pack-id=");
      expect(resetPropsContent).toContain("resource-pack-prompt=");
      expect(resetPropsContent).toContain("require-resource-pack=false");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects path traversal in syncInstance", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-traversal-sync-"));
    const target = path.join(dir, "instance");
    fs.mkdirSync(target, { recursive: true });

    const manifestPath = path.join(dir, "evil-manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        pack: "Evil",
        version: "1.0.0",
        target: "server",
        minecraft: "26.2",
        loader: { type: "fabric", version: "0.19.3" },
        protocol: 1,
        files: [
          {
            path: "../../escaped.txt",
            size: 5,
            hashes: { sha256: "a".repeat(64) },
            download: { url: "http://example.com/evil", provider: "direct" },
            policy: "MANAGED",
          },
        ],
      }),
    );

    try {
      await expect(syncInstance({ manifestPath, targetDir: target })).rejects.toThrow(
        /Unsafe relative path in manifest/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("server motd", () => {
  test("validateManifestForSync rejects motd on a client manifest and invalid values", () => {
    const base = {
      schemaVersion: 2,
      pack: "Lampas 2",
      version: "2.0.0",
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.19.3" },
      protocol: 3,
      files: [],
    };
    expect(() =>
      validateManifestForSync({ ...base, target: "server", motd: "Line one\nLine two" }),
    ).not.toThrow();
    expect(() => validateManifestForSync({ ...base, target: "client", motd: "Hi" })).toThrow(
      "only valid on a server manifest",
    );
    expect(() => validateManifestForSync({ ...base, target: "server", motd: "a\nb\nc" })).toThrow(
      "at most two lines",
    );
  });

  test("sync writes the motd as an escaped Java property in one backed-up write", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-server-motd-"));
    const target = path.join(dir, "server");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, "server.properties"),
      ["server-port=25576", "motd=Old MOTD", "difficulty=hard", ""].join("\n"),
      "utf-8",
    );

    const writeManifest = (name: string, extra: Record<string, unknown>) => {
      const p = path.join(dir, name);
      fs.writeFileSync(
        p,
        JSON.stringify({
          schemaVersion: 2,
          pack: "Lampas 2",
          version: "2.0.0",
          target: "server",
          minecraft: "26.2",
          loader: { type: "fabric", version: "0.19.3" },
          protocol: 3,
          files: [],
          ...extra,
        }),
      );
      return p;
    };

    try {
      const withPack = writeManifest("with-pack.json", {
        motd: "\u00a76Lampas 2: ???\nLorem C:\\path",
        resourcePack: {
          artifact: "lampas",
          required: true,
          filename: "Lampas-Resources-2.0.0.zip",
          path: "resourcepacks/Lampas-Resources-2.0.0.zip",
          size: 1,
          url: "https://cdn.lampas.gg/resources/Lampas-Resources-2.0.0.zip",
          sha1: "abc1234567890123456789012345678901234567",
          sha256: "a".repeat(64),
        },
      });
      await syncInstance({ manifestPath: withPack, targetDir: target });

      const content = fs.readFileSync(path.join(target, "server.properties"), "utf-8");
      // Properties.load reads \u00A7 as the section sign, \n as a line break and \\ as \.
      expect(content).toBe(
        [
          "server-port=25576",
          "motd=\\u00A76Lampas 2: ???\\nLorem C:\\\\path",
          "difficulty=hard",
          "resource-pack=https://cdn.lampas.gg/resources/Lampas-Resources-2.0.0.zip",
          "resource-pack-sha1=abc1234567890123456789012345678901234567",
          "resource-pack-id=",
          "resource-pack-prompt=",
          "require-resource-pack=true",
          "",
        ].join("\n"),
      );

      // The single backup holds the file as it was before the sync.
      const backups = fs.readdirSync(path.join(target, ".lampas", "backups"));
      expect(backups.length).toBe(1);
      expect(
        fs.readFileSync(path.join(target, ".lampas", "backups", backups[0]!), "utf-8"),
      ).toContain("motd=Old MOTD");

      // Without motd in the manifest the last written value stays; the pack settings reset.
      const without = writeManifest("without.json", {});
      await syncInstance({ manifestPath: without, targetDir: target });
      const after = fs.readFileSync(path.join(target, "server.properties"), "utf-8");
      expect(after).toContain("motd=\\u00A76Lampas 2: ???\\nLorem C:\\\\path\n");
      expect(after).toContain("require-resource-pack=false\n");
      expect(after).not.toContain("\n\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
