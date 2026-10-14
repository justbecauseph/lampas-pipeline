import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as fflate from "fflate";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 180_000;

export async function withAbortTimeout<T>(
  description: string,
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await operation(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Timed out after ${timeoutMs}ms while ${description}`, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export interface FileHashes {
  sha1: string;
  sha256: string;
  sha512: string;
  size: number;
}

export function computeFileHashes(filePath: string): FileHashes {
  const buffer = fs.readFileSync(filePath);
  return {
    sha1: createHash("sha1").update(buffer).digest("hex"),
    sha256: createHash("sha256").update(buffer).digest("hex"),
    sha512: createHash("sha512").update(buffer).digest("hex"),
    size: buffer.length,
  };
}

export async function computeFileHashesStreaming(filePath: string): Promise<FileHashes> {
  const hashes = {
    sha1: createHash("sha1"),
    sha256: createHash("sha256"),
    sha512: createHash("sha512"),
  };
  let size = 0;

  for await (const chunk of fs.createReadStream(filePath)) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    hashes.sha1.update(buffer);
    hashes.sha256.update(buffer);
    hashes.sha512.update(buffer);
  }

  return {
    sha1: hashes.sha1.digest("hex"),
    sha256: hashes.sha256.digest("hex"),
    sha512: hashes.sha512.digest("hex"),
    size,
  };
}

export interface VerifiedTransferOptions {
  expectedHash: string;
  algorithm?: "sha1" | "sha256" | "sha512";
  expectedSize?: number;
  headers?: Record<string, string>;
  attempts?: number;
  timeoutMs?: number;
}

export function temporarySibling(filePath: string): string {
  return `${filePath}.partial.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
}

export async function replaceFile(tempPath: string, destination: string): Promise<void> {
  try {
    await fs.promises.rename(tempPath, destination);
  } catch (error: any) {
    if (!fs.existsSync(destination) || (error?.code !== "EEXIST" && error?.code !== "EPERM")) throw error;
    const backupPath = temporarySibling(`${destination}.previous`);
    await fs.promises.rename(destination, backupPath);
    try {
      await fs.promises.rename(tempPath, destination);
      await fs.promises.rm(backupPath, { force: true });
    } catch (replacementError) {
      await fs.promises.rename(backupPath, destination).catch(() => undefined);
      throw replacementError;
    }
  }
}

async function verifyAndPromote(
  source: NodeJS.ReadableStream,
  destination: string,
  options: VerifiedTransferOptions
): Promise<number> {
  ensureDir(path.dirname(destination));
  const tempPath = temporarySibling(destination);
  const algorithm = options.algorithm || "sha256";
  const hash = createHash(algorithm);
  let size = 0;
  const hashingStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(source, hashingStream, fs.createWriteStream(tempPath, { flags: "wx" }));
    const actualHash = hash.digest("hex");
    if (actualHash !== options.expectedHash) {
      throw new Error(`${algorithm.toUpperCase()} mismatch: expected ${options.expectedHash}, got ${actualHash}`);
    }
    if (options.expectedSize !== undefined && options.expectedSize > 0 && size !== options.expectedSize) {
      throw new Error(`Size mismatch: expected ${options.expectedSize} bytes, got ${size}`);
    }
    await replaceFile(tempPath, destination);
    return size;
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function copyFileVerified(
  sourcePath: string,
  destination: string,
  options: VerifiedTransferOptions
): Promise<number> {
  return verifyAndPromote(fs.createReadStream(sourcePath), destination, options);
}

export async function downloadFileVerified(
  url: string,
  destination: string,
  options: VerifiedTransferOptions
): Promise<number> {
  const attempts = options.attempts || 3;
  const timeoutMs = options.timeoutMs || DEFAULT_DOWNLOAD_TIMEOUT_MS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await withAbortTimeout(
        `downloading ${url}`,
        async (signal) => {
          const response = await fetch(url, { signal, headers: options.headers });
          if (!response.ok || !response.body) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
          }
          return verifyAndPromote(Readable.fromWeb(response.body as any), destination, options);
        },
        timeoutMs
      );
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
      }
    }
  }

  throw new Error(`Failed to download ${url} after ${attempts} attempts`, { cause: lastError });
}

