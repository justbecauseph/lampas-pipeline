import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTarGzArchive, createZipArchive } from "../scripts/build-release";
import { RELEASE_TARGETS, resolveHostTarget } from "../src/release-targets";
import {
  cleanupPreviousExecutables,
  compareSemver,
  extractFromTarGz,
  extractFromZip,
  installExecutable,
  parseChecksums,
  parseSemver,
  resolveStandaloneExecutable,
  selectNewestRelease,
  selfUpdate,
  versionFromTag,
  type GithubRelease,
} from "../src/self-update";

const linuxTarget = RELEASE_TARGETS.find((t) => t.id === "linux_x64")!;
const windowsTarget = RELEASE_TARGETS.find((t) => t.id === "windows_x64")!;

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function release(tag: string, extra: Partial<GithubRelease> = {}): GithubRelease {
  return { tag_name: tag, draft: false, prerelease: false, assets: [], ...extra };
}

describe("semantic versions", () => {
  test("orders versions by semver 2.0.0 precedence", () => {
    // Precedence example from semver.org section 11, followed by plain releases.
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.10",
      "1.2.0",
      "2.0.0",
    ];
    for (let i = 0; i < ordered.length - 1; i++) {
      const a = parseSemver(ordered[i])!;
      const b = parseSemver(ordered[i + 1])!;
      expect(compareSemver(a, b)).toBe(-1);
      expect(compareSemver(b, a)).toBe(1);
    }
    expect(compareSemver(parseSemver("1.2.0+build.5")!, parseSemver("1.2.0")!)).toBe(0);
  });

  test("rejects non-semver strings", () => {
    expect(parseSemver("dev")).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("01.2.3")).toBeNull();
  });

  test("reads versions only from lampasctl-v tags", () => {
    expect(versionFromTag("lampasctl-v1.2.0")).toBe("1.2.0");
    expect(versionFromTag("lampasctl-v1.3.0-rc.1")).toBe("1.3.0-rc.1");
    expect(versionFromTag("v1.2.0")).toBeNull();
    expect(versionFromTag("pack-v2.3.36")).toBeNull();
    expect(versionFromTag("lampasctl-vnext")).toBeNull();
  });

  test("selects the newest stable release, ignoring drafts and other tags", () => {
    const releases = [
      release("lampasctl-v1.0.10"),
      release("lampasctl-v1.2.0"),
      release("lampasctl-v1.1.0"),
      release("lampasctl-v9.0.0", { draft: true }),
      release("lampasctl-v1.3.0-rc.1", { prerelease: true }),
      release("pack-v5.0.0"),
    ];
    expect(selectNewestRelease(releases, false)?.version).toBe("1.2.0");
    expect(selectNewestRelease(releases, true)?.version).toBe("1.3.0-rc.1");
    expect(selectNewestRelease([release("pack-v5.0.0")], true)).toBeNull();
  });

  test("treats a prerelease version as a prerelease even when the GitHub flag is unset", () => {
    const releases = [release("lampasctl-v1.2.0"), release("lampasctl-v1.3.0-beta.1")];
    expect(selectNewestRelease(releases, false)?.version).toBe("1.2.0");
  });
});

