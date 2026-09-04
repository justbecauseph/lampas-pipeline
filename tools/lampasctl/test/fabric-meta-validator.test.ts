import { describe, expect, test } from "bun:test";
import { verifyFabricLoaderCompatibility } from "../src/fabric-meta-validator";

describe("Fabric Meta Loader compatibility verification", () => {
  test("verifies valid real Fabric Loader and Minecraft combination", async () => {
    const result = await verifyFabricLoaderCompatibility("26.2", "0.19.3");
    expect(result.loader.version).toBe("0.19.3");
    expect(result.intermediary.version).toBeDefined();
    expect(result.launcherMeta.mainClass.client).toBe("net.fabricmc.loader.impl.launch.knot.KnotClient");
    expect(result.launcherMeta.libraries.common.length).toBeGreaterThan(0);
  });

  test("rejects incompatible or non-existent Loader version", async () => {
    await expect(
      verifyFabricLoaderCompatibility("26.2", "0.20.0-nonexistent")
    ).rejects.toThrow(/Fabric Loader 0\.20\.0-nonexistent is not available for Minecraft 26\.2/);
  });

  test("rejects invalid Minecraft version", async () => {
    await expect(
      verifyFabricLoaderCompatibility("not-a-minecraft-version", "0.19.3")
    ).rejects.toThrow(/Fabric Loader 0\.19\.3 is not available for Minecraft not-a-minecraft-version/);
  });

  test("URL encodes Minecraft and Loader versions in request", async () => {
    let capturedUrl = "";
    const mockFetch = async (input: string | URL | Request) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response("Not found", { status: 404 });
    };

    try {
      await verifyFabricLoaderCompatibility("26.2+snapshot", "0.19.3/build 1", { fetchFn: mockFetch });
    } catch {
      // Expected to fail
    }

    expect(capturedUrl).toContain("/26.2%2Bsnapshot/0.19.3%2Fbuild%201");
  });

  test("rejects response when returned loader version does not match requested", async () => {
    const mockFetch = async () => {
      return Response.json({
        loader: { version: "0.18.0", maven: "net.fabricmc:fabric-loader:0.18.0" },
        intermediary: { version: "26.2", maven: "net.fabricmc:intermediary:26.2" },
        launcherMeta: {
          mainClass: { client: "net.fabricmc.loader.impl.launch.knot.KnotClient" },
          libraries: { common: [{ name: "org.ow2.asm:asm:9.10.1" }] },
        },
      });
    };

    await expect(
      verifyFabricLoaderCompatibility("26.2", "0.19.3", { fetchFn: mockFetch })
    ).rejects.toThrow(/returned loader version '0\.18\.0', but '0\.19\.3' was requested/);
  });

  test("rejects response when intermediary is absent", async () => {
    const mockFetch = async () => {
      return Response.json({
        loader: { version: "0.19.3", maven: "net.fabricmc:fabric-loader:0.19.3" },
        launcherMeta: {
          mainClass: { client: "net.fabricmc.loader.impl.launch.knot.KnotClient" },
          libraries: { common: [{ name: "org.ow2.asm:asm:9.10.1" }] },
        },
      });
    };

    await expect(
      verifyFabricLoaderCompatibility("26.2", "0.19.3", { fetchFn: mockFetch })
    ).rejects.toThrow(/missing intermediary mappings/);
  });

  test("rejects response when launcherMeta mainClass client is absent", async () => {
    const mockFetch = async () => {
      return Response.json({
        loader: { version: "0.19.3", maven: "net.fabricmc:fabric-loader:0.19.3" },
        intermediary: { version: "26.2", maven: "net.fabricmc:intermediary:26.2" },
        launcherMeta: {
          mainClass: {},
          libraries: { common: [{ name: "org.ow2.asm:asm:9.10.1" }] },
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
        loader: { version: "0.19.3", maven: "net.fabricmc:fabric-loader:0.19.3" },
        intermediary: { version: "26.2", maven: "net.fabricmc:intermediary:26.2" },
        launcherMeta: {
          mainClass: { client: "net.fabricmc.loader.impl.launch.knot.KnotClient" },
          libraries: { common: [] },
        },
      });
    };

    await expect(
      verifyFabricLoaderCompatibility("26.2", "0.19.3", { fetchFn: mockFetch })
    ).rejects.toThrow(/malformed or empty required library metadata/);
  });
});
