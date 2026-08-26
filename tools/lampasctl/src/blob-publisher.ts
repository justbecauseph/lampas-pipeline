import * as fs from "node:fs";
import * as path from "node:path";
import type { PackManifest, ReleaseDescriptor } from "./types";
import { computeFileHashesStreaming } from "./utils";

export interface LocalPublishBlob {
  sha256: string;
  size: number;
  mimeType: string;
  localPath: string;
  manifestPath: string;
}

export interface PreparedBlob {
  sha256: string;
  status: "exists" | "upload";
  storageKey: string;
  uploadUrl?: string;
  expiresAt?: string;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const k = 1024;
  const sizes = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Discovers and validates all Lampas-provided files declared in manifests and release descriptors
 * without loading binary content into memory.
 * Ensures local files exist, match declared sizes, and match declared SHA-256 hashes.
 */
export async function discoverLocalLampasBlobs(params: {
  clientManifest: PackManifest;
  serverManifest: PackManifest;
  packDir: string;
  release?: ReleaseDescriptor;
}): Promise<LocalPublishBlob[]> {
  const { clientManifest, serverManifest, packDir, release } = params;
  const allFiles = [...clientManifest.files, ...serverManifest.files];
  const uniqueBlobs = new Map<string, { path: string; size?: number }>();

  for (const f of allFiles) {
    if (f.download?.provider === "lampas") {
      const sha = (f.hashes?.sha256 || "").toLowerCase().trim();
      if (!sha) {
        throw new Error(`Lampas file '${f.path}' is missing SHA-256 hash in manifest.`);
      }
      if (!uniqueBlobs.has(sha)) {
        uniqueBlobs.set(sha, { path: f.path, size: f.size });
      }
    }
  }

  // Also include server-enforced resource pack if it is a Lampas CAS blob
  const srp = release?.serverResourcePack || serverManifest.resourcePack;
  if (srp?.sha256) {
    const sha = srp.sha256.toLowerCase().trim();
    const isLampasBlob = srp.url.includes("/api/v1/blobs/") || !srp.url.startsWith("http");
    if (isLampasBlob && !uniqueBlobs.has(sha)) {
      const relPath = srp.path || (srp.filename ? `resourcepacks/${srp.filename}` : `resourcepacks/${srp.artifact}.zip`);
      uniqueBlobs.set(sha, { path: relPath, size: undefined });
    }
  }

  const discoveredBlobs: LocalPublishBlob[] = [];

  for (const [sha, info] of uniqueBlobs.entries()) {
    const candidatePaths = [
      path.resolve(packDir, "common", info.path),
      path.resolve(packDir, "client", info.path),
      path.resolve(packDir, "server", info.path),
      path.resolve(packDir, "custom", path.basename(info.path)),
      path.resolve(packDir, "resourcepacks", path.basename(info.path)),
      path.resolve(packDir, "custom", info.path),
      path.resolve(packDir, info.path),
    ];

    const foundPath = candidatePaths.find((p) => fs.existsSync(p));
    if (!foundPath) {
      throw new Error(
        `Lampas blob ${sha} for manifest path '${info.path}' could not be found locally.\n` +
        `Checked candidate paths:\n  ${candidatePaths.join("\n  ")}`
      );
    }

    const stat = fs.statSync(foundPath);
    if (typeof info.size === "number" && stat.size !== info.size) {
      throw new Error(
        `Local file size mismatch for '${info.path}' (${foundPath}): manifest declares ${info.size} bytes, but found ${stat.size} bytes on disk.`
      );
    }

    const hashes = await computeFileHashesStreaming(foundPath);
    if (hashes.sha256.toLowerCase() !== sha) {
      throw new Error(
        `Local SHA-256 mismatch for '${info.path}' (${foundPath}): manifest declares ${sha}, but computed ${hashes.sha256}.`
      );
    }

    const mimeType = info.path.endsWith(".json")
      ? "application/json"
      : info.path.endsWith(".jar")
      ? "application/java-archive"
      : "application/octet-stream";

    discoveredBlobs.push({
      sha256: sha,
      size: stat.size,
      mimeType,
      localPath: foundPath,
      manifestPath: info.path,
    });
  }

  return discoveredBlobs;
}

/**
 * Calls the Portal's blob preparation API to determine which blobs are already in object storage vs need uploading.
 */
export async function prepareBlobs(
  portalUrl: string,
  publishSecret: string,
  blobs: LocalPublishBlob[]
): Promise<PreparedBlob[]> {
  if (blobs.length === 0) return [];

  const prepareUrl = `${portalUrl.replace(/\/+$/, "")}/api/v1/blobs/prepare`;

  const payload = {
    blobs: blobs.map((b) => ({
      sha256: b.sha256,
      size: b.size,
      mimeType: b.mimeType,
    })),
  };

  const res = await fetch(prepareUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${publishSecret}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Blob preparation failed (${res.status} ${res.statusText}): ${errorText}`);
  }

  const data = (await res.json()) as { blobs: PreparedBlob[] };
  if (!data || !Array.isArray(data.blobs)) {
    throw new Error("Invalid response from blob preparation endpoint");
  }

  return data.blobs;
}

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_BACKOFF_MS = [500, 1000, 2000];

/**
 * Uploads a single blob directly to S3 via presigned PUT URL with retry logic for transient errors.
 */
export async function uploadSingleBlob(blob: LocalPublishBlob, uploadUrl: string): Promise<void> {
  let lastError: Error | null = null;
  const maxAttempts = RETRY_BACKOFF_MS.length + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": blob.mimeType,
          "Cache-Control": "public, max-age=31536000, immutable",
        },
        body: Bun.file(blob.localPath),
      });

      if (res.ok) {
        return;
      }

      if (!RETRYABLE_STATUS_CODES.has(res.status)) {
        const errorText = await res.text();
        throw new Error(
          `Direct PUT upload failed with status ${res.status} ${res.statusText}: ${errorText}`
        );
      }

      lastError = new Error(`Direct PUT upload received transient status ${res.status} ${res.statusText}`);
    } catch (err: any) {
      if (err.message?.includes("Direct PUT upload failed with status")) {
        throw err;
      }
      lastError = err;
    }

    if (attempt < maxAttempts) {
      const backoff = RETRY_BACKOFF_MS[attempt - 1];
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }

  throw new Error(
    `Direct PUT upload failed for '${blob.manifestPath}' (${blob.sha256}) after ${maxAttempts} attempts: ${lastError?.message || lastError}`
  );
}

export interface UploadMissingBlobsOptions {
  blobsToUpload: Array<{ blob: LocalPublishBlob; uploadUrl: string }>;
  maxConcurrency?: number;
  log?: (message: string) => void;
}

/**
 * Uploads missing blobs with bounded concurrency and progress reporting.
 */
export async function uploadMissingBlobs(options: UploadMissingBlobsOptions): Promise<void> {
  const { blobsToUpload, maxConcurrency = 6, log = console.log } = options;
  const total = blobsToUpload.length;
  if (total === 0) return;

  let currentIndex = 0;
  let completedCount = 0;
  let errorToThrow: Error | null = null;

  async function worker() {
    while (currentIndex < total && !errorToThrow) {
      const taskIndex = currentIndex++;
      const item = blobsToUpload[taskIndex];
      if (!item) break;

      log(`  ↑ [Upload ${taskIndex + 1}/${total}] ${item.blob.manifestPath} (${formatBytes(item.blob.size)})...`);

      try {
        await uploadSingleBlob(item.blob, item.uploadUrl);
        completedCount++;
      } catch (err: any) {
        errorToThrow = err;
        break;
      }
    }
  }

  const workerCount = Math.min(maxConcurrency, total);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  if (errorToThrow) {
    throw errorToThrow;
  }

  log(`  ✓ [Upload ${completedCount}/${total} complete] All blobs uploaded successfully.`);
}
