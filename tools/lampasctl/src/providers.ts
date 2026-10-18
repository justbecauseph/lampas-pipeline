import {
  computeBufferHashes,
  computeFileHashesStreaming,
  downloadFileVerified,
  ensureDir,
  withAbortTimeout,
} from "./utils";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  CURSEFORGE_USER_AGENT,
  CurseForgeClient,
  curseForgeSha1,
  type CurseForgeFile,
} from "./curseforge";
import type { ModDefinition, ResolvedArtifact, Side } from "./types";
import { MODRINTH_API, MODRINTH_USER_AGENT, modrinthFetch } from "./modrinth-http";
import * as path from "node:path";
import * as fs from "node:fs";

export const USER_AGENT = MODRINTH_USER_AGENT;

/** Where `resolve` keeps a downloaded Modrinth or CurseForge file: <baseDir>/.lampas/cache/<provider>/<project>/<version or file>/<filename>. */
export function providerCachePath(
  baseDir: string,
  provider: "modrinth" | "curseforge",
  projectId: string | number,
  versionOrFileId: string | number,
  filename: string
): string {
  return path.resolve(baseDir, ".lampas", "cache", provider, String(projectId), String(versionOrFileId), path.basename(filename));
}

/** The local file behind a `lampas` provider descriptor (`file` is relative to the pack directory). */
export function lampasArtifactPath(baseDir: string, file: string): string {
  return path.resolve(baseDir, "pack", file);
}
const FETCH_ATTEMPTS = 2;

export interface ModrinthVersionFile {
  hashes: {
    sha1: string;
    sha512: string;
    sha256?: string;
  };
  url: string;
  filename: string;
  primary: boolean;
  size: number;
  file_type?: string;
}

export interface ModrinthVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  files: ModrinthVersionFile[];
}

export interface ModrinthProject {
  id: string;
  slug: string;
  title: string;
  description: string;
}

export class ModrinthClient {
  private static async fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
      try {
        const res = await modrinthFetch(url, init);

        if (res.status === 404) {
          return null;
        }

        if (!res.ok) {
          throw new Error(`Modrinth API error ${res.status}: ${res.statusText} at ${url}`);
        }

        return (await res.json()) as T;
      } catch (err: any) {
        console.warn(`[Modrinth] fetch attempt ${attempt}/${FETCH_ATTEMPTS} failed for ${url}: ${err.message}`);
      }
    }

    return null;
  }

  static async getVersionByHash(hash: string, algorithm: "sha1" | "sha512" = "sha512"): Promise<ModrinthVersion | null> {
    const url = `${MODRINTH_API}/version_file/${hash}?algorithm=${algorithm}`;
    return this.fetchJson<ModrinthVersion>(url);
  }

  static async getVersionsByHashes(
    hashes: string[],
    algorithm: "sha1" | "sha512" = "sha512"
  ): Promise<Record<string, ModrinthVersion>> {
    if (hashes.length === 0) return {};
    const url = `${MODRINTH_API}/version_files`;
    const res = await this.fetchJson<Record<string, ModrinthVersion>>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hashes, algorithm }),
    });
    return res || {};
  }

  static async getVersion(versionId: string): Promise<ModrinthVersion | null> {
    const url = `${MODRINTH_API}/version/${versionId}`;
    return this.fetchJson<ModrinthVersion>(url);
  }

  static async getVersions(versionIds: string[]): Promise<ModrinthVersion[]> {
    if (versionIds.length === 0) return [];
    const ids = encodeURIComponent(JSON.stringify(versionIds));
    return (await this.fetchJson<ModrinthVersion[]>(`${MODRINTH_API}/versions?ids=${ids}`)) || [];
  }

  static async getProject(projectIdOrSlug: string): Promise<ModrinthProject | null> {
    const url = `${MODRINTH_API}/project/${projectIdOrSlug}`;
    return this.fetchJson<ModrinthProject>(url);
  }
}

