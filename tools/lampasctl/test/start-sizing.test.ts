import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const startPyPath = path.resolve("tools", "scripts", "start.py");
const scriptsDir = path.dirname(startPyPath);
const isWin = process.platform === "win32";

function makeJdk(parent: string, name: string, release: string | null): string {
  const binDir = path.join(parent, name, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  if (release !== null) fs.writeFileSync(path.join(parent, name, "release"), release);
  const javaBin = path.join(binDir, isWin ? "java.bat" : "java");
  if (isWin) {
    fs.writeFileSync(javaBin, "@echo off\r\necho MOCK JAVA LAUNCHED: %*\r\nexit /b 0\r\n");
  } else {
    fs.writeFileSync(javaBin, '#!/usr/bin/env bash\necho MOCK JAVA LAUNCHED: "$@"\nexit 0\n');
    fs.chmodSync(javaBin, 0o755);
  }
  return javaBin;
}

function makeServerDir(): { serverDir: string; javaBin: string; cleanup: () => void } {
  const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-start-sizing-"));
  fs.copyFileSync(startPyPath, path.join(serverDir, "start.py"));
  const runtimeDir = path.join(serverDir, ".lampas", "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, "fabric-server-launch.jar"), "jar");
  const javaBin = makeJdk(serverDir, "jdk", null);
  return { serverDir, javaBin, cleanup: () => fs.rmSync(serverDir, { recursive: true, force: true }) };
}

const SIZING_ENV = ["JAVA_MEMORY", "LAMPAS_GC", "LAMPAS_RAM", "LAMPAS_CPUS", "LAMPAS_EXTRA_RESERVE", "LAMPAS_COMPACT_HEADERS"];

function runStart(serverDir: string, args: string[], env: Record<string, string>) {
  const cleanEnv: Record<string, string | undefined> = { ...process.env };
  for (const key of SIZING_ENV) delete cleanEnv[key];
  const proc = spawnSync("python", ["start.py", "--no-sync", ...args], {
    cwd: serverDir,
    env: { ...cleanEnv, PYTHONUNBUFFERED: "1", ...env },
    encoding: "utf-8",
  });
  const stdout = proc.stdout || "";
  const dryLine = stdout.split(/\r?\n/).find((line) => line.startsWith("[Starter] Dry run: ")) ?? "";
  return { status: proc.status ?? 1, stdout, stderr: proc.stderr || "", flags: dryLine.split(" ") };
}

function py(code: string): string {
  const proc = spawnSync("python", ["-c", code], { cwd: scriptsDir, encoding: "utf-8" });
  if (proc.status !== 0) throw new Error(proc.stderr);
  return proc.stdout.trim();
}

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

describe("start.py host sizing", () => {
  test("8G host computes 5632M heap with JDK 25 G1 profile and no pinned thread counts", () => {
    const ctx = makeServerDir();
    try {
      const res = runStart(ctx.serverDir, ["--dry-run"], { JAVA_BIN: ctx.javaBin, LAMPAS_RAM: "8G" });
      expect(res.status).toBe(0);
      expect(res.stdout).not.toContain("MOCK JAVA LAUNCHED");
      expect(res.stdout).toContain("8G RAM (LAMPAS_RAM)");
      expect(res.flags).toContain("-Xmx5632M");
      expect(res.flags).toContain("-Xms5632M");
      expect(res.flags).toContain("-XX:+UseG1GC");
      expect(res.flags).toContain("-XX:G1HeapRegionSize=8M");
      expect(res.flags).toContain("-XX:G1ReservePercent=15");
      expect(res.flags).toContain("-XX:MaxTenuringThreshold=1");
      expect(res.flags).toContain("-XX:+UseCompactObjectHeaders");
      const joined = res.flags.join(" ");
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
      expect(res.flags.indexOf("-XX:+UnlockExperimentalVMOptions")).toBeLessThan(
        res.flags.indexOf("-XX:G1NewSizePercent=30")
      );
    } finally {
      ctx.cleanup();
    }
  });

  test("heap above 12G switches to Aikar large-heap overrides", () => {
    const ctx = makeServerDir();
    try {
      const res = runStart(ctx.serverDir, ["--dry-run"], { JAVA_BIN: ctx.javaBin, LAMPAS_RAM: "16G" });
      expect(res.flags).toContain("-Xmx12800M");
      expect(res.flags).toContain("-XX:G1NewSizePercent=40");
      expect(res.flags).toContain("-XX:G1MaxNewSizePercent=50");
      expect(res.flags).toContain("-XX:G1HeapRegionSize=16M");
      expect(res.flags).toContain("-XX:InitiatingHeapOccupancyPercent=20");
    } finally {
      ctx.cleanup();
    }
  });

  test("explicit --memory wins and extra JVM args come after generated flags", () => {
    const ctx = makeServerDir();
    try {
      const res = runStart(ctx.serverDir, ["--dry-run", "--memory", "3G", "-XX:G1ReservePercent=20"], {
        JAVA_BIN: ctx.javaBin,
        LAMPAS_RAM: "64G",
      });
      expect(res.status).toBe(0);
      expect(res.flags).toContain("-Xmx3G");
      expect(res.stdout).toContain("3G heap (--memory/JAVA_MEMORY)");
      const override = res.flags.indexOf("-XX:G1ReservePercent=20");
      expect(override).toBeGreaterThan(res.flags.indexOf("-XX:G1ReservePercent=15"));
      expect(override).toBeLessThan(res.flags.indexOf("-jar"));
    } finally {
      ctx.cleanup();
    }
  });

  test("LAMPAS_EXTRA_RESERVE lowers the computed heap", () => {
    const ctx = makeServerDir();
    try {
      const res = runStart(ctx.serverDir, ["--dry-run"], {
        JAVA_BIN: ctx.javaBin,
        LAMPAS_RAM: "8G",
        LAMPAS_EXTRA_RESERVE: "512M",
      });
      expect(res.flags).toContain("-Xmx5G");
    } finally {
      ctx.cleanup();
    }
  });

  test("host too small for the minimum heap refuses to start", () => {
    const ctx = makeServerDir();
    try {
      const res = runStart(ctx.serverDir, [], { JAVA_BIN: ctx.javaBin, LAMPAS_RAM: "3G" });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("below the 2G minimum");
      expect(res.stdout).not.toContain("MOCK JAVA LAUNCHED");
    } finally {
      ctx.cleanup();
    }
  });

  test("--gc zgc emits generational ZGC without G1 flags", () => {
    const ctx = makeServerDir();
    try {
      const res = runStart(ctx.serverDir, ["--dry-run", "--gc", "zgc"], { JAVA_BIN: ctx.javaBin, LAMPAS_RAM: "32G" });
      expect(res.flags).toContain("-XX:+UseZGC");
      expect(res.flags.join(" ")).not.toContain("G1");
      expect(res.flags.join(" ")).not.toContain("ZGenerational");
    } finally {
      ctx.cleanup();
    }
  });

  test("LAMPAS_CPUS sets ActiveProcessorCount and chunky tier; compact headers can be disabled", () => {
    const ctx = makeServerDir();
    try {
      const res = runStart(ctx.serverDir, ["--dry-run"], {
        JAVA_BIN: ctx.javaBin,
        LAMPAS_RAM: "8G",
        LAMPAS_CPUS: "4",
        LAMPAS_COMPACT_HEADERS: "0",
      });
      expect(res.flags).toContain("-XX:ActiveProcessorCount=4");
      expect(res.flags).toContain("-Dchunky.maxWorkingCount=1536");
      expect(res.flags).not.toContain("-XX:+UseCompactObjectHeaders");
    } finally {
      ctx.cleanup();
    }
  });

  test("Oracle GraalVM release file enables jdk.graal.TuneInlinerExploration; CE does not", () => {
    const ctx = makeServerDir();
    try {
      const oracle = makeJdk(
        ctx.serverDir,
        "oracle",
        'IMPLEMENTOR="Oracle Corporation"\nJAVA_VERSION="25.0.4"\nGRAALVM_VERSION="25.2.4"\n'
      );
      const ce = makeJdk(
        ctx.serverDir,
        "ce",
        'IMPLEMENTOR="GraalVM Community"\nJAVA_VERSION="25.0.2"\nGRAALVM_VERSION="25.0.2"\n'
      );
      const o = runStart(ctx.serverDir, ["--dry-run"], { JAVA_BIN: oracle, LAMPAS_RAM: "8G" });
      expect(o.flags).toContain("-Djdk.graal.TuneInlinerExploration=1");
      expect(o.stdout).toContain("(Oracle GraalVM)");
      const c = runStart(ctx.serverDir, ["--dry-run"], { JAVA_BIN: ce, LAMPAS_RAM: "8G" });
      expect(c.flags.join(" ")).not.toContain("TuneInlinerExploration");
    } finally {
      ctx.cleanup();
    }
  });
});

describe("start.py cgroup and THP parsing", () => {
  test("cgroup v2 takes the tightest cpu.max and memory.max/high up the hierarchy", () => {
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
        expect(py(`import start; print(start.read_cgroup_limits(${JSON.stringify(root)}))`)).toBe(
          "(1.5, 7516192768, 2)"
        );
        const host = JSON.parse(py(`import start, json; print(json.dumps(start.detect_host(${JSON.stringify(root)})))`));
        expect(host.ram).toBe(7516192768);
        expect(host.container).toBe(true);
        expect(host.ram_source).toBe("cgroup v2 limit");
        expect(host.cpus).toBeLessThanOrEqual(2);
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
        const host = JSON.parse(py(`import start, json; print(json.dumps(start.detect_host(${JSON.stringify(root)})))`));
        expect(host.ram).toBe(7889008 * 1024);
        expect(host.container).toBe(false);
        expect(host.ram_source).toBe("meminfo");
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
        expect(py(`import start; print(start.read_cgroup_limits(${JSON.stringify(root)}))`)).toBe(
          "(4.0, 6442450944, 1)"
        );
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
        expect(py(`import start; print(start.read_thp_mode(${JSON.stringify(root)}))`)).toBe("('madvise', 'never')");
        const g1 = py(
          `import start; print(start.build_jvm_flags('4G', 'g1', 2, False, ('madvise', 'never'), False, True))`
        );
        expect(g1).toContain("-XX:+UseTransparentHugePages");
        const zgc = py(
          `import start; print(start.build_jvm_flags('4G', 'zgc', 2, False, ('madvise', 'never'), False, True))`
        );
        expect(zgc).not.toContain("UseTransparentHugePages");
      }
    );
  });
});
