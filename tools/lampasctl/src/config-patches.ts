import { z } from "zod";
import type { ConfigOperation, ConfigPatch, ConfigPatchesFile, FilePolicy, ManifestFile } from "./types";
import { canonicalizeRelativePath } from "./utils";

export const SUPPORTED_CONFIG_ADAPTERS = [
  "json",
  "jsonc",
  "yaml",
  "toml",
  "properties",
  "ini",
  "text",
] as const;

export type SupportedConfigAdapter = (typeof SUPPORTED_CONFIG_ADAPTERS)[number];

/** Where a client static file came from: pack/client/ or pack/common/. */
export type ClientStaticOrigin = "common" | "client";

export const ConfigOperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set"),
    path: z.array(z.union([z.string(), z.number()])).min(1, "Operation path must not be empty"),
    value: z.any(),
  }),
  z.object({
    op: z.literal("remove"),
    path: z.array(z.union([z.string(), z.number()])).min(1, "Operation path must not be empty"),
  }),
  z.object({
    op: z.literal("replaceLiteral"),
    search: z.string().min(1, "Search string must not be empty"),
    replacement: z.string(),
    expectedMatches: z.number().int().min(1, "expectedMatches must be an integer >= 1"),
  }),
]);

export const ConfigPatchSchema = z.object({
  id: z.string().min(1, "Patch id must not be empty"),
  revision: z.number().int().min(1, "Revision must be an integer >= 1"),
  path: z.string().min(1, "Target path must not be empty"),
  adapter: z.string().min(1, "Adapter must not be empty"),
  mode: z.enum(["enforce", "once"]),
  missingFile: z.enum(["defer", "create"]),
  operations: z.array(ConfigOperationSchema).min(1, "At least one operation is required"),
});

export const ConfigPatchesFileSchema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal(1),
  patches: z.array(ConfigPatchSchema),
});

const OPTIONS_TXT = "options.txt";

/**
 * Protected client files that ship as seed-only PRESERVE defaults. Exact lowercase paths, from
 * pack/client/ only. Any other spelling or policy of these paths is rejected.
 */
export const SEED_CLIENT_FILES = ["options.txt", "servers.dat"] as const;

/** True only for an exact seed path. Other spellings of a seed path are not seeds. */
export function isSeedClientFile(relPath: string): boolean {
  return (SEED_CLIENT_FILES as readonly string[]).includes(relPath);
}

const PROTECTED_CLIENT_FILES = [
  "options.txt",
  "servers.dat",
  "usercache.json",
  "hotbar.nbt",
  "realms_persistence.json",
];

const PROTECTED_CLIENT_DIRS = ["saves/", "screenshots/", "logs/", "crash-reports/"];

const OPTIONS_KEYBIND_KEY_PATTERN = /^key_[A-Za-z0-9_.\-]+$/;
const OPTIONS_KEYBIND_VALUE_PATTERN = /^key\.(keyboard|mouse)\.[A-Za-z0-9_.\-]+$/;

// Limits mirror lampas-launcher src/metadata-policy.ts. The Portal's pack-manifest-schema.ts sets
// none of these, so the launcher is the binding limit.
const CONTROL_OR_DEL_PATTERN = /[\x00-\x1f\x7f]/;
const TEXT_CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const PROTOTYPE_SENSITIVE_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];
const MAX_PATCH_ID_LENGTH = 128;
const MAX_PATCH_PATH_LENGTH = 1024;
const MAX_OPERATION_PATH_SEGMENTS = 64;
const MAX_OPERATION_PATH_SEGMENT_LENGTH = 256;
const MAX_JSON_STRING_LENGTH = 4096;
const MAX_JSON_DEPTH = 20;
const MAX_JSON_OBJECT_KEYS = 256;
const MAX_JSON_ARRAY_LENGTH = 100_000;
const MAX_TEXT_LENGTH = 64 * 1024;
const MAX_EXPECTED_MATCHES = 100_000;

/** Case-folded canonical key for comparing paths. Paths that cannot be canonicalized compare by their raw lowercase form. */
function pathKey(relPath: string): string {
  try {
    return canonicalizeRelativePath(relPath).toLowerCase();
  } catch {
    return relPath.toLowerCase();
  }
}

