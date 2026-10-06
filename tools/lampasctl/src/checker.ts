import * as fs from "node:fs";
import * as path from "node:path";
import { matchingBlacklistRules, parsePackBlacklistRules, describeBlacklistRule } from "./blacklist";
import type { BlacklistRule, BlacklistTarget, ModDefinition, PackConfig } from "./types";
import { CURSEFORGE_FABRIC_LOADER_TYPE, CurseForgeClient, type CurseForgeFile } from "./curseforge";
import { parseTomlFile, writeTomlFile } from "./utils";

interface ModUpdateInfo {
  modId: string;
  name: string;
  provider: string;
  projectId: string;
  currentVersionId: string;
  currentVersionName: string;
  latestVersionId: string;
  latestVersionName: string;
  latestVersionUrl: string;
  latestFileName: string;
  changelog?: string;
  publishedAt?: string;
}

interface BlacklistDiagnostic {
  descriptorId: string;
  modName: string;
  projectId: string;
  provider: BlacklistTarget["provider"];
  rule: BlacklistRule;
  releaseId?: string;
  releaseName?: string;
  kind: "blocked" | "override";
  reason: "descriptor" | "current_pin" | "candidate" | "selected_update";
}

interface PreparedDescriptor {
  file: string;
  filePath: string;
  definition: ModDefinition;
}

export interface CheckUpdatesOptions {
  packDir: string;
  apply?: boolean;
  force?: boolean;
  markdownOut?: string;
  concurrency?: number;
}