describe("release assets", () => {
  test("parses sha256sum output in text and binary mode", () => {
    const a = "a".repeat(64);
    const b = "B".repeat(64);
    const sums = parseChecksums(`${a}  lampasctl_1.2.0_linux_x64.tar.gz\r\n${b} *lampasctl_1.2.0_windows_x64.zip\nnot a line\n`);
    expect(sums.get("lampasctl_1.2.0_linux_x64.tar.gz")).toBe(a);
    expect(sums.get("lampasctl_1.2.0_windows_x64.zip")).toBe("b".repeat(64));
    expect(sums.size).toBe(2);
  });

  test("extracts the executable from release tar.gz and zip archives", () => {
    const payload = new Uint8Array(1500).map((_, i) => i % 251);
    expect(extractFromTarGz(createTarGzArchive("lampasctl", payload), "lampasctl")).toEqual(payload);
    expect(extractFromTarGz(createTarGzArchive("other", payload), "lampasctl")).toBeNull();
    expect(extractFromZip(createZipArchive("lampasctl.exe", payload), "lampasctl.exe")).toEqual(payload);
    expect(extractFromZip(createZipArchive("other.exe", payload), "lampasctl.exe")).toBeNull();
  });

  test("resolves host targets, including musl Linux", () => {
    expect(resolveHostTarget({ platform: "linux", arch: "x64" }).id).toBe("linux_x64");
    expect(resolveHostTarget({ platform: "linux", arch: "x64", musl: true }).id).toBe("linux_x64_musl");
    expect(resolveHostTarget({ platform: "linux", arch: "arm64", musl: true }).id).toBe("linux_arm64_musl");
    expect(resolveHostTarget({ platform: "win32", arch: "x64" }).id).toBe("windows_x64");
    expect(resolveHostTarget({ platform: "darwin", arch: "arm64" }).id).toBe("darwin_arm64");
  });

  test("does not treat bun or node as the lampasctl executable", () => {
    expect(resolveStandaloneExecutable("/usr/local/bin/bun")).toBeNull();
    expect(resolveStandaloneExecutable("C:\\Users\\me\\.bun\\bin\\bun.exe")).toBeNull();
    expect(resolveStandaloneExecutable("/usr/bin/node")).toBeNull();
    expect(resolveStandaloneExecutable("/opt/lampas/lampasctl")).toBe("/opt/lampas/lampasctl");
  });
});

describe("installExecutable", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampasctl-self-update-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("POSIX: replaces the executable and passes the staged file to verify", () => {
    const exePath = path.join(dir, "lampasctl");
    fs.writeFileSync(exePath, "old", { mode: 0o750 });
    let verified: { stagedPath: string; version: string; content: string } | undefined;

    installExecutable({
      exePath,
      executable: Buffer.from("new"),
      version: "1.2.0",
      platform: "linux",
      verify: (stagedPath, version) => {
        verified = { stagedPath, version, content: fs.readFileSync(stagedPath, "utf-8") };
      },
    });

    expect(fs.readFileSync(exePath, "utf-8")).toBe("new");
    expect(verified?.version).toBe("1.2.0");
    expect(verified?.content).toBe("new");
    expect(fs.existsSync(verified!.stagedPath)).toBe(false);
    if (process.platform !== "win32") {
      expect(fs.statSync(exePath).mode & 0o777).toBe(0o750);
    }
    expect(fs.readdirSync(dir)).toEqual(["lampasctl"]);
  });

  test("keeps the current executable when verification fails", () => {
    const exePath = path.join(dir, "lampasctl");
    fs.writeFileSync(exePath, "old");

    expect(() =>
      installExecutable({
        exePath,
        executable: Buffer.from("broken"),
        version: "1.2.0",
        platform: "linux",
        verify: () => {
          throw new Error("did not report lampasctl 1.2.0");
        },
      })
    ).toThrow("did not report lampasctl 1.2.0");

    expect(fs.readFileSync(exePath, "utf-8")).toBe("old");
    expect(fs.readdirSync(dir)).toEqual(["lampasctl"]);
  });

  test("Windows: moves the running exe aside, and a later cleanup removes it", () => {
    const exePath = path.join(dir, "lampasctl.exe");
    fs.writeFileSync(exePath, "old");
    // Left by an earlier update whose process may still be running.
    fs.writeFileSync(path.join(dir, "lampasctl.old-123-abc.exe"), "older");
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep");

    installExecutable({ exePath, executable: Buffer.from("new"), version: "1.2.0", platform: "win32", verify: () => {} });

    expect(fs.readFileSync(exePath, "utf-8")).toBe("new");
    const moved = fs.readdirSync(dir).filter((name) => /^lampasctl\.old-.+\.exe$/.test(name) && name !== "lampasctl.old-123-abc.exe");
    expect(moved.length).toBe(1);
    expect(fs.readFileSync(path.join(dir, moved[0]), "utf-8")).toBe("old");

    cleanupPreviousExecutables(exePath);
    expect(fs.readdirSync(dir).sort()).toEqual(["lampasctl.exe", "notes.txt"]);
  });

  test("Windows: restores the previous exe when the new one cannot be moved into place", () => {
    const exePath = path.join(dir, "lampasctl.exe");
    fs.writeFileSync(exePath, "old");

    expect(() =>
      installExecutable({
        exePath,
        executable: Buffer.from("new"),
        version: "1.2.0",
        platform: "win32",
        // Removing the staged file makes the final rename fail after the current exe was moved aside.
        verify: (stagedPath) => fs.rmSync(stagedPath),
      })
    ).toThrow();

    expect(fs.readFileSync(exePath, "utf-8")).toBe("old");
    expect(fs.readdirSync(dir)).toEqual(["lampasctl.exe"]);
  });
});

