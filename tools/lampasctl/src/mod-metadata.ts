import * as fs from "node:fs";
import * as path from "node:path";
import * as fflate from "fflate";
import { CURSEFORGE_USER_AGENT } from "./curseforge";
import {
  matchesAnyPredicate,
  parseDependencyPredicates,
  parseVersion,
  type FabricVersion,
  type VersionPredicate,
} from "./fabric-version";
import { USER_AGENT, lampasArtifactPath, providerCachePath } from "./providers";
import type { PackConfig, PackLock, ResolvedArtifact } from "./types";
import { blobCachePath, computeFileHashesStreaming, downloadFileVerified } from "./utils";

/** Java version Lampas servers and clients run. Fabric Loader exposes it as the builtin mod `java`. */
export const LAMPAS_JAVA_VERSION = "25";

export type ModSide = "client" | "server";

interface ModRule {
  id: string;
  /** The fabric.mod.json value, for messages. */
  raw: string[];
  /** ORed, as in ModDependencyImpl.matches. */
  predicates: VersionPredicate[];
}

export interface ParsedFabricMod {
  id: string;
  version: FabricVersion;
  provides: string[];
  environment: "*" | "client" | "server";
  depends: ModRule[];
  breaks: ModRule[];
}

/** One jar and the jars nested in it through fabric.mod.json `jars`. */
export interface ModJarNode {
  /** `mods/<file>.jar`, with `!/<entry>` per nesting level. */
  source: string;
  mod?: ParsedFabricMod;
  /** An unreadable jar, or a fabric.mod.json that Fabric Loader's parser rejects. */
  error?: string;
  children: ModJarNode[];
}

export type ModMetadataIssueKind =
  | "duplicate"
  | "missing-dependency"
  | "unsatisfied-dependency"
  | "breaks"
  | "invalid-metadata";

export interface ModMetadataIssue {
  kind: ModMetadataIssueKind;
  message: string;
}

export interface ModSetReport {
  side: ModSide;
  /** Mods Fabric Loader would consider on this side, nested ones included. */
  modCount: number;
  jarCount: number;
  issues: ModMetadataIssue[];
}

function parseRules(value: unknown, field: string): ModRule[] {
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`'${field}' must be an object`);
  }
  return Object.entries(value as Record<string, unknown>).map(([id, raw]) => {
    try {
      return {
        id,
        raw: Array.isArray(raw) ? raw.map(String) : [String(raw)],
        predicates: parseDependencyPredicates(raw),
      };
    } catch (err: any) {
      throw new Error(`'${field}.${id}': ${err.message}`);
    }
  });
}

/**
 * Rewrites what Fabric Loader's JsonReader accepts inside strings and JSON.parse does not: raw control
 * characters, \' and an escaped line break.
 */
function normalizeFabricJson(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === "'") {
        out += "'";
        i++;
      } else if (next === "\n") {
        out += "\\n";
        i++;
      } else if (next !== undefined) {
        out += ch + next;
        i++;
      } else {
        out += ch;
      }
      continue;
    }
    if (ch === '"') inString = false;
    const code = ch.charCodeAt(0);
    out += code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : ch;
  }
  return out;
}

// MetadataVerifier.MOD_ID_PATTERN, applied to `id` and `provides` whenever metadata is parsed.
const MOD_ID_PATTERN = /^[a-z][a-z0-9-_]{1,63}$/;

function checkModId(id: unknown, label: string): string {
  if (typeof id !== "string" || !MOD_ID_PATTERN.test(id)) {
    throw new Error(`${label} ${JSON.stringify(id)} must match [a-z][a-z0-9-_]{1,63}`);
  }
  return id;
}

/**
 * Reads the fields of a fabric.mod.json that affect loading. Schema 1 is the current format; schema 0
 * (no `schemaVersion`) maps `requires` to depends, `conflicts` to breaks and `side` to the environment.
 */
