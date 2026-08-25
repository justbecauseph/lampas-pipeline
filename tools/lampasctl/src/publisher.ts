import * as fs from "node:fs";
import * as path from "node:path";
import { readJsonFile } from "./utils";
import type { PackManifest, ReleaseDescriptor } from "./types";
import {
  discoverLocalLampasBlobs,
  prepareBlobs,
  uploadMissingBlobs,
  formatBytes,
  type LocalPublishBlob,
} from "./blob-publisher";

export type ReleaseChannel = "dev" | "beta" | "stable";

export const ALL_RELEASE_CHANNELS: readonly ReleaseChannel[] = ["dev", "beta", "stable"];

export interface PublishOptions {
  manifestDir: string;
  packDir: string;
  portalUrl: string;
  publishSecret: string;
  channel?: ReleaseChannel | ReleaseChannel[] | string;
  maxConcurrency?: number;
}

export function resolvePublishChannels(channel?: ReleaseChannel | ReleaseChannel[] | string): ReleaseChannel[] {
  if (!channel || channel === "all" || channel === "true") {
    return [...ALL_RELEASE_CHANNELS];
  }

  let channels: string[];
  if (Array.isArray(channel)) {
    channels = channel;
  } else if (typeof channel === "string") {
    channels = channel.split(",").map((c) => c.trim()).filter(Boolean);
  } else {
    channels = [String(channel)];
  }

  if (channels.length === 0) {
    return [...ALL_RELEASE_CHANNELS];
  }

  for (const ch of channels) {
    if (!ALL_RELEASE_CHANNELS.includes(ch as ReleaseChannel)) {
      throw new Error(`Invalid channel '${ch}'. Supported channels are: ${ALL_RELEASE_CHANNELS.join(", ")} (or omit --channel to publish to all).`);
    }
  }

  return channels as ReleaseChannel[];
}

export async function publishRelease(options: PublishOptions): Promise<void> {
  const releasePath = path.join(options.manifestDir, "release.json");
  const clientManifestPath = path.join(options.manifestDir, "client-manifest.json");
  const serverManifestPath = path.join(options.manifestDir, "server-manifest.json");

  if (!fs.existsSync(releasePath) || !fs.existsSync(clientManifestPath) || !fs.existsSync(serverManifestPath)) {
    throw new Error(`Manifests missing in ${options.manifestDir}. Run 'lampasctl manifest' first.`);
  }

  if (!options.portalUrl) {
    throw new Error("Portal URL is required for 'publish'. Specify --portal <url> or PACK_PORTAL_URL.");
  }

  const release = readJsonFile<ReleaseDescriptor>(releasePath);
  const clientManifest = readJsonFile<PackManifest>(clientManifestPath);
  const serverManifest = readJsonFile<PackManifest>(serverManifestPath);
  const targetChannels = resolvePublishChannels(options.channel);

  console.log(`[Publish] Preparing to publish ${release.pack} v${release.version} to ${options.portalUrl} (channels: ${targetChannels.join(", ")})...`);

  // 1. Discover, locate, and validate all local Lampas blobs without buffering them into memory
  const localBlobs: LocalPublishBlob[] = await discoverLocalLampasBlobs({
    clientManifest,
    serverManifest,
    packDir: options.packDir,
  });

  const totalBytes = localBlobs.reduce((acc, b) => acc + b.size, 0);
  console.log(`[Publish] Found ${localBlobs.length} Lampas blobs (${formatBytes(totalBytes)})`);

  // 2. Prepare blobs: query portal for missing vs already-stored blobs in object storage
  if (localBlobs.length > 0) {
    console.log("[Publish] Checking remote blob state...");
    const preparedBlobs = await prepareBlobs(options.portalUrl, options.publishSecret, localBlobs);

    const missingPrepared = preparedBlobs.filter((b) => b.status === "upload");
    const existingCount = preparedBlobs.length - missingPrepared.length;

    const blobsToUpload: Array<{ blob: LocalPublishBlob; uploadUrl: string }> = [];
    let missingBytes = 0;

    for (const prep of missingPrepared) {
      const localBlob = localBlobs.find((b) => b.sha256 === prep.sha256);
      if (localBlob && prep.uploadUrl) {
        blobsToUpload.push({
          blob: localBlob,
          uploadUrl: prep.uploadUrl,
        });
        missingBytes += localBlob.size;
      }
    }

    console.log(`[Publish] ${existingCount} already stored; ${blobsToUpload.length} need upload (${formatBytes(missingBytes)})`);

    // 3. Direct presigned PUT upload with bounded concurrency
    if (blobsToUpload.length > 0) {
      await uploadMissingBlobs({
        blobsToUpload,
        maxConcurrency: options.maxConcurrency || 6,
      });
    }
  }

  // 4. Send single release metadata payload with all target channels and NO base64 payload
  const publishUrl = `${options.portalUrl.replace(/\/+$/, "")}/api/v1/releases/publish`;
  const payload = {
    version: release.version,
    minecraftVersion: release.minecraft,
    fabricVersion: release.loader.version,
    minimumLauncherVersion: release.minimumLauncherVersion,
    protocolVersion: release.protocol,
    clientManifest,
    serverManifest,
    launch: release.launch,
    channel: targetChannels[0],
    channels: targetChannels,
    gitCommit: release.gitCommit,
  };

  console.log(`[Publish] Publishing release metadata to ${publishUrl} (channels: ${targetChannels.join(", ")})...`);

  const res = await fetch(publishUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.publishSecret}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to publish release (${res.status} ${res.statusText}): ${errorText}`);
  }

  const result = (await res.json()) as any;
  const channelsStr = Array.isArray(result?.channelsUpdated)
    ? result.channelsUpdated.join(", ")
    : result?.channelUpdated || targetChannels.join(", ");

  console.log(`\n✓ [Publish Success] Release v${release.version} published! (channels: ${channelsStr})`);
}

