import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_FABRIC_SERVER_INSTALLER_VERSION,
  ensureFabricServerRuntime,
  prepareFabricServerRuntime,
  validateRuntimeDefinition,
} from "../src/fabric-runtime";
import { readJsonFile } from "../src/utils";
import type { ServerRuntimeState } from "../src/types";

describe("Fabric Server Runtime Provisioning", () => {
  let server: ReturnType<typeof Bun.serve>;
  let fabricMetaUrl: string;

  const validZipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);
  const jarV1Content = Buffer.concat([validZipHeader, Buffer.from("fabric-server-jar-0.19.3")]);
  const jarV1Sha256 = crypto.createHash("sha256").update(jarV1Content).digest("hex");

  const jarV2Content = Buffer.concat([validZipHeader, Buffer.from("fabric-server-jar-0.19.4")]);
  const jarV2Sha256 = crypto.createHash("sha256").update(jarV2Content).digest("hex");

  const sentinelJarContent = Buffer.concat([validZipHeader, Buffer.from("fabric-server-jar-0.99.123-test")]);
  const sentinelJarSha256 = crypto.createHash("sha256").update(sentinelJarContent).digest("hex");

  let recordedRequests: string[] = [];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        recordedRequests.push(url.pathname);

        if (url.pathname === "/v2/versions/loader/26.2/0.19.3/1.0.1/server/jar") {
          return new Response(jarV1Content, {
            headers: { "Content-Type": "application/java-archive" },
          });
        }
        if (url.pathname === "/v2/versions/loader/26.2/0.19.4/1.0.1/server/jar") {
          return new Response(jarV2Content, {
            headers: { "Content-Type": "application/java-archive" },
          });
        }
        if (url.pathname === "/v2/versions/loader/26.2/0.99.123-test/1.0.1/server/jar") {
          return new Response(sentinelJarContent, {
            headers: { "Content-Type": "application/java-archive" },
          });
        }
        if (url.pathname === "/v2/versions/loader/26.2/corrupt-zip/1.0.1/server/jar") {
          return new Response(Buffer.from("not-a-zip-header"), {
            headers: { "Content-Type": "application/java-archive" },
          });
        }
        if (url.pathname === "/v2/versions/loader/26.2/failing-loader/1.0.1/server/jar") {
          return new Response("Internal Server Error", { status: 500 });
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    fabricMetaUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  test("validateRuntimeDefinition validates Minecraft 26.2 and Fabric loader", () => {
    // Valid runtime
    const valid = validateRuntimeDefinition("26.2", { type: "fabric", version: "0.19.3" });
    expect(valid).toEqual({
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.19.3" },
    });

    // Fails closed on unsupported Minecraft version
    expect(() =>
      validateRuntimeDefinition("1.20.1", { type: "fabric", version: "0.19.3" })
    ).toThrow("Unsupported Minecraft version '1.20.1'. Only Minecraft 26.2 is currently supported.");

    // Rejects non-fabric loader
    expect(() =>
      validateRuntimeDefinition("26.2", { type: "neoforge", version: "20.4.0" })
    ).toThrow("Unsupported mod loader 'neoforge'. Lampas supports Fabric releases only.");

    // Rejects empty version
    expect(() =>
      validateRuntimeDefinition("26.2", { type: "fabric", version: "  " })
    ).toThrow("Invalid loader version: 'loader.version' must be a non-empty string.");
  });

  test("provisions Fabric server runtime, validates ZIP magic, stages and atomically activates", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-runtime-test-"));
    try {
      const state = await ensureFabricServerRuntime({
        targetDir: dir,
        minecraft: "26.2",
        loaderVersion: "0.19.3",
        fabricMetaUrl,
      });

      expect(state.minecraft).toBe("26.2");
      expect(state.loader.version).toBe("0.19.3");
      expect(state.installerVersion).toBe(DEFAULT_FABRIC_SERVER_INSTALLER_VERSION);
      expect(state.launcherJar).toBe("fabric-server-launch.jar");
      expect(state.launcherSha256).toBe(jarV1Sha256);

      // Check files on disk
      const launcherJar = path.join(dir, ".lampas", "runtime", "fabric-server-launch.jar");
      expect(fs.existsSync(launcherJar)).toBe(true);
      expect(fs.readFileSync(launcherJar).equals(jarV1Content)).toBe(true);

      const runtimeJson = path.join(dir, ".lampas", "runtime", "runtime.json");
      expect(fs.existsSync(runtimeJson)).toBe(true);
      const onDiskState = readJsonFile<ServerRuntimeState>(runtimeJson);
      expect(onDiskState.launcherSha256).toBe(jarV1Sha256);
      expect(onDiskState.loader.version).toBe("0.19.3");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("upgrades Fabric server runtime from 0.19.3 to 0.19.4", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-runtime-upgrade-"));
    try {
      // Step 1: Install 0.19.3
      await ensureFabricServerRuntime({
        targetDir: dir,
        minecraft: "26.2",
        loaderVersion: "0.19.3",
        fabricMetaUrl,
      });

      // Step 2: Upgrade to 0.19.4
      const upgradedState = await ensureFabricServerRuntime({
        targetDir: dir,
        minecraft: "26.2",
        loaderVersion: "0.19.4",
        fabricMetaUrl,
      });

      expect(upgradedState.loader.version).toBe("0.19.4");
      expect(upgradedState.launcherSha256).toBe(jarV2Sha256);

      const launcherJar = path.join(dir, ".lampas", "runtime", "fabric-server-launch.jar");
      expect(fs.readFileSync(launcherJar).equals(jarV2Content)).toBe(true);

      const runtimeJson = path.join(dir, ".lampas", "runtime", "runtime.json");
      const onDiskState = readJsonFile<ServerRuntimeState>(runtimeJson);
      expect(onDiskState.loader.version).toBe("0.19.4");
      expect(onDiskState.launcherSha256).toBe(jarV2Sha256);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reuses matching runtime in fast verification mode without re-downloading", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-runtime-fast-"));
    try {
      // Install 0.19.3
      await ensureFabricServerRuntime({
        targetDir: dir,
        minecraft: "26.2",
        loaderVersion: "0.19.3",
        fabricMetaUrl,
      });

      const countBefore = recordedRequests.length;

      // Re-provision with fast verification mode
      const staged = await prepareFabricServerRuntime({
        targetDir: dir,
        minecraft: "26.2",
        loaderVersion: "0.19.3",
        verificationMode: "fast",
        fabricMetaUrl,
      });

      expect(staged.isReused).toBe(true);
      expect(recordedRequests.length).toBe(countBefore); // No network request made
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("full verification mode recomputes SHA-256 and re-downloads if corrupted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-runtime-full-"));
    try {
      // Install 0.19.3
      await ensureFabricServerRuntime({
        targetDir: dir,
        minecraft: "26.2",
        loaderVersion: "0.19.3",
        fabricMetaUrl,
      });

      const launcherJar = path.join(dir, ".lampas", "runtime", "fabric-server-launch.jar");

      // Corrupt the launcher JAR on disk
      fs.writeFileSync(launcherJar, Buffer.concat([validZipHeader, Buffer.from("corrupted-data")]));

      // In full verification mode, it should detect corrupt hash and re-download
      const repairedState = await ensureFabricServerRuntime({
        targetDir: dir,
        minecraft: "26.2",
        loaderVersion: "0.19.3",
        verificationMode: "full",
        fabricMetaUrl,
      });

      expect(repairedState.launcherSha256).toBe(jarV1Sha256);
      expect(fs.readFileSync(launcherJar).equals(jarV1Content)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("failure atomicity: runtime download failure leaves existing installation completely untouched", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-runtime-atomicity-"));
    try {
      // Initial coherent state with 0.19.3
      await ensureFabricServerRuntime({
        targetDir: dir,
        minecraft: "26.2",
        loaderVersion: "0.19.3",
        fabricMetaUrl,
      });

      const launcherJar = path.join(dir, ".lampas", "runtime", "fabric-server-launch.jar");
      const runtimeJson = path.join(dir, ".lampas", "runtime", "runtime.json");

      // Attempt to upgrade to failing-loader
      await expect(
        ensureFabricServerRuntime({
          targetDir: dir,
          minecraft: "26.2",
          loaderVersion: "failing-loader",
          fabricMetaUrl,
        })
      ).rejects.toThrow("Failed to download Fabric server launcher");

      // Assert previous runtime and state are still intact
      expect(fs.existsSync(launcherJar)).toBe(true);
      expect(fs.readFileSync(launcherJar).equals(jarV1Content)).toBe(true);
      const onDiskState = readJsonFile<ServerRuntimeState>(runtimeJson);
      expect(onDiskState.loader.version).toBe("0.19.3");

      // Assert no leftover staging files
      const stagingDir = path.join(dir, ".lampas", "runtime", ".tmp-staging");
      if (fs.existsSync(stagingDir)) {
        expect(fs.readdirSync(stagingDir).length).toBe(0);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects invalid ZIP magic header", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-runtime-badzip-"));
    try {
      await expect(
        ensureFabricServerRuntime({
          targetDir: dir,
          minecraft: "26.2",
          loaderVersion: "corrupt-zip",
          fabricMetaUrl,
        })
      ).rejects.toThrow("Invalid Fabric server launcher JAR received");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sentinel loader 0.99.123-test propagates and persists correctly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-runtime-sentinel-"));
    try {
      const state = await ensureFabricServerRuntime({
        targetDir: dir,
        minecraft: "26.2",
        loaderVersion: "0.99.123-test",
        fabricMetaUrl,
      });

      expect(state.loader.version).toBe("0.99.123-test");
      expect(state.launcherSha256).toBe(sentinelJarSha256);

      const runtimeJson = path.join(dir, ".lampas", "runtime", "runtime.json");
      const onDiskState = readJsonFile<ServerRuntimeState>(runtimeJson);
      expect(onDiskState.loader.version).toBe("0.99.123-test");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