describe("selfUpdate", () => {
  const originalFetch = globalThis.fetch;
  const api = "https://api.test";
  const downloads = "https://downloads.test";
  let dir: string;
  let exePath: string;
  let requests: { url: string; headers: Headers }[];
  let routes: Map<string, () => Response>;

  function json(body: unknown, status = 200, headers: Record<string, string> = {}): () => Response {
    return () => new Response(JSON.stringify(body), { status, headers });
  }

  function bytes(data: Uint8Array | string): () => Response {
    return () => new Response(data as BodyInit);
  }

  /** A release with a linux_x64 archive whose executable contains `content`, plus SHA256SUMS. */
  function publish(
    version: string,
    content: string,
    options: { prerelease?: boolean; sums?: string | null; digest?: string; size?: number } = {}
  ): GithubRelease {
    const archive = createTarGzArchive("lampasctl", Buffer.from(content));
    const archiveName = `lampasctl_${version}_linux_x64.tar.gz`;
    const tag = `lampasctl-v${version}`;
    routes.set(`${downloads}/${tag}/${archiveName}`, bytes(archive));
    const assets: GithubRelease["assets"] = [
      {
        name: archiveName,
        browser_download_url: `${downloads}/${tag}/${archiveName}`,
        size: options.size ?? archive.length,
        digest: options.digest ?? `sha256:${sha256(archive)}`,
      },
    ];
    if (options.sums !== null) {
      const sums = options.sums ?? `${sha256(archive)}  ${archiveName}\n`;
      routes.set(`${downloads}/${tag}/SHA256SUMS`, bytes(sums));
      assets.push({ name: "SHA256SUMS", browser_download_url: `${downloads}/${tag}/SHA256SUMS`, size: sums.length });
    }
    const rel = release(tag, { prerelease: options.prerelease ?? false, assets });
    routes.set(`${api}/repos/test/repo/releases/tags/${tag}`, json(rel));
    return rel;
  }

  function listReleases(releases: GithubRelease[]) {
    routes.set(`${api}/repos/test/repo/releases?per_page=100&page=1`, json(releases));
  }

  function run(overrides: Partial<Parameters<typeof selfUpdate>[0]> = {}) {
    const logs: string[] = [];
    const promise = selfUpdate({
      currentVersion: "1.1.0",
      repo: "test/repo",
      apiBaseUrl: api,
      token: "",
      exePath,
      target: linuxTarget,
      platform: "linux",
      verify: () => {},
      log: (message) => logs.push(message),
      ...overrides,
    });
    return { promise, logs };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampasctl-self-update-"));
    exePath = path.join(dir, "lampasctl");
    fs.writeFileSync(exePath, "current");
    requests = [];
    routes = new Map();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, headers: new Headers(init?.headers) });
      const route = routes.get(url);
      return route ? route() : new Response("not found", { status: 404 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("installs the newest stable release after verifying its checksum", async () => {
    listReleases([publish("1.2.0", "v1.2.0"), publish("1.1.0", "v1.1.0"), publish("1.3.0-rc.1", "rc", { prerelease: true })]);

    const { promise } = run();
    const outcome = await promise;

    expect(outcome).toEqual({ status: "updated", previousVersion: "1.1.0", version: "1.2.0", exePath });
    expect(fs.readFileSync(exePath, "utf-8")).toBe("v1.2.0");
  });

  test("includes prereleases with includePrerelease", async () => {
    listReleases([publish("1.2.0", "v1.2.0"), publish("1.3.0-rc.1", "rc", { prerelease: true })]);

    const outcome = await run({ includePrerelease: true }).promise;

    expect(outcome.status).toBe("updated");
    expect(fs.readFileSync(exePath, "utf-8")).toBe("rc");
  });

  test("reports an available update in check mode without downloading", async () => {
    listReleases([publish("1.2.0", "v1.2.0")]);

    const { promise, logs } = run({ checkOnly: true });

    expect(await promise).toEqual({ status: "update-available", currentVersion: "1.1.0", latestVersion: "1.2.0" });
    expect(logs.join("\n")).toContain("lampasctl 1.2.0 is available (current: 1.1.0)");
    expect(requests.some((r) => r.url.startsWith(downloads))).toBe(false);
    expect(fs.readFileSync(exePath, "utf-8")).toBe("current");
  });

  test("does nothing when the current version is the newest", async () => {
    listReleases([publish("1.1.0", "v1.1.0"), publish("1.0.10", "v1.0.10")]);

    const { promise, logs } = run();

    expect((await promise).status).toBe("up-to-date");
    expect(logs).toEqual(["lampasctl 1.1.0 is up to date."]);
    expect(fs.readFileSync(exePath, "utf-8")).toBe("current");
  });

  test("does not downgrade a build newer than the newest release, even with force", async () => {
    listReleases([publish("1.2.0", "v1.2.0")]);

    expect((await run({ currentVersion: "1.3.0-rc.1" }).promise).status).toBe("up-to-date");
    expect((await run({ currentVersion: "1.3.0", force: true }).promise).status).toBe("up-to-date");
    expect((await run({ currentVersion: "1.3.0", version: "" }).promise).status).toBe("up-to-date");
    expect(fs.readFileSync(exePath, "utf-8")).toBe("current");
  });

  test("reinstalls the newest release with force when it is already installed", async () => {
    listReleases([publish("1.2.0", "v1.2.0")]);

    expect((await run({ currentVersion: "1.2.0", force: true }).promise).status).toBe("updated");
    expect(fs.readFileSync(exePath, "utf-8")).toBe("v1.2.0");
  });

  test("installs an exact older version with --version", async () => {
    publish("1.0.10", "v1.0.10");

    const outcome = await run({ version: "lampasctl-v1.0.10" }).promise;

    expect(outcome).toEqual({ status: "updated", previousVersion: "1.1.0", version: "1.0.10", exePath });
    expect(fs.readFileSync(exePath, "utf-8")).toBe("v1.0.10");
  });

  test("reinstalls the current version only with force", async () => {
    publish("1.1.0", "reinstalled");

    expect((await run({ version: "1.1.0" }).promise).status).toBe("up-to-date");
    expect(fs.readFileSync(exePath, "utf-8")).toBe("current");

    expect((await run({ version: "1.1.0", force: true }).promise).status).toBe("updated");
    expect(fs.readFileSync(exePath, "utf-8")).toBe("reinstalled");
  });

  test("fails for an unpublished version or an invalid version string", async () => {
    await expect(run({ version: "9.9.9" }).promise).rejects.toThrow("No published release lampasctl-v9.9.9");
    await expect(run({ version: "latest" }).promise).rejects.toThrow("--version must be a semantic version");
  });

  test("rejects an archive whose SHA-256 does not match SHA256SUMS", async () => {
    listReleases([publish("1.2.0", "v1.2.0", { sums: `${"0".repeat(64)}  lampasctl_1.2.0_linux_x64.tar.gz\n`, digest: "" })]);

    await expect(run().promise).rejects.toThrow("SHA-256 mismatch for lampasctl_1.2.0_linux_x64.tar.gz");
    expect(fs.readFileSync(exePath, "utf-8")).toBe("current");
    expect(fs.readdirSync(dir)).toEqual(["lampasctl"]);
  });

  test("rejects a GitHub asset digest that disagrees with SHA256SUMS", async () => {
    listReleases([publish("1.2.0", "v1.2.0", { digest: `sha256:${"1".repeat(64)}` })]);

    await expect(run().promise).rejects.toThrow("does not match SHA256SUMS");
    expect(fs.readFileSync(exePath, "utf-8")).toBe("current");
  });

  test("rejects a size mismatch", async () => {
    listReleases([publish("1.2.0", "v1.2.0", { size: 1 })]);

    await expect(run().promise).rejects.toThrow("Size mismatch");
  });

  test("refuses releases without SHA256SUMS or without an entry for the archive", async () => {
    listReleases([publish("1.2.0", "v1.2.0", { sums: null })]);
    await expect(run().promise).rejects.toThrow("has no SHA256SUMS asset");

    listReleases([publish("1.2.0", "v1.2.0", { sums: `${"0".repeat(64)}  something-else.zip\n` })]);
    await expect(run().promise).rejects.toThrow("has no entry for lampasctl_1.2.0_linux_x64.tar.gz");
  });

  test("names the available builds when the host target has none", async () => {
    listReleases([publish("1.2.0", "v1.2.0")]);

    await expect(run({ target: windowsTarget }).promise).rejects.toThrow(
      "lampasctl-v1.2.0 has no build for windows_x64 (expected lampasctl_1.2.0_windows_x64.zip; available: lampasctl_1.2.0_linux_x64.tar.gz)"
    );
  });

  test("refuses to install when running from source", async () => {
    listReleases([publish("1.2.0", "v1.2.0")]);

    await expect(run({ exePath: null }).promise).rejects.toThrow("runs from source");
    expect(requests.some((r) => r.url.startsWith(downloads))).toBe(false);
  });

  test("reports the GitHub rate limit and suggests a token", async () => {
    routes.set(
      `${api}/repos/test/repo/releases?per_page=100&page=1`,
      json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1760000000" })
    );

    await expect(run().promise).rejects.toThrow("GitHub API rate limit reached until 2025-10-09T08:53:20.000Z. Set GITHUB_TOKEN");
  });

  test("names the token variables when GitHub rejects the token", async () => {
    routes.set(`${api}/repos/test/repo/releases?per_page=100&page=1`, json({ message: "Bad credentials" }, 401));

    await expect(run({ token: "expired" }).promise).rejects.toThrow("Check or unset GITHUB_TOKEN / GH_TOKEN");
  });

  test("sends the token to the GitHub API but not to asset downloads", async () => {
    listReleases([publish("1.2.0", "v1.2.0")]);

    await run({ token: "secret-token" }).promise;

    const apiRequests = requests.filter((r) => r.url.startsWith(api));
    const downloadRequests = requests.filter((r) => r.url.startsWith(downloads));
    expect(apiRequests.length).toBeGreaterThan(0);
    expect(apiRequests.every((r) => r.headers.get("authorization") === "Bearer secret-token")).toBe(true);
    expect(downloadRequests.length).toBe(2);
    expect(downloadRequests.every((r) => r.headers.get("authorization") === null)).toBe(true);
  });

  test("follows release list pages", async () => {
    const filler = Array.from({ length: 100 }, (_, i) => release(`other-v${i}`));
    routes.set(`${api}/repos/test/repo/releases?per_page=100&page=1`, json(filler));
    routes.set(`${api}/repos/test/repo/releases?per_page=100&page=2`, json([publish("1.2.0", "v1.2.0")]));

    const outcome = await run({ checkOnly: true }).promise;

    expect(outcome).toEqual({ status: "update-available", currentVersion: "1.1.0", latestVersion: "1.2.0" });
  });
});

describe("self-update CLI arguments", () => {
  const cliPath = path.resolve(__dirname, "../src/cli.ts");

  function cli(...args: string[]) {
    return spawnSync("bun", ["run", cliPath, "self-update", ...args], { encoding: "utf-8" });
  }

  test("--help prints usage instead of updating", () => {
    const res = cli("--help");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("self-update           Replace this lampasctl binary");
  });

  test("rejects positionals, unknown flags and an empty --version", () => {
    expect(cli("1.2.0").stderr).toContain("self-update does not accept 1.2.0");
    expect(cli("--dry-run").stderr).toContain("self-update does not accept --dry-run");
    expect(cli("--version").stderr).toContain("--version needs a value");
    expect(cli("--version=").stderr).toContain("--version needs a value");
    expect(cli("1.2.0").status).toBe(1);
  });
});
