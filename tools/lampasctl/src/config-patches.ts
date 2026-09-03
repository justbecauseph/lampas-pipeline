import * as path from "node:path";
import { z } from "zod";
import type { ConfigOperation, ConfigPatch, ConfigPatchesFile, ManifestFile } from "./types";
import { normalizeRelPath } from "./utils";

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
  schemaVersion: z.literal(1),
  patches: z.array(ConfigPatchSchema),
});

export function isSafeConfigPatchPath(targetPath: string): boolean {
  if (!targetPath || typeof targetPath !== "string") return false;
  const normalized = normalizeRelPath(path.normalize(targetPath));

  if (
    normalized.startsWith("../") ||
    normalized === ".." ||
    path.isAbsolute(targetPath) ||
    /^[a-zA-Z]:/.test(targetPath) ||
    normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    normalized.startsWith("\\\\")
  ) {
    return false;
  }

  if (normalized === ".lampas" || normalized.startsWith(".lampas/")) {
    return false;
  }

  return true;
}

export function validateConfigPatches(
  patchesFileContent: unknown,
  existingFiles: ManifestFile[] = []
): ConfigPatch[] {
  const parseResult = ConfigPatchesFileSchema.safeParse(patchesFileContent);
  if (!parseResult.success) {
    const errorMessages = parseResult.error.errors
      .map((e) => `[${e.path.join(".")}] ${e.message}`)
      .join(", ");
    throw new Error(`Invalid config patches file schema: ${errorMessages}`);
  }

  const { patches } = parseResult.data;
  const seenIds = new Set<string>();
  const managedFilePaths = new Set(
    existingFiles
      .filter((f) => (f.policy || "MANAGED") === "MANAGED")
      .map((f) => normalizeRelPath(f.path))
  );

  for (const patch of patches) {
    // Unique patch id
    if (seenIds.has(patch.id)) {
      throw new Error(`Duplicate config patch id: '${patch.id}'`);
    }
    seenIds.add(patch.id);

    // Safe relative path
    if (!isSafeConfigPatchPath(patch.path)) {
      throw new Error(`Unsafe target path for config patch '${patch.id}': '${patch.path}'`);
    }

    const normPatchPath = normalizeRelPath(patch.path);

    // Ownership conflict: Cannot target a MANAGED file
    if (managedFilePaths.has(normPatchPath)) {
      throw new Error(
        `Config ownership conflict: '${patch.path}' is both a MANAGED artifact and a managed config-patch target.`
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
  }

  return patches as ConfigPatch[];
}
