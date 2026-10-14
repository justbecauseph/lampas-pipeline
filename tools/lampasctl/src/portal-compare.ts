import { canonicalJson, computeManifestDiff, formatBytes, type DiffResult } from "./diff";
import { fetchManifest, fetchPortalText, parsePortalJson, resolveChannelVersion } from "./release-resolver";
import type { PackManifest, ReleaseDescriptor } from "./types";

export const PORTAL_CHANNELS = ["dev", "beta", "stable"] as const;
export type PortalChannel = (typeof PORTAL_CHANNELS)[number];

const TARGETS = ["client", "server"] as const;
type Target = (typeof TARGETS)[number];

const DEFAULT_COMPARE_TIMEOUT_MS = 10_000;

export function isPortalChannel(value: string): value is PortalChannel {
  return (PORTAL_CHANNELS as readonly string[]).includes(value);
}

export interface LocalPublishedState {
  published: boolean;
  /** Creation time from the release descriptor, when the Portal returned one. */
  created?: string;
  /** The Portal answered 410 for this version. */
  revoked?: boolean;
}

export interface PortalTargetComparison {
  target: Target;
  /** null when the Portal manifest could not be fetched or compared. */
  diff: DiffResult | null;
  /** Whole-manifest canonical JSON equals the Portal's manifest for the compared version. False when diff is null. */
  contentIdentical: boolean;
  error?: string;
}

export interface PortalComparison {
  portalUrl: string;
  channel: PortalChannel;
  localVersion: string;
  /** Version each channel points to. null means the channel could not be resolved; see channelErrors. */
  channels: Record<string, string | null>;
  /** Reason for each channel that could not be resolved. */
  channelErrors: Record<string, string>;
  /** null means the published check failed; localPublishedError holds the reason. */
  localPublished: LocalPublishedState | null;
  localPublishedError?: string;
  /** Version the selected channel points to. The diff targets are compared against this version. */
  compareVersion: string | null;
  targets: PortalTargetComparison[];
  /**
   * Whether publishing the local version would be rejected with 409. true: the Portal's stored copy of
   * localVersion differs from the local release in at least one field (publishConflictFields). false:
   * they match, or the version is not published. null: could not be determined; publishConflictError
   * says why.
   */
  publishConflict: boolean | null;
  /**
   * The fields that differ when publishConflict is true: release fields in the order
   * minecraft, loader.version, minimumLauncherVersion, protocol, launch, gitCommit, status, signature,
   * then clientManifest and serverManifest. Empty otherwise.
   */
  publishConflictFields: string[];
  publishConflictError?: string;
  error?: string;
}

export interface ComparePortalReleaseOptions {
  portalUrl: string;
  channel: PortalChannel;
  client: PackManifest;
  server: PackManifest;
  /** The locally built release descriptor (buildManifests' `release`). */
  release: ReleaseDescriptor;
  timeoutMs?: number;
}

type Fetched = { manifest: PackManifest } | { error: string };
type TargetManifests = Record<Target, Fetched>;

interface ChannelResult {
  name: PortalChannel;
  version: string | null;
  error?: string;
}

/** The release fields the Portal's publish check compares, as its release descriptor serves them. */
interface StoredRelease {
  minecraft?: unknown;
  loader?: { version?: unknown } | null;
  minimumLauncherVersion?: unknown;
  protocol?: unknown;
  status?: unknown;
  gitCommit?: unknown;
  launch?: unknown;
  signature?: unknown;
}

interface LocalPublishedCheck {
  state: LocalPublishedState | null;
  /** The release descriptor from a 200 response. */
  stored?: StoredRelease;
  error?: string;
}

interface PublishConflictOutcome {
  conflict: boolean | null;
  fields: string[];
  error?: string;
}

const MANIFEST_FIELDS: Record<Target, string> = { client: "clientManifest", server: "serverManifest" };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPackManifest(value: unknown): value is PackManifest {
  return typeof value === "object" && value !== null && Array.isArray((value as { files?: unknown }).files);
}

async function resolveChannel(portalUrl: string, name: PortalChannel, timeoutMs: number): Promise<ChannelResult> {
  try {
    return { name, version: await resolveChannelVersion(portalUrl, name, { timeoutMs }) };
  } catch (err) {
    return { name, version: null, error: errorMessage(err) };
  }
}

