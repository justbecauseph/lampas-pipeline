import { afterEach, describe, expect, test } from "bun:test";
import {
  fetchManifest,
  fetchReleaseDescriptor,
  resolveChannelVersion,
  resolveRelease,
} from "../src/release-resolver";

/**
 * Portal stub that answers every request with 200 headers and the start of a JSON body, then never
 * finishes the body. Used to check that the request timeout covers reading the body.
 */
function startStalledBodyServer(): { baseUrl: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch() {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"schemaVersion":2,"files":['));
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

describe("release-resolver", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("resolveChannelVersion fetches version from channel endpoint", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr === "https://portal.lampas.town/api/v1/channels/dev") {
        return new Response(JSON.stringify({ channel: "dev", version: "2.1.0-beta.1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    }) as any;

    const version = await resolveChannelVersion("https://portal.lampas.town", "dev");
    expect(version).toBe("2.1.0-beta.1");
  });

  test("resolveChannelVersion throws descriptive error on 404", async () => {
    globalThis.fetch = (async () => {
      return new Response("Channel not found", { status: 404, statusText: "Not Found" });
    }) as any;

    await expect(
      resolveChannelVersion("https://portal.lampas.town", "nonexistent")
    ).rejects.toThrow("Failed to resolve release channel 'nonexistent'");
  });

  test("fetchReleaseDescriptor returns parsed release object", async () => {
    const mockRelease = {
      schemaVersion: 1,
      pack: "Lampas 2",
      version: "2.0.0",
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.19.3" },
      minimumLauncherVersion: "1.0.0",
      protocol: 2,
      created: "2026-08-26T00:00:00Z",
      clientManifest: "https://portal.lampas.town/api/v1/releases/2.0.0/client-manifest",
      serverManifest: "https://portal.lampas.town/api/v1/releases/2.0.0/server-manifest",
    };

    globalThis.fetch = (async (url: string | URL | Request) => {
      if (url.toString() === "https://portal.lampas.town/api/v1/releases/2.0.0") {
        return new Response(JSON.stringify(mockRelease), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    }) as any;

    const release = await fetchReleaseDescriptor("https://portal.lampas.town", "2.0.0");
    expect(release.version).toBe("2.0.0");
    expect(release.pack).toBe("Lampas 2");
  });

  test("resolveRelease resolves channel, release descriptor, and server manifest", async () => {
    const mockRelease = {
      schemaVersion: 1,
      pack: "Lampas 2",
      version: "2.0.0",
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.19.3" },
      minimumLauncherVersion: "1.0.0",
      protocol: 2,
      created: "2026-08-26T00:00:00Z",
      clientManifest: "https://portal.lampas.town/api/v1/releases/2.0.0/client-manifest",
      serverManifest: "https://portal.lampas.town/api/v1/releases/2.0.0/server-manifest",
    };

    const mockManifest = {
      schemaVersion: 1,
      pack: "Lampas 2",
      version: "2.0.0",
      target: "server",
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.19.3" },
      protocol: 2,
      files: [],
    };

    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr === "https://portal.lampas.town/api/v1/channels/stable") {
        return new Response(JSON.stringify({ channel: "stable", version: "2.0.0" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr === "https://portal.lampas.town/api/v1/releases/2.0.0") {
        return new Response(JSON.stringify(mockRelease), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr === "https://portal.lampas.town/api/v1/releases/2.0.0/server-manifest") {
        return new Response(JSON.stringify(mockManifest), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    }) as any;

    const result = await resolveRelease({
      portalUrl: "https://portal.lampas.town",
      channel: "stable",
      target: "server",
    });

    expect(result.version).toBe("2.0.0");
    expect(result.channel).toBe("stable");
    expect(result.manifest.target).toBe("server");
    expect(result.release.version).toBe("2.0.0");
  });

  test("fetchManifest rejects when the body stalls after the headers", async () => {
    const stub = startStalledBodyServer();
    try {
      await expect(fetchManifest(stub.baseUrl, "2.3.33", "client", { timeoutMs: 200 })).rejects.toThrow(
        "Timed out after 200ms while fetching client manifest for v2.3.33"
      );
    } finally {
      stub.stop();
    }
  });

  test("resolveChannelVersion and fetchReleaseDescriptor reject when the body stalls", async () => {
    const stub = startStalledBodyServer();
    try {
      await expect(resolveChannelVersion(stub.baseUrl, "dev", { timeoutMs: 200 })).rejects.toThrow(
        "Timed out after 200ms while resolving channel 'dev'"
      );
      await expect(fetchReleaseDescriptor(stub.baseUrl, "2.3.33", { timeoutMs: 200 })).rejects.toThrow(
        "Timed out after 200ms while fetching release descriptor for v2.3.33"
      );
    } finally {
      stub.stop();
    }
  });

  test("fetchManifest names the response in its error when the body is not JSON", async () => {
    globalThis.fetch = (async () => {
      return new Response("<!doctype html><html></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }) as any;

    await expect(fetchManifest("https://portal.lampas.town", "2.3.33", "server")).rejects.toThrow(
      "Invalid response for server manifest for version '2.3.33' from https://portal.lampas.town/api/v1/releases/2.3.33/server-manifest: body is not valid JSON"
    );
  });

  test("fetchManifest keeps the HTTP status in its error for non-ok responses", async () => {
    globalThis.fetch = (async () => {
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    }) as any;

    await expect(fetchManifest("https://portal.lampas.town", "2.3.33", "client")).rejects.toThrow(
      "Failed to fetch client manifest for version '2.3.33' from https://portal.lampas.town/api/v1/releases/2.3.33/client-manifest: HTTP 404 Not Found"
    );
  });
});