/** The sha256 blob cache layout `sync` uses: <cacheDir>/<first two hex digits>/<sha256>. */
export function blobCachePath(cacheDir: string, sha256: string): string {
  return path.join(cacheDir, sha256.substring(0, 2), sha256);
}

export async function copyFileAtomic(sourcePath: string, destination: string): Promise<void> {
  ensureDir(path.dirname(destination));
  const tempPath = temporarySibling(destination);
  try {
    await fs.promises.copyFile(sourcePath, tempPath, fs.constants.COPYFILE_FICLONE);
    await replaceFile(tempPath, destination);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function computeBufferHashes(buffer: Buffer | Uint8Array): FileHashes {
  return {
    sha1: createHash("sha1").update(buffer).digest("hex"),
    sha256: createHash("sha256").update(buffer).digest("hex"),
    sha512: createHash("sha512").update(buffer).digest("hex"),
    size: buffer.length,
  };
}

export interface FabricModJson {
  id?: string;
  name?: string;
  version?: string;
  environment?: string;
  depends?: Record<string, string | string[]>;
  recommends?: Record<string, string | string[]>;
  suggests?: Record<string, string | string[]>;
  conflicts?: Record<string, string | string[]>;
  breaks?: Record<string, string | string[]>;
  jars?: Array<{ file: string }>;
  mixins?: Array<string | { config: string }>;
  [key: string]: unknown;
}

export interface JarMetadata {
  filename: string;
  hasFabricModJson: boolean;
  fabricMod?: FabricModJson;
  innerJars: string[];
  mixins: string[];
}

export function inspectJar(filePath: string): JarMetadata {
  const filename = path.basename(filePath);
  const buffer = fs.readFileSync(filePath);

  const meta: JarMetadata = {
    filename,
    hasFabricModJson: false,
    innerJars: [],
    mixins: [],
  };

  try {
    const unzipped = fflate.unzipSync(new Uint8Array(buffer), {
      filter(file) {
        return (
          file.name === "fabric.mod.json" ||
          file.name.toLowerCase().endsWith(".jar") ||
          file.name.toLowerCase().endsWith(".mixins.json") ||
          file.name.toLowerCase().endsWith(".mixin.json")
        );
      },
    });

    for (const [name, data] of Object.entries(unzipped)) {
      if (name === "fabric.mod.json") {
        meta.hasFabricModJson = true;
        try {
          const text = new TextDecoder("utf-8").decode(data);
          meta.fabricMod = JSON.parse(text);
        } catch {
          // ignore corrupted json
        }
      } else if (
        name.toLowerCase().endsWith(".jar") &&
        (name.startsWith("META-INF/jars/") || name.startsWith("META-INF/jarjar/"))
      ) {
        meta.innerJars.push(name);
      } else if (name.endsWith(".json") && name.includes("mixin")) {
        meta.mixins.push(name);
      }
    }
  } catch (err) {
    // corrupted or non-standard jar
  }

  return meta;
}

export function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

// Windows reserved device names, with or without an extension (lampas-launcher path-policy.ts)
const DOS_DEVICE_REGEX = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
// Forbidden control characters: NUL through 0x1F and DEL (0x7F)
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/;

/**
 * Port of lampas-launcher canonicalizeRelativePath. Converts `\` to `/` and drops one trailing
 * slash. Throws for leading or trailing whitespace (the Portal's `value !== value.trim()` rule),
 * absolute or drive-rooted paths, control characters and DEL, `.` and `..` segments, empty inner
 * segments, segments ending in a dot or space, `:` (alternate data streams), reserved device names,
 * and prototype-sensitive keys. Returns the canonical path.
 */
export function canonicalizeRelativePath(relPath: string): string {
  if (!relPath || typeof relPath !== "string") {
    throw new Error("Relative path must be a non-empty string.");
  }
  if (CONTROL_CHAR_REGEX.test(relPath)) {
    throw new Error("Relative path contains prohibited control characters.");
  }
  if (relPath !== relPath.trim()) {
    throw new Error(`Relative path has leading or trailing whitespace: '${relPath}'`);
  }

  if (
    relPath.startsWith("//") ||
    relPath.startsWith("\\\\") ||
    relPath.startsWith("/") ||
    relPath.startsWith("\\") ||
    /^[a-zA-Z]:/.test(relPath)
  ) {
    throw new Error(`Absolute or drive-rooted paths are not permitted: '${relPath}'`);
  }

  const segments = relPath.replace(/\\/g, "/").split("/");
  const clean: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    if (segment === "") {
      if (i === 0 && segments.length > 1) {
        throw new Error(`Path must not start with a slash: '${relPath}'`);
      }
      if (i === segments.length - 1) continue;
      throw new Error(`Path contains consecutive slashes: '${relPath}'`);
    }
    if (segment === "." || segment === "..") {
      throw new Error(`Path traversal segment '${segment}' is prohibited: '${relPath}'`);
    }
    if (segment === "__proto__" || segment === "constructor" || segment === "prototype") {
      throw new Error(`Prototype-sensitive segment '${segment}' is prohibited: '${relPath}'`);
    }
    if (segment.includes(":")) {
      throw new Error(`Windows Alternate Data Stream notation is prohibited: '${segment}'`);
    }
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      throw new Error(`Path segment with trailing space or dot is prohibited: '${segment}'`);
    }
    if (DOS_DEVICE_REGEX.test(segment)) {
      throw new Error(`Reserved device name is prohibited: '${segment}'`);
    }
    clean.push(segment);
  }

  if (clean.length === 0) {
    throw new Error("Path resolved to empty target.");
  }
  return clean.join("/");
}

