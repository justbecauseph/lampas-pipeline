import { describe, expect, test } from "bun:test";
import { verifyFabricLoaderCompatibility } from "../src/fabric-meta-validator";

const validMetaFixture = {
  loader: {
    separator: ".",
    build: 19,
    maven: "net.fabricmc:fabric-loader:0.19.3",
    version: "0.19.3",
    stable: true,
  },
  intermediary: {
    maven: "net.fabricmc:intermediary:26.2",
    version: "26.2",
    stable: true,
  },
  launcherMeta: {
    version: 1,
    libraries: {
      client: [],
      common: [
        { name: "org.ow2.asm:asm:9.10.1", url: "https://maven.fabricmc.net/" },
      ],
      server: [],
    },
    mainClass: {
      client: "net.fabricmc.loader.impl.launch.knot.KnotClient",
      server: "net.fabricmc.loader.impl.launch.knot.KnotServer",
    },
  },
};

describe("Fabric Meta Loader compatibility verification (Hermetic)", () => {
  test("verifies valid Fabric Loader and Minecraft combination with mocked response", async () => {
    const mockFetch = async () => Response.json(validMetaFixture);
    const result = await verifyFabricLoaderCompatibility("26.2", "0.19.3", { fetchFn: mockFetch });

    expect(result.loader.version).toBe("0.19.3");
    expect(result.loader.maven).toBe("net.fabricmc:fabric-loader:0.19.3");
    expect(result.intermediary.maven).toBe("net.fabricmc:intermediary:26.2");
    expect(result.launcherMeta.mainClass.client).toBe("net.fabricmc.loader.impl.launch.knot.KnotClient");
    expect(result.launcherMeta.libraries.common.length).toBeGreaterThan(0);
  });

  test("differentiates 404 response as non-existent pair and does not retry", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    };

    await expect(
      verifyFabricLoaderCompatibility("26.2", "0.20.0-nonexistent", { fetchFn: mockFetch })
    ).rejects.toThrow(/Fabric Loader 0\.20\.0-nonexistent is not available for Minecraft 26\.2 \(Fabric Meta returned 404 Not Found\)/);

    // Assert that 404 fails immediately without retry
    expect(callCount).toBe(1);
  });

  test("differentiates 5xx response, retries, and fails closed if unavailable", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" });
    };

    await expect(
      verifyFabricLoaderCompatibility("26.2", "0.19.3", {
        fetchFn: mockFetch,
        maxRetries: 2,
        timeoutMs: 1000,
      })
    ).rejects.toThrow(/Fabric Meta service unavailable \(HTTP 503 Service Unavailable querying/);

    // Initial attempt + 2 retries = 3 attempts
    expect(callCount).toBe(3);
  });

  test("recovers from transient 5xx when subsequent retry succeeds", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" });
      }
      return Response.json(validMetaFixture);
    };

    const result = await verifyFabricLoaderCompatibility("26.2", "0.19.3", {
      fetchFn: mockFetch,
      maxRetries: 2,
      timeoutMs: 1000,
    });

    expect(callCount).toBe(2);
    expect(result.loader.version).toBe("0.19.3");
  });

  test("differentiates network connectivity failures and retries", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      throw new Error("Connection refused (ECONNREFUSED)");
    };

    await expect(
      verifyFabricLoaderCompatibility("26.2", "0.19.3", {
        fetchFn: mockFetch,
        maxRetries: 1,
        timeoutMs: 1000,
      })
    ).rejects.toThrow(/Failed to connect to Fabric Meta API.*Connection refused/);

    expect(callCount).toBe(2);
  });

  test("URL encodes Minecraft and Loader versions in request", async () => {
    let capturedUrl = "";
    const mockFetch = async (input: string | URL | Request) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return Response.json({
        ...validMetaFixture,
        loader: { ...validMetaFixture.loader, version: "0.19.3/build 1" },
      });
    };

    await verifyFabricLoaderCompatibility("26.2+snapshot", "0.19.3/build 1", { fetchFn: mockFetch });
    expect(capturedUrl).toContain("/26.2%2Bsnapshot/0.19.3%2Fbuild%201");
  });

  test("rejects response when returned loader version does not match requested", async () => {
    const mockFetch = async () => {
      return Response.json({
        ...validMetaFixture,
        loader: { ...validMetaFixture.loader, version: "0.18.0" },
      });
    };

    await expect(
      verifyFabricLoaderCompatibility("26.2", "0.19.3", { fetchFn: mockFetch })
    ).rejects.toThrow(/returned loader version '0\.18\.0', but '0\.19\.3' was requested/);
  });

  test("rejects response when loader.maven coordinate is missing or empty", async () => {
    const mockFetch = async () => {
      return Response.json({
        ...validMetaFixture,
        loader: { version: "0.19.3", maven: "" },
      });
    };

    await expect(
      verifyFabricLoaderCompatibility("26.2", "0.19.3", { fetchFn: mockFetch })
    ).rejects.toThrow(/missing or invalid loader metadata/);
  });

  test("rejects response when intermediary is absent or intermediary.maven is missing", async () => {
    const mockFetchMissingIntermediary = async () => {
      const { intermediary, ...withoutIntermediary } = validMetaFixture;
      return Response.json(withoutIntermediary);
    };

    await expect(
      verifyFabricLoaderCompatibility("26.2", "0.19.3", { fetchFn: mockFetchMissingIntermediary })
    ).rejects.toThrow(/missing valid intermediary mappings/);

    const mockFetchMissingMaven = async () => {
      return Response.json({
        ...validMetaFixture,
        intermediary: { version: "26.2", maven: "   " },
      });
    };

    await expect(
      verifyFabricLoaderCompatibility("26.2", "0.19.3", { fetchFn: mockFetchMissingMaven })
    ).rejects.toThrow(/missing valid intermediary mappings/);
  });

  test("rejects response when launcherMeta mainClass client is absent", async () => {
    const mockFetch = async () => {
      return Response.json({
        ...validMetaFixture,
        launcherMeta: {
          ...validMetaFixture.launcherMeta,
          mainClass: {},
        },
      });
    };

    await expect(
      verifyFabricLoaderCompatibility("26.2", "0.19.3", { fetchFn: mockFetch })
    ).rejects.toThrow(/missing launcherMeta\.mainClass\.client/);
  });

  test("rejects response when required common libraries are empty or malformed", async () => {
    const mockFetch = async () => {
      return Response.json({
        ...validMetaFixture,
        launcherMeta: {
          ...validMetaFixture.launcherMeta,
          libraries: { common: [] },
        },
      });
    };

    await expect(
      verifyFabricLoaderCompatibility("26.2", "0.19.3", { fetchFn: mockFetch })
    ).rejects.toThrow(/malformed or empty required library metadata/);
  });
});

// Optional live integration test (only runs when RUN_LIVE_FABRIC_META_TESTS=true)
describe("Fabric Meta Loader compatibility verification (Live)", () => {
  const runLive = process.env.RUN_LIVE_FABRIC_META_TESTS === "true" || process.env.RUN_LIVE_FABRIC_META_TESTS === "1";

  test.skipIf(!runLive)("live network: queries real Fabric Meta API for 26.2 and 0.19.3", async () => {
    const result = await verifyFabricLoaderCompatibility("26.2", "0.19.3");
    expect(result.loader.version).toBe("0.19.3");
    expect(result.loader.maven).toBeDefined();
    expect(result.intermediary.maven).toBeDefined();
    expect(result.launcherMeta.mainClass.client).toBe("net.fabricmc.loader.impl.launch.knot.KnotClient");
    expect(result.launcherMeta.libraries.common.length).toBeGreaterThan(0);
  });
});
