import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadMinecraftEnv, serverProcessEnv } from "../src/launcher/start";

const cliPath = path.resolve(__dirname, "../src/cli.ts");

function setupServerDir(): {
  serverDir: string;
  javaBin: string;
  createManagedRuntime: (content?: string) => string;
  createTxJournal: (overrides?: Record<string, unknown>) => string;
  cleanup: () => void;
} {
  const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-start-cmd-test-"));

  const isWin = process.platform === "win32";
  const javaBin = path.join(serverDir, isWin ? "mock_java.bat" : "mock_java.sh");
  if (isWin) {
    fs.writeFileSync(javaBin, "@echo off\r\necho MOCK JAVA LAUNCHED: %*\r\nexit /b 0\r\n");
  } else {
    fs.writeFileSync(javaBin, '#!/usr/bin/env bash\necho MOCK JAVA LAUNCHED: "$@"\nexit 0\n');
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
      }),
    );
    return jarPath;
  };

  const createTxJournal = (overrides: Record<string, unknown> = {}) => {
    const txDir = path.join(serverDir, ".lampas", ".tx-rollback");
    const runtimeBackupDir = path.join(txDir, "runtime");
    fs.mkdirSync(runtimeBackupDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeBackupDir, "fabric-server-launch.jar"), "backup-jar-content");
    const journalData = {
      txId: "tx-test-01",
      startedAt: new Date().toISOString(),
      targetDir: serverDir,
      overwrittenFiles: [],
      deletedFiles: [],
      newFiles: [],
      hadServerProperties: false,
      hadInstallationJson: false,
      hadRuntimeJar: true,
      hadRuntimeJson: false,
      ...overrides,
    };
    const journalPath = path.join(txDir, "journal.json");
    fs.writeFileSync(journalPath, JSON.stringify(journalData, null, 2));
    return journalPath;
  };

  const cleanup = () => {
    try {
      fs.rmSync(serverDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  };

  return { serverDir, javaBin, createManagedRuntime, createTxJournal, cleanup };
}

function runLampasctl(
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
  } = {},
): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync("bun", ["run", cliPath, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    encoding: "utf-8",
  });

  return {
    status: proc.status ?? (proc.error ? 1 : 0),
    stdout: proc.stdout || "",
    stderr: proc.stderr || "",
  };
}