export function parseFabricModJson(text: string): { mod: ParsedFabricMod; jars: string[] } {
  const json = JSON.parse(normalizeFabricJson(text));
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("fabric.mod.json is not an object");
  }
  const schemaVersion = json.schemaVersion ?? 0;
  if (schemaVersion !== 0 && schemaVersion !== 1) {
    throw new Error(`unsupported schemaVersion ${JSON.stringify(schemaVersion)}`);
  }
  const id = checkModId(json.id, "mod id");
  if (typeof json.version !== "string" || json.version.length === 0) {
    throw new Error("'version' must be a non-empty string");
  }
  const version = parseVersion(json.version, false);

  if (schemaVersion === 0) {
    const side = json.side ?? "universal";
    return {
      mod: {
        id,
        version,
        provides: [],
        // V0ModMetadataParser only warns about an unknown side and keeps the default.
        environment: side === "client" || side === "server" ? side : "*",
        depends: parseRules(json.requires, "requires"),
        breaks: parseRules(json.conflicts, "conflicts"),
      },
      jars: [],
    };
  }

  const provides = json.provides ?? [];
  if (!Array.isArray(provides)) throw new Error("'provides' must be an array of strings");
  for (const provided of provides) checkModId(provided, "provides declaration");

  const environmentRaw = json.environment ?? "*";
  if (typeof environmentRaw !== "string") throw new Error("'environment' must be a string");
  const environment = environmentRaw.toLowerCase();
  if (environment !== "" && environment !== "*" && environment !== "client" && environment !== "server") {
    throw new Error(`invalid environment '${environmentRaw}'`);
  }

  const jars: string[] = [];
  for (const entry of json.jars ?? []) {
    if (!entry || typeof entry.file !== "string") throw new Error("'jars' entries must have a string 'file'");
    jars.push(entry.file);
  }

  return {
    mod: {
      id,
      version,
      provides,
      environment: environment === "" ? "*" : (environment as ParsedFabricMod["environment"]),
      depends: parseRules(json.depends, "depends"),
      breaks: parseRules(json.breaks, "breaks"),
    },
    jars,
  };
}

function unzipEntries(data: Uint8Array, names: Set<string>): Record<string, Uint8Array> {
  return fflate.unzipSync(data, { filter: (file) => names.has(file.name) });
}

/** Reads a jar's fabric.mod.json and, recursively, the nested jars it lists. */
export function readModJar(data: Uint8Array, source: string): ModJarNode {
  const node: ModJarNode = { source, children: [] };
  let metadata: Uint8Array | undefined;
  try {
    metadata = unzipEntries(data, new Set(["fabric.mod.json"]))["fabric.mod.json"];
  } catch (err: any) {
    node.error = `cannot read jar: ${err.message}`;
    return node;
  }
  // Fabric Loader skips jars without fabric.mod.json.
  if (!metadata) return node;

  let jars: string[];
  try {
    // TextDecoder drops a leading BOM.
    const parsed = parseFabricModJson(new TextDecoder("utf-8").decode(metadata));
    node.mod = parsed.mod;
    jars = parsed.jars;
  } catch (err: any) {
    node.error = `invalid fabric.mod.json: ${err.message}`;
    return node;
  }

  // ModDiscoverer skips listed entries that are missing or not named *.jar.
  const listed = jars.filter((file) => file.endsWith(".jar"));
  if (listed.length > 0) {
    let nested: Record<string, Uint8Array>;
    try {
      nested = unzipEntries(data, new Set(listed));
    } catch (err: any) {
      node.error = `cannot read nested jars: ${err.message}`;
      return node;
    }
    for (const file of listed) {
      if (nested[file]) node.children.push(readModJar(nested[file], `${source}!/${file}`));
    }
  }
  return node;
}

interface LoadedMod {
  mod: ParsedFabricMod;
  source: string;
  /** The jar this one is nested in; undefined for a jar in mods/. */
  parent?: LoadedMod;
}

interface Candidate {
  version: FabricVersion;
  label: string;
}

function loadsOn(mod: ParsedFabricMod, side: ModSide): boolean {
  return mod.environment === "*" || mod.environment === side;
}

function describeRule(rule: ModRule): string {
  return rule.raw.map((r) => (r.length === 0 ? "*" : r)).join(" || ");
}

function describeMod(entry: LoadedMod): string {
  return `${entry.mod.id} ${entry.mod.version.friendly} (${entry.source})`;
}

function modIds(entry: LoadedMod): string[] {
  return [...new Set([entry.mod.id, ...entry.mod.provides])];
}

function candidateOf(entry: LoadedMod): Candidate {
  return { version: entry.mod.version, label: describeMod(entry) };
}

/** Fabric Loader's builtin mods for a Lampas pack. */
export function lampasBuiltinMods(minecraft: string, loaderVersion: string): Record<string, string> {
  return { minecraft, fabricloader: loaderVersion, java: LAMPAS_JAVA_VERSION };
}

/**
 * The loader jar itself loads as a top-level mod rather than a builtin, so a nested copy of its ID loses
 * to it like any nested copy of a top-level mod, instead of colliding with a builtin.
 */
const LOADER_MOD_ID = "fabricloader";