export class ArtifactResolver {
  static async resolveModDefinition(
    modId: string,
    def: ModDefinition,
    baseDir: string,
    prefetchedVersion?: ModrinthVersion,
    prefetchedCurseForgeFile?: CurseForgeFile,
    cachedArtifact?: ResolvedArtifact
  ): Promise<ResolvedArtifact> {
    const { provider, side, name } = def;

    if (provider.type === "modrinth") {
      const version = prefetchedVersion || await ModrinthClient.getVersion(provider.version_id);
      if (!version) {
        throw new Error(`Mod '${modId}' (${name}): Modrinth version '${provider.version_id}' not found.`);
      }

      const primaryFile =
        version.files.find((f) => f.primary) || version.files[0];
      if (!primaryFile) {
        throw new Error(`Mod '${modId}' (${name}): No files found in Modrinth version '${provider.version_id}'.`);
      }

      // 1. Check if sha256 is already in the primaryFile metadata
      let sha256 = primaryFile.hashes.sha256;

      // 2. Check if existing lockfile already has this exact artifact resolved
      if (!sha256 && cachedArtifact && cachedArtifact.provider?.type === "modrinth") {
        const matchesVersion = cachedArtifact.provider.versionId === provider.version_id;
        const matchesHash =
          (primaryFile.hashes.sha512 && cachedArtifact.sha512 === primaryFile.hashes.sha512) ||
          (primaryFile.hashes.sha1 && cachedArtifact.sha1 === primaryFile.hashes.sha1);
        if (matchesVersion && matchesHash && cachedArtifact.sha256) {
          sha256 = cachedArtifact.sha256;
        }
      }

      // 3. If sha256 is still needed, check local disk cache or download verified
      if (!sha256) {
        const cachePath = providerCachePath(
          baseDir,
          "modrinth",
          provider.project_id || version.project_id || "unknown",
          provider.version_id,
          primaryFile.filename
        );

        const expectedSha512 = primaryFile.hashes.sha512;
        const expectedSha1 = primaryFile.hashes.sha1;
        const expectedSize = primaryFile.size;

        let hashes = fs.existsSync(cachePath) ? await computeFileHashesStreaming(cachePath) : undefined;
        const isCacheValid = hashes && (
          (!expectedSha512 || hashes.sha512 === expectedSha512) &&
          (!expectedSha1 || hashes.sha1 === expectedSha1) &&
          (!expectedSize || hashes.size === expectedSize)
        );

        if (!isCacheValid) {
          const verifyHash = expectedSha512 || expectedSha1;
          const verifyAlgorithm: "sha512" | "sha1" = expectedSha512 ? "sha512" : "sha1";

          if (verifyHash) {
            await downloadFileVerified(primaryFile.url, cachePath, {
              expectedHash: verifyHash,
              algorithm: verifyAlgorithm,
              expectedSize,
              headers: { "User-Agent": USER_AGENT },
              timeoutMs: 180_000,
              attempts: 3,
            });
          } else {
            ensureDir(path.dirname(cachePath));
            await withAbortTimeout(
              `downloading '${modId}' to calculate sha256`,
              async (signal) => {
                const resp = await fetch(primaryFile.url, {
                  signal,
                  headers: { "User-Agent": USER_AGENT },
                });
                if (!resp.ok || !resp.body) {
                  throw new Error(`Artifact download returned ${resp.status}: ${resp.statusText}`);
                }
                const tempPath = `${cachePath}.tmp.${Date.now()}`;
                await pipeline(Readable.fromWeb(resp.body as any), fs.createWriteStream(tempPath));
                await fs.promises.rename(tempPath, cachePath);
              },
              180_000
            );
          }
          hashes = await computeFileHashesStreaming(cachePath);
        }

        sha256 = hashes!.sha256;
      }

      const artifactType = def.type || "mod";
      const targetDir = def.type === "shader" ? "shaderpacks" : def.type === "resourcepack" ? "resourcepacks" : "mods";

      return {
        id: modId,
        name: def.name,
        side,
        filename: primaryFile.filename,
        size: primaryFile.size,
        sha256,
        sha512: primaryFile.hashes.sha512,
        sha1: primaryFile.hashes.sha1,
        downloadUrl: primaryFile.url,
        artifactType,
        targetDir,
        provider: {
          type: "modrinth",
          projectId: provider.project_id,
          versionId: provider.version_id,
        },
      };
    }

    if (provider.type === "curseforge") {
      const file = prefetchedCurseForgeFile || await CurseForgeClient.getFile(provider.project_id, provider.file_id);
      if (file.modId !== provider.project_id) {
        throw new Error(
          `Mod '${modId}' (${name}): CurseForge file '${provider.file_id}' belongs to project '${file.modId}'.`
        );
      }
      if (file.isAvailable === false) {
        throw new Error(`Mod '${modId}' (${name}): CurseForge file '${provider.file_id}' is not available.`);
      }

      const expectedSha1 = curseForgeSha1(file);
      if (!expectedSha1) {
        throw new Error(
          `Mod '${modId}' (${name}): CurseForge file '${provider.file_id}' has no SHA-1 hash and cannot be verified safely.`
        );
      }

      const downloadUrl = await CurseForgeClient.getDownloadUrl(provider.project_id, provider.file_id, file);
      const filename = path.basename(file.fileName);
      const cachePath = providerCachePath(baseDir, "curseforge", provider.project_id, provider.file_id, filename);

      let hashes = fs.existsSync(cachePath) ? await computeFileHashesStreaming(cachePath) : undefined;
      if (!hashes || hashes.sha1 !== expectedSha1 || (file.fileLength > 0 && hashes.size !== file.fileLength)) {
        await downloadFileVerified(downloadUrl, cachePath, {
          expectedHash: expectedSha1,
          algorithm: "sha1",
          expectedSize: file.fileLength,
          headers: { "User-Agent": CURSEFORGE_USER_AGENT },
          timeoutMs: 120_000,
        });
        hashes = await computeFileHashesStreaming(cachePath);
      }

      const artifactType = def.type || "mod";
      const targetDir = artifactType === "shader" ? "shaderpacks" : artifactType === "resourcepack" ? "resourcepacks" : "mods";

      return {
        id: modId,
        name: def.name,
        side,
        filename,
        size: hashes.size,
        sha256: hashes.sha256,
        sha512: hashes.sha512,
        sha1: hashes.sha1,
        downloadUrl,
        artifactType,
        targetDir,
        provider: {
          type: "curseforge",
          projectId: provider.project_id,
          fileId: provider.file_id,
        },
      };
    }

    if (provider.type === "lampas") {
      const filePath = lampasArtifactPath(baseDir, provider.file);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Mod '${modId}' (${name}): Lampas file '${provider.file}' not found at ${filePath}`);
      }

      const hashes = await computeFileHashesStreaming(filePath);
      const filename = path.basename(filePath);
      const artifactType = def.type || (provider.file.includes("shader") ? "shader" : provider.file.includes("resource") ? "resourcepack" : "mod");
      const targetDir = artifactType === "shader" ? "shaderpacks" : artifactType === "resourcepack" ? "resourcepacks" : "mods";

      return {
        id: modId,
        name: def.name,
        side,
        filename,
        size: hashes.size,
        sha256: hashes.sha256,
        sha512: hashes.sha512,
        sha1: hashes.sha1,
        downloadUrl: `/api/v1/blobs/${hashes.sha256}`,
        artifactType,
        targetDir,
        provider: {
          type: "lampas",
          file: provider.file,
        },
      };
    }

    if (provider.type === "direct") {
      const artifactType = def.type || "mod";
      const targetDir = artifactType === "shader" ? "shaderpacks" : artifactType === "resourcepack" ? "resourcepacks" : "mods";

      return {
        id: modId,
        name: def.name,
        side,
        filename: provider.filename || `${modId}.jar`,
        size: provider.size || 0,
        sha256: provider.sha256,
        ...(provider.sha1 ? { sha1: provider.sha1 } : {}),
        downloadUrl: provider.url,
        artifactType,
        targetDir,
        provider: {
          type: "direct",
        },
      };
    }

    throw new Error(`Mod '${modId}' (${name}): Provider type '${(provider as any).type}' is not yet supported.`);
  }
}
