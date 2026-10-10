import type { PackConfig } from "./types";

export const DEFAULT_PORTAL_BASE_URL = "https://portal.lampas.town";

/** Normalize a portal base URL: require http(s), drop trailing slashes. */
export function normalizePortalBaseUrl(raw: string, source: string): string {
  const value = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid portal base URL from ${source}: '${raw}'.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid portal base URL from ${source}: '${raw}' must use http or https.`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`Invalid portal base URL from ${source}: '${raw}' must not contain a query or fragment.`);
  }
  return value.replace(/\/+$/, "");
}

/** Read `[portal] base_url` from pack.toml, if present. */
export function readPackPortalBaseUrl(packConfig: PackConfig): string | undefined {
  const raw = packConfig.portal?.base_url;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("Invalid pack.toml [portal] base_url: expected a non-empty string.");
  }
  return normalizePortalBaseUrl(raw, "pack.toml [portal] base_url");
}

/** Resolve the portal base URL: explicit override, then pack.toml, then fallback. */
export function resolvePortalBaseUrl(packConfig: PackConfig, override?: string, fallback?: string): string | undefined {
  if (override) return normalizePortalBaseUrl(override, "--portal / environment");
  return readPackPortalBaseUrl(packConfig) ?? (fallback ? normalizePortalBaseUrl(fallback, "default") : undefined);
}
