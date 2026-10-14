import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as fflate from "fflate";
import {
  isMuslHost,
  RELEASE_TARGETS,
  releaseArchiveName,
  resolveHostTarget,
  type TargetDefinition,
} from "./release-targets";
import { DEFAULT_DOWNLOAD_TIMEOUT_MS, DEFAULT_OPERATION_TIMEOUT_MS, withAbortTimeout } from "./utils";

export const LAMPASCTL_RELEASE_REPO = "justbecauseph/lampas-pipeline";
export const LAMPASCTL_TAG_PREFIX = "lampasctl-v";
export const GITHUB_API_BASE_URL = "https://api.github.com";
const CHECKSUMS_ASSET = "SHA256SUMS";
const RELEASES_PER_PAGE = 100;
const MAX_RELEASE_PAGES = 10;
const DOWNLOAD_ATTEMPTS = 3;

export interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
  /** `sha256:<hex>`; GitHub fills it for assets uploaded since mid-2025. */
  digest?: string | null;
}

export interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  html_url?: string;
  assets: GithubReleaseAsset[];
}

// ---------------------------------------------------------------------------
// Semantic versions
// ---------------------------------------------------------------------------

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSemver(version: string): SemVer | null {
  const match = SEMVER_REGEX.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semver 2.0.0 precedence: negative when a < b, zero when equal, positive when a > b. Build metadata is ignored. */
export function compareSemver(a: SemVer, b: SemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return Math.sign(a[key] - b[key]);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    if (i >= a.prerelease.length) return -1;
    if (i >= b.prerelease.length) return 1;
    const result = compareIdentifiers(a.prerelease[i], b.prerelease[i]);
    if (result !== 0) return result;
  }
  return 0;
}

/** Version of a `lampasctl-v<semver>` tag, or null for any other tag. */
export function versionFromTag(tag: string): string | null {
  if (!tag.startsWith(LAMPASCTL_TAG_PREFIX)) return null;
  const version = tag.substring(LAMPASCTL_TAG_PREFIX.length);
  return parseSemver(version) ? version : null;
}

/** The highest-precedence published lampasctl release. Prereleases count only when `includePrerelease` is set. */
export function selectNewestRelease(
  releases: GithubRelease[],
  includePrerelease: boolean
): { release: GithubRelease; version: string } | null {
  let best: { release: GithubRelease; version: string; semver: SemVer } | null = null;
  for (const release of releases) {
    if (release.draft) continue;
    const version = versionFromTag(release.tag_name);
    if (!version) continue;
    const semver = parseSemver(version)!;
    if ((release.prerelease || semver.prerelease.length > 0) && !includePrerelease) continue;
    if (!best || compareSemver(semver, best.semver) > 0) {
      best = { release, version, semver };
    }
  }
  return best ? { release: best.release, version: best.version } : null;
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

export interface GithubClientOptions {
  repo?: string;
  apiBaseUrl?: string;
  /** Sent only to the GitHub API, never to asset downloads. Defaults to GITHUB_TOKEN, then GH_TOKEN. */
  token?: string;
  userAgent?: string;
  timeoutMs?: number;
}

function githubToken(options: GithubClientOptions): string | undefined {
  return options.token ?? (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined);
}

async function githubGetJson<T>(
  apiPath: string,
  options: GithubClientOptions
): Promise<{ status: number; body: T | null }> {
  const base = (options.apiBaseUrl ?? GITHUB_API_BASE_URL).replace(/\/+$/, "");
  const url = `${base}${apiPath}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": options.userAgent ?? "lampasctl",
  };
  const token = githubToken(options);
  if (token) headers.Authorization = `Bearer ${token}`;

  return withAbortTimeout(
    `requesting ${url}`,
    async (signal) => {
      const res = await fetch(url, { headers, signal });
      if (res.status === 404) return { status: 404, body: null };
      if (!res.ok) {
        const rateLimited =
          res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
        if (rateLimited) {
          const reset = Number(res.headers.get("x-ratelimit-reset"));
          const resetAt = Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString()}` : "";
          throw new Error(
            `GitHub API rate limit reached${resetAt}. Set GITHUB_TOKEN or GH_TOKEN to raise the limit.`
          );
        }
        if (res.status === 401 && token) {
          throw new Error("GitHub API rejected the token (HTTP 401). Check or unset GITHUB_TOKEN / GH_TOKEN.");
        }
        throw new Error(`GitHub API request ${url} failed: HTTP ${res.status} ${res.statusText}`);
      }
      const text = await res.text();
      try {
        return { status: res.status, body: JSON.parse(text) as T };
      } catch {
        throw new Error(`GitHub API returned invalid JSON for ${url}`);
      }
    },
    options.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
  );
}