type UpstreamRelease = {
  id: string | number;
  name?: string;
  version_number?: string;
  displayName?: string;
  fileName?: string;
  date_published?: string;
  fileDate?: string;
  changelog?: string;
  files?: Array<{ primary?: boolean; filename?: string }>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateDescriptorProviderIds(file: string, definition: ModDefinition): void {
  const provider = definition?.provider as unknown as Record<string, unknown> | undefined;
  if (!isPlainObject(provider)) throw new Error(`Invalid provider configuration in ${file}: provider must be a table.`);
  if (provider.type === "modrinth") {
    for (const key of ["project_id", "version_id"] as const) {
      const value = provider[key];
      if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /\s/.test(value)) {
        throw new Error(`Invalid provider configuration in ${file}: Modrinth ${key} must be a non-empty string without whitespace.`);
      }
    }
  } else if (provider.type === "curseforge") {
    for (const key of ["project_id", "file_id"] as const) {
      const value = provider[key];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Invalid provider configuration in ${file}: CurseForge ${key} must be a positive safe integer.`);
      }
    }
  }
}

function publishedTime(release: UpstreamRelease): number | undefined {
  const value = release.date_published || release.fileDate;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function sortByPublishedDate<T extends UpstreamRelease>(releases: T[]): T[] {
  return [...releases].sort((a, b) => publishedTime(b)! - publishedTime(a)!);
}

function hasComparableDates(releases: UpstreamRelease[]): boolean {
  return releases.every((release) => publishedTime(release) !== undefined);
}

function describeRelease(release: UpstreamRelease): string {
  return release.version_number || release.displayName || release.name || release.fileName || String(release.id);
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function describeRule(rule: BlacklistRule): string {
  return describeBlacklistRule(rule);
}

function projectAndPinTarget(
  modId: string,
  provider: "modrinth" | "curseforge",
  projectId: string | number,
  versionId?: string | number
): BlacklistTarget {
  return { modId, provider, projectId, versionId };
}

function recordBlacklistMatches(
  diagnostics: BlacklistDiagnostic[],
  matches: readonly BlacklistRule[],
  details: Omit<BlacklistDiagnostic, "rule" | "kind">,
  force: boolean
): void {
  for (const rule of matches) {
    const kind = force ? "override" : "blocked";
    const item: BlacklistDiagnostic = { ...details, rule, kind };
    diagnostics.push(item);
    if (force) {
      console.warn(
        `  ⚠ [Blacklist Override] ${details.modName} (${details.descriptorId}): --force ignored ${describeRule(rule)}${details.releaseId ? ` for release ${details.releaseId}` : ""}.`
      );
    } else {
      console.warn(
        `  ⛔ [Blocked by Blacklist] ${details.modName} (${details.descriptorId}): ${describeRule(rule)}${details.releaseId ? ` matched release ${details.releaseId}` : ""}.`
      );
    }
  }
}

function associateDescriptorOverrideWithUpdate(
  diagnostics: BlacklistDiagnostic[],
  descriptorId: string,
  rules: readonly BlacklistRule[],
  release: UpstreamRelease
): void {
  for (const diagnostic of diagnostics) {
    if (
      diagnostic.kind === "override" &&
      diagnostic.reason === "descriptor" &&
      diagnostic.descriptorId === descriptorId &&
      rules.includes(diagnostic.rule)
    ) {
      diagnostic.releaseId = String(release.id);
      diagnostic.releaseName = describeRelease(release);
      diagnostic.reason = "selected_update";
    }
  }
}

function matchingBroadRules(
  rules: readonly BlacklistRule[],
  target: BlacklistTarget
): BlacklistRule[] {
  return matchingBlacklistRules(rules, target).filter((rule) => rule.scope !== "version_id");
}

function releaseBlacklistRules(
  rules: readonly BlacklistRule[],
  target: BlacklistTarget,
  releaseId: string | number
): BlacklistRule[] {
  return matchingBlacklistRules(rules, { ...target, versionId: releaseId }).filter((rule) => rule.scope === "version_id");
}

function writeMarkdownReport(
  markdownOut: string,
  packConfig: PackConfig,
  updates: ModUpdateInfo[],
  diagnostics: BlacklistDiagnostic[],
  skippedChecks: Array<{ descriptorId: string; modName: string; reason: string }>
): void {
  let md = `## 📦 Upstream Mod Updates Available (${updates.length})\n\n`;
  md += `Target: **Minecraft ${packConfig.pack.minecraft}** • **Fabric ${packConfig.loader.version}**\n\n`;
  md += `| Mod | Mod ID | Project ID | Version | Version IDs | Release Date |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;

  for (const update of updates) {
    const dateStr = update.publishedAt ? new Date(update.publishedAt).toLocaleDateString() : "N/A";
    md += `| **${escapeMarkdownCell(update.name)}** | \`${update.modId}\` | \`${escapeMarkdownCell(update.projectId)}\` | **${escapeMarkdownCell(update.currentVersionName)}** → [**${escapeMarkdownCell(update.latestVersionName)}**](${update.latestVersionUrl}) | \`${update.currentVersionId}\` → \`${update.latestVersionId}\` | ${dateStr} |\n`;
  }

  const blocked = diagnostics.filter((item) => item.kind === "blocked");
  const overrides = diagnostics.filter((item) => item.kind === "override");
  md += `\n## Blocked Releases (${blocked.length})\n\n`;
  if (blocked.length === 0) {
    md += `No releases or descriptors matched a blacklist.\n`;
  } else {
    md += `| Descriptor | Mod | Scope and exact rule | Project ID | Release | Exact release ID |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;
    for (const item of blocked) {
      const label = item.releaseName ? `${item.releaseName}${item.reason === "current_pin" ? " (current pin)" : ""}` : "Entire descriptor skipped";
      const releaseId = item.releaseId ? `\`${item.releaseId}\`` : "—";
      md += `| \`${item.descriptorId}.toml\` | ${escapeMarkdownCell(item.modName)} | ${escapeMarkdownCell(describeRule(item.rule))} | \`${escapeMarkdownCell(item.projectId)}\` | ${escapeMarkdownCell(label)} | ${releaseId} |\n`;
    }
  }

  md += `\n## Blacklist Overrides (${overrides.length})\n\n`;
  if (overrides.length === 0) {
    md += `No blacklist entries were bypassed.\n`;
  } else {
    md += `This invocation used \`--force\`; listed matches were ignored for this update check.\n\n`;
    md += `| Descriptor | Mod | Scope and exact rule | Project ID | Release | Exact release ID | Override context |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
    for (const item of overrides) {
      const label = item.releaseName ? `${item.releaseName}${item.reason === "current_pin" ? " (current pin)" : ""}` : "All compatible releases checked";
      md += `| \`${item.descriptorId}.toml\` | ${escapeMarkdownCell(item.modName)} | ${escapeMarkdownCell(describeRule(item.rule))} | \`${escapeMarkdownCell(item.projectId)}\` | ${escapeMarkdownCell(label)} | ${item.releaseId ? `\`${item.releaseId}\`` : "—"} | ${item.reason.replace(/_/g, " ")} |\n`;
    }
  }

  md += `\n## Skipped Checks (${skippedChecks.length})\n\n`;
  if (skippedChecks.length === 0) {
    md += `No update checks were skipped.\n`;
  } else {
    md += `| Descriptor | Mod | Reason |\n`;
    md += `| :--- | :--- | :--- |\n`;
    for (const item of skippedChecks) {
      md += `| \`${item.descriptorId}.toml\` | ${escapeMarkdownCell(item.modName)} | ${escapeMarkdownCell(item.reason)} |\n`;
    }
  }

  fs.writeFileSync(markdownOut, md, "utf-8");
}

