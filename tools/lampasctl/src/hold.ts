import { nestedRootKeyPath } from "./blacklist";
import type { HoldRule } from "./types";

const HOLD_FIELDS = new Set(["mod_id", "reason"]);
// A descriptor basename: no path separators, no leading dot (so no "." or ".."), and nothing a file system may fold.
const MOD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function invalid(source: string, index: number | undefined, detail: string): never {
  const entry = index === undefined ? "" : `[${index}]`;
  throw new Error(`Invalid hold configuration in ${source}${entry}: ${detail}`);
}

/**
 * Parse the root `[[hold]]` rules. A hold keeps a descriptor at its current pin: `check-updates` does not query or
 * update it, even with `--force`. Unlike a blacklist rule it does not make the descriptor itself invalid.
 */
export function parseHoldRules(raw: unknown, source = "pack.toml hold"): HoldRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) invalid(source, undefined, "must be an array of rule tables");

  const seen = new Set<string>();
  return raw.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      invalid(source, index, "must be a rule table");
    }

    const entry = value as Record<string, unknown>;
    const extraFields = Object.keys(entry).filter((key) => !HOLD_FIELDS.has(key));
    if (extraFields.length > 0) {
      invalid(
        source,
        index,
        `unknown field${extraFields.length > 1 ? "s" : ""}: ${extraFields.join(", ")}`,
      );
    }

    const modId = entry.mod_id;
    if (typeof modId !== "string" || !MOD_ID_PATTERN.test(modId)) {
      invalid(
        source,
        index,
        "mod_id must be a descriptor basename of letters, digits, '.', '_' and '-' that starts with a letter or digit",
      );
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      invalid(source, index, "reason must be a non-empty string");
    }
    if (seen.has(modId)) invalid(source, index, `duplicate hold for mod_id '${modId}'`);
    seen.add(modId);

    return { mod_id: modId, reason: entry.reason };
  });
}

/** Validate that hold is declared only at the pack.toml root, then parse its rules. */
export function parsePackHoldRules(packConfig: unknown, source = "pack.toml"): HoldRule[] {
  if (!packConfig || typeof packConfig !== "object" || Array.isArray(packConfig)) {
    throw new Error(
      `Invalid hold configuration in ${source}: pack configuration must be a root table.`,
    );
  }
  const misplaced = nestedRootKeyPath(packConfig, "hold");
  if (misplaced) {
    throw new Error(
      `Invalid hold configuration in ${source}: hold must be declared at the root, not under '${misplaced}'.`,
    );
  }
  return parseHoldRules((packConfig as Record<string, unknown>).hold, source);
}

/** Directories whose `*.toml` descriptors a hold can name, matching the update checker and the resolver. */
export const HOLD_DESCRIPTOR_DIRS = ["mods", "shaderpacks", "shaders", "resourcepacks"] as const;

/**
 * Holds whose mod_id is not exactly the basename of a descriptor file. Matching is by exact, case-sensitive file name
 * from the directory listing, as check-updates matches, so a case-insensitive file system cannot satisfy it.
 */
export function unmatchedHolds(
  rules: readonly HoldRule[],
  descriptorIds: ReadonlySet<string>,
): HoldRule[] {
  return rules.filter((rule) => !descriptorIds.has(rule.mod_id));
}
