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

export async function verifyFabricLoaderCompatibility(
  minecraft: string,
  loaderVersion: string,
  options?: {
    metaBaseUrl?: string;
    fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  }
): Promise<FabricMetaLoaderData> {
  const metaBaseUrl = options?.metaBaseUrl || "https://meta.fabricmc.net";
  const customFetch = options?.fetchFn || fetch;
  const url = `${metaBaseUrl}/v2/versions/loader/${encodeURIComponent(minecraft)}/${encodeURIComponent(loaderVersion)}`;

  let response: Response;
  try {
    response = await customFetch(url);
  } catch (err: any) {
    throw new Error(`[Loader] Failed to query Fabric Meta API (${url}): ${err.message}`);
  }

  if (!response.ok) {
    throw new Error(
      `[Loader] Fabric Loader ${loaderVersion} is not available for Minecraft ${minecraft}. Refusing to build release.`
    );
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

  if (!data.loader || data.loader.version !== loaderVersion) {
    throw new Error(
      `[Loader] Fabric Meta returned loader version '${data?.loader?.version}', but '${loaderVersion}' was requested.`
    );
  }

  if (!data.intermediary || (!data.intermediary.maven && !data.intermediary.version)) {
    throw new Error(
      `[Loader] Fabric Meta response is missing intermediary mappings for Minecraft ${minecraft}.`
    );
  }

  if (!data.launcherMeta) {
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
