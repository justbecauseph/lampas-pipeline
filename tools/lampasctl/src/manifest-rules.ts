import type {
  ConfigPatch,
  ManagedServerProperties,
  ManifestFile,
  PackManifest,
  ServerDifficulty,
  ServerGamemode,
  ServerResourcePackConfig,
} from "./types";
import { isProtectedClientPath, isSeedClientFile } from "./config-patches";
import { canonicalizeRelativePath } from "./utils";

/*
 * Checks on the manifests lampasctl is about to write. They mirror lampas2-portal
 * lib/pack-manifest-schema.ts (the Portal accepts a manifest only if these pass) and the launcher's
 * lampas-launcher src/metadata-policy.ts limits. Running them here means `manifest` and `validate`
 * fail on exactly what the Portal and the launcher would reject.
 */

const CONTROL_OR_DEL_PATTERN = /[\x00-\x1f\x7f]/;
// Mod catalog descriptions keep tab, newline, and carriage return, as the launcher's textValue does.
const TEXT_CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const MAX_FILE_PATH_LENGTH = 1024;
const MAX_URL_LENGTH = 2048;
const MAX_ARRAY_LENGTH = 100_000;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_PACK_NAME_LENGTH = 256;
const MAX_MINECRAFT_LENGTH = 128;
const MAX_LOADER_VERSION_LENGTH = 128;
const MAX_ID_LENGTH = 128;
const MAX_MOD_NAME_LENGTH = 512;
const MAX_MOD_FILENAME_LENGTH = 512;
const MAX_MOD_DESCRIPTION_LENGTH = 4096;
const MAX_MOD_CATEGORY_LENGTH = 128;
// Highest protocol the launcher runs (lampas-launcher src/sync.ts MAX_SUPPORTED_PROTOCOL). The Portal's
// pack-manifest-schema.ts enforces the same ceiling. Raise all three together.
const MAX_SUPPORTED_PROTOCOL = 3;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SHA1_PATTERN = /^[0-9a-f]{40}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const SHA512_PATTERN = /^[0-9a-f]{128}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDERS: readonly string[] = ["modrinth", "curseforge", "lampas", "direct"];
const POLICIES: readonly string[] = ["MANAGED", "PRESERVE", "OPTIONAL", "GENERATED"];
const SIDES: readonly string[] = ["client", "server", "both"];

// The Portal's SERVER_PROTECTED_PATHS. A MANAGED server file under one of these is rejected.
const SERVER_PROTECTED_PATHS: readonly string[] = [
  "world/",
  "saves/",
  "logs/",
  "crash-reports/",
  "server.properties",
  "usercache.json",
  "whitelist.json",
  "ops.json",
  "banned-players.json",
  "banned-ips.json",
  "eula.txt",
  "start.py",
  "start.sh",
  ".lampas/",
  ".backups/",
];

/** Longest server MOTD, in UTF-16 code units. The Portal enforces the same limit. */
export const MAX_MOTD_LENGTH = 512;

export const SERVER_DIFFICULTIES: readonly ServerDifficulty[] = [
  "peaceful",
  "easy",
  "normal",
  "hard",
];
export const SERVER_GAMEMODES: readonly ServerGamemode[] = [
  "survival",
  "creative",
  "adventure",
  "spectator",
];
export const MAX_SERVER_PROPERTY_INT32 = 2_147_483_647;
/** floor(Long.MAX_VALUE / 1_000_000) so ServerWatchdog's maxTickTime * 1_000_000L never overflows Java long. */
export const MAX_SERVER_TICK_TIME = 9_223_372_036_854;
/** floor(Integer.MAX_VALUE / 20) so 20 * seconds (MinecraftServer pauseWhenEmptySeconds, TickThrottler) never overflows Java int. */
export const MAX_SERVER_TICK_SECONDS = 107_374_182;
export const MAX_BUG_REPORT_LINK_LENGTH = MAX_URL_LENGTH;

export const MANAGED_SERVER_PROPERTY_KEYS = [
  "allow-flight",
  "bug-report-link",
  "chat-spam-threshold-seconds",
  "command-spam-threshold-seconds",
  "difficulty",
  "enable-code-of-conduct",
  "force-gamemode",
  "gamemode",
  "hardcore",
  "hide-online-players",
  "max-tick-time",
  "pause-when-empty-seconds",
  "player-idle-timeout",
  "spawn-protection",
] as const;