/**
 * Checks the mods one side loads, following Fabric Loader's resolver: jars in mods/ must load, one copy
 * per mod ID; nested jar-in-jar mods load only when their parent loads and their own rules allow it.
 * Reports duplicate top-level mod IDs (including `provides`), `depends` that no loadable copy satisfies
 * and `breaks` that match a mod that must load.
 */
export function analyzeModSet(side: ModSide, jars: ModJarNode[], builtins: Record<string, string>): ModSetReport {
  const issues: ModMetadataIssue[] = [];
  const loaded: LoadedMod[] = [];
  // Mods skipped for this side, by ID. Their nested jars are not scanned (ModDiscoverer).
  const envDisabled = new Map<string, FabricVersion[]>();

  const visit = (node: ModJarNode, parent?: LoadedMod) => {
    if (node.error) {
      issues.push({ kind: "invalid-metadata", message: `${node.source}: ${node.error}` });
      return;
    }
    if (!node.mod) return;
    if (!loadsOn(node.mod, side)) {
      envDisabled.set(node.mod.id, [...(envDisabled.get(node.mod.id) ?? []), node.mod.version]);
      return;
    }
    const entry: LoadedMod = { mod: node.mod, source: node.source, parent };
    loaded.push(entry);
    for (const child of node.children) visit(child, entry);
  };
  for (const jar of jars) visit(jar);

  const topLevel = loaded.filter((e) => !e.parent);
  const nested = loaded.filter((e) => e.parent);
  const topProviders = new Map<string, LoadedMod[]>();
  const nestedProviders = new Map<string, LoadedMod[]>();
  for (const entry of loaded) {
    const index = entry.parent ? nestedProviders : topProviders;
    for (const id of modIds(entry)) index.set(id, [...(index.get(id) ?? []), entry]);
  }

  const builtinVersions = new Map(Object.entries(builtins).map(([id, v]) => [id, parseVersion(v, false)]));
  const builtinCandidate = (id: string): Candidate | undefined => {
    const version = builtinVersions.get(id);
    return version ? { version, label: `${id} ${version.friendly} (builtin)` } : undefined;
  };

  // Keyed by jar path: one jar that lists its own ID in `provides` is not a duplicate.
  for (const [id, providers] of topProviders) {
    const sources = new Set(providers.map((p) => p.source));
    if (builtinVersions.has(id)) {
      issues.push({ kind: "duplicate", message: `mod ID '${id}' is builtin and also provided by ${providers.map(describeMod).join(", ")}` });
    } else if (sources.size > 1) {
      issues.push({
        kind: "duplicate",
        message: `mod ID '${id}' is provided by ${sources.size} jars, and Fabric Loader loads only one of them: ${providers.map(describeMod).join(", ")}`,
      });
    }
  }
  for (const [id, providers] of nestedProviders) {
    if (builtinVersions.has(id) && id !== LOADER_MOD_ID) {
      issues.push({ kind: "duplicate", message: `mod ID '${id}' is builtin and also provided by ${providers.map(describeMod).join(", ")}` });
    }
  }

  // ModResolver softens a dependency to "suggests" when no enabled mod has the ID and a mod disabled
  // for this side matches it.
  const softened = (rule: ModRule) =>
    !builtinVersions.has(rule.id) &&
    !topProviders.has(rule.id) &&
    !nestedProviders.has(rule.id) &&
    (envDisabled.get(rule.id) ?? []).some((v) => matchesAnyPredicate(rule.predicates, v));

  /** The copies that must load: a builtin, or the top-level jars (one of which loads). */
  const mandatory = (id: string): Candidate[] => {
    const builtin = builtinCandidate(id);
    if (builtin) return [builtin];
    return (topProviders.get(id) ?? []).map(candidateOf);
  };

  // Nested mods that can load: not shadowed by a mandatory ID, parent loadable, every `depends`
  // satisfiable and no `breaks` against a mandatory mod. Removing one can strand others, so iterate.
  const excluded = new Map<LoadedMod, string>();
  for (const entry of nested) {
    const shadow = modIds(entry).find((id) => mandatory(id).length > 0);
    if (shadow !== undefined) excluded.set(entry, `'${shadow}' is already provided by a top-level or builtin mod`);
  }
  for (const owner of topLevel) {
    for (const rule of owner.mod.breaks) {
      for (const entry of nestedProviders.get(rule.id) ?? []) {
        if (!excluded.has(entry) && matchesAnyPredicate(rule.predicates, entry.mod.version)) {
          excluded.set(entry, `${describeMod(owner)} breaks ${rule.id} ${describeRule(rule)}`);
        }
      }
    }
  }

  const available = (id: string): Candidate[] => {
    const required = mandatory(id);
    if (required.length > 0) return required;
    return (nestedProviders.get(id) ?? []).filter((e) => !excluded.has(e)).map(candidateOf);
  };

  for (let changed = true; changed; ) {
    changed = false;
    for (const entry of nested) {
      if (excluded.has(entry)) continue;
      let reason: string | undefined;
      if (entry.parent && excluded.has(entry.parent)) {
        reason = `its parent ${describeMod(entry.parent)} cannot load`;
      }
      for (const rule of entry.mod.depends) {
        if (reason) break;
        if (softened(rule)) continue;
        if (!available(rule.id).some((c) => matchesAnyPredicate(rule.predicates, c.version))) {
          reason = `it depends on ${rule.id} ${describeRule(rule)}`;
        }
      }
      for (const rule of entry.mod.breaks) {
        if (reason) break;
        const required = mandatory(rule.id);
        if (required.length > 0 && required.every((c) => matchesAnyPredicate(rule.predicates, c.version))) {
          reason = `it breaks ${rule.id} ${describeRule(rule)}`;
        }
      }
      if (reason) {
        excluded.set(entry, reason);
        changed = true;
      }
    }
  }

  const describeExcluded = (id: string) =>
    (nestedProviders.get(id) ?? [])
      .filter((e) => excluded.has(e))
      .map((e) => `${describeMod(e)}, which cannot load because ${excluded.get(e)}`);

  // Requirements top-level mods place on nested-only IDs; one copy has to satisfy all of them.
  const nestedRequirements = new Map<string, Array<{ owner: LoadedMod; rule: ModRule }>>();

  for (const owner of topLevel) {
    for (const rule of owner.mod.depends) {
      const found = available(rule.id);
      if (found.length === 0) {
        if (softened(rule)) continue;
        const unloadable = describeExcluded(rule.id);
        issues.push(
          unloadable.length === 0
            ? { kind: "missing-dependency", message: `${describeMod(owner)} depends on ${rule.id} ${describeRule(rule)}, which is not present` }
            : { kind: "unsatisfied-dependency", message: `${describeMod(owner)} depends on ${rule.id} ${describeRule(rule)}, but only ${unloadable.join("; ")} is present` }
        );
      } else if (!found.some((c) => matchesAnyPredicate(rule.predicates, c.version))) {
        issues.push({
          kind: "unsatisfied-dependency",
          message: `${describeMod(owner)} depends on ${rule.id} ${describeRule(rule)}, but only ${found.map((c) => c.label).join(", ")} is present`,
        });
      } else if (mandatory(rule.id).length === 0) {
        nestedRequirements.set(rule.id, [...(nestedRequirements.get(rule.id) ?? []), { owner, rule }]);
      }
    }

    for (const rule of owner.mod.breaks) {
      const required = mandatory(rule.id);
      // With several top-level copies of an ID, Fabric Loader can load one the rule does not match.
      if (required.length > 0 && required.every((c) => matchesAnyPredicate(rule.predicates, c.version))) {
        issues.push({
          kind: "breaks",
          message: `${describeMod(owner)} breaks ${rule.id} ${describeRule(rule)}, and ${required.map((c) => c.label).join(", ")} is present`,
        });
      }
    }
  }

  for (const [id, requirements] of nestedRequirements) {
    if (requirements.length < 2) continue;
    const found = available(id);
    const fitsAll = found.some((c) => requirements.every(({ rule }) => matchesAnyPredicate(rule.predicates, c.version)));
    if (!fitsAll) {
      issues.push({
        kind: "unsatisfied-dependency",
        message: `no single copy of ${id} satisfies ${requirements.map(({ owner, rule }) => `${describeMod(owner)} (${describeRule(rule)})`).join(" and ")}; present: ${found.map((c) => c.label).join(", ")}`,
      });
    }
  }

  return { side, modCount: loaded.length, jarCount: jars.length, issues };
}