export async function checkPackUpdates(options: CheckUpdatesOptions): Promise<ModUpdateInfo[]> {
  const packConfigFile = path.join(options.packDir, "pack.toml");
  const modsDir = path.join(options.packDir, "mods");

  if (!fs.existsSync(packConfigFile)) throw new Error(`pack.toml not found at ${packConfigFile}`);
  if (!fs.existsSync(modsDir)) throw new Error(`mods directory not found at ${modsDir}`);

  const packConfig = parseTomlFile<PackConfig>(packConfigFile);
  // This validates the complete policy before any upstream requests or descriptor writes.
  const blacklistRules = parsePackBlacklistRules(packConfig, packConfigFile);
  const targetMc = packConfig.pack.minecraft;
  const targetLoader = packConfig.loader.type;

  const modFiles = fs.readdirSync(modsDir).filter((file) => file.endsWith(".toml")).sort();
  const descriptors: PreparedDescriptor[] = modFiles.map((file) => {
    const filePath = path.join(modsDir, file);
    const definition = parseTomlFile<ModDefinition>(filePath);
    validateDescriptorProviderIds(file, definition);
    return { file, filePath, definition };
  });

  console.log(`[Update Checker] Scanning upstream updates for Minecraft ${targetMc} (${targetLoader})...\n`);

  const updatesAvailable: ModUpdateInfo[] = [];
  const blacklistDiagnostics: BlacklistDiagnostic[] = [];
  const skippedChecks: Array<{ descriptorId: string; modName: string; reason: string }> = [];
  let upToDateCount = 0;
  let skippedCount = 0;
  const recordSkip = (descriptorId: string, modName: string, reason: string) => {
    skippedCount++;
    skippedChecks.push({ descriptorId, modName, reason });
    console.warn(`  ⚠ [Skipped] ${modName} (${descriptorId}): ${reason}`);
  };
  const queue = [...descriptors];
  const concurrency = options.concurrency || 12;
  const force = options.force === true;

  async function worker() {
    while (queue.length > 0) {
      const descriptor = queue.shift();
      if (!descriptor) break;
      const { file, filePath, definition: def } = descriptor;
      const modId = path.basename(file, ".toml");
      const provider = def.provider;

      if (provider.type === "modrinth") {
        const projectId = provider.project_id;
        const currentVersionId = provider.version_id;
        const baseTarget = projectAndPinTarget(modId, "modrinth", projectId);
        const currentPinRules = matchingBlacklistRules(blacklistRules, {
          ...baseTarget,
          versionId: currentVersionId,
        }).filter((rule) => rule.scope === "version_id");
        if (currentPinRules.length > 0) {
          recordBlacklistMatches(
            blacklistDiagnostics,
            currentPinRules,
            {
              descriptorId: modId,
              modName: def.name,
              projectId,
              provider: "modrinth",
              releaseId: currentVersionId,
              releaseName: currentVersionId,
              reason: "current_pin",
            },
            force
          );
        }
        const broadMatches = matchingBroadRules(blacklistRules, baseTarget);
        if (broadMatches.length > 0) {
          recordBlacklistMatches(
            blacklistDiagnostics,
            broadMatches,
            {
              descriptorId: modId,
              modName: def.name,
              projectId,
              provider: "modrinth",
              reason: "descriptor",
            },
            force
          );
          if (!force) continue;
        }

        try {
          const url = `https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version?game_versions=[%22${encodeURIComponent(targetMc)}%22]&loaders=[%22${encodeURIComponent(targetLoader)}%22]`;
          const res = await fetch(url, {
            headers: {
              "User-Agent": "Lampas-Pipeline/2.0 (update-checker)",
              Accept: "application/json",
            },
          });
          if (!res.ok) {
            recordSkip(modId, def.name, `Modrinth returned HTTP ${res.status}.`);
            continue;
          }

          const response = await res.json();
          if (!Array.isArray(response) || response.some((release) =>
            !isPlainObject(release) || typeof release.id !== "string" || release.id.length === 0 || release.id.trim() !== release.id || /\s/.test(release.id)
          )) {
            recordSkip(modId, def.name, "Modrinth returned malformed version metadata.");
            continue;
          }
          const rawVersions = response as UpstreamRelease[];
          if (rawVersions.length === 0) {
            recordSkip(modId, def.name, "Modrinth returned no compatible releases.");
            continue;
          }

          let currentVersionMetadata = rawVersions.find((version) => version.id === currentVersionId);
          if (!currentVersionMetadata || publishedTime(currentVersionMetadata) === undefined) {
            try {
              const currentRes = await fetch(`https://api.modrinth.com/v2/version/${encodeURIComponent(currentVersionId)}`, {
                headers: {
                  "User-Agent": "Lampas-Pipeline/2.0 (update-checker)",
                  Accept: "application/json",
                },
              });
              if (currentRes.ok) {
                const metadata = await currentRes.json();
                if (isPlainObject(metadata) && metadata.id === currentVersionId) currentVersionMetadata = metadata as UpstreamRelease;
              }
            } catch {
              // If the current pin cannot be dated, newness cannot be established safely.
            }
          }
          const currentTime = currentVersionMetadata && currentVersionMetadata.id === currentVersionId
            ? publishedTime(currentVersionMetadata)
            : undefined;
          if (currentTime === undefined || !hasComparableDates(rawVersions)) {
            const reason = `Pinned release ${currentVersionId} or a compatible candidate has no valid publication date; newness could not be established.`;
            recordSkip(modId, def.name, reason);
            continue;
          }
          const versions = sortByPublishedDate(rawVersions);
          const newerVersions = versions.filter((version) => publishedTime(version)! > currentTime);

          let latest: UpstreamRelease | undefined;
          for (const release of newerVersions) {
            const matches = releaseBlacklistRules(blacklistRules, baseTarget, release.id);
            if (matches.length > 0 && !force) {
              recordBlacklistMatches(
                blacklistDiagnostics,
                matches,
                {
                  descriptorId: modId,
                  modName: def.name,
                  projectId,
                  provider: "modrinth",
                  releaseId: String(release.id),
                  releaseName: describeRelease(release),
                  reason: "candidate",
                },
                force
              );
              continue;
            }
            latest = release;
            if (matches.length > 0) {
              recordBlacklistMatches(
                blacklistDiagnostics,
                matches,
                {
                  descriptorId: modId,
                  modName: def.name,
                  projectId,
                  provider: "modrinth",
                  releaseId: String(release.id),
                  releaseName: describeRelease(release),
                  reason: "selected_update",
                },
                force
              );
            }
            break;
          }

          if (!latest) {
            if (newerVersions.length === 0) upToDateCount++;
            continue;
          }

          if (force && broadMatches.length > 0) {
            associateDescriptorOverrideWithUpdate(blacklistDiagnostics, modId, broadMatches, latest);
          }
          const latestId = String(latest.id);
          const primaryFile = latest.files?.find((candidate) => candidate.primary) || latest.files?.[0];
          const updateInfo: ModUpdateInfo = {
            modId,
            name: def.name,
            provider: "modrinth",
            projectId,
            currentVersionId,
            currentVersionName: currentVersionMetadata?.version_number || currentVersionMetadata?.name || currentVersionId,
            latestVersionId: latestId,
            latestVersionName: latest.version_number || latest.name || latestId,
            latestVersionUrl: `https://modrinth.com/mod/${encodeURIComponent(projectId)}/version/${encodeURIComponent(latestId)}`,
            latestFileName: primaryFile?.filename || latest.name || latestId,
            changelog: latest.changelog ? latest.changelog.trim().substring(0, 300) : undefined,
            publishedAt: latest.date_published,
          };
          updatesAvailable.push(updateInfo);
          console.log(`  ⚡ [Update Found] ${def.name}`);
          console.log(`     Mod ID: ${modId}`);
          console.log(`     Project ID: ${projectId}`);
          console.log(`     Version: ${updateInfo.currentVersionName} -> ${updateInfo.latestVersionName}`);
          console.log(`     Version IDs: ${currentVersionId} -> ${latestId}`);
          console.log(`     Updated version: ${updateInfo.latestVersionUrl}`);

          if (options.apply) {
            provider.version_id = latestId;
            writeTomlFile(filePath, def);
            console.log(`     ✓ Applied to ${file}`);
          }
        } catch (err: any) {
          recordSkip(modId, def.name, err?.message || String(err));
        }
      } else if (provider.type === "curseforge") {
        const projectId = provider.project_id;
        const currentFileId = provider.file_id;
        const baseTarget = projectAndPinTarget(modId, "curseforge", projectId);
        const currentPinRules = matchingBlacklistRules(blacklistRules, {
          ...baseTarget,
          versionId: currentFileId,
        }).filter((rule) => rule.scope === "version_id");
        if (currentPinRules.length > 0) {
          recordBlacklistMatches(
            blacklistDiagnostics,
            currentPinRules,
            {
              descriptorId: modId,
              modName: def.name,
              projectId: String(projectId),
              provider: "curseforge",
              releaseId: String(currentFileId),
              releaseName: String(currentFileId),
              reason: "current_pin",
            },
            force
          );
        }
        const broadMatches = matchingBroadRules(blacklistRules, baseTarget);
        if (broadMatches.length > 0) {
          recordBlacklistMatches(
            blacklistDiagnostics,
            broadMatches,
            {
              descriptorId: modId,
              modName: def.name,
              projectId: String(projectId),
              provider: "curseforge",
              reason: "descriptor",
            },
            force
          );
          if (!force) continue;
        }

        try {
          const files = await CurseForgeClient.getModFiles(projectId, {
            gameVersion: targetMc,
            modLoaderType: CURSEFORGE_FABRIC_LOADER_TYPE,
          });
          if (files.some((candidate) => !Number.isSafeInteger(candidate.id) || candidate.id <= 0)) {
            recordSkip(modId, def.name, "CurseForge returned malformed file ID metadata.");
            continue;
          }
          const rawFiles = files as CurseForgeFile[];
          if (rawFiles.length === 0) {
            recordSkip(modId, def.name, "CurseForge returned no compatible releases.");
            continue;
          }

          let currentFileMetadata = rawFiles.find((candidate) => candidate.id === currentFileId);
          if (!currentFileMetadata || publishedTime(currentFileMetadata) === undefined) {
            try {
              currentFileMetadata = await CurseForgeClient.getFile(projectId, currentFileId);
            } catch (error: any) {
              if (error?.message?.includes("CURSEFORGE_API_KEY")) throw error;
              currentFileMetadata = undefined;
            }
          }
          const currentTime = currentFileMetadata?.id === currentFileId ? publishedTime(currentFileMetadata) : undefined;
          if (currentTime === undefined || !hasComparableDates(rawFiles)) {
            const reason = `Pinned file ${currentFileId} or a compatible candidate has no valid publication date; newness could not be established.`;
            recordSkip(modId, def.name, reason);
            continue;
          }
          const sortedFiles = sortByPublishedDate(rawFiles) as CurseForgeFile[];
          const newerFiles = sortedFiles.filter((candidate) => publishedTime(candidate)! > currentTime);

          let latest: CurseForgeFile | undefined;
          for (const release of newerFiles) {
            const matches = releaseBlacklistRules(blacklistRules, baseTarget, release.id);
            if (matches.length > 0 && !force) {
              recordBlacklistMatches(
                blacklistDiagnostics,
                matches,
                {
                  descriptorId: modId,
                  modName: def.name,
                  projectId: String(projectId),
                  provider: "curseforge",
                  releaseId: String(release.id),
                  releaseName: describeRelease(release),
                  reason: "candidate",
                },
                force
              );
              continue;
            }
            latest = release;
            if (matches.length > 0) {
              recordBlacklistMatches(
                blacklistDiagnostics,
                matches,
                {
                  descriptorId: modId,
                  modName: def.name,
                  projectId: String(projectId),
                  provider: "curseforge",
                  releaseId: String(release.id),
                  releaseName: describeRelease(release),
                  reason: "selected_update",
                },
                force
              );
            }
            break;
          }

          if (!latest) {
            if (newerFiles.length === 0) upToDateCount++;
            continue;
          }

          if (force && broadMatches.length > 0) {
            associateDescriptorOverrideWithUpdate(blacklistDiagnostics, modId, broadMatches, latest);
          }
          const project = await CurseForgeClient.getMod(projectId);
          const latestVersionUrl = `https://www.curseforge.com/minecraft/mc-mods/${project.slug}/files/${latest.id}`;
          const updateInfo: ModUpdateInfo = {
            modId,
            name: def.name,
            provider: "curseforge",
            projectId: String(projectId),
            currentVersionId: String(currentFileId),
            currentVersionName: currentFileMetadata?.displayName || currentFileMetadata?.fileName || String(currentFileId),
            latestVersionId: String(latest.id),
            latestVersionName: latest.displayName || latest.fileName,
            latestVersionUrl,
            latestFileName: latest.fileName,
            publishedAt: latest.fileDate,
          };
          updatesAvailable.push(updateInfo);
          console.log(`  ⚡ [Update Found] ${def.name}`);
          console.log(`     Mod ID: ${modId}`);
          console.log(`     Project ID: ${projectId}`);
          console.log(`     Version: ${updateInfo.currentVersionName} -> ${updateInfo.latestVersionName}`);
          console.log(`     File IDs: ${currentFileId} -> ${latest.id}`);
          console.log(`     Updated version: ${latestVersionUrl}`);

          if (options.apply) {
            provider.file_id = latest.id;
            writeTomlFile(filePath, def);
            console.log(`     ✓ Applied to ${file}`);
          }
        } catch (err: any) {
          if (err?.message?.includes("CURSEFORGE_API_KEY")) throw err;
          recordSkip(modId, def.name, err?.message || String(err));
        }
      } else {
        const modMatches = matchingBlacklistRules(blacklistRules, { modId, provider: provider.type });
        if (modMatches.length > 0) {
          recordBlacklistMatches(
            blacklistDiagnostics,
            modMatches,
            {
              descriptorId: modId,
              modName: def.name,
              projectId: "",
              provider: provider.type,
              reason: "descriptor",
            },
            force
          );
          if (!force) continue;
        }
        recordSkip(modId, def.name, `Provider ${String(provider.type)} has no upstream update source.`);
      }
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), descriptors.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  updatesAvailable.sort((a, b) => a.modId.localeCompare(b.modId));
  blacklistDiagnostics.sort(
    (a, b) => a.descriptorId.localeCompare(b.descriptorId) || (a.releaseId || "").localeCompare(b.releaseId || "")
  );
  const blockedCount = blacklistDiagnostics.filter((item) => item.kind === "blocked").length;
  const overrideCount = blacklistDiagnostics.filter((item) => item.kind === "override").length;
  console.log("\n" + "=".repeat(60));
  console.log(` [Update Summary] ${updatesAvailable.length} updates found, ${upToDateCount} up-to-date, ${blockedCount} blacklist block(s), ${overrideCount} blacklist override(s), ${skippedCount} custom/skipped.`);
  console.log("=".repeat(60) + "\n");

  if (options.markdownOut) {
    writeMarkdownReport(options.markdownOut, packConfig, updatesAvailable, blacklistDiagnostics, skippedChecks);
    console.log(`[Update Checker] Markdown report written to ${options.markdownOut}`);
  }

  return updatesAvailable;
}
