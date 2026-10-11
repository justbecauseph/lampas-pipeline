import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Host detection for the dedicated server launcher: usable CPUs and RAM (honoring cgroup
 * v1/v2 limits), transparent huge page mode and the Java runtime edition. Ported from
 * tools/scripts/start.py; every reader takes a filesystem root so tests can use fixtures.
 */

export const MiB = 1024 * 1024;
export const GiB = 1024 * MiB;

/** cgroup limits at or above 2^62 mean "unlimited". */
export const CGROUP_UNLIMITED = 2 ** 62;

export interface CgroupLimits {
  /** CPU quota in CPUs (quota / period), or null when unlimited. */
  cpuQuota: number | null;
  /** Memory limit in bytes, or null when unlimited. */
  memLimit: number | null;
  version: 1 | 2 | null;
}

export interface HostInfo {
  cpus: number;
  cpuSource: string;
  ram: number | null;
  ramSource: string;
  /** True when RAM comes from a cgroup limit, i.e. the limit covers only this process tree. */
  container: boolean;
}

export type ThpMode = [enabled: string | null, shmemEnabled: string | null];

/** Parses a JVM-style size (4096M, 4G, 512m, 1073741824) into bytes. Bare numbers are bytes. */
export function parseSize(value: string | number): number {
  let text = String(value).trim().toUpperCase();
  if (text.endsWith("B")) {
    text = text.slice(0, -1);
  }
  const units: Record<string, number> = { K: 1024, M: MiB, G: GiB, T: 1024 * GiB };
  const unit = units[text.slice(-1)];
  if (text && unit) {
    const num = text.slice(0, -1);
    if (!/^\d+(\.\d+)?$/.test(num)) {
      throw new Error(`Invalid size: '${value}'`);
    }
    return Math.floor(Number(num) * unit);
  }
  if (!/^\d+$/.test(text)) {
    throw new Error(`Invalid size: '${value}'`);
  }
  return Number(text);
}

/** Formats bytes as a JVM size, preferring whole gigabytes. */
export function formatSize(bytes: number): string {
  if (bytes % GiB === 0) {
    return `${bytes / GiB}G`;
  }
  return `${Math.floor(bytes / MiB)}M`;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8").trim();
  } catch {
    return null;
  }
}

function readInt(file: string): number | null {
  const text = readText(file);
  if (text === null || text === "max" || !/^-?\d+$/.test(text)) {
    return null;
  }
  const value = Number(text);
  if (value < 0 || value >= CGROUP_UNLIMITED) {
    return null;
  }
  return value;
}

function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

interface CgroupEntry {
  hierarchyId: string;
  controllers: string[];
  path: string;
}

/** Parses /proc/self/cgroup into hierarchy entries. */
function cgroupEntries(root: string): CgroupEntry[] {
  const text = readText(path.join(root, "proc", "self", "cgroup"));
  if (!text) return [];
  const entries: CgroupEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const first = line.indexOf(":");
    const second = first >= 0 ? line.indexOf(":", first + 1) : -1;
    if (second < 0) continue;
    entries.push({
      hierarchyId: line.slice(0, first),
      controllers: line.slice(first + 1, second).split(","),
      path: line.slice(second + 1).replace(" (deleted)", ""),
    });
  }
  return entries;
}

/** Yields directories from base/rel up to base (inclusive). */
function walkUp(base: string, rel: string): string[] {
  const parts = rel.split("/").filter(Boolean);
  const dirs: string[] = [];
  for (let i = parts.length; i >= 0; i--) {
    dirs.push(i === 0 ? base : path.join(base, ...parts.slice(0, i)));
  }
  return dirs;
}

function v1Dirs(root: string, entries: CgroupEntry[], controller: string): string[] {
  for (const entry of entries) {
    if (!entry.controllers.includes(controller)) continue;
    for (const mount of [entry.controllers.join(","), controller]) {
      const base = path.join(root, "sys", "fs", "cgroup", mount);
      if (isDir(base)) {
        const nested = path.join(base, ...entry.path.split("/").filter(Boolean));
        return nested !== base && isDir(nested) ? [nested, base] : [base];
      }
    }
  }
  return [];
}