/** Lock artifacts that land in `mods/` as jars. */
export function modJarArtifacts(lock: PackLock, exclude?: string): ResolvedArtifact[] {
  return Object.entries(lock.artifacts)
    .filter(([id, artifact]) => {
      if (id === exclude) return false;
      const targetDir = artifact.targetDir || (artifact.artifactType === "shader"
        ? "shaderpacks"
        : artifact.artifactType === "resourcepack" ? "resourcepacks" : "mods");
      return targetDir === "mods" && artifact.filename.toLowerCase().endsWith(".jar");
    })
    .map(([, artifact]) => artifact);
}

async function sha256Matches(filePath: string, expected: string): Promise<boolean> {
  if (!fs.existsSync(filePath)) return false;
  return (await computeFileHashesStreaming(filePath)).sha256 === expected;
}

/**
 * Returns a local path to the artifact's jar, verified against the lock's sha256: the `lampas` file in the
 * pack, the `resolve` provider cache or the `sync` blob cache, or else a verified download into that cache.
 */
export async function obtainArtifactJar(artifact: ResolvedArtifact, baseDir: string): Promise<string> {
  const expected = artifact.sha256.toLowerCase();
  const provider = artifact.provider;

  if (provider.type === "lampas") {
    if (!provider.file) throw new Error(`'${artifact.id}' has no lampas file in pack.lock.json`);
    const filePath = lampasArtifactPath(baseDir, provider.file);
    if (!(await sha256Matches(filePath, expected))) {
      throw new Error(`pack/${provider.file} is missing or does not match the pack.lock.json sha256; run 'lampasctl resolve'`);
    }
    return filePath;
  }

  let providerPath: string | undefined;
  if (provider.type === "modrinth" && provider.projectId !== undefined && provider.versionId !== undefined) {
    providerPath = providerCachePath(baseDir, "modrinth", provider.projectId, provider.versionId, artifact.filename);
  } else if (provider.type === "curseforge" && provider.projectId !== undefined && provider.fileId !== undefined) {
    providerPath = providerCachePath(baseDir, "curseforge", provider.projectId, provider.fileId, artifact.filename);
  }
  const blobPath = blobCachePath(path.resolve(baseDir, ".lampas", "cache", "sha256"), expected);

  for (const candidate of [providerPath, blobPath]) {
    if (candidate && (await sha256Matches(candidate, expected))) return candidate;
  }

  if (!/^https?:\/\//i.test(artifact.downloadUrl)) {
    throw new Error(`not cached locally and its download URL '${artifact.downloadUrl}' is not absolute`);
  }
  const destination = providerPath ?? blobPath;
  await downloadFileVerified(artifact.downloadUrl, destination, {
    expectedHash: expected,
    algorithm: "sha256",
    expectedSize: artifact.size,
    headers: { "User-Agent": provider.type === "curseforge" ? CURSEFORGE_USER_AGENT : USER_AGENT },
  });
  return destination;
}

