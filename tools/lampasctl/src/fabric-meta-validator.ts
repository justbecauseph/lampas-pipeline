export interface FabricMetaLoaderData {
  loader: {
    separator?: string;
    build?: number;
    maven: string;
    version: string;
    stable?: boolean;
  };
  intermediary: {
    maven: string;
    version: string;
    stable?: boolean;
  };
  launcherMeta: {
    version?: number;
    libraries: {
      client?: Array<{ name: string; url?: string; [key: string]: any }>;
      common: Array<{ name: string; url?: string; [key: string]: any }>;
      server?: Array<{ name: string; url?: string; [key: string]: any }>;
    };
    mainClass: {
      client: string;
      server?: string;
    };
  };
}

export interface VerifyFabricMetaOptions {
  metaBaseUrl?: string;
  fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  maxRetries?: number;
}

export async function verifyFabricLoaderCompatibility(
  minecraft: string,
  loaderVersion: string,
  options?: VerifyFabricMetaOptions
): Promise<FabricMetaLoaderData> {
  const metaBaseUrl = options?.metaBaseUrl || "https://meta.fabricmc.net";
  const customFetch = options?.fetchFn || fetch;
  const timeoutMs = options?.timeoutMs ?? 5000;
  const maxRetries = options?.maxRetries ?? 2;
  const url = `${metaBaseUrl}/v2/versions/loader/${encodeURIComponent(minecraft)}/${encodeURIComponent(loaderVersion)}`;

  let response: Response | null = null;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      response = await customFetch(url, { signal });

      // If 404, combination does not exist - fail closed immediately without retry
      if (response.status === 404) {
        throw new Error(
          `[Loader] Fabric Loader ${loaderVersion} is not available for Minecraft ${minecraft} (Fabric Meta returned 404 Not Found). Release generation aborted.`
        );
      }

      // If 5xx, service unavailable - retry if attempts remain
      if (response.status >= 500) {
        const errorMsg = `[Loader] Fabric Meta service unavailable (HTTP ${response.status} ${response.statusText} querying ${url}).`;
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
          continue;
        }
        throw new Error(`${errorMsg} Release generation aborted.`);
      }

      // Any other non-ok status (e.g. 400, 403) - do not retry
      if (!response.ok) {
        throw new Error(
          `[Loader] Fabric Meta query failed with HTTP ${response.status} ${response.statusText} (${url}). Release generation aborted.`
        );
      }

      // Successful response received
      break;
    } catch (err: any) {
      lastError = err;
      // If error is already our formatted [Loader] error, rethrow immediately
      if (err.message && err.message.includes("[Loader]")) {
        throw err;
      }
      // Transient network or timeout error - retry if attempts remain
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
        continue;
      }
      throw new Error(`[Loader] Failed to connect to Fabric Meta API (${url}): ${err.message}`);
    }
  }

  if (!response || !response.ok) {
    throw lastError || new Error(`[Loader] Failed to query Fabric Meta API (${url}).`);
  }

  let data: any;
  try {
    data = await response.json();
  } catch (err: any) {
    throw new Error(`[Loader] Failed to parse Fabric Meta response as JSON: ${err.message}`);
  }

  if (!data || typeof data !== "object") {
    throw new Error(`[Loader] Fabric Meta response for Minecraft ${minecraft} and Loader ${loaderVersion} is malformed.`);
  }

  if (
    !data.loader ||
    typeof data.loader !== "object" ||
    data.loader.version !== loaderVersion ||
    typeof data.loader.maven !== "string" ||
    !data.loader.maven.trim()
  ) {
    if (data?.loader?.version && data.loader.version !== loaderVersion) {
      throw new Error(
        `[Loader] Fabric Meta returned loader version '${data?.loader?.version}', but '${loaderVersion}' was requested.`
      );
    }
    throw new Error(
      `[Loader] Fabric Meta response has missing or invalid loader metadata (expected valid 'version' and 'maven' coordinates).`
    );
  }

  if (
    !data.intermediary ||
    typeof data.intermediary !== "object" ||
    typeof data.intermediary.maven !== "string" ||
    !data.intermediary.maven.trim() ||
    typeof data.intermediary.version !== "string" ||
    !data.intermediary.version.trim()
  ) {
    throw new Error(
      `[Loader] Fabric Meta response is missing valid intermediary mappings for Minecraft ${minecraft} (expected valid 'version' and 'maven' coordinates).`
    );
  }

  if (!data.launcherMeta || typeof data.launcherMeta !== "object") {
    throw new Error(`[Loader] Fabric Meta response is missing launcherMeta.`);
  }

  if (!data.launcherMeta.mainClass || !data.launcherMeta.mainClass.client) {
    throw new Error(`[Loader] Fabric Meta response is missing launcherMeta.mainClass.client.`);
  }

  const commonLibs = data.launcherMeta.libraries?.common;
  if (!Array.isArray(commonLibs) || commonLibs.length === 0) {
    throw new Error(`[Loader] Fabric Meta response has malformed or empty required library metadata.`);
  }

  return data as FabricMetaLoaderData;
}