export async function listGithubReleases(options: GithubClientOptions = {}): Promise<GithubRelease[]> {
  const repo = options.repo ?? LAMPASCTL_RELEASE_REPO;
  const releases: GithubRelease[] = [];
  for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
    const { status, body } = await githubGetJson<GithubRelease[]>(
      `/repos/${repo}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`,
      options
    );
    if (status === 404) throw new Error(`GitHub repository ${repo} was not found`);
    if (!Array.isArray(body)) throw new Error(`GitHub API returned an unexpected release list for ${repo}`);
    releases.push(...body);
    if (body.length < RELEASES_PER_PAGE) break;
  }
  return releases;
}

export async function getGithubReleaseByTag(
  tag: string,
  options: GithubClientOptions = {}
): Promise<GithubRelease | null> {
  const repo = options.repo ?? LAMPASCTL_RELEASE_REPO;
  const { body } = await githubGetJson<GithubRelease>(
    `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
    options
  );
  return body && !body.draft ? body : null;
}

// ---------------------------------------------------------------------------
// Downloads, checksums and archives
// ---------------------------------------------------------------------------

async function downloadBytes(url: string, timeoutMs: number, attempts: number): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await withAbortTimeout(
        `downloading ${url}`,
        async (signal) => {
          const res = await fetch(url, { signal });
          if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
          return new Uint8Array(await res.arrayBuffer());
        },
        timeoutMs
      );
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
      }
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Failed to download ${url} after ${attempts} attempts: ${reason}`, { cause: lastError });
}

/** Parses `sha256sum` output (`<hex>  <name>` or `<hex> *<name>`) into a name → lowercase hex map. */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (match) sums.set(match[2].trim(), match[1].toLowerCase());
  }
  return sums;
}

function readTarString(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return Buffer.from(end === -1 ? slice : slice.subarray(0, end)).toString("utf-8");
}