export interface CheckModMetadataOptions {
  packDir: string;
  packConfig: PackConfig;
  lock: PackLock;
  concurrency?: number;
}

/** Validates fabric.mod.json across each side's mods. Logs findings and returns the number of issues. */
export async function checkPackModMetadata(options: CheckModMetadataOptions): Promise<number> {
  const baseDir = path.dirname(path.resolve(options.packDir));
  const srp = options.packConfig.server?.resourcepack || options.packConfig.server?.resource_pack;
  const artifacts = modJarArtifacts(options.lock, srp?.artifact);

  const trees = new Map<string, ModJarNode>();
  const failures: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < artifacts.length) {
      const artifact = artifacts[next++];
      try {
        const jarPath = await obtainArtifactJar(artifact, baseDir);
        trees.set(artifact.id, readModJar(new Uint8Array(fs.readFileSync(jarPath)), `mods/${artifact.filename}`));
      } catch (err: any) {
        failures.push(`'${artifact.id}' (${artifact.filename}): ${err.message}${err.cause?.message ? ` (${err.cause.message})` : ""}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 6, artifacts.length) }, () => worker()));

  for (const failure of failures.sort()) {
    console.error(`  ✗ [Mod Jar Unavailable] ${failure}`);
  }

  const builtins = lampasBuiltinMods(options.packConfig.pack.minecraft, options.packConfig.loader.version);
  const labels: Record<ModMetadataIssueKind, string> = {
    duplicate: "Duplicate Mod ID",
    "missing-dependency": "Missing Dependency",
    "unsatisfied-dependency": "Unsatisfied Dependency",
    breaks: "Breaking Mod",
    "invalid-metadata": "Invalid Mod Metadata",
  };

  let issueCount = failures.length;
  for (const side of ["client", "server"] as const) {
    const jars = artifacts
      .filter((a) => a.side === side || a.side === "both")
      .map((a) => trees.get(a.id))
      .filter((tree): tree is ModJarNode => tree !== undefined);
    const report = analyzeModSet(side, jars, builtins);
    for (const issue of report.issues) {
      console.error(`  ✗ [${labels[issue.kind]}] ${side}: ${issue.message}`);
    }
    const mark = report.issues.length === 0 ? "✓" : "✗";
    console.log(`  ${mark} [Mod Metadata] ${side}: ${report.modCount} mods from ${report.jarCount} jars (nested included), ${report.issues.length} issues`);
    issueCount += report.issues.length;
  }
  return issueCount;
}