export function isSafeConfigPatchPath(targetPath: string): boolean {
  if (!targetPath || typeof targetPath !== "string") return false;
  try {
    const canonical = canonicalizeRelativePath(targetPath);
    return canonical !== ".lampas" && !canonical.startsWith(".lampas/");
  } catch {
    return false;
  }
}

/**
 * Launcher-protected client paths (player data and launcher state), matching
 * lampas-launcher src/path-policy.ts. Compares the canonical path case-insensitively. A path that
 * cannot be canonicalized is reported as protected, because such paths are rejected elsewhere.
 */
export function isProtectedClientPath(relPath: string): boolean {
  let lower: string;
  try {
    lower = canonicalizeRelativePath(relPath).toLowerCase();
  } catch {
    return true;
  }

  if (lower === ".lampas" || lower.startsWith(".lampas/") || lower.startsWith(".lampas-moving-")) {
    return true;
  }

  if (PROTECTED_CLIENT_FILES.includes(lower)) {
    return true;
  }

  return PROTECTED_CLIENT_DIRS.some((dir) => lower === dir.slice(0, -1) || lower.startsWith(dir));
}

/**
 * The only patch allowed on a protected path: a once-mode keybind rebind of exactly `options.txt`.
 * Matches lampas-launcher src/config-patches/reconciler.ts isOptionsKeybindPatch, except that the
 * path must be the exact lowercase string `options.txt` (no case folding, no trailing slash).
 */
export function isOptionsKeybindPatch(patch: ConfigPatch): boolean {
  if (patch.path !== OPTIONS_TXT) return false;
  if (patch.adapter !== "properties") return false;
  if (patch.mode !== "once") return false;
  if (patch.missingFile !== "defer") return false;
  if (patch.operations.length === 0) return false;

  return patch.operations.every((op) => {
    if (op.op !== "set" || op.path.length !== 1) return false;
    const [key] = op.path;
    return (
      typeof key === "string" &&
      OPTIONS_KEYBIND_KEY_PATTERN.test(key) &&
      typeof op.value === "string" &&
      OPTIONS_KEYBIND_VALUE_PATTERN.test(op.value)
    );
  });
}

/** True when relPath matches a [client].preserve entry, case-insensitively after canonicalization. */
export function isPreserveListed(relPath: string, preserve: readonly string[]): boolean {
  const key = pathKey(relPath);
  return preserve.some((entry) => pathKey(entry) === key);
}

/**
 * Policy for a file shipped from pack/client/. Seed files (options.txt, servers.dat, exact lowercase
 * names) are always PRESERVE: the launcher places them only when the player has none. Other files
 * are PRESERVE only when listed in [client].preserve, and MANAGED otherwise.
 */
export function clientStaticFilePolicy(relPath: string, preserve: readonly string[] = []): FilePolicy {
  if (isSeedClientFile(relPath)) return "PRESERVE";
  return isPreserveListed(relPath, preserve) ? "PRESERVE" : "MANAGED";
}

/**
 * Policy for a file shipped from pack/common/ in the client manifest. Seed names are never PRESERVE
 * from pack/common/, so a seed name there stays MANAGED and is rejected as a protected path.
 */
export function commonStaticFilePolicy(relPath: string, preserve: readonly string[] = []): FilePolicy {
  if (isSeedClientFile(relPath)) return "MANAGED";
  return isPreserveListed(relPath, preserve) ? "PRESERVE" : "MANAGED";
}

/**
 * Validates the [client].preserve list from pack.toml and returns the canonical entries. Each entry
 * must canonicalize, must not be a launcher-protected path (only the exact seed paths may be
 * listed), and must match a client static file. Seed paths must come from pack/client/.
 */
