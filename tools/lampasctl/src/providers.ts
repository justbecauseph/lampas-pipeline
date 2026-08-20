import { computeBufferHashes, computeFileHashes, withAbortTimeout, type FileHashes } from "./utils";
import type { ModDefinition, ResolvedArtifact, Side } from "./types";
import * as path from "node:path";
import * as fs from "node:fs";

const MODRINTH_API = "https://api.modrinth.com/v2";
const USER_AGENT = "Lampas-Pipeline/1.0 (contact@lampas.gg)";
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
        return await withAbortTimeout(`fetching Modrinth metadata from ${url}`, async (signal) => {
          const res = await fetch(url, {
            ...init,
            signal,
            headers: {
              "User-Agent": USER_AGENT,
              Accept: "application/json",
              ...(init?.headers || {}),
            },
          });

          if (res.status === 404) {
            return null;
          }

          if (!res.ok) {
            throw new Error(`Modrinth API error ${res.status}: ${res.statusText} at ${url}`);
          }

          return (await res.json()) as T;
        });
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

  static async getProject(projectIdOrSlug: string): Promise<ModrinthProject | null> {
    const url = `${MODRINTH_API}/project/${projectIdOrSlug}`;
    return this.fetchJson<ModrinthProject>(url);
  }
}

export class ArtifactResolver {
  static async resolveModDefinition(
    modId: string,
    def: ModDefinition,
    baseDir: string
  ): Promise<ResolvedArtifact> {
    const { provider, side, name } = def;

    if (provider.type === "modrinth") {
      const version = await ModrinthClient.getVersion(provider.version_id);
      if (!version) {
        throw new Error(`Mod '${modId}' (${name}): Modrinth version '${provider.version_id}' not found.`);
      }

      const primaryFile =
        version.files.find((f) => f.primary) || version.files[0];
      if (!primaryFile) {
        throw new Error(`Mod '${modId}' (${name}): No files found in Modrinth version '${provider.version_id}'.`);
      }

      // Compute sha256 if missing from response
      let sha256 = primaryFile.hashes.sha256;
      if (!sha256) {
        // Modrinth does not always supply sha256, so download and hash the complete artifact.
        let buf: Buffer | undefined;
        let lastError: unknown;

        for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
          try {
            buf = await withAbortTimeout(`downloading '${modId}' to calculate sha256`, async (signal) => {
              const resp = await fetch(primaryFile.url, {
                signal,
                headers: { "User-Agent": USER_AGENT },
              });
              if (!resp.ok) {
                throw new Error(`Artifact download returned ${resp.status}: ${resp.statusText}`);
              }
              return Buffer.from(await resp.arrayBuffer());
            });
            break;
          } catch (err: any) {
            lastError = err;
            console.warn(
              `[Resolver] Download attempt ${attempt}/${FETCH_ATTEMPTS} failed for '${modId}': ${err.message}`
            );
          }
        }

        if (!buf) {
          throw new Error(
            `Failed to download binary to calculate sha256 for '${modId}' after ${FETCH_ATTEMPTS} attempts`,
            { cause: lastError }
          );
        }

        const hashes = computeBufferHashes(buf);
        sha256 = hashes.sha256;
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

    if (provider.type === "lampas") {
      const filePath = path.resolve(baseDir, "pack", provider.file);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Mod '${modId}' (${name}): Lampas file '${provider.file}' not found at ${filePath}`);
      }

      const hashes = computeFileHashes(filePath);
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
