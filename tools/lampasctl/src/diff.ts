import * as fs from "node:fs";
import * as path from "node:path";
import { readJsonFile } from "./utils";
import type { PackManifest, ManifestFileEntry } from "./types";

export interface DiffOptions {
  fromManifestPath: string;
  toManifestPath: string;
  markdownOut?: string;
}

export interface DiffResult {
  added: ManifestFileEntry[];
  removed: ManifestFileEntry[];
  modified: Array<{
    path: string;
    oldSize: number;
    newSize: number;
    oldHash: string;
    newHash: string;
  }>;
  totalSizeDelta: number;
}

function formatBytes(bytes: number): string {
  if (Math.abs(bytes) < 1024) return `${bytes} B`;
  if (Math.abs(bytes) < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export async function diffManifests(options: DiffOptions): Promise<DiffResult> {
  if (!fs.existsSync(options.fromManifestPath)) {
    throw new Error(`Base manifest not found: ${options.fromManifestPath}`);
  }
  if (!fs.existsSync(options.toManifestPath)) {
    throw new Error(`Target manifest not found: ${options.toManifestPath}`);
  }

  const manifestA = readJsonFile<PackManifest>(options.fromManifestPath);
  const manifestB = readJsonFile<PackManifest>(options.toManifestPath);

  const filesA = new Map<string, ManifestFileEntry>(manifestA.files.map((f) => [f.path, f]));
  const filesB = new Map<string, ManifestFileEntry>(manifestB.files.map((f) => [f.path, f]));

  const added: ManifestFileEntry[] = [];
  const removed: ManifestFileEntry[] = [];
  const modified: DiffResult["modified"] = [];

  let totalSizeDelta = 0;

  // Check additions and modifications
  for (const [pathKey, entryB] of filesB.entries()) {
    const entryA = filesA.get(pathKey);
    if (!entryA) {
      added.push(entryB);
      totalSizeDelta += entryB.size;
    } else if (entryA.hashes.sha256 !== entryB.hashes.sha256) {
      modified.push({
        path: pathKey,
        oldSize: entryA.size,
        newSize: entryB.size,
        oldHash: entryA.hashes.sha256,
        newHash: entryB.hashes.sha256,
      });
      totalSizeDelta += entryB.size - entryA.size;
    }
  }

  // Check removals
  for (const [pathKey, entryA] of filesA.entries()) {
    if (!filesB.has(pathKey)) {
      removed.push(entryA);
      totalSizeDelta -= entryA.size;
    }
  }

  console.log("=".repeat(60));
  console.log(` Pack Manifest Diff: ${manifestA.version} -> ${manifestB.version} (${manifestB.target})`);
  console.log("=".repeat(60));

  if (added.length > 0) {
    console.log(`\n➕ Added Files (${added.length}):`);
    for (const a of added) {
      console.log(`  + ${a.path} (${formatBytes(a.size)})`);
    }
  }

  if (removed.length > 0) {
    console.log(`\n➖ Removed Files (${removed.length}):`);
    for (const r of removed) {
      console.log(`  - ${r.path} (${formatBytes(r.size)})`);
    }
  }

  if (modified.length > 0) {
    console.log(`\n🔄 Modified / Updated Files (${modified.length}):`);
    for (const m of modified) {
      const delta = m.newSize - m.oldSize;
      const deltaStr = delta >= 0 ? `+${formatBytes(delta)}` : formatBytes(delta);
      console.log(`  ~ ${m.path} (${formatBytes(m.oldSize)} -> ${formatBytes(m.newSize)}, delta: ${deltaStr})`);
    }
  }

  console.log("\n" + "-".repeat(60));
  console.log(
    ` Summary: +${added.length} added, -${removed.length} removed, ~${modified.length} updated.`
  );
  console.log(` Net Size Delta: ${totalSizeDelta >= 0 ? "+" : ""}${formatBytes(totalSizeDelta)}`);
  console.log("-".repeat(60) + "\n");

  if (options.markdownOut) {
    let md = `## 🔍 Modpack Release Diff: \`v${manifestA.version}\` ➔ \`v${manifestB.version}\`\n\n`;
    md += `**Target Scope**: \`${manifestB.target}\` • **Net Size Delta**: \`${totalSizeDelta >= 0 ? "+" : ""}${formatBytes(totalSizeDelta)}\`\n\n`;

    if (added.length > 0) {
      md += `### ➕ Added Files (${added.length})\n\n`;
      md += `| File Path | Size |\n| :--- | :--- |\n`;
      for (const a of added) {
        md += `| \`${a.path}\` | ${formatBytes(a.size)} |\n`;
      }
      md += "\n";
    }

    if (removed.length > 0) {
      md += `### ➖ Removed Files (${removed.length})\n\n`;
      md += `| File Path | Size |\n| :--- | :--- |\n`;
      for (const r of removed) {
        md += `| \`${r.path}\` | ${formatBytes(r.size)} |\n`;
      }
      md += "\n";
    }

    if (modified.length > 0) {
      md += `### 🔄 Updated Files (${modified.length})\n\n`;
      md += `| File Path | Previous Size | New Size | Delta |\n| :--- | :--- | :--- | :--- |\n`;
      for (const m of modified) {
        const delta = m.newSize - m.oldSize;
        const deltaStr = delta >= 0 ? `+${formatBytes(delta)}` : formatBytes(delta);
        md += `| \`${m.path}\` | ${formatBytes(m.oldSize)} | ${formatBytes(m.newSize)} | \`${deltaStr}\` |\n`;
      }
      md += "\n";
    }

    fs.writeFileSync(options.markdownOut, md, "utf-8");
    console.log(`[Diff] Markdown diff written to ${options.markdownOut}`);
  }

  return {
    added,
    removed,
    modified,
    totalSizeDelta,
  };
}