describe("lampasctl start CLI command", () => {
  test("--dry-run flag generation, host logging, and dry-run line format", () => {
    const ctx = setupServerDir();
    try {
      ctx.createManagedRuntime();

      const res = runLampasctl(["start", "--target", ctx.serverDir, "--no-sync", "--dry-run"], {
        env: { JAVA_BIN: ctx.javaBin },
      });

      expect(res.status).toBe(0);
      expect(res.stdout).toContain("[Starter] Host:");
      expect(res.stdout).toContain("CPUs");
      expect(res.stdout).toContain("RAM");
      expect(res.stdout).toContain(`[Starter] Using Java: ${ctx.javaBin}`);
      expect(res.stdout).toContain(
        "[Starter] Starting Minecraft Fabric Server (fabric-server-launch.jar)",
      );
      expect(res.stdout).toContain("[Starter] Dry run:");
      expect(res.stdout).toContain("-Xms");
      expect(res.stdout).toContain("-Xmx");
      expect(res.stdout).toContain("-XX:+ExitOnOutOfMemoryError");
      expect(res.stdout).toContain("-jar");
      expect(res.stdout).toContain("fabric-server-launch.jar");
      expect(res.stdout).toContain("nogui");
      // dry-run must NOT launch Java
      expect(res.stdout).not.toContain("MOCK JAVA LAUNCHED");
    } finally {
      ctx.cleanup();
    }
  });

  test("-- extra JVM args passthrough after generated flags and before -jar", () => {
    const ctx = setupServerDir();
    try {
      ctx.createManagedRuntime();

      const res = runLampasctl(
        [
          "start",
          "--target",
          ctx.serverDir,
          "--no-sync",
          "--dry-run",
          "--",
          "-Dcustom.prop=value",
          "-XX:+CustomFlag",
        ],
        { env: { JAVA_BIN: ctx.javaBin } },
      );

      expect(res.status).toBe(0);
      expect(res.stdout).toContain("[Starter] Dry run:");

      const dryRunLine = res.stdout.split("\n").find((l) => l.startsWith("[Starter] Dry run:"))!;
      expect(dryRunLine).toBeDefined();

      const customPropIdx = dryRunLine.indexOf("-Dcustom.prop=value");
      const customFlagIdx = dryRunLine.indexOf("-XX:+CustomFlag");
      const jarIdx = dryRunLine.indexOf("-jar");
      const formatMsgIdx = dryRunLine.indexOf("-Dlog4j2.formatMsgNoLookups=true");

      expect(customPropIdx).toBeGreaterThan(-1);
      expect(customFlagIdx).toBeGreaterThan(customPropIdx);
      expect(jarIdx).toBeGreaterThan(customFlagIdx);
      // Generated flags appear before extra JVM args
      expect(customPropIdx).toBeGreaterThan(formatMsgIdx);
    } finally {
      ctx.cleanup();
    }
  });

  test("--no-sync with managed runtime launches mock java", () => {
    const ctx = setupServerDir();
    try {
      ctx.createManagedRuntime();

      const res = runLampasctl(["start", "--target", ctx.serverDir, "--no-sync"], {
        env: { JAVA_BIN: ctx.javaBin },
      });

      expect(res.status).toBe(0);
      expect(res.stdout).toContain("MOCK JAVA LAUNCHED:");
      expect(res.stdout).toContain("fabric-server-launch.jar");
      expect(res.stdout).toContain("nogui");
    } finally {
      ctx.cleanup();
    }
  });

  test("missing managed runtime exits 1 with expected error message", () => {
    const ctx = setupServerDir();
    try {
      // Do not create managed runtime
      const res = runLampasctl(["start", "--target", ctx.serverDir, "--no-sync"], {
        env: { JAVA_BIN: ctx.javaBin },
      });

      expect(res.status).toBe(1);
      expect(res.stderr).toContain(
        "[Starter Error] No managed Fabric runtime is installed. Run lampasctl start without --no-sync first.",
      );
      expect(res.stdout).not.toContain("MOCK JAVA LAUNCHED");
    } finally {
      ctx.cleanup();
    }
  });

  test("deploy error without --allow-stale exits 1", () => {
    const ctx = setupServerDir();
    try {
      ctx.createManagedRuntime();

      // Point to an unreachable portal to trigger deploy failure
      const res = runLampasctl(
        ["start", "--target", ctx.serverDir, "--portal", "http://127.0.0.1:9", "--channel", "dev"],
        { env: { JAVA_BIN: ctx.javaBin } },
      );

      expect(res.status).toBe(1);
      expect(res.stderr).toContain("[Starter Error] Pack deployment failed:");
      expect(res.stderr).toContain(
        "[Starter Error] Aborting server launch to prevent inconsistent state. (Use --allow-stale or --no-sync to bypass)",
      );
      expect(res.stdout).not.toContain("MOCK JAVA LAUNCHED");
    } finally {
      ctx.cleanup();
    }
  });

  test("deploy error with --allow-stale recovers and launches", () => {
    const ctx = setupServerDir();
    try {
      ctx.createManagedRuntime();

      // Point to an unreachable portal with --allow-stale enabled
      const res = runLampasctl(
        [
          "start",
          "--target",
          ctx.serverDir,
          "--portal",
          "http://127.0.0.1:9",
          "--channel",
          "dev",
          "--allow-stale",
        ],
        { env: { JAVA_BIN: ctx.javaBin } },
      );

      expect(res.status).toBe(0);
      expect(res.stderr).toContain("[Starter Error] Pack deployment failed:");
      expect(res.stdout).toContain(
        "[Starter Warning] Deployment failed. Attempting transaction recovery before stale launch (--allow-stale enabled)...",
      );
      expect(res.stdout).toContain(
        "[Starter Warning] Continuing server launch with recovered installation state (--allow-stale enabled).",
      );
      expect(res.stdout).toContain("MOCK JAVA LAUNCHED:");
      expect(res.stdout).toContain("fabric-server-launch.jar");
    } finally {
      ctx.cleanup();
    }
  });

  test("interrupted transaction journal triggers rollback before launch", () => {
    const ctx = setupServerDir();
    try {
      ctx.createManagedRuntime();
      const journalPath = ctx.createTxJournal();

      expect(fs.existsSync(journalPath)).toBe(true);

      const res = runLampasctl(["start", "--target", ctx.serverDir, "--no-sync"], {
        env: { JAVA_BIN: ctx.javaBin },
      });

      expect(res.status).toBe(0);
      expect(res.stdout).toContain(
        "[Starter Warning] Detected interrupted deployment transaction journal. Running recovery before launch...",
      );
      expect(res.stdout).toContain("[Starter] Transaction recovery completed successfully.");
      expect(res.stdout).toContain("MOCK JAVA LAUNCHED:");
      // Journal must have been unlinked/cleaned up by rollback
      expect(fs.existsSync(journalPath)).toBe(false);
    } finally {
      ctx.cleanup();
    }
  });

  test("interrupted transaction journal fails closed if recovery fails", () => {
    const ctx = setupServerDir();
    try {
      ctx.createManagedRuntime();
      // Target dir mismatch in journal triggers recovery error
      ctx.createTxJournal({ targetDir: "C:/non/existent/mismatched/target" });

      const res = runLampasctl(["start", "--target", ctx.serverDir, "--no-sync"], {
        env: { JAVA_BIN: ctx.javaBin },
      });

      expect(res.status).toBe(1);
      expect(res.stdout).toContain(
        "[Starter Warning] Detected interrupted deployment transaction journal. Running recovery before launch...",
      );
      expect(res.stderr).toContain("[Starter Error] Transaction recovery failed:");
      expect(res.stderr).toContain("Aborting server launch.");
      expect(res.stdout).not.toContain("MOCK JAVA LAUNCHED");
    } finally {
      ctx.cleanup();
    }
  });

  test(".minecraft-env loading in target directory sets env vars without overwriting existing process.env", () => {
    const ctx = setupServerDir();
    try {
      ctx.createManagedRuntime();

      fs.writeFileSync(
        path.join(ctx.serverDir, ".minecraft-env"),
        [
          "# Minecraft server environment configuration",
          "JAVA_MEMORY=3G",
          "LAMPAS_GC=zgc",
          'PRESET_KEY="preset_from_file"',
          "DO_NOT_OVERWRITE=from_file",
        ].join("\n"),
      );

      const res = runLampasctl(["start", "--target", ctx.serverDir, "--no-sync", "--dry-run"], {
        env: {
          JAVA_BIN: ctx.javaBin,
          DO_NOT_OVERWRITE: "from_process_env",
        },
      });

      expect(res.status).toBe(0);
      // JAVA_MEMORY=3G and LAMPAS_GC=zgc loaded from .minecraft-env
      expect(res.stdout).toContain("with 3G heap (--memory/JAVA_MEMORY), GC zgc...");
      expect(res.stdout).toContain("-Xms3G -Xmx3G");
      expect(res.stdout).toContain("-XX:+UseZGC");
    } finally {
      ctx.cleanup();
    }
  });

  test("loadMinecraftEnv function preserves existing process.env and parses quotes correctly", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-env-test-"));
    try {
      process.env.EXISTING_TEST_KEY = "original_value";

      fs.writeFileSync(
        path.join(tempDir, ".minecraft-env"),
        [
          "# Comment line",
          "",
          "EXISTING_TEST_KEY=new_value",
          "NEW_PLAIN_KEY=plain_value",
          'NEW_DOUBLE_QUOTED="quoted value with spaces"',
          "NEW_SINGLE_QUOTED='single quoted value'",
          "export EXPORTED_KEY=exported_value",
        ].join("\n"),
      );

      const loaded = loadMinecraftEnv(tempDir);

      expect(loaded.EXISTING_TEST_KEY).toBe("new_value");
      expect(loaded.NEW_PLAIN_KEY).toBe("plain_value");
      expect(loaded.NEW_DOUBLE_QUOTED).toBe("quoted value with spaces");
      expect(loaded.NEW_SINGLE_QUOTED).toBe("single quoted value");
      expect(loaded.EXPORTED_KEY).toBe("exported_value");

      // process.env must NOT have overwritten existing key
      expect(process.env.EXISTING_TEST_KEY).toBe("original_value");
      // Newly set keys must be present in process.env
      expect(process.env.NEW_PLAIN_KEY).toBe("plain_value");
      expect(process.env.NEW_DOUBLE_QUOTED).toBe("quoted value with spaces");
      expect(process.env.EXPORTED_KEY).toBe("exported_value");
    } finally {
      delete process.env.EXISTING_TEST_KEY;
      delete process.env.NEW_PLAIN_KEY;
      delete process.env.NEW_DOUBLE_QUOTED;
      delete process.env.NEW_SINGLE_QUOTED;
      delete process.env.EXPORTED_KEY;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("log4j2.xml inclusion and computed heap below minimum error", () => {
    const ctx = setupServerDir();
    try {
      ctx.createManagedRuntime();

      // Create log4j2.xml
      const log4jPath = path.join(ctx.serverDir, "log4j2.xml");
      fs.writeFileSync(log4jPath, "<Configuration></Configuration>");

      const res = runLampasctl(["start", "--target", ctx.serverDir, "--no-sync", "--dry-run"], {
        env: { JAVA_BIN: ctx.javaBin },
      });

      expect(res.status).toBe(0);
      expect(res.stdout).toContain(`-Dlog4j2.configurationFile=${log4jPath}`);

      // Host too small for 2G minimum heap
      const smallHostRes = runLampasctl(
        ["start", "--target", ctx.serverDir, "--no-sync", "--dry-run"],
        {
          env: {
            JAVA_BIN: ctx.javaBin,
            LAMPAS_RAM: "2G",
          },
        },
      );

      expect(smallHostRes.status).toBe(1);
      expect(smallHostRes.stderr).toContain("[Starter Error] Computed heap");
      expect(smallHostRes.stderr).toContain("is below the 2G minimum for this modpack.");
    } finally {
      ctx.cleanup();
    }
  });
});

describe("lampasctl start and the read-only deploy token (PACK_DEPLOY_TOKEN)", () => {
  const TOKEN = "start-deploy-token-for-tests";

  /**
   * Mock Java that prints the deploy token and a control variable as the server process sees
   * them. An unset variable prints as an empty pair of brackets.
   */
  function writeEnvPrintingJava(serverDir: string): string {
    const isWin = process.platform === "win32";
    const javaBin = path.join(serverDir, isWin ? "mock_java_env.bat" : "mock_java_env.sh");
    if (isWin) {
      fs.writeFileSync(
        javaBin,
        [
          "@echo off",
          "echo MOCK JAVA LAUNCHED",
          "echo CHILD_DEPLOY_TOKEN=[%PACK_DEPLOY_TOKEN%]",
          "echo CHILD_CONTROL=[%LAMPAS_TEST_CONTROL%]",
          "exit /b 0",
          "",
        ].join("\r\n"),
      );
    } else {
      fs.writeFileSync(
        javaBin,
        [
          "#!/usr/bin/env bash",
          "echo MOCK JAVA LAUNCHED",
          'echo "CHILD_DEPLOY_TOKEN=[${PACK_DEPLOY_TOKEN:-}]"',
          'echo "CHILD_CONTROL=[${LAMPAS_TEST_CONTROL:-}]"',
          "exit 0",
          "",
        ].join("\n"),
      );
      fs.chmodSync(javaBin, 0o755);
    }
    return javaBin;
  }

  /** The test process's environment without the deploy token, plus `extra`. */
  function envWithoutToken(extra: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key.toUpperCase() !== "PACK_DEPLOY_TOKEN") {
        env[key] = value;
      }
    }
    return { ...env, ...extra };
  }

  /**
   * Runs lampasctl without blocking the event loop, so a mock Portal in this process can answer.
   * `cwd` is the temporary server directory: Bun loads `.env` from the working directory, and a
   * developer's `.env` with PACK_DEPLOY_TOKEN must not reach these runs.
   */
  async function runLampasctlAsync(
    args: string[],
    env: Record<string, string>,
    cwd: string,
  ): Promise<{ status: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { status, stdout, stderr };
  }

  test("a token in .minecraft-env reaches the Portal reads of the deploy and is absent from the server process", async () => {
    const ctx = setupServerDir();
    const seen: { path: string; authorization: string | null }[] = [];
    // Enforces the read gate, then has no release to serve, so the deploy fails after its reads.
    const portal = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const authorization = req.headers.get("authorization");
        seen.push({ path: url.pathname, authorization });
        if (authorization !== `Bearer ${TOKEN}`) {
          return new Response("Unauthorized", { status: 401, statusText: "Unauthorized" });
        }
        if (url.pathname === "/api/v1/channels/dev") {
          return Response.json({ channel: "dev", version: "9.9.9" });
        }
        return new Response("Not Found", { status: 404, statusText: "Not Found" });
      },
    });
    try {
      ctx.createManagedRuntime();
      const javaBin = writeEnvPrintingJava(ctx.serverDir);
      fs.writeFileSync(
        path.join(ctx.serverDir, ".minecraft-env"),
        [`PACK_DEPLOY_TOKEN=${TOKEN}`, "LAMPAS_TEST_CONTROL=from-env-file", ""].join("\n"),
      );

      const res = await runLampasctlAsync(
        [
          "start",
          "--target",
          ctx.serverDir,
          "--portal",
          `http://127.0.0.1:${portal.port}`,
          "--channel",
          "dev",
          "--allow-stale",
        ],
        envWithoutToken({ JAVA_BIN: javaBin }),
        ctx.serverDir,
      );

      // The deploy's channel and release reads carried the token from .minecraft-env.
      expect(seen).toEqual([
        { path: "/api/v1/channels/dev", authorization: `Bearer ${TOKEN}` },
        { path: "/api/v1/releases/9.9.9", authorization: `Bearer ${TOKEN}` },
      ]);

      expect(res.status).toBe(0);
      expect(res.stdout).toContain("MOCK JAVA LAUNCHED");
      // Other .minecraft-env values still reach the server process; the token does not.
      expect(res.stdout).toContain("CHILD_CONTROL=[from-env-file]");
      expect(res.stdout).toContain("CHILD_DEPLOY_TOKEN=[]");
      // lampasctl never prints the token either.
      expect(res.stdout).not.toContain(TOKEN);
      expect(res.stderr).not.toContain(TOKEN);
    } finally {
      await portal.stop(true);
      ctx.cleanup();
    }
  });

  test("a token in the process environment (systemd EnvironmentFile) is absent from the server process", async () => {
    const ctx = setupServerDir();
    try {
      ctx.createManagedRuntime();
      const javaBin = writeEnvPrintingJava(ctx.serverDir);

      const res = await runLampasctlAsync(
        ["start", "--target", ctx.serverDir, "--no-sync"],
        envWithoutToken({
          JAVA_BIN: javaBin,
          PACK_DEPLOY_TOKEN: TOKEN,
          LAMPAS_TEST_CONTROL: "from-process-env",
        }),
        ctx.serverDir,
      );

      expect(res.status).toBe(0);
      expect(res.stdout).toContain("MOCK JAVA LAUNCHED");
      expect(res.stdout).toContain("CHILD_CONTROL=[from-process-env]");
      expect(res.stdout).toContain("CHILD_DEPLOY_TOKEN=[]");
      expect(res.stdout).not.toContain(TOKEN);
      expect(res.stderr).not.toContain(TOKEN);
    } finally {
      ctx.cleanup();
    }
  });

  test("serverProcessEnv drops only the deploy token and leaves its input unchanged", () => {
    const env = { PATH: "/usr/bin", PACK_DEPLOY_TOKEN: TOKEN, JDK_JAVA_OPTIONS: "-Dx=y" };

    expect(serverProcessEnv(env, "linux")).toEqual({ PATH: "/usr/bin", JDK_JAVA_OPTIONS: "-Dx=y" });
    expect(env.PACK_DEPLOY_TOKEN).toBe(TOKEN);
    // POSIX names are case-sensitive: a differently cased name is another variable.
    expect(serverProcessEnv({ pack_deploy_token: "other" }, "linux")).toEqual({
      pack_deploy_token: "other",
    });
  });

  test("serverProcessEnv matches the token name case-insensitively on Windows", () => {
    expect(serverProcessEnv({ Path: "C:/bin", Pack_Deploy_Token: TOKEN }, "win32")).toEqual({
      Path: "C:/bin",
    });
  });

  test("a deploy rejected with 401 for a missing token stops the launch and names PACK_DEPLOY_TOKEN", async () => {
    const ctx = setupServerDir();
    const portal = Bun.serve({
      port: 0,
      fetch() {
        return new Response("Unauthorized", { status: 401, statusText: "Unauthorized" });
      },
    });
    try {
      ctx.createManagedRuntime();
      const javaBin = writeEnvPrintingJava(ctx.serverDir);

      const res = await runLampasctlAsync(
        [
          "start",
          "--target",
          ctx.serverDir,
          "--portal",
          `http://127.0.0.1:${portal.port}`,
          "--channel",
          "dev",
        ],
        envWithoutToken({ JAVA_BIN: javaBin }),
        ctx.serverDir,
      );

      expect(res.status).toBe(1);
      expect(res.stderr).toContain("[Starter Error] Pack deployment failed:");
      expect(res.stderr).toContain("PACK_DEPLOY_TOKEN");
      expect(res.stderr).toContain("HTTP 401");
      expect(res.stdout).not.toContain("MOCK JAVA LAUNCHED");
    } finally {
      await portal.stop(true);
      ctx.cleanup();
    }
  });
});
