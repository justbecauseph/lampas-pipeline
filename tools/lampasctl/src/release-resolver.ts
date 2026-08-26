import { withAbortTimeout } from "./utils";
import type { PackManifest, ReleaseDescriptor } from "./types";

export interface ResolveReleaseOptions {
  portalUrl: string;
  channel?: string;
  version?: string;
  target?: "client" | "server";
  token?: string;
  timeoutMs?: number;
}

export interface ResolvedReleaseInfo {
  version: string;
  channel?: string;
  release: ReleaseDescriptor;
  manifest: PackManifest;
}

export async function resolveChannelVersion(
  portalUrl: string,
  channel: string,
  options?: { token?: string; timeoutMs?: number }
): Promise<string> {
  const base = portalUrl.replace(/\/+$/, "");
  const url = `${base}/api/v1/channels/${encodeURIComponent(channel)}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options?.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }

  const res = await withAbortTimeout(
    `resolving channel '${channel}'`,
    (signal) => fetch(url, { headers, signal }),
    options?.timeoutMs || 15000
  );
  if (!res.ok) {
    throw new Error(`Failed to resolve release channel '${channel}' from ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { channel?: string; version?: string };
  if (!data.version) {
    throw new Error(`Invalid response for channel '${channel}' from ${url}: missing 'version' property`);
  }
  return data.version;
}

export async function fetchReleaseDescriptor(
  portalUrl: string,
  version: string,
  options?: { token?: string; timeoutMs?: number }
): Promise<ReleaseDescriptor> {
  const base = portalUrl.replace(/\/+$/, "");
  const url = `${base}/api/v1/releases/${encodeURIComponent(version)}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options?.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }

  const res = await withAbortTimeout(
    `fetching release descriptor for v${version}`,
    (signal) => fetch(url, { headers, signal }),
    options?.timeoutMs || 15000
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch release descriptor for version '${version}' from ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as ReleaseDescriptor;
}

export async function fetchManifest(
  portalUrl: string,
  version: string,
  target: "client" | "server",
  options?: { token?: string; timeoutMs?: number }
): Promise<PackManifest> {
  const base = portalUrl.replace(/\/+$/, "");
  const endpoint = target === "server" ? "server-manifest" : "client-manifest";
  const url = `${base}/api/v1/releases/${encodeURIComponent(version)}/${endpoint}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options?.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }

  const res = await withAbortTimeout(
    `fetching ${target} manifest for v${version}`,
    (signal) => fetch(url, { headers, signal }),
    options?.timeoutMs || 15000
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch ${target} manifest for version '${version}' from ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as PackManifest;
}

export async function resolveRelease(options: ResolveReleaseOptions): Promise<ResolvedReleaseInfo> {
  const { portalUrl, channel, target = "server", token, timeoutMs } = options;
  let version = options.version;

  if (!version) {
    if (!channel) {
      throw new Error("Either --version or --channel must be specified to resolve a release.");
    }
    console.log(`[Resolver] Resolving release for channel '${channel}' from Portal: ${portalUrl}...`);
    version = await resolveChannelVersion(portalUrl, channel, { token, timeoutMs });
    console.log(`[Resolver] Channel '${channel}' pointer is at version v${version}`);
  }

  console.log(`[Resolver] Fetching release descriptor for v${version}...`);
  const release = await fetchReleaseDescriptor(portalUrl, version, { token, timeoutMs });

  console.log(`[Resolver] Fetching ${target} manifest for v${version}...`);
  const manifest = await fetchManifest(portalUrl, version, target, { token, timeoutMs });

  return {
    version,
    channel,
    release,
    manifest,
  };
}
