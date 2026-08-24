import * as fs from "node:fs";
import * as path from "node:path";
import { readJsonFile } from "./utils";
import type { PackManifest, ReleaseDescriptor } from "./types";

export type ReleaseChannel = "dev" | "beta" | "stable";

export const ALL_RELEASE_CHANNELS: readonly ReleaseChannel[] = ["dev", "beta", "stable"];

export interface PublishOptions {
  manifestDir: string;
  packDir: string;
  portalUrl: string;
  publishSecret: string;
  channel?: ReleaseChannel | ReleaseChannel[] | string;
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

  // Collect Lampas blobs to upload
  const blobsToUpload: Array<{
    sha256: string;
    size: number;
    mimeType: string;
    contentBase64: string;
  }> = [];

  const allFiles = [...clientManifest.files, ...serverManifest.files];
  const uploadedHashes = new Set<string>();

  for (const f of allFiles) {
    if (f.download.provider === "lampas" && !uploadedHashes.has(f.hashes.sha256)) {
      uploadedHashes.add(f.hashes.sha256);

      // Locate local file
      const candidatePaths = [
        path.resolve(options.packDir, "common", f.path),
        path.resolve(options.packDir, "client", f.path),
        path.resolve(options.packDir, "server", f.path),
        path.resolve(options.packDir, "custom", path.basename(f.path)),
      ];

      const foundPath = candidatePaths.find((p) => fs.existsSync(p));
      if (foundPath) {
        const buffer = fs.readFileSync(foundPath);
        blobsToUpload.push({
          sha256: f.hashes.sha256,
          size: buffer.length,
          mimeType: f.path.endsWith(".json")
            ? "application/json"
            : f.path.endsWith(".jar")
            ? "application/java-archive"
            : "application/octet-stream",
          contentBase64: buffer.toString("base64"),
        });
      }
    }
  }

  console.log(`[Publish] Packaging ${blobsToUpload.length} content blobs...`);

  const publishUrl = `${options.portalUrl.replace(/\/+$/, "")}/api/v1/releases/publish`;

  for (const ch of targetChannels) {
    const payload = {
      version: release.version,
      minecraftVersion: release.minecraft,
      fabricVersion: release.loader.version,
      minimumLauncherVersion: release.minimumLauncherVersion,
      protocolVersion: release.protocol,
      clientManifest,
      serverManifest,
      launch: release.launch,
      channel: ch,
      gitCommit: release.gitCommit,
      blobs: blobsToUpload,
    };

    console.log(`[Publish] Sending release payload to ${publishUrl} (channel: ${ch})...`);

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
      throw new Error(`Failed to publish release to channel '${ch}' (${res.status} ${res.statusText}): ${errorText}`);
    }

    const result = (await res.json()) as any;
    console.log(`\n✓ [Publish Success] Release v${release.version} published to channel '${result?.channelUpdated || ch}'!`);
  }
}
