import * as fs from "node:fs";
import * as path from "node:path";
import type { InstallationState, RequiredResourcePack } from "./types";

/**
 * Validates whether a Minecraft server address string is well-formed.
 * Accepts: "play.lampas.town", "play.lampas.town:25565", "127.0.0.1:25565", "localhost", "[::1]:25565"
 * Rejects: "https://...", "play.lampas.town/path", "", "play.lampas.town:99999", etc.
 */
export function isValidServerAddress(server: string): boolean {
  if (!server || typeof server !== "string") return false;
  const trimmed = server.trim();
  if (!trimmed || trimmed !== server) return false;
  if (
    trimmed.includes("://") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    /\s/.test(trimmed) ||
    trimmed.includes("?") ||
    trimmed.includes("#") ||
    trimmed.includes("@")
  ) {
    return false;
  }

  let host = trimmed;
  let portStr: string | undefined;

  if (trimmed.startsWith("[")) {
    const closeBracket = trimmed.indexOf("]");
    if (closeBracket === -1) return false;
    host = trimmed.substring(1, closeBracket);
    const rest = trimmed.substring(closeBracket + 1);
    if (rest) {
      if (!rest.startsWith(":")) return false;
      portStr = rest.substring(1);
    }
  } else {
    const colonIndex = trimmed.lastIndexOf(":");
    if (colonIndex !== -1 && trimmed.indexOf(":") === colonIndex) {
      // Exactly one colon -> host:port
      host = trimmed.substring(0, colonIndex);
      portStr = trimmed.substring(colonIndex + 1);
    } else if (colonIndex !== -1) {
      // Multiple colons without brackets -> IPv6 address without port
      host = trimmed;
    }
  }

  if (!host) return false;

  if (portStr !== undefined) {
    if (!/^\d+$/.test(portStr)) return false;
    const portNum = parseInt(portStr, 10);
    if (portNum < 1 || portNum > 65535) return false;
  }

  // IPv4 check
  const isIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
  if (isIpv4) {
    const octets = host.split(".").map(Number);
    if (octets.some((o) => o < 0 || o > 255)) return false;
    return true;
  }

  // Hostname check (RFC 1123 / standard domains / localhost)
  const hostnameRegex = /^([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9])(\.([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9]))*$/;
  if (hostnameRegex.test(host)) {
    return true;
  }

  // IPv6 check
  const isIpv6 = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/.test(host);
  if (isIpv6) {
    return true;
  }

  return false;
}

/**
 * Reconciles the resource pack list for options.txt:
 * - Removes old Lampas-managed packs that are no longer in the current required list.
 * - Preserves all existing user-selected resource packs and their relative order.
 * - Ensures all current required packs are included (appending if missing).
 */
export function reconcileResourcePacks(
  existingPacks: string[],
  currentRequired: string[],
  oldManaged: string[]
): string[] {
  const currentSet = new Set(currentRequired);
  const oldSet = new Set(oldManaged);

  // 1. Remove old managed packs that are no longer required
  const reconciled = existingPacks.filter((item) => {
    if (oldSet.has(item) && !currentSet.has(item)) {
      return false;
    }
    return true;
  });

  // 2. Add current required packs if missing
  for (const req of currentRequired) {
    if (!reconciled.includes(req)) {
      reconciled.push(req);
    }
  }

  return reconciled;
}

/**
 * Ensures all required Lampas resource packs are downloaded, present on disk,
 * and enabled in <gameDir>/options.txt. Obsolete managed entries are removed cleanly.
 */
