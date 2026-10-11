import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  detectHost,
  formatSize,
  GiB,
  MiB,
  parseSize,
  readCgroupLimits,
  readThpMode,
} from "../src/launcher/host";
import { findJavaBinary, isOracleGraalvm } from "../src/launcher/java";
import {
  buildJvmFlags,
  chunkyWorkingCount,
  MIN_HEAP,
  planHeap,
} from "../src/launcher/jvm-flags";

const isWin = process.platform === "win32";

function writeTree(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function withTempRoot(prefix: string, files: Record<string, string>, fn: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    writeTree(root, files);
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function makeJdk(parent: string, name: string, release: string | null, binName?: string): string {
  const binDir = path.join(parent, name, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  if (release !== null) {
    fs.writeFileSync(path.join(parent, name, "release"), release);
  }
  const defaultBin = isWin ? "java.bat" : "java";
  const javaBin = path.join(binDir, binName ?? defaultBin);
  if (isWin) {
    fs.writeFileSync(javaBin, "@echo off\r\nexit /b 0\r\n");
  } else {
    fs.writeFileSync(javaBin, "#!/usr/bin/env bash\nexit 0\n");
    fs.chmodSync(javaBin, 0o755);
  }
  return javaBin;
}

describe("launcher sizing and JVM flag planning", () => {
  test("8G host computes 5632M heap with JDK 25 G1 profile and no pinned thread counts", () => {
    const heap = planHeap(8 * GiB, false);
    expect(heap).toBe(5632 * MiB);
    expect(formatSize(heap)).toBe("5632M");

    const flags = buildJvmFlags({
      heap,
      gc: "g1",
      cpus: 2,
      cpuOverride: false,
      thp: [null, null],
      oracleGraal: false,
      compactHeaders: true,
    });

    expect(flags).toContain("-Xmx5632M");
    expect(flags).toContain("-Xms5632M");
    expect(flags).toContain("-XX:+UseG1GC");
    expect(flags).toContain("-XX:G1HeapRegionSize=8M");
    expect(flags).toContain("-XX:G1ReservePercent=15");
    expect(flags).toContain("-XX:MaxTenuringThreshold=1");
    expect(flags).toContain("-XX:+UseCompactObjectHeaders");

    const joined = flags.join(" ");
    for (const banned of [
      "CICompilerCount",
      "ParallelGCThreads",
      "ConcGCThreads",
      "-Dgraal.",
      "TuneInlinerExploration",
      "EnableJVMCI",
      "ParallelRefProcEnabled",
      "MaxGCPauseMillis",
      "ActiveProcessorCount",
    ]) {
      expect(joined).not.toContain(banned);
    }

    expect(flags.indexOf("-XX:+UnlockExperimentalVMOptions")).toBeLessThan(
      flags.indexOf("-XX:G1NewSizePercent=30")
    );
  });

  test("heap above 12G switches to Aikar large-heap overrides", () => {
    const heap = planHeap(16 * GiB, false);
    expect(heap).toBe(12800 * MiB);
    expect(formatSize(heap)).toBe("12800M");

    const flags = buildJvmFlags({
      heap,
      gc: "g1",
      cpus: 8,
      cpuOverride: false,
      thp: [null, null],
      oracleGraal: false,
      compactHeaders: true,
    });

    expect(flags).toContain("-Xmx12800M");
    expect(flags).toContain("-XX:G1NewSizePercent=40");
    expect(flags).toContain("-XX:G1MaxNewSizePercent=50");
    expect(flags).toContain("-XX:G1HeapRegionSize=16M");
    expect(flags).toContain("-XX:InitiatingHeapOccupancyPercent=20");
  });

  test("string heap '3G' used verbatim", () => {
    const flags = buildJvmFlags({
      heap: "3G",
      gc: "g1",
      cpus: 4,
      cpuOverride: false,
      thp: [null, null],
      oracleGraal: false,
      compactHeaders: true,
    });

    expect(flags).toContain("-Xms3G");
    expect(flags).toContain("-Xmx3G");
  });

  test("8G with 512M extra reserve -> 5G", () => {
    const heap = planHeap(8 * GiB, false, 512 * MiB);
    expect(heap).toBe(5 * GiB);
    expect(formatSize(heap)).toBe("5G");

    const flags = buildJvmFlags({
      heap,
      gc: "g1",
      cpus: 2,
      cpuOverride: false,
      thp: [null, null],
      oracleGraal: false,
      compactHeaders: true,
    });

    expect(flags).toContain("-Xmx5G");
    expect(flags).toContain("-Xms5G");
  });

  test("3G host -> below MIN_HEAP", () => {
    const heap = planHeap(3 * GiB, false);
    expect(heap).toBeLessThan(MIN_HEAP);
  });

  test("zgc -> UseZGC, no G1, no ZGenerational", () => {
    const flags = buildJvmFlags({
      heap: "32G",
      gc: "zgc",
      cpus: 8,
      cpuOverride: false,
      thp: [null, null],
      oracleGraal: false,
      compactHeaders: true,
    });

    expect(flags).toContain("-XX:+UseZGC");
    const joined = flags.join(" ");
    expect(joined).not.toContain("G1");
    expect(joined).not.toContain("ZGenerational");
  });

  test("cpuOverride with 4 cpus -> ActiveProcessorCount=4 and chunky 1536, compactHeaders false omits it", () => {
    const flags = buildJvmFlags({
      heap: "8G",
      gc: "g1",
      cpus: 4,
      cpuOverride: true,
      thp: [null, null],
      oracleGraal: false,
      compactHeaders: false,
    });

    expect(flags).toContain("-XX:ActiveProcessorCount=4");
    expect(flags).toContain("-Dchunky.maxWorkingCount=1536");
    expect(flags).not.toContain("-XX:+UseCompactObjectHeaders");
  });

  test("detectHost with env LAMPAS_CPUS/LAMPAS_RAM overrides (and invalid LAMPAS_CPUS throws)", () => {
    const host = detectHost({
      env: {
        LAMPAS_CPUS: "4",
        LAMPAS_RAM: "8G",
      },
    });

    expect(host.cpus).toBe(4);
    expect(host.cpuSource).toBe("LAMPAS_CPUS");
    expect(host.ram).toBe(8 * GiB);
    expect(host.ramSource).toBe("LAMPAS_RAM");
    expect(host.container).toBe(false);

    expect(() => detectHost({ env: { LAMPAS_CPUS: "invalid" } })).toThrow(
      "LAMPAS_CPUS must be a whole number"
    );
    expect(() => detectHost({ env: { LAMPAS_RAM: "invalid" } })).toThrow(
      "Invalid size"
    );
  });

  test("parseSize and formatSize cases incl. invalid input throws", () => {
    expect(parseSize("4096M")).toBe(4096 * MiB);
    expect(parseSize("4G")).toBe(4 * GiB);
    expect(parseSize("512m")).toBe(512 * MiB);
    expect(parseSize("1073741824")).toBe(1073741824);
    expect(parseSize(1073741824)).toBe(1073741824);
    expect(parseSize("4GB")).toBe(4 * GiB);
    expect(parseSize("1024K")).toBe(1024 * 1024);
    expect(parseSize("1T")).toBe(1024 * GiB);
    expect(parseSize("1.5G")).toBe(1610612736);
    expect(parseSize("0G")).toBe(0);
    expect(parseSize("0")).toBe(0);

    expect(formatSize(4 * GiB)).toBe("4G");
    expect(formatSize(5632 * MiB)).toBe("5632M");
    expect(formatSize(0)).toBe("0G");

    expect(() => parseSize("")).toThrow("Invalid size");
    expect(() => parseSize("   ")).toThrow("Invalid size");
    expect(() => parseSize("abc")).toThrow("Invalid size");
    expect(() => parseSize("4GG")).toThrow("Invalid size");
    expect(() => parseSize("1.5")).toThrow("Invalid size");
    expect(() => parseSize("B")).toThrow("Invalid size");
  });

  test("Oracle vs CE release-file fixtures for isOracleGraalvm", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-test-graal-"));
    try {
      const oracleBin = makeJdk(
        tempDir,
        "oracle",
        'IMPLEMENTOR="Oracle Corporation"\nJAVA_VERSION="25.0.4"\nGRAALVM_VERSION="25.2.4"\n'
      );
      const ceBin = makeJdk(
        tempDir,
        "ce",
        'IMPLEMENTOR="GraalVM Community"\nJAVA_VERSION="25.0.2"\nGRAALVM_VERSION="25.0.2"\n'
      );
      const standardBin = makeJdk(
        tempDir,
        "standard",
        'IMPLEMENTOR="Eclipse Adoptium"\nJAVA_VERSION="25.0.4"\n'
      );
      const missingBin = makeJdk(tempDir, "missing", null);

      expect(isOracleGraalvm(oracleBin)).toBe(true);
      expect(isOracleGraalvm(ceBin)).toBe(false);
      expect(isOracleGraalvm(standardBin)).toBe(false);
      expect(isOracleGraalvm(missingBin)).toBe(false);
      expect(isOracleGraalvm(path.join(tempDir, "nonexistent"))).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("findJavaBinary precedence with injected env", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-test-find-java-"));
    try {
      // 1. JAVA_BIN wins if exists
      const javaBinPath = makeJdk(tempDir, "bin-override", null);
      const binRes = findJavaBinary({ JAVA_BIN: javaBinPath }, "win32");
      expect(binRes).toBe(javaBinPath);

      // 2. JAVA_BIN missing -> fallback to JAVA_HOME
      const javaHomeDir = path.join(tempDir, "home-override");
      const expectedHomeJava = makeJdk(tempDir, "home-override", null, isWin ? "java.exe" : "java");
      const homeRes = findJavaBinary(
        { JAVA_BIN: path.join(tempDir, "missing-bin"), JAVA_HOME: javaHomeDir },
        process.platform
      );
      expect(homeRes).toBe(expectedHomeJava);

      // 3. SDKMAN candidates on non-Windows
      const fakeHome = path.join(tempDir, "fake-home");
      const sdkmanJava = path.join(fakeHome, ".sdkman", "candidates", "java", "current", "bin", "java");
      fs.mkdirSync(path.dirname(sdkmanJava), { recursive: true });
      fs.writeFileSync(sdkmanJava, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(sdkmanJava, 0o755);

      const sdkRes = findJavaBinary({}, "linux", fakeHome);
      expect(sdkRes).toBe(sdkmanJava);

      // SDKMAN ignored on Windows
      const winSdkRes = findJavaBinary({ PATH: "" }, "win32", fakeHome);
      expect(winSdkRes).toBe("java");

      // 4. PATH lookup
      const fakePathDir = path.join(tempDir, "fake-path");
      fs.mkdirSync(fakePathDir, { recursive: true });
      const pathJava = path.join(fakePathDir, isWin ? "java.exe" : "java");
      fs.writeFileSync(pathJava, "fake");
      if (!isWin) fs.chmodSync(pathJava, 0o755);

      const pathRes = findJavaBinary({ PATH: fakePathDir }, process.platform, path.join(tempDir, "empty-home"));
      expect(pathRes).toBe(pathJava);

      // 5. Fallback to 'java'
      const fallbackRes = findJavaBinary({ PATH: "" }, "linux", path.join(tempDir, "empty-home"));
      expect(fallbackRes).toBe("java");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("cgroup v2 fixture takes the tightest cpu.max and memory.max/high up the hierarchy", () => {
    withTempRoot(
      "lampas-cg2-",
      {
        "proc/self/cgroup": "0::/system.slice/lampas-server.service\n",
        "proc/meminfo": "MemTotal:       16384000 kB\nMemFree: 1 kB\n",
        "sys/fs/cgroup/cgroup.controllers": "cpu memory\n",
        "sys/fs/cgroup/system.slice/cpu.max": "300000 100000\n",
        "sys/fs/cgroup/system.slice/memory.max": "max\n",
        "sys/fs/cgroup/system.slice/lampas-server.service/cpu.max": "150000 100000\n",
        "sys/fs/cgroup/system.slice/lampas-server.service/memory.max": "8589934592\n",
        "sys/fs/cgroup/system.slice/lampas-server.service/memory.high": "7516192768\n",
      },
      (root) => {
        const limits = readCgroupLimits(root);
        expect(limits.cpuQuota).toBe(1.5);
        expect(limits.memLimit).toBe(7516192768);
        expect(limits.version).toBe(2);

        const host = detectHost({ root, cpuCount: 8 });
        expect(host.cpus).toBe(2);
        expect(host.cpuSource).toBe("cgroup v2 quota");
        expect(host.ram).toBe(7516192768);
        expect(host.container).toBe(true);
        expect(host.ramSource).toBe("cgroup v2 limit");
      }
    );
  });

  test("cgroup v2 without limits falls back to MemTotal", () => {
    withTempRoot(
      "lampas-cg2u-",
      {
        "proc/self/cgroup": "0::/system.slice/lampas-server.service\n",
        "proc/meminfo": "MemTotal:        7889008 kB\n",
        "sys/fs/cgroup/cgroup.controllers": "cpu memory\n",
        "sys/fs/cgroup/system.slice/lampas-server.service/cpu.max": "max 100000\n",
        "sys/fs/cgroup/system.slice/lampas-server.service/memory.max": "max\n",
      },
      (root) => {
        const host = detectHost({ root });
        expect(host.ram).toBe(7889008 * 1024);
        expect(host.container).toBe(false);
        expect(host.ramSource).toBe("meminfo");
      }
    );
  });

  test("cgroup v1 ignores the unlimited sentinel and uses hierarchical_memory_limit", () => {
    withTempRoot(
      "lampas-cg1-",
      {
        "proc/self/cgroup": "4:memory:/docker/abc\n3:cpu,cpuacct:/docker/abc\n",
        "sys/fs/cgroup/cpu,cpuacct/docker/abc/cpu.cfs_quota_us": "400000\n",
        "sys/fs/cgroup/cpu,cpuacct/docker/abc/cpu.cfs_period_us": "100000\n",
        "sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes": "9223372036854771712\n",
        "sys/fs/cgroup/memory/docker/abc/memory.stat": "cache 0\nhierarchical_memory_limit 6442450944\n",
      },
      (root) => {
        const limits = readCgroupLimits(root);
        expect(limits.cpuQuota).toBe(4);
        expect(limits.memLimit).toBe(6442450944);
        expect(limits.version).toBe(1);
      }
    );
  });

  test("THP active modes are read from the bracketed token and gate UseTransparentHugePages", () => {
    withTempRoot(
      "lampas-thp-",
      {
        "sys/kernel/mm/transparent_hugepage/enabled": "always [madvise] never\n",
        "sys/kernel/mm/transparent_hugepage/shmem_enabled": "always within_size advise [never] deny force\n",
      },
      (root) => {
        const thp = readThpMode(root);
        expect(thp).toEqual(["madvise", "never"]);

        const g1 = buildJvmFlags({
          heap: "4G",
          gc: "g1",
          cpus: 2,
          cpuOverride: false,
          thp,
          oracleGraal: false,
          compactHeaders: true,
        });
        expect(g1).toContain("-XX:+UseTransparentHugePages");

        const zgc = buildJvmFlags({
          heap: "4G",
          gc: "zgc",
          cpus: 2,
          cpuOverride: false,
          thp,
          oracleGraal: false,
          compactHeaders: true,
        });
        expect(zgc).not.toContain("-XX:+UseTransparentHugePages");
      }
    );
  });
});
