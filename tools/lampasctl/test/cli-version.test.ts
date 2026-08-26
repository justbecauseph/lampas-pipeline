import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { getLampasctlVersion } from "../src/cli";

const cliPath = path.resolve(__dirname, "../src/cli.ts");

describe("lampasctl CLI version commands", () => {
  test("getLampasctlVersion defaults to dev when uncompiled and env unset", () => {
    delete process.env.LAMPASCTL_VERSION;
    expect(getLampasctlVersion()).toBe("dev");
  });

  test("getLampasctlVersion reads LAMPASCTL_VERSION environment variable", () => {
    process.env.LAMPASCTL_VERSION = "1.5.0-beta.2";
    expect(getLampasctlVersion()).toBe("1.5.0-beta.2");
    delete process.env.LAMPASCTL_VERSION;
  });

  test("CLI handles --version flag", () => {
    const res = spawnSync("bun", ["run", cliPath, "--version"], {
      encoding: "utf-8",
      env: { ...process.env, LAMPASCTL_VERSION: "2.0.0" },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("lampasctl 2.0.0");
  });

  test("CLI handles -v flag", () => {
    const res = spawnSync("bun", ["run", cliPath, "-v"], {
      encoding: "utf-8",
      env: { ...process.env, LAMPASCTL_VERSION: "2.0.0" },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("lampasctl 2.0.0");
  });

  test("CLI handles version command", () => {
    const res = spawnSync("bun", ["run", cliPath, "version"], {
      encoding: "utf-8",
      env: { ...process.env, LAMPASCTL_VERSION: "2.0.0" },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("lampasctl 2.0.0");
  });

  test("CLI help mentions version", () => {
    const res = spawnSync("bun", ["run", cliPath, "help"], {
      encoding: "utf-8",
      env: { ...process.env, LAMPASCTL_VERSION: "2.0.0" },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("lampasctl v2.0.0");
  });
});
