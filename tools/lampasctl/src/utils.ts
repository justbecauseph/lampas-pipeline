import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as fflate from "fflate";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;

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

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function parseTomlFile<T = unknown>(filePath: string): T {
  const content = fs.readFileSync(filePath, "utf-8");
  return parseToml(content) as T;
}

export function writeTomlFile(filePath: string, data: any): void {
  ensureDir(path.dirname(filePath));
  const content = stringifyToml(data);
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
