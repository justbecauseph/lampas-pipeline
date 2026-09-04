import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("start.py managed runtime launcher", () => {
  const startPyPath = path.resolve("tools", "scripts", "start.py");

  function setupServerDir(): {
    serverDir: string;
    javaBin: string;
    createManagedRuntime: (content?: string) => string;
    createLegacyJars: () => void;
    cleanup: () => void;
  } {
    const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-start-test-"));
    // Copy start.py
    fs.copyFileSync(startPyPath, path.join(serverDir, "start.py"));

    // Create mock java binary
    const isWin = process.platform === "win32";
    const javaBin = path.join(serverDir, isWin ? "mock_java.bat" : "mock_java.sh");
    if (isWin) {
      fs.writeFileSync(
        javaBin,
        "@echo off\r\necho MOCK JAVA LAUNCHED: %*\r\nexit /b 0\r\n"
      );
    } else {
      fs.writeFileSync(
        javaBin,
        "#!/usr/bin/env bash\necho MOCK JAVA LAUNCHED: \"$@\"\nexit 0\n"
      );
      fs.chmodSync(javaBin, 0o755);
    }

    const createManagedRuntime = (content = "managed-jar-content") => {
      const runtimeDir = path.join(serverDir, ".lampas", "runtime");
      fs.mkdirSync(runtimeDir, { recursive: true });
      const jarPath = path.join(runtimeDir, "fabric-server-launch.jar");
      fs.writeFileSync(jarPath, content);
      fs.writeFileSync(
        path.join(runtimeDir, "runtime.json"),
        JSON.stringify({
          minecraft: "26.2",
          loader: { type: "fabric", version: "0.19.3" },
          launcherJar: "fabric-server-launch.jar",
        })
      );
      return jarPath;
    };

    const createLegacyJars = () => {
      fs.writeFileSync(path.join(serverDir, "fabric-server-launch-old.jar"), "legacy-jar-1");
      fs.writeFileSync(path.join(serverDir, "fabric-server-1.20.jar"), "legacy-jar-2");
      fs.writeFileSync(path.join(serverDir, "server.jar"), "legacy-root-server-jar");
    };

    const cleanup = () => {
      fs.rmSync(serverDir, { recursive: true, force: true });
    };

    return { serverDir, javaBin, createManagedRuntime, createLegacyJars, cleanup };
  }

  function runStartPy(
    serverDir: string,
    args: string[],
    envOverrides: Record<string, string> = {}
  ): { status: number; stdout: string; stderr: string } {
    const proc = spawnSync("python", ["start.py", ...args], {
      cwd: serverDir,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        ...envOverrides,
      },
      encoding: "utf-8",
    });

    return {
      status: proc.status ?? (proc.error ? 1 : 0),
      stdout: proc.stdout || "",
      stderr: proc.stderr || "",
    };
  }

  test("managed runtime found -> launched successfully", () => {
    const ctx = setupServerDir();
    try {
      ctx.createManagedRuntime();

      const res = runStartPy(ctx.serverDir, ["--no-sync"], {
        JAVA_BIN: ctx.javaBin,
      });

      expect(res.status).toBe(0);
      expect(res.stdout).toContain("MOCK JAVA LAUNCHED");
      expect(res.stdout).toContain("fabric-server-launch.jar");
      expect(res.stdout).toContain("nogui");
    } finally {
      ctx.cleanup();
    }
  });

  test("multiple legacy fabric-server jars and server.jar are completely ignored", () => {
    const ctx = setupServerDir();
    try {
      ctx.createManagedRuntime("canonical-runtime-jar");
      ctx.createLegacyJars();

      const res = runStartPy(ctx.serverDir, ["--no-sync"], {
        JAVA_BIN: ctx.javaBin,
      });

      expect(res.status).toBe(0);
      expect(res.stdout).toContain("fabric-server-launch.jar");
      expect(res.stdout).not.toContain("fabric-server-launch-old.jar");
      expect(res.stdout).not.toContain("fabric-server-1.20.jar");
      expect(res.stdout).not.toContain("server.jar");
    } finally {
      ctx.cleanup();
    }
  });

  test("managed runtime missing -> fails with error code 1 and descriptive error", () => {
    const ctx = setupServerDir();
    try {
      // Intentionally do NOT create managed runtime, only legacy jars
      ctx.createLegacyJars();

      const res = runStartPy(ctx.serverDir, ["--no-sync"], {
        JAVA_BIN: ctx.javaBin,
      });

      expect(res.status).toBe(1);
      expect(res.stderr).toContain(
        "[Starter Error] No managed Fabric runtime is installed. Run start.py without --no-sync first."
      );
      expect(res.stdout).not.toContain("MOCK JAVA LAUNCHED");
    } finally {
      ctx.cleanup();
    }
  });

  test("--no-sync with managed runtime launches without calling lampasctl deploy", () => {
    const ctx = setupServerDir();
    try {
      ctx.createManagedRuntime();

      // Create a mock lampasctl that would fail if called
      const isWin = process.platform === "win32";
      const ctlBin = path.join(ctx.serverDir, isWin ? "mock_ctl.bat" : "mock_ctl.sh");
      if (isWin) {
        fs.writeFileSync(ctlBin, "@echo off\r\necho ERROR: SHOULD NOT BE CALLED\r\nexit /b 1\r\n");
      } else {
        fs.writeFileSync(ctlBin, "#!/usr/bin/env bash\necho ERROR: SHOULD NOT BE CALLED\nexit 1\n");
        fs.chmodSync(ctlBin, 0o755);
      }

      const res = runStartPy(ctx.serverDir, ["--no-sync"], {
        JAVA_BIN: ctx.javaBin,
        LAMPASCTL_BIN: ctlBin,
      });

      expect(res.status).toBe(0);
      expect(res.stdout).not.toContain("SHOULD NOT BE CALLED");
      expect(res.stdout).toContain("MOCK JAVA LAUNCHED");
    } finally {
      ctx.cleanup();
    }
  });

  test("--no-sync without managed runtime exits 1 and emits informative error", () => {
    const ctx = setupServerDir();
    try {
      const res = runStartPy(ctx.serverDir, ["--no-sync"], {
        JAVA_BIN: ctx.javaBin,
      });

      expect(res.status).toBe(1);
      expect(res.stderr).toContain(
        "[Starter Error] No managed Fabric runtime is installed. Run start.py without --no-sync first."
      );
    } finally {
      ctx.cleanup();
    }
  });

  test("deploy success -> launches the newly managed runtime", () => {
    const ctx = setupServerDir();
    try {
      // Create mock lampasctl that deploys the managed runtime
      const isWin = process.platform === "win32";
      const ctlBin = path.join(ctx.serverDir, isWin ? "mock_deploy_success.bat" : "mock_deploy_success.sh");
      const runtimeDir = path.join(ctx.serverDir, ".lampas", "runtime");
      const targetJar = path.join(runtimeDir, "fabric-server-launch.jar");

      if (isWin) {
        fs.writeFileSync(
          ctlBin,
          `@echo off\r\nmkdir "${runtimeDir}" 2>nul\r\necho deployed-jar > "${targetJar}"\r\necho [Deploy Complete] Success\r\nexit /b 0\r\n`
        );
      } else {
        fs.writeFileSync(
          ctlBin,
          `#!/usr/bin/env bash\nmkdir -p "${runtimeDir}"\necho deployed-jar > "${targetJar}"\necho "[Deploy Complete] Success"\nexit 0\n`
        );
        fs.chmodSync(ctlBin, 0o755);
      }

      const res = runStartPy(ctx.serverDir, [], {
        JAVA_BIN: ctx.javaBin,
        LAMPASCTL_BIN: ctlBin,
      });

      expect(res.status).toBe(0);
      expect(res.stdout).toContain("[Starter] Checking for server pack updates via lampasctl deploy...");
      expect(res.stdout).toContain("MOCK JAVA LAUNCHED");
      expect(res.stdout).toContain("fabric-server-launch.jar");
    } finally {
      ctx.cleanup();
    }
  });

  test("deploy failure without --allow-stale aborts server startup with deploy exit code", () => {
    const ctx = setupServerDir();
    try {
      ctx.createManagedRuntime("previous-coherent-jar");

      // Mock lampasctl deploy failing with exit code 42
      const isWin = process.platform === "win32";
      const ctlBin = path.join(ctx.serverDir, isWin ? "mock_deploy_fail.bat" : "mock_deploy_fail.sh");
      if (isWin) {
        fs.writeFileSync(ctlBin, "@echo off\r\necho Deploy failed with error\r\nexit /b 42\r\n");
      } else {
        fs.writeFileSync(ctlBin, "#!/usr/bin/env bash\necho Deploy failed with error\nexit 42\n");
        fs.chmodSync(ctlBin, 0o755);
      }

      const res = runStartPy(ctx.serverDir, [], {
        JAVA_BIN: ctx.javaBin,
        LAMPASCTL_BIN: ctlBin,
      });

      expect(res.status).toBe(42);
      expect(res.stderr).toContain("[Starter Error] Pack deployment failed with exit code 42.");
      expect(res.stderr).toContain(
        "[Starter Error] Aborting server launch to prevent inconsistent state."
      );
      expect(res.stdout).not.toContain("MOCK JAVA LAUNCHED");
    } finally {
      ctx.cleanup();
    }
  });

  test("deploy failure with --allow-stale launches previous coherent managed runtime", () => {
    const ctx = setupServerDir();
    try {
      ctx.createManagedRuntime("previous-coherent-jar");

      // Mock lampasctl deploy failing with exit code 42
      const isWin = process.platform === "win32";
      const ctlBin = path.join(ctx.serverDir, isWin ? "mock_deploy_fail.bat" : "mock_deploy_fail.sh");
      if (isWin) {
        fs.writeFileSync(ctlBin, "@echo off\r\necho Deploy failed with error\r\nexit /b 42\r\n");
      } else {
        fs.writeFileSync(ctlBin, "#!/usr/bin/env bash\necho Deploy failed with error\nexit 42\n");
        fs.chmodSync(ctlBin, 0o755);
      }

      const res = runStartPy(ctx.serverDir, ["--allow-stale"], {
        JAVA_BIN: ctx.javaBin,
        LAMPASCTL_BIN: ctlBin,
      });

      expect(res.status).toBe(0);
      expect(res.stderr).toContain("[Starter Error] Pack deployment failed with exit code 42.");
      expect(res.stdout).toContain(
        "[Starter Warning] Continuing server launch despite deployment failure (--allow-stale enabled)."
      );
      expect(res.stdout).toContain("MOCK JAVA LAUNCHED");
      expect(res.stdout).toContain("fabric-server-launch.jar");
    } finally {
      ctx.cleanup();
    }
  });
});
