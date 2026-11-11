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

export interface PortalTextResponse {
  ok: boolean;
  status: number;
  statusText: string;
  /** Body text, read before the timeout is cleared. Empty when the response is not ok. */
  text: string;
}

/** Environment variable that holds the read-only deploy token for Portal metadata reads. */
export const DEPLOY_TOKEN_ENV = "PACK_DEPLOY_TOKEN";

/**
 * The read-only deploy token from the environment, or undefined when it is unset or blank. It is
 * sent on channel, release-descriptor and manifest reads only, never on blob or third-party
 * downloads. This is not the publish secret (PACK_PUBLISH_SECRET).
 */
export function deployTokenFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env[DEPLOY_TOKEN_ENV]?.trim() || undefined;
}

/**
 * Explains a 401 or 403 from a Portal metadata read in terms of the deploy token. Returns "" for
 * any other status. `tokenSent` says whether the request carried an Authorization header.
 */
export function portalAuthHint(status: number, tokenSent: boolean): string {
  if (status === 401) {
    return tokenSent
      ? `${DEPLOY_TOKEN_ENV} is set, but the Portal did not receive or did not accept it`
      : `${DEPLOY_TOKEN_ENV} is missing; this read needs the read-only deploy token, so set ${DEPLOY_TOKEN_ENV}`;
  }
  if (status === 403) {
    return tokenSent
      ? `${DEPLOY_TOKEN_ENV} was not accepted; the token does not grant this read`
      : `${DEPLOY_TOKEN_ENV} is missing and the Portal refused the read; set ${DEPLOY_TOKEN_ENV}`;
  }
  return "";
}

/** "HTTP <status> <statusText>", followed by the deploy-token hint on 401 and 403. */
export function describePortalFailure(
  res: { status: number; statusText: string },
  tokenSent: boolean,
): string {
  const base = `HTTP ${res.status} ${res.statusText}`.trim();
  const hint = portalAuthHint(res.status, tokenSent);
  return hint ? `${base} (${hint})` : base;
}

/**
 * GET a Portal URL and read its body inside the timeout. A body that stalls after the headers
 * fails with the same "Timed out" error as a response that never arrives.
 */
export async function fetchPortalText(
  url: string,
  description: string,
  options?: { token?: string; timeoutMs?: number },
): Promise<PortalTextResponse> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options?.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }

  return withAbortTimeout(
    description,
    async (signal) => {
      const res = await fetch(url, { headers, signal });
      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        text: res.ok ? await res.text() : "",
      };
    },
    options?.timeoutMs || 15000,
  );
}

/** Parse a Portal response body. `context` names the response in the error message. */
export function parsePortalJson<T = unknown>(text: string, context: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${context}: body is not valid JSON (${reason})`, { cause: err });
  }
}

export async function resolveChannelVersion(
  portalUrl: string,
  channel: string,
  options?: { token?: string; timeoutMs?: number },
): Promise<string> {
  const base = portalUrl.replace(/\/+$/, "");
  const url = `${base}/api/v1/channels/${encodeURIComponent(channel)}`;

  const res = await fetchPortalText(url, `resolving channel '${channel}'`, options);
  if (!res.ok) {
    throw new Error(
      `Failed to resolve release channel '${channel}' from ${url}: ${describePortalFailure(res, Boolean(options?.token))}`,
    );
  }
  const data = parsePortalJson<{ channel?: string; version?: string } | null>(
    res.text,
    `Invalid response for channel '${channel}' from ${url}`,
  );
  if (!data?.version) {
    throw new Error(
      `Invalid response for channel '${channel}' from ${url}: missing 'version' property`,
    );
  }
  return data.version;
}

export async function fetchReleaseDescriptor(
  portalUrl: string,
  version: string,
  options?: { token?: string; timeoutMs?: number },
): Promise<ReleaseDescriptor> {
  const base = portalUrl.replace(/\/+$/, "");
  const url = `${base}/api/v1/releases/${encodeURIComponent(version)}`;

  const res = await fetchPortalText(url, `fetching release descriptor for v${version}`, options);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch release descriptor for version '${version}' from ${url}: ${describePortalFailure(res, Boolean(options?.token))}`,
    );
  }
  return parsePortalJson<ReleaseDescriptor>(
    res.text,
    `Invalid response for release descriptor for version '${version}' from ${url}`,
  );
}

export async function fetchManifest(
  portalUrl: string,
  version: string,
  target: "client" | "server",
  options?: { token?: string; timeoutMs?: number },
): Promise<PackManifest> {
  const base = portalUrl.replace(/\/+$/, "");
  const endpoint = target === "server" ? "server-manifest" : "client-manifest";
  const url = `${base}/api/v1/releases/${encodeURIComponent(version)}/${endpoint}`;

  const res = await fetchPortalText(url, `fetching ${target} manifest for v${version}`, options);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch ${target} manifest for version '${version}' from ${url}: ${describePortalFailure(res, Boolean(options?.token))}`,
    );
  }
  return parsePortalJson<PackManifest>(
    res.text,
    `Invalid response for ${target} manifest for version '${version}' from ${url}`,
  );
}

export async function resolveRelease(options: ResolveReleaseOptions): Promise<ResolvedReleaseInfo> {
  const { portalUrl, channel, target = "server", token, timeoutMs } = options;
  let version = options.version;

  if (!version) {
    if (!channel) {
      throw new Error("Either --version or --channel must be specified to resolve a release.");
    }
    console.log(
      `[Resolver] Resolving release for channel '${channel}' from Portal: ${portalUrl}...`,
    );
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