export type ManagedServerPropertyKey = (typeof MANAGED_SERVER_PROPERTY_KEYS)[number];

/**
 * The server MOTD rules, shared with the Portal: a non-empty string of at most MAX_MOTD_LENGTH
 * characters and at most two lines (the multiplayer list shows two), with no surrounding
 * whitespace and no control characters other than the one line break. Section-sign formatting
 * codes and other non-ASCII text are allowed.
 */
export function assertServerMotd(motd: unknown, label: string): asserts motd is string {
  if (typeof motd !== "string" || motd.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (motd.length > MAX_MOTD_LENGTH) {
    throw new Error(`${label} is ${motd.length} characters, above the ${MAX_MOTD_LENGTH} limit.`);
  }
  if (motd !== motd.trim()) {
    throw new Error(`${label} must not start or end with whitespace.`);
  }
  if (/[\u0000-\u0009\u000B-\u001F\u007F]/.test(motd)) {
    throw new Error(`${label} must not contain control characters other than a line break.`);
  }
  if (motd.split("\n").length > 2) {
    throw new Error(`${label} must have at most two lines.`);
  }
}

type ServerPropertyValidator = (value: unknown, label: string) => void;

function assertBooleanProperty(value: unknown, label: string): void {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
}

function assertIntRangeProperty(value: unknown, min: number, max: number, label: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
}

function assertEnumProperty(value: unknown, allowed: readonly string[], label: string): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}.`);
  }
}

const URI_CONTROL_PATTERN = /[\x00-\x1f\x7f-\x9f]/;
const URI_DISALLOWED_ASCII_PATTERN = /[\\^`{|}"<>]/;
const URI_BAD_PERCENT_PATTERN = /%(?![0-9a-fA-F]{2})/;
const URI_IPV6_AUTHORITY_PATTERN = /^(?:[^@[\]]*@)?\[[0-9a-fA-F:.]+\](?::\d+)?$/;

