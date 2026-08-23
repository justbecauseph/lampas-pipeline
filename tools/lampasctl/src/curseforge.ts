import { withAbortTimeout } from "./utils";

export const CURSEFORGE_API = "https://api.curseforge.com/v1";
export const CURSEFORGE_MINECRAFT_GAME_ID = 432;
export const CURSEFORGE_MODS_CLASS_ID = 6;
export const CURSEFORGE_FABRIC_LOADER_TYPE = 4;
export const CURSEFORGE_USER_AGENT = "Lampas-Pipeline/2.0 (contact@lampas.town)";

const FETCH_ATTEMPTS = 2;

interface CurseForgeResponse<T> {
  data: T;
  pagination?: {
    index: number;
    pageSize: number;
    resultCount: number;
    totalCount: number;
  };
}

export interface CurseForgeCategory {
  id: number;
  name: string;
  slug: string;
}

export interface CurseForgeAuthor {
  id: number;
  name: string;
  url?: string;
}

export interface CurseForgeMod {
  id: number;
  gameId: number;
  name: string;
  slug: string;
  summary?: string;
  classId?: number;
  isAvailable?: boolean;
  allowModDistribution?: boolean | null;
  links?: {
    websiteUrl?: string;
    wikiUrl?: string;
    issuesUrl?: string;
    sourceUrl?: string;
  };
  logo?: {
    thumbnailUrl?: string;
    url?: string;
  };
  categories?: CurseForgeCategory[];
  authors?: CurseForgeAuthor[];
}

export interface CurseForgeFileHash {
  value: string;
  /** 1 = SHA-1, 2 = MD5 */
  algo: number;
}

export interface CurseForgeFileDependency {
  modId: number;
  /** 3 = required dependency */
  relationType: number;
}

export interface CurseForgeFile {
  id: number;
  gameId: number;
  modId: number;
  isAvailable: boolean;
  displayName: string;
  fileName: string;
  releaseType: number;
  fileStatus: number;
  hashes: CurseForgeFileHash[];
  fileDate: string;
  fileLength: number;
  downloadUrl?: string | null;
  gameVersions: string[];
  dependencies?: CurseForgeFileDependency[];
}

export interface CurseForgeFileQuery {
  gameVersion?: string;
  modLoaderType?: number;
  pageSize?: number;
}

function apiKey(): string {
  const key = process.env.CURSEFORGE_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "CurseForge access requires CURSEFORGE_API_KEY. Set it in your environment or a local .env file; do not commit the key."
    );
  }
  return key;
}