export function validateClientPreserveList(
  raw: unknown,
  staticFiles: ReadonlyArray<{ path: string; origin: ClientStaticOrigin }>
): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`[client].preserve in pack.toml must be an array of non-empty path strings.`);
  }

  return (raw as string[]).map((entry) => {
    let canonical: string;
    try {
      canonical = canonicalizeRelativePath(entry);
    } catch (err: any) {
      throw new Error(`Unsafe [client].preserve path '${entry}': ${err.message}`);
    }

    if (isProtectedClientPath(canonical) && !isSeedClientFile(entry)) {
      throw new Error(
        `[client].preserve path '${entry}' is a launcher-protected path and cannot be shipped. Only the exact seed paths options.txt and servers.dat may be listed, and they are always seeds from pack/client/.`
      );
    }

    const key = pathKey(canonical);
    const matches = staticFiles.filter((file) => pathKey(file.path) === key);
    if (matches.length === 0) {
      throw new Error(`[client].preserve path '${entry}' does not match a file in pack/client/ or pack/common/.`);
    }
    if (isSeedClientFile(entry) && !matches.some((file) => file.origin === "client")) {
      throw new Error(
        `[client].preserve path '${entry}' must come from pack/client/. ${entry} is only allowed from pack/client/.`
      );
    }

    return canonical;
  });
}

/**
 * Client manifest paths must canonicalize, and no two may collide case-insensitively. The launcher
 * rejects both conditions when it validates a manifest.
 */
export function validateClientFilePaths(files: ReadonlyArray<{ path: string }>): void {
  const seen = new Map<string, string>();
  for (const file of files) {
    let canonical: string;
    try {
      canonical = canonicalizeRelativePath(file.path);
    } catch (err: any) {
      throw new Error(`Client file '${file.path}' has a path the launcher rejects: ${err.message}`);
    }

    const key = canonical.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new Error(
        `Duplicate client manifest path '${canonical}': '${previous}' and '${file.path}' resolve to the same file.`
      );
    }
    seen.set(key, file.path);
  }
}

/**
 * Rejects client manifest files on launcher-protected paths. Launchers refuse such files and fail
 * the whole sync. The only allowed protected files are the exact seed paths in SEED_CLIENT_FILES,
 * and only with policy PRESERVE. Their origin (pack/client/ or pack/common/) is enforced upstream.
 */
export function validateProtectedClientFiles(
  files: ReadonlyArray<{ path: string; policy?: FilePolicy }>
): void {
  for (const file of files) {
    if (!isProtectedClientPath(file.path)) continue;

    const isSeed = isSeedClientFile(file.path) && file.policy === "PRESERVE";
    if (!isSeed) {
      throw new Error(
        `Client file '${file.path}' targets a launcher-protected path and cannot be shipped. Only the seed files options.txt and servers.dat may ship from a protected path, and only from pack/client/ with policy PRESERVE.`
      );
    }
  }
}

/** Patch ids are 1 to 128 characters with no control characters and no leading or trailing whitespace. */
function assertPatchId(id: string): void {
  if (id.length > MAX_PATCH_ID_LENGTH) {
    throw new Error(`Config patch id is longer than ${MAX_PATCH_ID_LENGTH} characters.`);
  }
  if (CONTROL_OR_DEL_PATTERN.test(id)) {
    throw new Error(`Config patch id ${JSON.stringify(id)} contains a control character.`);
  }
  if (id !== id.trim()) {
    throw new Error(`Config patch id ${JSON.stringify(id)} has leading or trailing whitespace.`);
  }
}

