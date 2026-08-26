import { describe, expect, test, afterEach } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { publishRelease, resolvePublishChannels } from "../src/publisher";
import {
  discoverLocalLampasBlobs,
  uploadSingleBlob,
  type LocalPublishBlob,
} from "../src/blob-publisher";

function setupPublishFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-publish-test-"));
  const packDir = path.join(dir, "pack");
  const manifestDir = path.join(dir, "manifest");
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.mkdirSync(path.join(packDir, "custom"), { recursive: true });
  fs.mkdirSync(path.join(packDir, "common", "config"), { recursive: true });

  const customModContent = "dummy jar bytes";
  const customModSha = crypto.createHash("sha256").update(customModContent).digest("hex");
  const customModSize = Buffer.byteLength(customModContent);
  fs.writeFileSync(path.join(packDir, "custom", "custom-mod.jar"), customModContent, "utf-8");

  const configContent = "{\"setting\": true}";
  const configSha = crypto.createHash("sha256").update(configContent).digest("hex");
  const configSize = Buffer.byteLength(configContent);
  fs.writeFileSync(path.join(packDir, "common", "config", "lampas.json"), configContent, "utf-8");

  const releaseJson = {
    schemaVersion: 1,
    pack: "Lampas Modpack",
    version: "2.1.0",
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
    version: "2.1.0",
    target: "client",
    minecraft: "1.21.1",
    loader: { type: "fabric", version: "0.16.9" },
    protocol: 1,
    files: [
      {
        path: "mods/custom-mod.jar",
        size: customModSize,
        hashes: { sha256: customModSha },
        download: { url: `http://localhost:3000/api/v1/blobs/${customModSha}`, provider: "lampas" },
        policy: "MANAGED",
      },
      {
        path: "config/lampas.json",
        size: configSize,
        hashes: { sha256: configSha },
        download: { url: `http://localhost:3000/api/v1/blobs/${configSha}`, provider: "lampas" },
        policy: "MANAGED",
      },
    ],
  };

  const serverManifest = {
    schemaVersion: 1,
    pack: "Lampas Modpack",
    version: "2.1.0",
    target: "server",
    minecraft: "1.21.1",
    loader: { type: "fabric", version: "0.16.9" },
    protocol: 1,
    files: [
      {
        // Duplicate SHA across manifests to verify deduplication
        path: "config/lampas.json",
        size: configSize,
        hashes: { sha256: configSha },
        download: { url: `http://localhost:3000/api/v1/blobs/${configSha}`, provider: "lampas" },
        policy: "MANAGED",
      },
      {
        path: "mods/modrinth-mod.jar",
        size: 5000,
        hashes: { sha256: "f".repeat(64) },
        download: { url: "https://cdn.modrinth.com/...", provider: "modrinth" },
        policy: "MANAGED",
      },
    ],
  };

  fs.writeFileSync(path.join(manifestDir, "release.json"), JSON.stringify(releaseJson, null, 2), "utf-8");
  fs.writeFileSync(path.join(manifestDir, "client-manifest.json"), JSON.stringify(clientManifest, null, 2), "utf-8");
  fs.writeFileSync(path.join(manifestDir, "server-manifest.json"), JSON.stringify(serverManifest, null, 2), "utf-8");

  return {
    dir,
    packDir,
    manifestDir,
    customModSha,
    customModSize,
    configSha,
    configSize,
    clientManifest,
    serverManifest,
  };
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

