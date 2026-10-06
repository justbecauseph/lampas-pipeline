import type { BlacklistRule, BlacklistTarget } from "./types";

const VALID_PROVIDERS = new Set(["modrinth", "curseforge"]);
const RULE_FIELDS = new Set(["scope", "id", "provider", "reason"]);

function invalid(source: string, index: number | undefined, detail: string): never {
  const entry = index === undefined ? "" : `[${index}]`;
  throw new Error(`Invalid blacklist configuration in ${source}${entry}: ${detail}`);
}

function hasNonWhitespaceId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value && !/\s/.test(value);
}

/** Parse and validate the root pack blacklist without consulting any provider. */
export function parseBlacklistRules(raw: unknown, source = "pack.toml blacklist"): BlacklistRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) invalid(source, undefined, "must be an array of rule tables");

  return raw.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      invalid(source, index, "must be a rule table");
    }

    const entry = value as Record<string, unknown>;
    const extraFields = Object.keys(entry).filter((key) => !RULE_FIELDS.has(key));
    if (extraFields.length > 0) {
      invalid(source, index, `unknown field${extraFields.length > 1 ? "s" : ""}: ${extraFields.join(", ")}`);
    }

    if (typeof entry.scope !== "string" || !["mod_id", "project_id", "version_id"].includes(entry.scope)) {
      invalid(source, index, "scope must be 'mod_id', 'project_id', or 'version_id'");
    }

    if (entry.scope === "mod_id") {
      if (Object.hasOwn(entry, "provider")) {
        invalid(source, index, "mod_id rules cannot specify provider");
      }
      if (!hasNonWhitespaceId(entry.id)) {
        invalid(source, index, "mod_id id must be a non-empty string without whitespace");
      }
    } else {
      if (typeof entry.provider !== "string" || !VALID_PROVIDERS.has(entry.provider)) {
        invalid(source, index, `${entry.scope} rules require provider 'modrinth' or 'curseforge'`);
      }

      if (entry.provider === "curseforge") {
        if (typeof entry.id !== "number" || !Number.isSafeInteger(entry.id) || entry.id <= 0) {
          invalid(source, index, `${entry.scope} CurseForge id must be a positive safe integer`);
        }
      } else if (!hasNonWhitespaceId(entry.id)) {
        invalid(source, index, `${entry.scope} Modrinth id must be a non-empty string without whitespace`);
      }
    }

    if (Object.hasOwn(entry, "reason") && (typeof entry.reason !== "string" || entry.reason.trim().length === 0)) {
      invalid(source, index, "reason must be a non-empty string when provided");
    }

    return { ...entry } as BlacklistRule;
  });
}

/** Validate that blacklist is declared only at the pack.toml root, then parse its rules. */
export function parsePackBlacklistRules(packConfig: unknown, source = "pack.toml"): BlacklistRule[] {
  if (!packConfig || typeof packConfig !== "object" || Array.isArray(packConfig)) {
    throw new Error(`Invalid blacklist configuration in ${source}: pack configuration must be a root table.`);
  }

  const nestedBlacklistPath = (value: unknown, currentPath: string[], root: boolean): string | undefined => {
    if (!value || typeof value !== "object") return undefined;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const found = nestedBlacklistPath(value[index], [...currentPath, `[${index}]`], false);
        if (found) return found;
      }
      return undefined;
    }

    for (const [key, child] of Object.entries(value)) {
      if (root && key === "blacklist") continue;
      const childPath = [...currentPath, key];
      if (key === "blacklist") return childPath.join(".");
      const found = nestedBlacklistPath(child, childPath, false);
      if (found) return found;
    }
    return undefined;
  };

  const root = packConfig as Record<string, unknown>;
  const misplaced = nestedBlacklistPath(root, [], true);
  if (misplaced) {
    throw new Error(
      `Invalid blacklist configuration in ${source}: blacklist must be declared at the root, not under '${misplaced}'.`
    );
  }
  return parseBlacklistRules(root.blacklist, source);
}

/** Match only the explicitly selected identity scope and, where present, provider. */
export function matchingBlacklistRules(
  rules: readonly BlacklistRule[],
  target: BlacklistTarget
): BlacklistRule[] {
  return rules.filter((rule) => {
    if (rule.scope === "mod_id") return target.modId === rule.id;
    if (rule.provider !== target.provider) return false;
    if (rule.scope === "project_id") return target.projectId === rule.id;
    return target.versionId === rule.id;
  });
}

export function describeBlacklistRule(rule: BlacklistRule): string {
  const provider = rule.scope === "mod_id" ? "" : ` (${rule.provider})`;
  const reason = rule.reason ? ` — ${rule.reason}` : "";
  return `${rule.scope} '${rule.id}'${provider}${reason}`;
}