export async function ensureRequiredResourcePacks(
  gameDir: string,
  requiredPacks: RequiredResourcePack[]
): Promise<void> {
  if (!requiredPacks || requiredPacks.length === 0) {
    return;
  }

  // 1. Verify that all required resource pack files exist on disk
  for (const pack of requiredPacks) {
    const candidatePaths = [
      path.join(gameDir, pack.path || ""),
      path.join(gameDir, "resourcepacks", pack.filename),
    ];
    const exists = candidatePaths.some((p) => fs.existsSync(p));
    if (!exists) {
      throw new Error(
        `Unable to prepare required Lampas resource pack (${pack.id}): File missing at ${pack.path || pack.filename}. Run Repair and try again.`
      );
    }
  }

  // 2. Read previous installation state to find previously managed resource packs
  const stateDir = path.join(gameDir, ".lampas");
  const stateFile = path.join(stateDir, "installation.json");
  let prevState: InstallationState = {
    pack: "",
    version: "",
    installedAt: "",
    files: {},
  };

  if (fs.existsSync(stateFile)) {
    try {
      prevState = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    } catch {
      // fresh or invalid state
    }
  }

  const oldManagedFilenames = prevState.managedResourcePacks || [];
  const oldManagedIdentifiers = oldManagedFilenames.map((f) =>
    f.startsWith("file/") ? f : `file/${f}`
  );
  const currentRequiredIdentifiers = requiredPacks.map((p) =>
    p.filename.startsWith("file/") ? p.filename : `file/${p.filename}`
  );
  const currentFilenames = requiredPacks.map((p) => p.filename);

  // 3. Locate and safely update <gameDir>/options.txt
  const optionsPath = path.join(gameDir, "options.txt");

  if (!fs.existsSync(optionsPath)) {
    const defaultPacks = ["vanilla", ...currentRequiredIdentifiers];
    const uniquePacks = Array.from(new Set(defaultPacks));
    const content = `resourcePacks:${JSON.stringify(uniquePacks)}\n`;
    fs.writeFileSync(optionsPath, content, "utf-8");
  } else {
    const content = fs.readFileSync(optionsPath, "utf-8");
    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    const lines = content.split(/\r?\n/);
    const lineIndex = lines.findIndex((l) => l.startsWith("resourcePacks:"));

    if (lineIndex === -1) {
      // Line not present in existing options.txt -> append it
      const defaultPacks = ["vanilla", ...currentRequiredIdentifiers];
      const uniquePacks = Array.from(new Set(defaultPacks));
      const newLine = `resourcePacks:${JSON.stringify(uniquePacks)}`;
      const newContent =
        content.endsWith("\n") || content.endsWith("\r")
          ? `${content}${newLine}${eol}`
          : `${content}${eol}${newLine}${eol}`;
      fs.writeFileSync(optionsPath, newContent, "utf-8");
    } else {
      const rawLine = lines[lineIndex];
      const rawVal = rawLine.substring("resourcePacks:".length).trim();
      let parsedList: string[] | null = null;

      try {
        const parsed = JSON.parse(rawVal);
        if (Array.isArray(parsed)) {
          parsedList = parsed.filter((x) => typeof x === "string");
        }
      } catch {
        // parsing failed
      }

      if (!parsedList) {
        // Malformed resourcePacks line: backup options.txt and safely reconstruct only this setting
        const backupPath = path.join(gameDir, "options.txt.lampas-backup");
        fs.writeFileSync(backupPath, content, "utf-8");

        const reconstructed = ["vanilla", ...currentRequiredIdentifiers];
        lines[lineIndex] = `resourcePacks:${JSON.stringify(Array.from(new Set(reconstructed)))}`;
        fs.writeFileSync(optionsPath, lines.join(eol), "utf-8");
      } else {
        const reconciled = reconcileResourcePacks(
          parsedList,
          currentRequiredIdentifiers,
          oldManagedIdentifiers
        );
        const newRawVal = JSON.stringify(reconciled);

        if (newRawVal !== rawVal) {
          lines[lineIndex] = `resourcePacks:${newRawVal}`;
          fs.writeFileSync(optionsPath, lines.join(eol), "utf-8");
        }
      }
    }
  }

  // 4. Update installation state with currently managed resource packs
  prevState.managedResourcePacks = currentFilenames;
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
  fs.writeFileSync(stateFile, JSON.stringify(prevState, null, 2), "utf-8");
}