describe("discoverLocalLampasBlobs", () => {
  test("discovers local Lampas blobs and deduplicates across client and server manifests", async () => {
    const fixture = setupPublishFixture();
    try {
      const blobs = await discoverLocalLampasBlobs({
        clientManifest: fixture.clientManifest as any,
        serverManifest: fixture.serverManifest as any,
        packDir: fixture.packDir,
      });

      // Exactly 2 unique Lampas blobs (custom-mod.jar and lampas.json), excluding Modrinth mod
      expect(blobs.length).toBe(2);

      const modBlob = blobs.find((b) => b.sha256 === fixture.customModSha);
      expect(modBlob).toBeDefined();
      expect(modBlob?.size).toBe(fixture.customModSize);
      expect(modBlob?.mimeType).toBe("application/java-archive");
      expect(modBlob?.localPath).toBe(path.join(fixture.packDir, "custom", "custom-mod.jar"));

      const configBlob = blobs.find((b) => b.sha256 === fixture.configSha);
      expect(configBlob).toBeDefined();
      expect(configBlob?.size).toBe(fixture.configSize);
      expect(configBlob?.mimeType).toBe("application/json");
      expect(configBlob?.localPath).toBe(path.join(fixture.packDir, "common", "config", "lampas.json"));
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("throws a hard error if a Lampas blob is missing locally with candidate paths", async () => {
    const fixture = setupPublishFixture();
    fs.unlinkSync(path.join(fixture.packDir, "custom", "custom-mod.jar"));

    try {
      await expect(
        discoverLocalLampasBlobs({
          clientManifest: fixture.clientManifest as any,
          serverManifest: fixture.serverManifest as any,
          packDir: fixture.packDir,
        })
      ).rejects.toThrow("could not be found locally");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("throws a hard error if local file size differs from manifest", async () => {
    const fixture = setupPublishFixture();
    fs.writeFileSync(path.join(fixture.packDir, "custom", "custom-mod.jar"), "modified larger content bytes");

    try {
      await expect(
        discoverLocalLampasBlobs({
          clientManifest: fixture.clientManifest as any,
          serverManifest: fixture.serverManifest as any,
          packDir: fixture.packDir,
        })
      ).rejects.toThrow("size mismatch");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("throws a hard error if local file SHA-256 differs from manifest", async () => {
    const fixture = setupPublishFixture();
    // Overwrite with same byte length but different bytes
    fs.writeFileSync(path.join(fixture.packDir, "custom", "custom-mod.jar"), "dummy jar byteX");

    try {
      await expect(
        discoverLocalLampasBlobs({
          clientManifest: fixture.clientManifest as any,
          serverManifest: fixture.serverManifest as any,
          packDir: fixture.packDir,
        })
      ).rejects.toThrow("SHA-256 mismatch");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("discovers server-enforced Lampas blob when absent from client/server files", async () => {
    const fixture = setupPublishFixture();
    const srpContent = "dummy server resource pack zip bytes";
    const srpSha = crypto.createHash("sha256").update(srpContent).digest("hex");
    fs.writeFileSync(path.join(fixture.packDir, "custom", "lampas2-resource-pack.zip"), srpContent, "utf-8");

    const releaseWithSrp: any = {
      serverResourcePack: {
        artifact: "lampas2",
        filename: "lampas2-resource-pack.zip",
        path: "resourcepacks/lampas2-resource-pack.zip",
        size: srpContent.length,
        url: `https://portal.lampas.town/api/v1/blobs/${srpSha}`,
        sha256: srpSha,
        sha1: "1".repeat(40),
        id: "7af14f5a-e521-443a-9275-265decab3edc",
        required: true,
      },
    };

    try {
      const blobs = await discoverLocalLampasBlobs({
        clientManifest: fixture.clientManifest as any,
        serverManifest: fixture.serverManifest as any,
        packDir: fixture.packDir,
        release: releaseWithSrp,
      });

      const srpBlob = blobs.find((b) => b.sha256 === srpSha);
      expect(srpBlob).toBeDefined();
      expect(srpBlob?.manifestPath).toBe("resourcepacks/lampas2-resource-pack.zip");
      expect(srpBlob?.localPath).toBe(path.join(fixture.packDir, "custom", "lampas2-resource-pack.zip"));
      expect(srpBlob?.mimeType).toBe("application/zip");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("rejects a server-enforced Lampas blob when its declared size is stale", async () => {
    const fixture = setupPublishFixture();
    const srpContent = "dummy server resource pack zip bytes";
    const srpSha = crypto.createHash("sha256").update(srpContent).digest("hex");
    fs.writeFileSync(path.join(fixture.packDir, "custom", "lampas2-resource-pack.zip"), srpContent, "utf-8");

    const releaseWithSrp: any = {
      serverResourcePack: {
        artifact: "lampas2",
        filename: "lampas2-resource-pack.zip",
        path: "resourcepacks/lampas2-resource-pack.zip",
        size: srpContent.length + 1,
        url: `https://portal.lampas.town/api/v1/blobs/${srpSha}`,
        sha256: srpSha,
        sha1: "1".repeat(40),
        id: "7af14f5a-e521-443a-9275-265decab3edc",
        required: true,
      },
    };

    try {
      await expect(
        discoverLocalLampasBlobs({
          clientManifest: fixture.clientManifest as any,
          serverManifest: fixture.serverManifest as any,
          packDir: fixture.packDir,
          release: releaseWithSrp,
        })
      ).rejects.toThrow("size mismatch");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

describe("uploadSingleBlob", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("retries on transient 500/503 errors and succeeds if subsequent attempt returns 200", async () => {
    const fixture = setupPublishFixture();
    let callCount = 0;

    globalThis.fetch = (async () => {
      callCount++;
      if (callCount < 2) {
        return new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" });
      }
      return new Response("", { status: 200 });
    }) as any;

    try {
      const blob: LocalPublishBlob = {
        sha256: fixture.customModSha,
        size: fixture.customModSize,
        mimeType: "application/java-archive",
        localPath: path.join(fixture.packDir, "custom", "custom-mod.jar"),
        manifestPath: "mods/custom-mod.jar",
      };

      await uploadSingleBlob(blob, "https://storage.railway.app/test-upload");
      expect(callCount).toBe(2);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("fails immediately without retry on non-retryable 403 Forbidden", async () => {
    const fixture = setupPublishFixture();
    let callCount = 0;

    globalThis.fetch = (async () => {
      callCount++;
      return new Response("Forbidden: Signature expired", { status: 403, statusText: "Forbidden" });
    }) as any;

    try {
      const blob: LocalPublishBlob = {
        sha256: fixture.customModSha,
        size: fixture.customModSize,
        mimeType: "application/java-archive",
        localPath: path.join(fixture.packDir, "custom", "custom-mod.jar"),
        manifestPath: "mods/custom-mod.jar",
      };

      await expect(uploadSingleBlob(blob, "https://storage.railway.app/test-upload")).rejects.toThrow("status 403");
      expect(callCount).toBe(1);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

describe("publishRelease", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("full direct upload: prepares blobs, uploads only missing blobs directly, and posts single release payload without base64", async () => {
    const fixture = setupPublishFixture();
    const fetchCalls: Array<{ url: string; method: string; body?: any; headers?: any }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      let parsedBody: any = null;

      if (typeof init?.body === "string") {
        try {
          parsedBody = JSON.parse(init.body);
        } catch {
          parsedBody = init.body;
        }
      }

      fetchCalls.push({
        url,
        method,
        body: parsedBody,
        headers: init?.headers,
      });

      // 1. Prepare endpoint
      if (url.endsWith("/api/v1/blobs/prepare")) {
        return new Response(
          JSON.stringify({
            blobs: [
              {
                sha256: fixture.configSha,
                status: "exists",
                storageKey: `blobs/co/${fixture.configSha}`,
              },
              {
                sha256: fixture.customModSha,
                status: "upload",
                storageKey: `blobs/cu/${fixture.customModSha}`,
                uploadUrl: `https://storage.railway.app/blobs/cu/${fixture.customModSha}?signed=1`,
                expiresAt: new Date(Date.now() + 900000).toISOString(),
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // 2. Direct S3 PUT upload
      if (url.includes("storage.railway.app")) {
        return new Response("", { status: 200 });
      }

      // 3. Publish endpoint
      if (url.endsWith("/api/v1/releases/publish")) {
        return new Response(
          JSON.stringify({
            success: true,
            releaseId: "rel-123",
            version: "2.1.0",
            channelsUpdated: parsedBody?.channels || ["dev", "beta", "stable"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("Not found", { status: 404 });
    }) as any;

    try {
      await publishRelease({
        manifestDir: fixture.manifestDir,
        packDir: fixture.packDir,
        portalUrl: "http://localhost:3000",
        publishSecret: "secret-token-123",
      });

      // Check request sequence:
      // 1. Prepare
      // 2. Direct PUT for customMod ONLY (config was 'exists')
      // 3. Single publish POST for all channels
      expect(fetchCalls.length).toBe(3);

      // Prepare call
      expect(fetchCalls[0].url).toBe("http://localhost:3000/api/v1/blobs/prepare");
      expect(fetchCalls[0].method).toBe("POST");
      expect(fetchCalls[0].body.blobs.length).toBe(2);

      // S3 PUT call
      expect(fetchCalls[1].url).toContain(`blobs/cu/${fixture.customModSha}`);
      expect(fetchCalls[1].method).toBe("PUT");

      // Publish call
      expect(fetchCalls[2].url).toBe("http://localhost:3000/api/v1/releases/publish");
      expect(fetchCalls[2].method).toBe("POST");
      expect(fetchCalls[2].body.version).toBe("2.1.0");
      expect(fetchCalls[2].body.channels).toEqual(["dev", "beta", "stable"]);
      // Crucial: NO base64 blobs field in payload!
      expect(fetchCalls[2].body.blobs).toBeUndefined();
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("skips all PUT uploads when all blobs already exist remotely", async () => {
    const fixture = setupPublishFixture();
    const fetchCalls: Array<{ url: string; method: string }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      fetchCalls.push({ url, method });

      if (url.endsWith("/api/v1/blobs/prepare")) {
        return new Response(
          JSON.stringify({
            blobs: [
              { sha256: fixture.configSha, status: "exists", storageKey: `blobs/co/${fixture.configSha}` },
              { sha256: fixture.customModSha, status: "exists", storageKey: `blobs/cu/${fixture.customModSha}` },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.endsWith("/api/v1/releases/publish")) {
        return new Response(
          JSON.stringify({ success: true, version: "2.1.0", channelsUpdated: ["dev"] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("Not found", { status: 404 });
    }) as any;

    try {
      await publishRelease({
        manifestDir: fixture.manifestDir,
        packDir: fixture.packDir,
        portalUrl: "http://localhost:3000",
        publishSecret: "secret-token-123",
        channel: "dev",
      });

      // Exactly 2 calls: prepare and publish (0 PUT uploads!)
      expect(fetchCalls.length).toBe(2);
      expect(fetchCalls[0].url).toContain("/api/v1/blobs/prepare");
      expect(fetchCalls[1].url).toContain("/api/v1/releases/publish");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("aborts release publication if direct PUT upload fails", async () => {
    const fixture = setupPublishFixture();
    const fetchCalls: Array<{ url: string }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push({ url });

      if (url.endsWith("/api/v1/blobs/prepare")) {
        return new Response(
          JSON.stringify({
            blobs: [
              {
                sha256: fixture.customModSha,
                status: "upload",
                storageKey: `blobs/cu/${fixture.customModSha}`,
                uploadUrl: "https://storage.railway.app/upload-fail",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.includes("storage.railway.app")) {
        return new Response("Upload Error", { status: 500, statusText: "Internal Server Error" });
      }

      return new Response("OK", { status: 200 });
    }) as any;

    try {
      await expect(
        publishRelease({
          manifestDir: fixture.manifestDir,
          packDir: fixture.packDir,
          portalUrl: "http://localhost:3000",
          publishSecret: "secret-token",
        })
      ).rejects.toThrow("Direct PUT upload failed");

      // Verify that publish endpoint was NEVER called
      const publishCall = fetchCalls.find((c) => c.url.endsWith("/api/v1/releases/publish"));
      expect(publishCall).toBeUndefined();
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("aborts if portal prepare endpoint responds with 401", async () => {
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
      ).rejects.toThrow("Blob preparation failed (401 Unauthorized)");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("throws error if portal publish endpoint responds with 500", async () => {
    const fixture = setupPublishFixture();

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/blobs/prepare")) {
        return new Response(
          JSON.stringify({
            blobs: [
              { sha256: fixture.configSha, status: "exists", storageKey: `blobs/co/${fixture.configSha}` },
              { sha256: fixture.customModSha, status: "exists", storageKey: `blobs/cu/${fixture.customModSha}` },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Database error", { status: 500, statusText: "Internal Server Error" });
    }) as any;

    try {
      await expect(
        publishRelease({
          manifestDir: fixture.manifestDir,
          packDir: fixture.packDir,
          portalUrl: "http://localhost:3000",
          publishSecret: "secret",
          channel: "dev",
        })
      ).rejects.toThrow("Failed to publish release (500 Internal Server Error)");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

describe("Architecture Guard: Publisher & Blob Publisher", () => {
  test("publisher and blob-publisher modules must not contain base64 packaging logic", () => {
    const publisherCode = fs.readFileSync(path.resolve(__dirname, "../src/publisher.ts"), "utf-8");
    const blobPublisherCode = fs.readFileSync(path.resolve(__dirname, "../src/blob-publisher.ts"), "utf-8");

    const forbiddenPatterns = [/contentBase64/, /\.toString\(["']base64["']\)/];

    for (const pattern of forbiddenPatterns) {
      expect(publisherCode).not.toMatch(pattern);
      expect(blobPublisherCode).not.toMatch(pattern);
    }
  });
});