export function isSafeRelativePath(relPath: string): boolean {
  if (!relPath || typeof relPath !== "string") return false;
  const normalized = path.normalize(relPath).replace(/\\/g, "/");
  if (
    normalized.startsWith("../") ||
    normalized === ".." ||
    path.isAbsolute(normalized) ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.startsWith("//") ||
    normalized.startsWith("\\\\")
  ) {
    return false;
  }
  return true;
}

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function parseTomlFile<T = unknown>(filePath: string): T {
  const content = fs.readFileSync(filePath, "utf-8");
  return parseToml(content) as T;
}

export function inferTomlSchemaHeader(filePath: string): string | null {
  const norm = filePath.replace(/\\/g, "/");
  if (/(?:^|\/)pack\/pack\.toml$/i.test(norm)) {
    return "#:schema ../schemas/pack.schema.json\n\n";
  }
  if (/(?:^|\/)pack\/(?:mods|resourcepacks|shaderpacks|shaders)\/[^/]+\.toml$/i.test(norm)) {
    return "#:schema ../../schemas/artifact-definition.schema.json\n\n";
  }
  return null;
}

export function writeTomlFile(filePath: string, data: any, schemaHeader?: string | false): void {
  ensureDir(path.dirname(filePath));
  let header = "";
  if (schemaHeader === undefined) {
    const inferred = inferTomlSchemaHeader(filePath);
    if (inferred) header = inferred;
  } else if (typeof schemaHeader === "string") {
    header = `#:schema ${schemaHeader}\n\n`;
  }
  const content = header + stringifyToml(data);
  fs.writeFileSync(filePath, content, "utf-8");
}

export function writeJsonFile(filePath: string, data: unknown, pretty = true): void {
  ensureDir(path.dirname(filePath));
  const content = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  fs.writeFileSync(filePath, content, "utf-8");
}

export function readJsonFile<T = unknown>(filePath: string): T {
  const content = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(content) as T;
}

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

export function formatPromptJson(prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  return JSON.stringify({ text: trimmed });
}

export function generateDeterministicUuid(seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex");
  const p1 = hash.substring(0, 8);
  const p2 = hash.substring(8, 12);
  const p3 = "4" + hash.substring(13, 16);
  const variantByte = (parseInt(hash.substring(16, 18), 16) & 0x3f) | 0x80;
  const p4 = variantByte.toString(16).padStart(2, "0") + hash.substring(18, 20);
  const p5 = hash.substring(20, 32);
  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