/** Reads the CPU quota and memory limit from cgroup v2 or v1. */
export function readCgroupLimits(root = "/"): CgroupLimits {
  const entries = cgroupEntries(root);
  const cgroupBase = path.join(root, "sys", "fs", "cgroup");
  let cpuQuota: number | null = null;
  let memLimit: number | null = null;

  if (fs.existsSync(path.join(cgroupBase, "cgroup.controllers"))) {
    const rel = entries.find((e) => e.hierarchyId === "0")?.path ?? "/";
    for (const dir of walkUp(cgroupBase, rel)) {
      const cpuMax = readText(path.join(dir, "cpu.max"));
      if (cpuMax) {
        const fields = cpuMax.split(/\s+/);
        if (fields.length === 2 && fields[0] !== "max") {
          const quota = Number(fields[0]) / Number(fields[1]);
          if (Number.isFinite(quota)) {
            cpuQuota = cpuQuota === null ? quota : Math.min(cpuQuota, quota);
          }
        }
      }
      for (const name of ["memory.max", "memory.high"]) {
        const value = readInt(path.join(dir, name));
        if (value !== null) {
          memLimit = memLimit === null ? value : Math.min(memLimit, value);
        }
      }
    }
    return { cpuQuota, memLimit, version: 2 };
  }

  if (entries.length === 0) {
    return { cpuQuota: null, memLimit: null, version: null };
  }

  for (const dir of v1Dirs(root, entries, "cpu")) {
    const quota = readInt(path.join(dir, "cpu.cfs_quota_us"));
    const period = readInt(path.join(dir, "cpu.cfs_period_us"));
    if (quota && period) {
      cpuQuota = quota / period;
      break;
    }
  }

  for (const dir of v1Dirs(root, entries, "memory")) {
    const candidates: number[] = [];
    const limit = readInt(path.join(dir, "memory.limit_in_bytes"));
    if (limit !== null) candidates.push(limit);
    const stat = readText(path.join(dir, "memory.stat")) ?? "";
    for (const line of stat.split(/\r?\n/)) {
      if (line.startsWith("hierarchical_memory_limit ")) {
        const field = line.split(/\s+/)[1];
        if (field && /^\d+$/.test(field) && Number(field) < CGROUP_UNLIMITED) {
          candidates.push(Number(field));
        }
      }
    }
    if (candidates.length > 0) {
      memLimit = Math.min(...candidates);
      break;
    }
  }

  return { cpuQuota, memLimit, version: 1 };
}

/** Returns MemTotal from /proc/meminfo in bytes, or null. */
export function readMeminfoTotal(root = "/"): number | null {
  const text = readText(path.join(root, "proc", "meminfo"));
  if (!text) return null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("MemTotal:")) {
      const kb = line.split(/\s+/)[1];
      return kb && /^\d+$/.test(kb) ? Number(kb) * 1024 : null;
    }
  }
  return null;
}

/** CPUs this process may run on (affinity-aware on Linux). */
export function baseCpuCount(): number {
  try {
    const count = os.availableParallelism();
    if (count > 0) return count;
  } catch {
    // older runtimes
  }
  return os.cpus().length || 1;
}

export interface DetectHostOptions {
  root?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  cpuCount?: number;
  totalMemory?: () => number;
}

/**
 * Detects usable CPUs and RAM. LAMPAS_CPUS / LAMPAS_RAM override detection.
 * cgroup files are read on Linux, or whenever a non-default root is given (tests).
 */
export function detectHost(options: DetectHostOptions = {}): HostInfo {
  const root = options.root ?? "/";
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  let cpus = options.cpuCount ?? baseCpuCount();
  let cpuSource = "affinity";
  let ram: number | null = null;
  let ramSource = "unknown";
  let container = false;

  if (platform === "linux" || root !== "/") {
    const { cpuQuota, memLimit, version } = readCgroupLimits(root);
    if (cpuQuota !== null && Math.ceil(cpuQuota) < cpus) {
      cpus = Math.max(1, Math.ceil(cpuQuota));
      cpuSource = `cgroup v${version} quota`;
    }
    ram = readMeminfoTotal(root);
    ramSource = "meminfo";
    if (memLimit !== null && (ram === null || memLimit < ram)) {
      ram = memLimit;
      ramSource = `cgroup v${version} limit`;
      container = true;
    }
  }

  if (ram === null) {
    const total = (options.totalMemory ?? os.totalmem)();
    if (total > 0) {
      ram = total;
      ramSource = "os.totalmem";
    }
  }

  const envCpus = env.LAMPAS_CPUS;
  if (envCpus) {
    if (!/^\d+$/.test(envCpus.trim())) {
      throw new Error(`LAMPAS_CPUS must be a whole number, got '${envCpus}'`);
    }
    cpus = Math.max(1, Number(envCpus.trim()));
    cpuSource = "LAMPAS_CPUS";
  }
  const envRam = env.LAMPAS_RAM;
  if (envRam) {
    ram = parseSize(envRam);
    ramSource = "LAMPAS_RAM";
    container = false;
  }

  return { cpus, cpuSource, ram, ramSource, container };
}

/** Returns the active transparent huge page modes, or nulls when unavailable. */
export function readThpMode(root = "/"): ThpMode {
  const active = (name: string): string | null => {
    const text = readText(path.join(root, "sys", "kernel", "mm", "transparent_hugepage", name));
    const match = text ? /\[([^\]]*)\]/.exec(text) : null;
    return match ? match[1] : null;
  };
  return [active("enabled"), active("shmem_enabled")];
}