async function checkLocalPublished(portalUrl: string, version: string, timeoutMs: number): Promise<LocalPublishedCheck> {
  const url = `${portalUrl}/api/v1/releases/${encodeURIComponent(version)}`;
  try {
    const res = await fetchPortalText(url, `checking whether v${version} is published`, { timeoutMs });
    if (res.status === 404) {
      return { state: { published: false } };
    }
    if (res.status === 410) {
      return { state: { published: true, revoked: true } };
    }
    if (!res.ok) {
      return { state: null, error: `HTTP ${res.status} ${res.statusText}`.trim() };
    }
    const data = parsePortalJson<unknown>(res.text, `Invalid response for release v${version} from ${url}`);
    const record = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
    if (typeof record?.version !== "string") {
      return { state: null, error: `Invalid response for release v${version} from ${url}: missing 'version' property` };
    }
    return {
      state: typeof record.created === "string" ? { published: true, created: record.created } : { published: true },
      stored: record as StoredRelease,
    };
  } catch (err) {
    return { state: null, error: errorMessage(err) };
  }
}

async function fetchPortalManifest(
  portalUrl: string,
  version: string,
  target: Target,
  timeoutMs: number
): Promise<Fetched> {
  try {
    const manifest: unknown = await fetchManifest(portalUrl, version, target, { timeoutMs });
    if (!isPackManifest(manifest)) {
      return { error: `Portal ${target} manifest for v${version} has no 'files' array` };
    }
    return { manifest };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

async function fetchTargetManifests(portalUrl: string, version: string, timeoutMs: number): Promise<TargetManifests> {
  const [client, server] = await Promise.all([
    fetchPortalManifest(portalUrl, version, "client", timeoutMs),
    fetchPortalManifest(portalUrl, version, "server", timeoutMs),
  ]);
  return { client, server };
}

/**
 * Whether the local version is on the Portal. A failed status check still counts as published when
 * the selected channel already points at the local version.
 */
function isLocalPublished(state: LocalPublishedState | null, compareVersion: string | null, localVersion: string): boolean | null {
  if (state !== null) return state.published;
  return compareVersion === localVersion ? true : null;
}

function compareTarget(target: Target, fetched: Fetched, local: PackManifest): PortalTargetComparison {
  if ("error" in fetched) {
    return { target, diff: null, contentIdentical: false, error: fetched.error };
  }
  try {
    return {
      target,
      diff: computeManifestDiff(fetched.manifest, local),
      contentIdentical: canonicalJson(fetched.manifest) === canonicalJson(local),
    };
  } catch (err) {
    return { target, diff: null, contentIdentical: false, error: errorMessage(err) };
  }
}

/**
 * Release fields the Portal compares on publish (releaseContentMatches in the Portal's publish route),
 * each against the stored descriptor's value. Publishing sends no signature and always sends STABLE,
 * so any stored signature or other status differs.
 */
function releaseFieldDiffs(release: ReleaseDescriptor, stored: StoredRelease): string[] {
  const diffs: string[] = [];
  if (stored.minecraft !== release.minecraft) diffs.push("minecraft");
  if (stored.loader?.version !== release.loader.version) diffs.push("loader.version");
  if (stored.minimumLauncherVersion !== release.minimumLauncherVersion) diffs.push("minimumLauncherVersion");
  if (stored.protocol !== release.protocol) diffs.push("protocol");
  if (canonicalJson(stored.launch ?? null) !== canonicalJson(release.launch ?? null)) diffs.push("launch");
  if ((stored.gitCommit ?? null) !== (release.gitCommit ?? null)) diffs.push("gitCommit");
  if (stored.status !== "STABLE") diffs.push("status");
  if ((stored.signature ?? null) !== null) diffs.push("signature");
  return diffs;
}

/**
 * Compares the local release with the Portal's stored copy of the same version. The Portal rejects a
 * publish with 409 when any of these differ, so one difference is enough for a conflict. Without the
 * stored descriptor, the release fields are not checked, and a match is reported as unknown.
 */
function publishConflictFor(
  local: Record<Target, PackManifest>,
  release: ReleaseDescriptor,
  released: TargetManifests,
  stored: StoredRelease | undefined,
  storedError: string | undefined
): PublishConflictOutcome {
  const fields = stored ? releaseFieldDiffs(release, stored) : [];
  const errors: string[] = [];
  for (const target of TARGETS) {
    const fetched = released[target];
    if ("error" in fetched) {
      errors.push(`${target} manifest: ${fetched.error}`);
    } else if (canonicalJson(fetched.manifest) !== canonicalJson(local[target])) {
      fields.push(MANIFEST_FIELDS[target]);
    }
  }
  if (fields.length > 0) return { conflict: true, fields };
  if (!stored) errors.push(`release fields not checked: ${storedError ?? "unknown error"}`);
  if (errors.length > 0) return { conflict: null, fields, error: errors.join("; ") };
  return { conflict: false, fields };
}

/**
 * Compare the locally built manifests with what the Portal serves for the channel's release, and
 * check whether the local version is already published with different content.
 * Never throws for network or HTTP failures; they are recorded in the returned result.
 */
export async function comparePortalRelease(options: ComparePortalReleaseOptions): Promise<PortalComparison> {
  const portalUrl = options.portalUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMPARE_TIMEOUT_MS;
  const localVersion = options.client.version;
  const local: Record<Target, PackManifest> = { client: options.client, server: options.server };

  const [channelResults, localCheck] = await Promise.all([
    Promise.all(PORTAL_CHANNELS.map((name) => resolveChannel(portalUrl, name, timeoutMs))),
    checkLocalPublished(portalUrl, localVersion, timeoutMs),
  ]);

  const channels: Record<string, string | null> = {};
  const channelErrors: Record<string, string> = {};
  for (const entry of channelResults) {
    channels[entry.name] = entry.version;
    if (entry.error !== undefined) {
      channelErrors[entry.name] = entry.error;
    }
  }

  const compareVersion = channels[options.channel] ?? null;
  const published = isLocalPublished(localCheck.state, compareVersion, localVersion);
  // The Portal rejects a publish of a revoked version with 409 whatever its content, so its manifests are not fetched for the check.
  const revoked = localCheck.state?.revoked === true;

  // The selected channel's release gives the diff. The local version's own release gives the publish
  // check. One fetch serves both when the channel already points at the local version.
  const compareFetch = compareVersion !== null ? fetchTargetManifests(portalUrl, compareVersion, timeoutMs) : undefined;
  const publishedFetch =
    published !== true || revoked
      ? undefined
      : compareVersion === localVersion && compareFetch
        ? compareFetch
        : fetchTargetManifests(portalUrl, localVersion, timeoutMs);
  const [compared, released] = await Promise.all([compareFetch, publishedFetch]);

  const result: PortalComparison = {
    portalUrl,
    channel: options.channel,
    localVersion,
    channels,
    channelErrors,
    localPublished: localCheck.state,
    compareVersion,
    targets: [],
    publishConflict: null,
    publishConflictFields: [],
  };
  if (localCheck.error !== undefined) {
    result.localPublishedError = localCheck.error;
  }

  if (compared) {
    result.targets = TARGETS.map((target) => compareTarget(target, compared[target], local[target]));
  } else {
    result.error = `Portal channel '${options.channel}' is unavailable: ${channelErrors[options.channel] ?? "unknown error"}`;
  }

  if (published === false) {
    result.publishConflict = false;
  } else if (published === true && revoked) {
    result.publishConflict = true;
    result.publishConflictFields = ["status"];
  } else if (published === true && released) {
    const outcome = publishConflictFor(local, options.release, released, localCheck.stored, localCheck.error);
    result.publishConflict = outcome.conflict;
    result.publishConflictFields = outcome.fields;
    if (outcome.error !== undefined) {
      result.publishConflictError = outcome.error;
    }
  }
  // published === null: the status is unknown, so publishConflict stays null. localPublishedError says why.

  return result;
}

function hasDifferences(diff: DiffResult): boolean {
  return (
    diff.added.length > 0 ||
    diff.removed.length > 0 ||
    diff.modified.length > 0 ||
    diff.changedFields.length > 0
  );
}

function describePublished(c: PortalComparison): string {
  const state = c.localPublished;
  if (state === null) {
    const reason = c.localPublishedError ?? "check failed";
    return c.compareVersion === c.localVersion
      ? `published (status check failed: ${reason}; channel '${c.channel}' points at it)`
      : `unknown (${reason})`;
  }
  if (!state.published) return "not published";
  if (state.revoked) return "published (revoked)";
  return state.created ? `published ${state.created}` : "published";
}

function describeTarget(target: PortalTargetComparison): string[] {
  if (target.diff === null) {
    return [`  ${target.target}: unavailable (${target.error ?? "unknown error"})`];
  }
  const diff = target.diff;
  if (!hasDifferences(diff)) {
    return target.contentIdentical
      ? [`  ${target.target}: identical`]
      : [`  ${target.target}: identical files; other manifest metadata differs (e.g. download URLs or ordering)`];
  }

  const net = `${diff.totalSizeDelta >= 0 ? "+" : ""}${formatBytes(diff.totalSizeDelta)}`;
  const fields = diff.changedFields.length > 0 ? `; fields changed: ${diff.changedFields.join(", ")}` : "";
  const lines = [
    `  ${target.target}: +${diff.added.length} added, -${diff.removed.length} removed, ~${diff.modified.length} updated, net ${net}${fields}`,
  ];
  for (const a of diff.added) {
    lines.push(`    + ${a.path} (${formatBytes(a.size)})`);
  }
  for (const r of diff.removed) {
    lines.push(`    - ${r.path} (${formatBytes(r.size)})`);
  }
  for (const m of diff.modified) {
    lines.push(`    ~ ${m.path} (${formatBytes(m.oldSize)} -> ${formatBytes(m.newSize)})`);
  }
  return lines;
}

export function printPortalComparison(c: PortalComparison): void {
  const channelList = Object.entries(c.channels)
    .map(([name, version]) => `${name}=${version ?? "unavailable"}`)
    .join(", ");

  console.log("=".repeat(60));
  console.log(` Portal Comparison: ${c.portalUrl} (channel '${c.channel}')`);
  console.log("=".repeat(60));
  console.log(` Local version:    ${c.localVersion}`);
  console.log(` Portal channels:  ${channelList}`);
  console.log(` Local version on Portal: ${describePublished(c)}`);
  console.log(` Compared against: ${c.compareVersion ? `v${c.compareVersion} (${c.channel})` : "unavailable"}`);
  console.log("");

  // The selected channel's reason is already in c.error when the comparison is skipped.
  const failures = Object.entries(c.channelErrors)
    .filter(([name]) => name !== c.channel)
    .map(([name, reason]) => `${name}: ${reason}`)
    .join("; ");
  if (c.error) {
    console.warn(`[Portal] Comparison skipped: ${c.error}${failures ? `. Other unavailable channels: ${failures}` : ""}`);
  } else if (failures) {
    console.warn(`[Portal] Unavailable channels: ${failures}`);
  }

  for (const target of c.targets) {
    for (const line of describeTarget(target)) {
      console.log(line);
    }
  }

  const v = c.localVersion;
  const published = isLocalPublished(c.localPublished, c.compareVersion, c.localVersion);
  if (published === true) {
    if (c.localPublished?.revoked) {
      console.warn(
        `⚠ v${v} is revoked on the Portal; publishing it will be rejected (409). Bump [pack] version in pack.toml before publishing.`
      );
    } else if (c.publishConflict === true) {
      console.warn(
        `⚠ v${v} is already published on the Portal with different content (${c.publishConflictFields.join(", ")}); publishing it will be rejected (409). Bump [pack] version in pack.toml before publishing.`
      );
    } else if (c.publishConflict === false) {
      console.log(`v${v} is already published with identical manifests; publishing it again only moves channel pointers.`);
    } else {
      console.warn(`v${v} is already published; publish conflicts could not be fully checked (${c.publishConflictError ?? "unknown error"}).`);
    }
  } else if (published === null) {
    console.warn(
      `v${v} publish status is unknown (${c.localPublishedError ?? "check failed"}); publish conflicts were not checked.`
    );
  }
}