function assertBugReportLinkProperty(value: unknown, label: string): void {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  if (value === "") return;
  if (value.length > MAX_BUG_REPORT_LINK_LENGTH) {
    throw new Error(
      `${label} is ${value.length} characters, above the ${MAX_BUG_REPORT_LINK_LENGTH} limit.`,
    );
  }
  if (/\s/.test(value) || URI_CONTROL_PATTERN.test(value)) {
    throw new Error(`${label} must not contain whitespace, control characters, or DEL.`);
  }
  if (!/^https?:\/\/[^/?#]/i.test(value)) {
    throw new Error(`${label} must be an HTTP(S) URL with a host: ${JSON.stringify(value)}`);
  }
  if (URI_DISALLOWED_ASCII_PATTERN.test(value) || URI_BAD_PERCENT_PATTERN.test(value)) {
    throw new Error(
      `${label} contains characters or percent-escapes rejected by java.net.URI: ${JSON.stringify(value)}`,
    );
  }
  const rest = value.slice(value.indexOf("//") + 2);
  const endAuthority = rest.search(/[/?#]/);
  const authority = endAuthority === -1 ? rest : rest.slice(0, endAuthority);
  const afterAuthority = endAuthority === -1 ? "" : rest.slice(endAuthority);
  if (
    afterAuthority.includes("[") ||
    afterAuthority.includes("]") ||
    ((authority.includes("[") || authority.includes("]")) &&
      !URI_IPV6_AUTHORITY_PATTERN.test(authority))
  ) {
    throw new Error(
      `${label} has brackets outside a valid IPv6 host literal: ${JSON.stringify(value)}`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an HTTP(S) URL or empty string: ${JSON.stringify(value)}`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname.length === 0
  ) {
    throw new Error(`${label} must be an HTTP(S) URL with a host: ${JSON.stringify(value)}`);
  }
}

const SERVER_PROPERTY_VALIDATORS: ReadonlyMap<string, ServerPropertyValidator> = new Map<
  ManagedServerPropertyKey,
  ServerPropertyValidator
>([
  ["allow-flight", assertBooleanProperty],
  ["bug-report-link", assertBugReportLinkProperty],
  [
    "chat-spam-threshold-seconds",
    (v, l) => assertIntRangeProperty(v, 0, MAX_SERVER_TICK_SECONDS, l),
  ],
  [
    "command-spam-threshold-seconds",
    (v, l) => assertIntRangeProperty(v, 0, MAX_SERVER_TICK_SECONDS, l),
  ],
  ["difficulty", (v, l) => assertEnumProperty(v, SERVER_DIFFICULTIES, l)],
  ["enable-code-of-conduct", assertBooleanProperty],
  ["force-gamemode", assertBooleanProperty],
  ["gamemode", (v, l) => assertEnumProperty(v, SERVER_GAMEMODES, l)],
  ["hardcore", assertBooleanProperty],
  ["hide-online-players", assertBooleanProperty],
  ["max-tick-time", (v, l) => assertIntRangeProperty(v, -1, MAX_SERVER_TICK_TIME, l)],
  ["pause-when-empty-seconds", (v, l) => assertIntRangeProperty(v, -1, MAX_SERVER_TICK_SECONDS, l)],
  ["player-idle-timeout", (v, l) => assertIntRangeProperty(v, 0, MAX_SERVER_PROPERTY_INT32, l)],
  ["spawn-protection", (v, l) => assertIntRangeProperty(v, 0, MAX_SERVER_PROPERTY_INT32, l)],
]);

/** Validates an allowlisted server.properties override object. Shared with the Portal. */
export function assertServerProperties(
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean } = {},
): asserts value is ManagedServerProperties {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0 && !options.allowEmpty) {
    throw new Error(`${label} must set at least one property.`);
  }
  for (const key of keys) {
    const validator = SERVER_PROPERTY_VALIDATORS.get(key);
    if (!validator) {
      throw new Error(
        `${label} contains unsupported property '${key}'. Allowed keys: ${MANAGED_SERVER_PROPERTY_KEYS.join(", ")}.`,
      );
    }
    validator(record[key], `${label} '${key}'`);
  }
}

/** The Portal's isSafeManifestPath: no padding, no NUL, no backslash, no rooted or empty or dot segments. */
export function isPortalSafePath(value: string): boolean {
  if (!value || value.includes("\0") || value.includes("\\")) return false;
  if (value !== value.trim()) return false;
  if (value.startsWith("/") || value.startsWith("//") || /^[a-zA-Z]:($|\/)/.test(value)) {
    return false;
  }
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isServerProtectedPath(value: string): boolean {
  return SERVER_PROTECTED_PATHS.some((prefix) => value === prefix || value.startsWith(prefix));
}

/** The Portal's download URL rule (HTTP(S) or root-relative) with the launcher's length limit. */
function assertDownloadUrl(url: unknown, label: string): void {
  if (
    typeof url !== "string" ||
    url.length === 0 ||
    url.length > MAX_URL_LENGTH ||
    url !== url.trim() ||
    CONTROL_OR_DEL_PATTERN.test(url)
  ) {
    throw new Error(
      `${label} must be a non-empty URL of at most ${MAX_URL_LENGTH} characters without padding, control characters, or DEL.`,
    );
  }
  if (url.startsWith("/")) {
    if (!isPortalSafePath(url.slice(1))) {
      throw new Error(`${label} must be a safe root-relative path: ${JSON.stringify(url)}`);
    }
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `${label} must be an HTTP(S) URL or a root-relative path: ${JSON.stringify(url)}`,
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname.length === 0
  ) {
    throw new Error(`${label} must be an HTTP(S) URL: ${JSON.stringify(url)}`);
  }
}

function assertManifestFile(target: "client" | "server", file: ManifestFile, index: number): void {
  const label = `${target} manifest files[${index}]`;
  if (
    typeof file.path !== "string" ||
    !isPortalSafePath(file.path) ||
    CONTROL_OR_DEL_PATTERN.test(file.path)
  ) {
    throw new Error(`${label} path must be a safe relative path: ${JSON.stringify(file.path)}`);
  }
  if (file.path.length > MAX_FILE_PATH_LENGTH) {
    throw new Error(`${label} path is longer than ${MAX_FILE_PATH_LENGTH} characters.`);
  }

  if (target === "client") {
    try {
      canonicalizeRelativePath(file.path);
    } catch (err: any) {
      throw new Error(`${label} path is not launcher-canonical: ${err.message}`);
    }
  }

  if (!Number.isSafeInteger(file.size) || file.size < 0) {
    throw new Error(`${label} size must be a non-negative integer.`);
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`${label} size exceeds ${MAX_FILE_SIZE} bytes.`);
  }

  if (!SHA256_PATTERN.test(file.hashes?.sha256 ?? "")) {
    throw new Error(`${label} sha256 must be a 64-character hex digest.`);
  }
  if (file.hashes.sha512 !== undefined && !SHA512_PATTERN.test(file.hashes.sha512)) {
    throw new Error(`${label} sha512 must be a 128-character hex digest.`);
  }

  assertDownloadUrl(file.download?.url, `${label} download url`);
  if (!PROVIDERS.includes(file.download?.provider)) {
    throw new Error(
      `${label} download provider is unsupported: ${JSON.stringify(file.download?.provider)}`,
    );
  }
  if (!POLICIES.includes(file.policy)) {
    throw new Error(`${label} policy is unsupported: ${JSON.stringify(file.policy)}`);
  }

  // Protected-path rules: client seeds are exact PRESERVE files; server MANAGED files may not sit on protected paths.
  if (target === "client" && isProtectedClientPath(file.path)) {
    if (!(file.policy === "PRESERVE" && isSeedClientFile(file.path))) {
      throw new Error(`${label} '${file.path}' targets a launcher-protected path.`);
    }
  }
  if (target === "server" && file.policy === "MANAGED" && isServerProtectedPath(file.path)) {
    throw new Error(`${label} '${file.path}' is MANAGED on a protected server path.`);
  }
}

/** A launcher string field: 1 to max characters, no padding, no control characters or DEL. */
function assertBoundedString(value: unknown, max: number, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value !== value.trim() ||
    CONTROL_OR_DEL_PATTERN.test(value)
  ) {
    throw new Error(
      `${label} must be a string of 1 to ${max} characters without padding, control characters, or DEL.`,
    );
  }
}

function assertModEntry(mod: any, index: number): void {
  const label = `client manifest mods[${index}]`;
  assertBoundedString(mod?.id, MAX_ID_LENGTH, `${label} id`);
  assertBoundedString(mod?.name, MAX_MOD_NAME_LENGTH, `${label} name`);
  if (!SIDES.includes(mod?.side)) {
    throw new Error(`${label} side must be client, server, or both.`);
  }
  assertBoundedString(mod?.filename, MAX_MOD_FILENAME_LENGTH, `${label} filename`);
  if (mod.filename.includes("/") || mod.filename.includes("\\")) {
    throw new Error(`${label} filename must be a basename.`);
  }
  if (!Number.isSafeInteger(mod?.size) || mod.size < 0) {
    throw new Error(`${label} size must be a non-negative integer.`);
  }
  if (mod.description !== undefined) {
    if (
      typeof mod.description !== "string" ||
      mod.description.length > MAX_MOD_DESCRIPTION_LENGTH ||
      TEXT_CONTROL_PATTERN.test(mod.description)
    ) {
      throw new Error(
        `${label} description must be text of at most ${MAX_MOD_DESCRIPTION_LENGTH} characters without control characters.`,
      );
    }
  }
  if (mod.iconUrl !== undefined) assertDownloadUrl(mod.iconUrl, `${label} iconUrl`);
  if (mod.sourceUrl !== undefined) assertDownloadUrl(mod.sourceUrl, `${label} sourceUrl`);
  if (mod.categories !== undefined) {
    if (!Array.isArray(mod.categories) || mod.categories.length > MAX_ARRAY_LENGTH) {
      throw new Error(`${label} categories must be an array of at most ${MAX_ARRAY_LENGTH} items.`);
    }
    mod.categories.forEach((category: unknown, categoryIndex: number) =>
      assertBoundedString(
        category,
        MAX_MOD_CATEGORY_LENGTH,
        `${label} categories[${categoryIndex}]`,
      ),
    );
  }
}

function assertEnvelope(manifest: PackManifest): void {
  const target = manifest.target;
  if (manifest.schemaVersion !== 2) {
    throw new Error(`${target} manifest schemaVersion must be 2.`);
  }
  assertBoundedString(manifest.pack, MAX_PACK_NAME_LENGTH, `${target} manifest pack`);
  assertBoundedString(manifest.minecraft, MAX_MINECRAFT_LENGTH, `${target} manifest minecraft`);
  assertBoundedString(
    manifest.loader?.version,
    MAX_LOADER_VERSION_LENGTH,
    `${target} manifest loader.version`,
  );
  if (typeof manifest.version !== "string" || !VERSION_PATTERN.test(manifest.version)) {
    throw new Error(
      `${target} manifest version must be a launcher-compatible version (letters, digits, '.', '_', '+', '-').`,
    );
  }
  if (manifest.loader?.type !== "fabric") {
    throw new Error(`${target} manifest loader.type must be 'fabric'.`);
  }
  if (
    !Number.isSafeInteger(manifest.protocol) ||
    manifest.protocol < 0 ||
    manifest.protocol > MAX_SUPPORTED_PROTOCOL
  ) {
    throw new Error(
      `${target} manifest protocol must be an integer from 0 to ${MAX_SUPPORTED_PROTOCOL}.`,
    );
  }
  if (manifest.files.length > MAX_ARRAY_LENGTH) {
    throw new Error(`${target} manifest has more than ${MAX_ARRAY_LENGTH} files.`);
  }
  if (manifest.mods) {
    if (manifest.mods.length > MAX_ARRAY_LENGTH) {
      throw new Error(`${target} manifest has more than ${MAX_ARRAY_LENGTH} mods.`);
    }
    manifest.mods.forEach((mod, index) => assertModEntry(mod, index));
  }
  if (target === "client" && manifest.resourcePack !== undefined) {
    throw new Error("resourcePack is only valid on a server manifest.");
  }
  if (target === "client" && manifest.motd !== undefined) {
    throw new Error("motd is only valid on a server manifest.");
  }
  if (target === "client" && manifest.serverProperties !== undefined) {
    throw new Error("serverProperties is only valid on a server manifest.");
  }
  if (target === "server" && manifest.configPatches !== undefined) {
    throw new Error("configPatches are only valid on a client manifest.");
  }
}

/** The Portal's resourcePack rules, with the UUID and provider checks lampasctl needs for the configured id. */
function assertServerResourcePack(srp: ServerResourcePackConfig): void {
  const label = "server manifest resourcePack";
  if (
    typeof srp.artifact !== "string" ||
    srp.artifact.length === 0 ||
    srp.artifact !== srp.artifact.trim()
  ) {
    throw new Error(`${label} artifact must be a non-empty string without padding.`);
  }
  if (typeof srp.required !== "boolean") {
    throw new Error(`${label} required must be a boolean.`);
  }
  const filename = srp.filename;
  if (
    typeof filename !== "string" ||
    filename.length === 0 ||
    filename !== filename.trim() ||
    !isPortalSafePath(filename) ||
    filename.includes("/")
  ) {
    throw new Error(`${label} filename must be a safe filename without path separators.`);
  }
  if (
    !isPortalSafePath(srp.path) ||
    !srp.path.startsWith("resourcepacks/") ||
    srp.path.split("/").pop() !== filename
  ) {
    throw new Error(
      `${label} path must be a safe path under resourcepacks/ that ends with the filename.`,
    );
  }
  if (!Number.isSafeInteger(srp.size) || srp.size < 0) {
    throw new Error(`${label} size must be a non-negative integer.`);
  }
  assertDownloadUrl(srp.url, `${label} url`);
  if (!SHA1_PATTERN.test(srp.sha1 ?? "")) {
    throw new Error(`${label} sha1 must be a 40-character hex digest.`);
  }
  if (!SHA256_PATTERN.test(srp.sha256)) {
    throw new Error(`${label} sha256 must be a 64-character hex digest.`);
  }
  if (srp.prompt !== undefined) {
    try {
      JSON.parse(srp.prompt);
    } catch {
      throw new Error(`${label} prompt must contain valid JSON.`);
    }
  }
  if (srp.id === undefined && srp.uuid === undefined) {
    throw new Error(`${label} needs a UUID (id or uuid).`);
  }
  if (srp.id !== undefined && !UUID_PATTERN.test(srp.id)) {
    throw new Error(`${label} id must be a valid UUID.`);
  }
  if (srp.uuid !== undefined && !UUID_PATTERN.test(srp.uuid)) {
    throw new Error(`${label} uuid must be a valid UUID.`);
  }
  if (
    srp.id !== undefined &&
    srp.uuid !== undefined &&
    srp.id.toLowerCase() !== srp.uuid.toLowerCase()
  ) {
    throw new Error(`${label} id and uuid must match when both are supplied.`);
  }
  if (!PROVIDERS.includes(srp.provider ?? "")) {
    throw new Error(`${label} provider is unsupported: ${JSON.stringify(srp.provider)}`);
  }
  if (srp.provider === "lampas") {
    let parsed: URL;
    try {
      parsed = new URL(srp.url, "https://lampas.invalid");
    } catch {
      throw new Error(`${label} url is malformed.`);
    }
    const expected = `/api/v1/blobs/${srp.sha256}`;
    if (parsed.pathname !== expected && parsed.pathname !== `${expected}/`) {
      throw new Error(`${label} Lampas url path must be /api/v1/blobs/<sha256>.`);
    }
  }
}

/**
 * A patch modId is a launcher id (1 to 128 characters, no padding, control characters, or DEL) and
 * must be the id of an entry in manifest.mods. A patch that sets modId is rejected when the manifest
 * has no mods list.
 */
function assertConfigPatchModId(manifest: PackManifest, patch: ConfigPatch, index: number): void {
  if (patch.modId === undefined) return;
  const label = `client manifest configPatches[${index}] modId`;
  assertBoundedString(patch.modId, MAX_ID_LENGTH, label);
  if (!manifest.mods) {
    throw new Error(
      `${label} ${JSON.stringify(patch.modId)} needs a mods list, and the manifest has none.`,
    );
  }
  if (!manifest.mods.some((mod) => mod.id === patch.modId)) {
    throw new Error(`${label} ${JSON.stringify(patch.modId)} is not the id of an entry in mods.`);
  }
}

/** The Portal's enforce rule: no two enforce operations may target the same path, within or across patches. */
function assertEnforceOperationsUnique(patches: readonly ConfigPatch[]): void {
  const owners = new Map<string, string>();
  for (const patch of patches) {
    if (patch.mode !== "enforce" || patch.adapter === "text") continue;
    for (const op of patch.operations) {
      if (op.op === "replaceLiteral") continue;
      const key = `${patch.path}::${JSON.stringify(op.path)}`;
      const existing = owners.get(key);
      if (existing !== undefined) {
        const detail =
          existing === patch.id
            ? "duplicate within the patch"
            : `already set by patch '${existing}'`;
        throw new Error(
          `Config patch '${patch.id}' has a conflicting enforce operation for path '${op.path.join(".")}' on '${patch.path}' (${detail}).`,
        );
      }
      owners.set(key, patch.id);
    }
  }
}

/**
 * Throws if the manifest would be rejected by the Portal or the launcher. Duplicate file paths are
 * checked case-insensitively, which is stricter than the Portal's exact match.
 */
export function validateManifestRules(manifest: PackManifest): void {
  assertEnvelope(manifest);

  const target = manifest.target;
  const owners = new Map<string, string>();
  let totalBytes = 0;
  manifest.files.forEach((file, index) => {
    assertManifestFile(target, file, index);
    const key = file.path.toLowerCase();
    const previous = owners.get(key);
    if (previous !== undefined) {
      throw new Error(
        `${target} manifest has duplicate file path '${file.path}' (conflicts with '${previous}').`,
      );
    }
    owners.set(key, file.path);
    totalBytes += file.size;
  });
  if (target === "client" && totalBytes > MAX_TOTAL_FILE_BYTES) {
    throw new Error(
      `client manifest files total ${totalBytes} bytes, above the ${MAX_TOTAL_FILE_BYTES} byte limit.`,
    );
  }

  if (manifest.resourcePack !== undefined) {
    assertServerResourcePack(manifest.resourcePack);
  }
  if (manifest.motd !== undefined) {
    assertServerMotd(manifest.motd, "server manifest motd");
  }
  if (manifest.serverProperties !== undefined) {
    assertServerProperties(manifest.serverProperties, "server manifest serverProperties");
  }
  if (manifest.configPatches !== undefined) {
    if (manifest.configPatches.length > MAX_ARRAY_LENGTH) {
      throw new Error(`client manifest has more than ${MAX_ARRAY_LENGTH} config patches.`);
    }
    manifest.configPatches.forEach((patch, index) =>
      assertConfigPatchModId(manifest, patch, index),
    );
    assertEnforceOperationsUnique(manifest.configPatches);
  }
}