/** Reads the regular file named `fileName` (at the archive root) from a gzip-compressed tar archive. */
export function extractFromTarGz(archive: Uint8Array, fileName: string): Uint8Array | null {
  const tar = new Uint8Array(zlib.gunzipSync(archive));
  let offset = 0;
  let longName: string | null = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const sizeField = readTarString(header, 124, 12).trim();
    const size = sizeField ? parseInt(sizeField, 8) : 0;
    if (!Number.isFinite(size) || size < 0) throw new Error("Corrupt tar archive: invalid entry size");
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error("Corrupt tar archive: entry extends past the end of the archive");

    const typeFlag = String.fromCharCode(header[156]);
    if (typeFlag === "L") {
      longName = readTarString(tar, dataStart, size);
    } else {
      let name = longName ?? readTarString(header, 0, 100);
      longName = null;
      const prefix = readTarString(header, 345, 155);
      if (prefix && readTarString(header, 257, 6) === "ustar") name = `${prefix}/${name}`;
      name = name.replace(/^\.\//, "");
      if ((typeFlag === "0" || header[156] === 0) && name === fileName) {
        return tar.slice(dataStart, dataEnd);
      }
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** Reads the file named `fileName` (at the archive root) from a zip archive. */
export function extractFromZip(archive: Uint8Array, fileName: string): Uint8Array | null {
  const files = fflate.unzipSync(archive, { filter: (file) => file.name === fileName });
  return files[fileName] ?? null;
}

export function extractExecutable(archive: Uint8Array, target: TargetDefinition): Uint8Array {
  const data =
    target.archiveExt === ".zip"
      ? extractFromZip(archive, target.exeName)
      : extractFromTarGz(archive, target.exeName);
  if (!data || data.length === 0) {
    throw new Error(`Release archive does not contain ${target.exeName}`);
  }
  return data;
}

export interface DownloadedRelease {
  version: string;
  archiveName: string;
  sha256: string;
  executable: Uint8Array;
}

/**
 * Downloads the host archive of `release`, checks it against the release's SHA256SUMS entry, the
 * asset size and the GitHub asset digest, and returns the extracted executable.
 */
export async function downloadReleaseExecutable(
  release: GithubRelease,
  version: string,
  target: TargetDefinition,
  options: { timeoutMs?: number; attempts?: number } = {}
): Promise<DownloadedRelease> {
  const archiveName = releaseArchiveName(version, target);
  const asset = release.assets.find((a) => a.name === archiveName);
  if (!asset) {
    const available = release.assets
      .map((a) => a.name)
      .filter((name) => name.startsWith("lampasctl_"))
      .join(", ");
    throw new Error(
      `${release.tag_name} has no build for ${target.id} (expected ${archiveName}; available: ${available || "none"})`
    );
  }
  const sumsAsset = release.assets.find((a) => a.name === CHECKSUMS_ASSET);
  if (!sumsAsset) {
    throw new Error(`${release.tag_name} has no ${CHECKSUMS_ASSET} asset; refusing to install an unverified binary`);
  }

  const attempts = options.attempts ?? DOWNLOAD_ATTEMPTS;
  const sumsText = Buffer.from(
    await downloadBytes(sumsAsset.browser_download_url, DEFAULT_OPERATION_TIMEOUT_MS, attempts)
  ).toString("utf-8");
  const expected = parseChecksums(sumsText).get(archiveName);
  if (!expected) {
    throw new Error(`${CHECKSUMS_ASSET} of ${release.tag_name} has no entry for ${archiveName}`);
  }
  const digest = asset.digest?.toLowerCase();
  if (digest?.startsWith("sha256:") && digest.substring(7) !== expected) {
    throw new Error(`GitHub asset digest of ${archiveName} does not match ${CHECKSUMS_ASSET}`);
  }

  const archive = await downloadBytes(
    asset.browser_download_url,
    options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
    attempts
  );
  if (asset.size > 0 && archive.length !== asset.size) {
    throw new Error(`Size mismatch for ${archiveName}: expected ${asset.size} bytes, got ${archive.length}`);
  }
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch for ${archiveName}: expected ${expected}, got ${actual}`);
  }

  return { version, archiveName, sha256: actual, executable: extractExecutable(archive, target) };
}

// ---------------------------------------------------------------------------
// Installing over the running executable
// ---------------------------------------------------------------------------

declare const LAMPASCTL_TARGET: string | undefined;

/** Release target id baked into compiled builds by build-release.ts, or null when running from source. */
export function compiledTargetId(): string | null {
  return typeof LAMPASCTL_TARGET !== "undefined" && LAMPASCTL_TARGET ? LAMPASCTL_TARGET : null;
}

/**
 * The release target to download: the running binary's own target when it was compiled by
 * build-release.ts, otherwise detected from the host.
 */
export function resolveUpdateTarget(): TargetDefinition {
  const compiled = compiledTargetId();
  const target = compiled ? RELEASE_TARGETS.find((t) => t.id === compiled) : undefined;
  return target ?? resolveHostTarget({ musl: isMuslHost() });
}

/**
 * Path of `execPath` with symlinks resolved, or null when it is the `bun` or `node` runtime.
 * Callers also require {@link compiledTargetId} so a renamed Bun runtime is never replaced.
 */
export function resolveStandaloneExecutable(execPath = process.execPath): string | null {
  const name = path.basename(execPath).toLowerCase().replace(/\.exe$/, "");
  if (name === "bun" || name === "node") return null;
  try {
    return fs.realpathSync(execPath);
  } catch {
    return execPath;
  }
}

function splitExecutableName(exePath: string): { dir: string; stem: string; ext: string } {
  const ext = path.extname(exePath);
  return { dir: path.dirname(exePath), stem: path.basename(exePath, ext), ext };
}

function uniqueSuffix(): string {
  return `${process.pid}-${Date.now().toString(36)}`;
}

/** Where Windows moves the replaced executable (`lampasctl.old-<pid>-<time>.exe`) until a later run deletes it. */
export function previousExecutablePath(exePath: string): string {
  const { dir, stem, ext } = splitExecutableName(exePath);
  return path.join(dir, `${stem}.old-${uniqueSuffix()}${ext}`);
}

/**
 * Deletes executables that earlier Windows self-updates moved aside. Files still locked by a
 * running lampasctl process are skipped; a later run removes them.
 */
export function cleanupPreviousExecutables(
  exePath: string | null = compiledTargetId() ? resolveStandaloneExecutable() : null
): void {
  if (!exePath) return;
  const { dir, stem, ext } = splitExecutableName(exePath);
  const prefix = `${stem}.old-`.toLowerCase();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const lower = name.toLowerCase();
    if (!lower.startsWith(prefix) || !lower.endsWith(ext.toLowerCase())) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // Still running.
    }
  }
}

/** Runs `<exe> --version` and checks that it reports `lampasctl <version>`. */
export function verifyExecutableVersion(exePath: string, version: string): void {
  const result = spawnSync(exePath, ["--version"], { encoding: "utf-8", timeout: 60_000 });
  if (result.error) {
    throw new Error(`The downloaded binary failed to run: ${result.error.message}`);
  }
  const output = (result.stdout ?? "").trim();
  if (result.status !== 0 || output !== `lampasctl ${version}`) {
    const detail = output || (result.stderr ?? "").trim() || `exit code ${result.status}`;
    throw new Error(`The downloaded binary did not report lampasctl ${version} (got: ${detail})`);
  }
}

function permissionHint(error: any, dir: string): Error {
  if (error?.code === "EACCES" || error?.code === "EPERM" || error?.code === "EROFS") {
    return new Error(
      `Cannot write to ${dir} (${error.code}). Rerun with permission to modify the lampasctl install (for example with sudo).`,
      { cause: error }
    );
  }
  return error;
}

export interface InstallExecutableOptions {
  exePath: string;
  executable: Uint8Array;
  version: string;
  platform?: NodeJS.Platform;
  /** Checks the staged binary before it replaces `exePath`. Defaults to {@link verifyExecutableVersion}. */
  verify?: (stagedPath: string, version: string) => void;
}

/**
 * Writes `executable` next to `exePath`, verifies it, then swaps it in. POSIX renames over the
 * running file and keeps its mode (and owner, when running as root). Windows cannot overwrite a
 * running exe, so it moves the current file to {@link previousExecutablePath} first and moves it
 * back if the second rename fails.
 */
export function installExecutable(options: InstallExecutableOptions): void {
  const { exePath, executable, version } = options;
  const platform = options.platform ?? process.platform;
  const verify = options.verify ?? verifyExecutableVersion;
  const { dir, stem, ext } = splitExecutableName(exePath);
  const stagedPath = path.join(dir, `${stem}.new-${uniqueSuffix()}${ext}`);

  try {
    let current: fs.Stats | undefined;
    try {
      current = fs.statSync(exePath);
    } catch {
      // Keep the defaults below when the current file cannot be inspected.
    }
    const mode = platform !== "win32" && current ? current.mode & 0o777 : 0o755;
    fs.writeFileSync(stagedPath, executable, { flag: "wx", mode });
    if (platform !== "win32") {
      fs.chmodSync(stagedPath, mode);
      if (current && process.getuid?.() === 0) fs.chownSync(stagedPath, current.uid, current.gid);
    }
  } catch (error) {
    fs.rmSync(stagedPath, { force: true });
    throw permissionHint(error, dir);
  }

  try {
    verify(stagedPath, version);
  } catch (error) {
    fs.rmSync(stagedPath, { force: true });
    throw error;
  }

  if (platform !== "win32") {
    try {
      fs.renameSync(stagedPath, exePath);
    } catch (error) {
      fs.rmSync(stagedPath, { force: true });
      throw permissionHint(error, dir);
    }
    return;
  }

  const oldPath = previousExecutablePath(exePath);
  try {
    fs.renameSync(exePath, oldPath);
  } catch (error) {
    fs.rmSync(stagedPath, { force: true });
    throw permissionHint(error, dir);
  }
  try {
    fs.renameSync(stagedPath, exePath);
  } catch (error) {
    try {
      fs.renameSync(oldPath, exePath);
    } catch (restoreError: any) {
      throw new Error(
        `Failed to install the new binary and to restore the previous one; it is at ${oldPath}: ${restoreError?.message}`,
        { cause: error }
      );
    }
    fs.rmSync(stagedPath, { force: true });
    throw permissionHint(error, dir);
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export interface SelfUpdateOptions extends GithubClientOptions {
  currentVersion: string;
  /** Exact version to install (`1.2.0`, `v1.2.0` or `lampasctl-v1.2.0`). */
  version?: string;
  checkOnly?: boolean;
  includePrerelease?: boolean;
  force?: boolean;
  /** Defaults to the running executable when it is a compiled lampasctl build. */
  exePath?: string | null;
  target?: TargetDefinition;
  platform?: NodeJS.Platform;
  verify?: (stagedPath: string, version: string) => void;
  log?: (message: string) => void;
}

export type SelfUpdateOutcome =
  | { status: "up-to-date"; currentVersion: string; latestVersion: string }
  | { status: "update-available"; currentVersion: string; latestVersion: string }
  | { status: "updated"; previousVersion: string; version: string; exePath: string };

function normalizeRequestedVersion(raw: string): string {
  let version = raw.trim();
  if (version.startsWith(LAMPASCTL_TAG_PREFIX)) version = version.substring(LAMPASCTL_TAG_PREFIX.length);
  else if (version.startsWith("v")) version = version.substring(1);
  if (!parseSemver(version)) {
    throw new Error(`--version must be a semantic version such as 1.2.0 (got '${raw}')`);
  }
  return version;
}

export async function selfUpdate(options: SelfUpdateOptions): Promise<SelfUpdateOutcome> {
  const log = options.log ?? ((message: string) => console.log(message));
  const current = options.currentVersion;
  const currentSemver = parseSemver(current);
  const client: GithubClientOptions = {
    repo: options.repo,
    apiBaseUrl: options.apiBaseUrl,
    token: options.token,
    timeoutMs: options.timeoutMs,
    userAgent: options.userAgent ?? `lampasctl/${current}`,
  };

  let release: GithubRelease;
  let version: string;
  if (options.version) {
    version = normalizeRequestedVersion(options.version);
    const found = await getGithubReleaseByTag(`${LAMPASCTL_TAG_PREFIX}${version}`, client);
    if (!found) {
      throw new Error(`No published release ${LAMPASCTL_TAG_PREFIX}${version} in ${client.repo ?? LAMPASCTL_RELEASE_REPO}`);
    }
    release = found;
  } else {
    const newest = selectNewestRelease(await listGithubReleases(client), options.includePrerelease === true);
    if (!newest) {
      throw new Error(`No published lampasctl releases found in ${client.repo ?? LAMPASCTL_RELEASE_REPO}`);
    }
    ({ release, version } = newest);
  }

  const targetSemver = parseSemver(version)!;
  const order = currentSemver ? compareSemver(targetSemver, currentSemver) : 1;
  const explicit = Boolean(options.version);

  if (options.checkOnly) {
    if (!currentSemver) {
      log(`The latest lampasctl release is ${version} (current: ${current}).`);
      return { status: "update-available", currentVersion: current, latestVersion: version };
    }
    if (order > 0) {
      log(`lampasctl ${version} is available (current: ${current}). Run 'lampasctl self-update' to install it.`);
      return { status: "update-available", currentVersion: current, latestVersion: version };
    }
    log(
      order === 0
        ? `lampasctl ${current} is up to date.`
        : `lampasctl ${current} is newer than ${explicit ? "the requested" : "the latest published"} release ${version}.`
    );
    return { status: "up-to-date", currentVersion: current, latestVersion: version };
  }

  // Without --version, --force only reinstalls the same version; it never downgrades.
  if (!explicit && (order < 0 || (order === 0 && !options.force))) {
    log(
      order === 0
        ? `lampasctl ${current} is up to date.`
        : `lampasctl ${current} is newer than the latest published release ${version}; nothing to do.`
    );
    return { status: "up-to-date", currentVersion: current, latestVersion: version };
  }
  if (!options.force && explicit && order === 0) {
    log(`lampasctl ${current} is already installed. Pass --force to reinstall it.`);
    return { status: "up-to-date", currentVersion: current, latestVersion: version };
  }

  const exePath =
    options.exePath === undefined ? (compiledTargetId() ? resolveStandaloneExecutable() : null) : options.exePath;
  if (!exePath) {
    throw new Error(
      "self-update replaces the standalone lampasctl binary, but this lampasctl runs from source. Update the checkout with git instead."
    );
  }
  const target = options.target ?? resolveUpdateTarget();

  log(`Downloading lampasctl ${version} (${target.id}) from ${release.html_url ?? release.tag_name}...`);
  const downloaded = await downloadReleaseExecutable(release, version, target, { timeoutMs: options.timeoutMs });
  log(`Verified ${downloaded.archiveName} (SHA-256 ${downloaded.sha256}).`);

  installExecutable({
    exePath,
    executable: downloaded.executable,
    version,
    platform: options.platform,
    verify: options.verify,
  });
  log(`Updated lampasctl ${current} -> ${version} at ${exePath}.`);
  return { status: "updated", previousVersion: current, version, exePath };
}
