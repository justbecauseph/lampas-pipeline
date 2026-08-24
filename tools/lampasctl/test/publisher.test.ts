import { describe, expect, test, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { publishRelease, resolvePublishChannels } from "../src/publisher";

function setupPublishFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-publish-test-"));
  const packDir = path.join(dir, "pack");
  const manifestDir = path.join(dir, "manifest");
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.mkdirSync(path.join(packDir, "custom"), { recursive: true });

  const releaseJson = {
    schemaVersion: 1,
    pack: "Lampas Modpack",
    version: "1.0.0",
    minecraft: "1.21.1",
    loader: { type: "fabric", version: "0.16.9" },
    minimumLauncherVersion: "1.0.0",
    protocol: 1,
    gitCommit: "abc1234",
    created: new Date().toISOString(),
    clientManifest: "client-manifest.json",
    serverManifest: "server-manifest.json",
    launch: { autoConnect: true, server: "play.lampas.town:25565" },
  };

  const clientManifest = {
    schemaVersion: 1,
    pack: "Lampas Modpack",
    version: "1.0.0",
    target: "client",
    minecraft: "1.21.1",
    loader: { type: "fabric", version: "0.16.9" },
    protocol: 1,
    files: [
      {
        path: "mods/custom-mod.jar",
        size: 11,
        hashes: { sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
        download: { url: "http://localhost:3000/api/v1/blobs/e3b0c4", provider: "lampas" },
        policy: "MANAGED",
      },
    ],
  };

  const serverManifest = {
    schemaVersion: 1,
    pack: "Lampas Modpack",
    version: "1.0.0",
    target: "server",
    minecraft: "1.21.1",
    loader: { type: "fabric", version: "0.16.9" },
    protocol: 1,
    files: [],
  };

  fs.writeFileSync(path.join(manifestDir, "release.json"), JSON.stringify(releaseJson, null, 2), "utf-8");
  fs.writeFileSync(path.join(manifestDir, "client-manifest.json"), JSON.stringify(clientManifest, null, 2), "utf-8");
  fs.writeFileSync(path.join(manifestDir, "server-manifest.json"), JSON.stringify(serverManifest, null, 2), "utf-8");

  // Create sample custom jar
  fs.writeFileSync(path.join(packDir, "custom", "custom-mod.jar"), "dummy jar bytes", "utf-8");

  return { dir, packDir, manifestDir };
}

describe("resolvePublishChannels", () => {
  test("defaults to all envs (dev, beta, stable) when channel is undefined or empty", () => {
    expect(resolvePublishChannels(undefined)).toEqual(["dev", "beta", "stable"]);
    expect(resolvePublishChannels("")).toEqual(["dev", "beta", "stable"]);
  });

  test("defaults to all envs when channel is 'all' or 'true'", () => {
    expect(resolvePublishChannels("all")).toEqual(["dev", "beta", "stable"]);
    expect(resolvePublishChannels("true")).toEqual(["dev", "beta", "stable"]);
  });

  test("resolves a specific single channel", () => {
    expect(resolvePublishChannels("dev")).toEqual(["dev"]);
    expect(resolvePublishChannels("beta")).toEqual(["beta"]);
    expect(resolvePublishChannels("stable")).toEqual(["stable"]);
  });

  test("resolves comma-separated channels", () => {
    expect(resolvePublishChannels("dev,beta")).toEqual(["dev", "beta"]);
    expect(resolvePublishChannels("beta, stable")).toEqual(["beta", "stable"]);
  });

  test("resolves array of channels", () => {
    expect(resolvePublishChannels(["dev", "stable"])).toEqual(["dev", "stable"]);
  });

  test("throws on invalid channel name", () => {
    expect(() => resolvePublishChannels("invalid")).toThrow("Invalid channel 'invalid'");
    expect(() => resolvePublishChannels("dev,production")).toThrow("Invalid channel 'production'");
  });
});

describe("publishRelease", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("publishes to all envs (dev, beta, stable) when channel is omitted", async () => {
    const fixture = setupPublishFixture();
    const calls: Array<{ url: string; headers: any; body: any }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      calls.push({
        url: String(input),
        headers: init?.headers,
        body,
      });

      return new Response(JSON.stringify({ success: true, channelUpdated: body.channel }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    try {
      await publishRelease({
        manifestDir: fixture.manifestDir,
        packDir: fixture.packDir,
        portalUrl: "http://localhost:3000",
        publishSecret: "secret-token-123",
      });

      expect(calls.length).toBe(3);
      expect(calls[0].url).toBe("http://localhost:3000/api/v1/releases/publish");
      expect(calls[0].body.channel).toBe("dev");
      expect(calls[0].body.version).toBe("1.0.0");
      expect(calls[0].body.blobs.length).toBe(1);
      expect(calls[0].headers.Authorization).toBe("Bearer secret-token-123");

      expect(calls[1].url).toBe("http://localhost:3000/api/v1/releases/publish");
      expect(calls[1].body.channel).toBe("beta");

      expect(calls[2].url).toBe("http://localhost:3000/api/v1/releases/publish");
      expect(calls[2].body.channel).toBe("stable");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("publishes only to specified channel when channel parameter is provided", async () => {
    const fixture = setupPublishFixture();
    const calls: Array<{ url: string; body: any }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      calls.push({
        url: String(input),
        body,
      });

      return new Response(JSON.stringify({ success: true, channelUpdated: body.channel }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    try {
      await publishRelease({
        manifestDir: fixture.manifestDir,
        packDir: fixture.packDir,
        portalUrl: "https://dev.portal.town",
        publishSecret: "dev-secret",
        channel: "dev",
      });

      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe("https://dev.portal.town/api/v1/releases/publish");
      expect(calls[0].body.channel).toBe("dev");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("throws error if portalUrl is missing", async () => {
    const fixture = setupPublishFixture();
    try {
      await expect(
        publishRelease({
          manifestDir: fixture.manifestDir,
          packDir: fixture.packDir,
          portalUrl: "",
          publishSecret: "secret",
        })
      ).rejects.toThrow("Portal URL is required");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("throws error if manifest directory does not contain manifests", async () => {
    const fixture = setupPublishFixture();
    fs.unlinkSync(path.join(fixture.manifestDir, "release.json"));

    try {
      await expect(
        publishRelease({
          manifestDir: fixture.manifestDir,
          packDir: fixture.packDir,
          portalUrl: "http://localhost:3000",
          publishSecret: "secret",
        })
      ).rejects.toThrow("Manifests missing");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("throws error if portal publish endpoint responds with error status", async () => {
    const fixture = setupPublishFixture();

    globalThis.fetch = (async () => {
      return new Response("Unauthorized", { status: 401, statusText: "Unauthorized" });
    }) as any;

    try {
      await expect(
        publishRelease({
          manifestDir: fixture.manifestDir,
          packDir: fixture.packDir,
          portalUrl: "http://localhost:3000",
          publishSecret: "invalid-token",
          channel: "dev",
        })
      ).rejects.toThrow("Failed to publish release to channel 'dev' (401 Unauthorized): Unauthorized");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});
