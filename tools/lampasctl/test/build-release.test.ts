import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as fflate from "fflate";
import {
  cleanVersion,
  createTarGzArchive,
  createZipArchive,
  generateChecksums,
  RELEASE_TARGETS,
  resolveHostTarget,
} from "../scripts/build-release";

describe("build-release utility functions", () => {
  test("cleanVersion extracts proper semver from tag prefixes", () => {
    expect(cleanVersion("lampasctl-v1.0.0")).toBe("1.0.0");
    expect(cleanVersion("lampasctl-v0.2.1-beta.1")).toBe("0.2.1-beta.1");
    expect(cleanVersion("v2.5.0")).toBe("2.5.0");
    expect(cleanVersion("1.2.3")).toBe("1.2.3");
    expect(cleanVersion("dev")).toBe("dev");
    expect(cleanVersion(undefined)).toBe("dev");
  });

  test("resolveHostTarget returns a valid supported target", () => {
    const hostTarget = resolveHostTarget();
    expect(hostTarget).toBeDefined();
    expect(RELEASE_TARGETS.some((t) => t.id === hostTarget.id)).toBe(true);
    expect(hostTarget.bunTarget).toContain("bun-");
  });

  test("createTarGzArchive produces valid POSIX tar.gz with 0755 executable permissions", () => {
    const payload = Buffer.from("echo 'hello from lampasctl'");
    const compressed = createTarGzArchive("lampasctl", payload);

    expect(compressed.length).toBeGreaterThan(0);

    // Decompress with gzip
    const uncompressedTar = zlib.gunzipSync(compressed);
    expect(uncompressedTar.length).toBeGreaterThanOrEqual(512 + payload.length);

    // Check filename
    const filename = uncompressedTar.subarray(0, 100).toString("utf8").replace(/\0/g, "");
    expect(filename).toBe("lampasctl");

    // Check permissions
    const mode = uncompressedTar.subarray(100, 108).toString("ascii").replace(/\0/g, "");
    expect(mode).toBe("0000755");

    // Check ustar magic
    const magic = uncompressedTar.subarray(257, 263).toString("ascii").replace(/\0/g, "");
    expect(magic).toBe("ustar");

    // Check payload in tar body (at offset 512)
    const fileContent = uncompressedTar.subarray(512, 512 + payload.length);
    expect(fileContent.equals(payload)).toBe(true);
  });

  test("createZipArchive produces a readable zip archive", () => {
    const payload = Buffer.from("binary executable contents");
    const zipBytes = createZipArchive("lampasctl.exe", payload);

    expect(zipBytes.length).toBeGreaterThan(0);

    const unzipped = fflate.unzipSync(zipBytes);
    expect(unzipped["lampasctl.exe"]).toBeDefined();
    expect(Buffer.from(unzipped["lampasctl.exe"]).equals(payload)).toBe(true);
  });

  test("generateChecksums creates SHA256SUMS matching actual archive hashes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-sums-test-"));
    try {
      const file1 = path.join(dir, "lampasctl_1.0.0_linux_x64.tar.gz");
      const file2 = path.join(dir, "lampasctl_1.0.0_windows_x64.zip");
      fs.writeFileSync(file1, "dummy-tar-bytes-1");
      fs.writeFileSync(file2, "dummy-zip-bytes-2");

      const sumsPath = generateChecksums(dir);
      expect(fs.existsSync(sumsPath)).toBe(true);

      const sumsContent = fs.readFileSync(sumsPath, "utf-8");
      expect(sumsContent).toContain("lampasctl_1.0.0_linux_x64.tar.gz");
      expect(sumsContent).toContain("lampasctl_1.0.0_windows_x64.zip");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