/** Mirrors the launcher's JSON value rules for `set` values: depth, string length, and object keys. */
function assertJsonLimits(value: unknown, label: string, depth = 0): void {
  if (depth > MAX_JSON_DEPTH) {
    throw new Error(`${label} is nested deeper than ${MAX_JSON_DEPTH} levels.`);
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > MAX_JSON_STRING_LENGTH) {
      throw new Error(`${label} has a string longer than ${MAX_JSON_STRING_LENGTH} characters.`);
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number.`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY_LENGTH) {
      throw new Error(`${label} is an array longer than ${MAX_JSON_ARRAY_LENGTH} items.`);
    }
    value.forEach((item, index) => assertJsonLimits(item, `${label}[${index}]`, depth + 1));
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length > MAX_JSON_OBJECT_KEYS) {
      throw new Error(`${label} has more than ${MAX_JSON_OBJECT_KEYS} properties.`);
    }
    for (const key of keys) {
      if (PROTOTYPE_SENSITIVE_KEYS.includes(key)) {
        throw new Error(`${label} contains the prohibited property key '${key}'.`);
      }
      assertJsonLimits(record[key], `${label}.${key}`, depth + 1);
    }
    return;
  }
  throw new Error(`${label} is not a JSON value.`);
}

/** Replacement and search text: at most 64 KiB, with the launcher's text control-character rule. */
function assertTextLimits(text: string, label: string): void {
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error(`${label} is longer than ${MAX_TEXT_LENGTH} characters.`);
  }
  if (TEXT_CONTROL_PATTERN.test(text)) {
    throw new Error(`${label} contains a control character that the launcher rejects.`);
  }
}

/** Operation path, value, and text limits from the launcher. Mirrors metadata-policy.ts validateConfigPatch. */
function assertOperationLimits(op: ConfigOperation, patchId: string): void {
  if (op.op === "set" || op.op === "remove") {
    if (op.path.length < 1 || op.path.length > MAX_OPERATION_PATH_SEGMENTS) {
      throw new Error(
        `Config patch '${patchId}' operation path must have 1 to ${MAX_OPERATION_PATH_SEGMENTS} segments.`
      );
    }
    for (const segment of op.path) {
      if (typeof segment === "string") {
        if (
          segment.length === 0 ||
          segment.length > MAX_OPERATION_PATH_SEGMENT_LENGTH ||
          CONTROL_OR_DEL_PATTERN.test(segment)
        ) {
          throw new Error(
            `Config patch '${patchId}' operation path segments must be non-empty strings of at most ${MAX_OPERATION_PATH_SEGMENT_LENGTH} characters without control characters.`
          );
        }
        if (PROTOTYPE_SENSITIVE_KEYS.includes(segment)) {
          throw new Error(
            `Config patch '${patchId}' operation path contains the prohibited key '${segment}'.`
          );
        }
      } else if (!Number.isSafeInteger(segment) || segment < 0) {
        throw new Error(`Config patch '${patchId}' operation path index ${segment} must be a non-negative integer.`);
      }
    }
  }

  if (op.op === "set") {
    if (op.value === undefined) {
      throw new Error(`Config patch '${patchId}' set operation requires a value.`);
    }
    assertJsonLimits(op.value, `Config patch '${patchId}' set value`);
  }

  if (op.op === "replaceLiteral") {
    assertTextLimits(op.search, `Config patch '${patchId}' search text`);
    assertTextLimits(op.replacement, `Config patch '${patchId}' replacement text`);
    if (op.expectedMatches > MAX_EXPECTED_MATCHES) {
      throw new Error(
        `Config patch '${patchId}' expectedMatches must be at most ${MAX_EXPECTED_MATCHES}.`
      );
    }
  }
}

export function validateConfigPatches(
  patchesFileContent: unknown,
  existingFiles: ManifestFile[] = [],
  options: { warn?: boolean } = {}
): ConfigPatch[] {
  const warn = options.warn !== false;
  const parseResult = ConfigPatchesFileSchema.safeParse(patchesFileContent);
  if (!parseResult.success) {
    const errorMessages = parseResult.error.errors
      .map((e) => `[${e.path.join(".")}] ${e.message}`)
      .join(", ");
    throw new Error(`Invalid config patches file schema: ${errorMessages}`);
  }

  const { patches } = parseResult.data;
  const seenIds = new Set<string>();

  // Every whole-file entry, MANAGED or PRESERVE, is a collision target.
  const wholeFiles = new Map<string, ManifestFile>();
  for (const file of existingFiles) {
    wholeFiles.set(pathKey(file.path), file);
  }

  const canonicalPatches: ConfigPatch[] = [];
  for (const rawPatch of patches) {
    const patch = rawPatch as ConfigPatch;

    assertPatchId(patch.id);

    // Unique patch id
    if (seenIds.has(patch.id)) {
      throw new Error(`Duplicate config patch id: '${patch.id}'`);
    }
    seenIds.add(patch.id);

    if (patch.path.length > MAX_PATCH_PATH_LENGTH) {
      throw new Error(`Config patch '${patch.id}' target path is longer than ${MAX_PATCH_PATH_LENGTH} characters.`);
    }

    // Canonical relative path (launcher rules) that is not the .lampas namespace
    if (!isSafeConfigPatchPath(patch.path)) {
      throw new Error(`Unsafe target path for config patch '${patch.id}': '${patch.path}'`);
    }
    const canonicalPath = canonicalizeRelativePath(patch.path);

    // Whole-file ownership. A config patch may not target any whole-file entry, except a PRESERVE
    // options.txt with options.txt keybind patches. This runs before the protected-path check, so a
    // patch on a PRESERVE seed reports the collision.
    const wholeFile = wholeFiles.get(pathKey(canonicalPath));
    if (wholeFile) {
      const policy = wholeFile.policy || "MANAGED";
      const isOptionsSeedException =
        wholeFile.path === OPTIONS_TXT && policy === "PRESERVE" && isOptionsKeybindPatch(patch);
      if (!isOptionsSeedException) {
        if (policy === "MANAGED") {
          throw new Error(
            `Config ownership conflict: '${canonicalPath}' is both a MANAGED artifact and a managed config-patch target.`
          );
        }
        throw new Error(
          `Config ownership conflict: '${canonicalPath}' is both a ${policy} whole-file entry and a config-patch target. The only exception is a PRESERVE options.txt with once-mode keybind rebinds.`
        );
      }
    }

    // Launcher-protected player data and launcher state. options.txt keybind rebinds are the only exception.
    if (isProtectedClientPath(canonicalPath) && !isOptionsKeybindPatch(patch)) {
      throw new Error(
        `Config patch '${patch.id}' targets launcher-protected path '${patch.path}'. Only once-mode keybind 'set' operations (key_* to key.keyboard.* or key.mouse.*) with adapter 'properties' and missingFile 'defer' may target options.txt. Other player data (servers.dat, usercache.json, hotbar.nbt, realms_persistence.json, saves/, screenshots/, logs/, crash-reports/) and launcher state (.lampas, .lampas-moving-*) cannot be patched.`
      );
    }

    // Supported adapter check
    if (!SUPPORTED_CONFIG_ADAPTERS.includes(patch.adapter as SupportedConfigAdapter)) {
      if (patch.adapter === "json5") {
        throw new Error(
          `Adapter 'json5' for patch '${patch.id}' is currently unsupported: safe comment/formatting preservation cannot be guaranteed.`
        );
      }
      throw new Error(
        `Unsupported adapter '${patch.adapter}' for patch '${patch.id}'. Known adapters: ${SUPPORTED_CONFIG_ADAPTERS.join(", ")}`
      );
    }

    for (const op of patch.operations) {
      assertOperationLimits(op, patch.id);
    }

    // Adapter-specific operation validation
    if (patch.adapter === "text") {
      if (patch.missingFile === "create") {
        throw new Error(
          `Adapter 'text' for patch '${patch.id}' cannot have missingFile='create'. Generic text creation is not permitted.`
        );
      }
      for (const op of patch.operations) {
        if (op.op !== "replaceLiteral") {
          throw new Error(
            `Adapter 'text' for patch '${patch.id}' only supports 'replaceLiteral' operations, got '${(op as any).op}'.`
          );
        }
      }
    } else {
      // Structured adapters (json, jsonc, yaml, toml, properties, ini)
      for (const op of patch.operations) {
        if (op.op !== "set" && op.op !== "remove") {
          throw new Error(
            `Adapter '${patch.adapter}' for patch '${patch.id}' only supports 'set' and 'remove' operations, got '${(op as any).op}'.`
          );
        }
      }
    }

    if (warn && isOptionsKeybindPatch(patch) && patch.operations.length > 1) {
      console.warn(
        `[Config Patch Warning] '${patch.id}' sets ${patch.operations.length} keys in options.txt. The launcher defers the whole patch while any one key line is missing from options.txt, so keep one keybind patch per mod.`
      );
    }

    canonicalPatches.push({ ...patch, path: canonicalPath });
  }

  return canonicalPatches;
}
