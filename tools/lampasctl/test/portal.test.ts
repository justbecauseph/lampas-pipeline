import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildManifests } from "../src/manifest";
import { normalizePortalBaseUrl, readPackPortalBaseUrl, resolvePortalBaseUrl } from "../src/portal";
import { resolvePublishPortalUrl } from "../src/publisher";
import type { PackConfig } from "../src/types";

const BASE_PACK = { pack: { name: "Lampas Test", version: "2.0.0", minecraft: "26.2" }, loader: { type: "fabric", version: "0.19.3" } } as PackConfig;

function packTomlWithPortal(portalSection: string): string {
  return `
[pack]
name = "Lampas Test"
version = "2.0.0"
minecraft = "26.2"

[loader]
type = "fabric"
version = "0.19.3"
${portalSection}
`;
}

function setupPack(packToml: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-portal-test-"));
  const packDir = path.join(dir, "pack");
  const outDir = path.join(dir, "manifest");
  fs.mkdirSync(path.join(packDir, "mods"), { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, "pack.toml"), packToml, "utf-8");
  const lockFile = path.join(packDir, "pack.lock.json");
  fs.writeFileSync(
    lockFile,
    JSON.stringify({
      schema: 1,
      packName: "Lampas Test",
      packVersion: "2.0.0",
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.19.3" },
      updated: new Date().toISOString(),
      artifacts: {},
    }),
    "utf-8"
  );
  return { dir, packDir, outDir, lockFile };
}

describe("portal base URL resolution", () => {
  test("normalizes trailing slashes and rejects non-http URLs", () => {
    expect(normalizePortalBaseUrl("https://portal.lampas.town/", "test")).toBe("https://portal.lampas.town");
    expect(normalizePortalBaseUrl(" http://localhost:3000// ", "test")).toBe("http://localhost:3000");
    expect(() => normalizePortalBaseUrl("ftp://portal.lampas.town", "test")).toThrow("http or https");
    expect(() => normalizePortalBaseUrl("portal.lampas.town", "test")).toThrow("Invalid portal base URL");
    expect(() => normalizePortalBaseUrl("https://portal.lampas.town/?x=1", "test")).toThrow("query or fragment");
  });

  test("reads [portal] base_url from pack.toml", () => {
    expect(readPackPortalBaseUrl(BASE_PACK)).toBeUndefined();
    expect(readPackPortalBaseUrl({ ...BASE_PACK, portal: { base_url: "https://dev.lampas.town/" } })).toBe("https://dev.lampas.town");
    expect(() => readPackPortalBaseUrl({ ...BASE_PACK, portal: { base_url: "  " } })).toThrow("non-empty string");
  });

  test("prefers override, then pack.toml, then fallback", () => {
    const withPortal = { ...BASE_PACK, portal: { base_url: "https://dev.lampas.town" } };
    expect(resolvePortalBaseUrl(withPortal, "http://localhost:3000", "https://portal.lampas.town")).toBe("http://localhost:3000");
    expect(resolvePortalBaseUrl(withPortal, undefined, "https://portal.lampas.town")).toBe("https://dev.lampas.town");
    expect(resolvePortalBaseUrl(BASE_PACK, undefined, "https://portal.lampas.town")).toBe("https://portal.lampas.town");
    expect(resolvePortalBaseUrl(BASE_PACK)).toBeUndefined();
  });
});

describe("manifest generation with [portal] base_url", () => {
  test("uses pack.toml portal base URL when no override is given", async () => {
    const fixture = setupPack(packTomlWithPortal(`[portal]\nbase_url = "https://dev.lampas.town/"`));
    try {
      const { release } = await buildManifests({ packDir: fixture.packDir, lockFile: fixture.lockFile, outDir: fixture.outDir });
      expect(release.clientManifest).toBe("https://dev.lampas.town/api/v1/releases/2.0.0/client-manifest");
      expect(release.serverManifest).toBe("https://dev.lampas.town/api/v1/releases/2.0.0/server-manifest");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("explicit portalBaseUrl overrides pack.toml", async () => {
    const fixture = setupPack(packTomlWithPortal(`[portal]\nbase_url = "https://dev.lampas.town"`));
    try {
      const { release } = await buildManifests({
        packDir: fixture.packDir,
        lockFile: fixture.lockFile,
        outDir: fixture.outDir,
        portalBaseUrl: "http://localhost:3000",
      });
      expect(release.clientManifest).toBe("http://localhost:3000/api/v1/releases/2.0.0/client-manifest");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("falls back to the default when pack.toml has no portal section", async () => {
    const fixture = setupPack(packTomlWithPortal(""));
    try {
      const { release } = await buildManifests({
        packDir: fixture.packDir,
        lockFile: fixture.lockFile,
        outDir: fixture.outDir,
        defaultPortalBaseUrl: "https://portal.lampas.town",
      });
      expect(release.clientManifest).toBe("https://portal.lampas.town/api/v1/releases/2.0.0/client-manifest");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("rejects an invalid pack.toml portal base URL", async () => {
    const fixture = setupPack(packTomlWithPortal(`[portal]\nbase_url = "dev.lampas.town"`));
    try {
      await expect(
        buildManifests({ packDir: fixture.packDir, lockFile: fixture.lockFile, outDir: fixture.outDir })
      ).rejects.toThrow("pack.toml [portal] base_url");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

describe("publish portal URL resolution", () => {
  test("uses --portal / PACK_PORTAL_URL before pack.toml", () => {
    const fixture = setupPack(packTomlWithPortal(`[portal]\nbase_url = "https://dev.lampas.town"`));
    try {
      expect(resolvePublishPortalUrl({ packDir: fixture.packDir, portalUrl: "http://localhost:3000/" })).toBe("http://localhost:3000");
      expect(resolvePublishPortalUrl({ packDir: fixture.packDir, portalUrl: "" })).toBe("https://dev.lampas.town");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("requires a portal URL when neither flag nor pack.toml provides one", () => {
    const fixture = setupPack(packTomlWithPortal(""));
    try {
      expect(() => resolvePublishPortalUrl({ packDir: fixture.packDir })).toThrow("[portal] base_url in pack.toml");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});