function apiUrl(endpoint: string, params?: Record<string, string | number | undefined>): string {
  const url = new URL(`${CURSEFORGE_API}${endpoint}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function curseForgeSha1(file: CurseForgeFile): string | undefined {
  return file.hashes?.find((hash) => hash.algo === 1)?.value?.toLowerCase();
}

export function sortCurseForgeFilesNewest(files: CurseForgeFile[]): CurseForgeFile[] {
  return [...files].sort((a, b) => Date.parse(b.fileDate) - Date.parse(a.fileDate));
}

export class CurseForgeClient {
  private static async fetchData<T>(url: string, init?: RequestInit): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
      try {
        return await withAbortTimeout(`fetching CurseForge metadata from ${url}`, async (signal) => {
          const response = await fetch(url, {
            ...init,
            signal,
            headers: {
              Accept: "application/json",
              "User-Agent": CURSEFORGE_USER_AGENT,
              "x-api-key": apiKey(),
              ...(init?.headers || {}),
            },
          });

          if (response.status === 401 || response.status === 403) {
            throw new Error(
              `CurseForge API rejected CURSEFORGE_API_KEY (${response.status} ${response.statusText}). Check that the key is current and authorized.`
            );
          }
          if (response.status === 404) {
            throw new Error(`CurseForge resource not found at ${url}`);
          }
          if (!response.ok) {
            throw new Error(`CurseForge API error ${response.status}: ${response.statusText} at ${url}`);
          }

          const body = (await response.json()) as CurseForgeResponse<T>;
          return body.data;
        });
      } catch (error: any) {
        lastError = error;
        if (
          error?.message?.includes("rejected CURSEFORGE_API_KEY") ||
          error?.message?.includes("CurseForge resource not found") ||
          error?.message?.includes("requires CURSEFORGE_API_KEY")
        ) {
          break;
        }
        if (attempt < FETCH_ATTEMPTS) {
          console.warn(`[CurseForge] fetch attempt ${attempt}/${FETCH_ATTEMPTS} failed for ${url}: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`Failed to fetch CurseForge metadata from ${url}`);
  }

  static async getMod(projectId: number): Promise<CurseForgeMod> {
    return this.fetchData<CurseForgeMod>(apiUrl(`/mods/${projectId}`));
  }

  static async getMods(projectIds: number[]): Promise<CurseForgeMod[]> {
    if (projectIds.length === 0) return [];
    return this.fetchData<CurseForgeMod[]>(apiUrl("/mods"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modIds: projectIds }),
    });
  }

  static async findMod(projectIdOrSlug: string): Promise<CurseForgeMod> {
    if (/^\d+$/.test(projectIdOrSlug)) {
      return this.getMod(Number(projectIdOrSlug));
    }

    const mods = await this.fetchData<CurseForgeMod[]>(
      apiUrl("/mods/search", {
        gameId: CURSEFORGE_MINECRAFT_GAME_ID,
        classId: CURSEFORGE_MODS_CLASS_ID,
        slug: projectIdOrSlug,
        pageSize: 50,
      })
    );
    const exact = mods.find((mod) => mod.slug.toLowerCase() === projectIdOrSlug.toLowerCase());
    if (!exact) {
      throw new Error(`CurseForge project slug '${projectIdOrSlug}' was not found.`);
    }
    return exact;
  }

  static async getFile(projectId: number, fileId: number): Promise<CurseForgeFile> {
    const file = await this.fetchData<CurseForgeFile>(apiUrl(`/mods/${projectId}/files/${fileId}`));
    if (file.modId !== projectId) {
      throw new Error(`CurseForge file '${fileId}' belongs to project '${file.modId}', not '${projectId}'.`);
    }
    return file;
  }

  static async getFiles(fileIds: number[]): Promise<CurseForgeFile[]> {
    if (fileIds.length === 0) return [];
    return this.fetchData<CurseForgeFile[]>(apiUrl("/mods/files"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileIds }),
    });
  }

  static async getModFiles(projectId: number, query: CurseForgeFileQuery = {}): Promise<CurseForgeFile[]> {
    const files = await this.fetchData<CurseForgeFile[]>(
      apiUrl(`/mods/${projectId}/files`, {
        gameVersion: query.gameVersion,
        modLoaderType: query.modLoaderType,
        pageSize: query.pageSize || 50,
      })
    );
    return sortCurseForgeFilesNewest(files.filter((file) => file.isAvailable !== false));
  }

  static async getDownloadUrl(projectId: number, fileId: number, file?: CurseForgeFile): Promise<string> {
    if (file?.downloadUrl) return file.downloadUrl;

    let downloadUrl: string | null;
    try {
      downloadUrl = await this.fetchData<string | null>(
        apiUrl(`/mods/${projectId}/files/${fileId}/download-url`)
      );
    } catch (error: any) {
      if (error?.message?.includes("CurseForge resource not found")) {
        throw new Error(
          `CurseForge file '${fileId}' for project '${projectId}' does not permit third-party downloads. Download it manually and add the local .jar instead.`,
          { cause: error }
        );
      }
      throw error;
    }
    if (!downloadUrl) {
      throw new Error(
        `CurseForge file '${fileId}' for project '${projectId}' does not permit third-party downloads. Download it manually and add the local .jar instead.`
      );
    }
    return downloadUrl;
  }
}
