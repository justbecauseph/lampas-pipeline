import { formatSize, GiB, MiB, parseSize, type ThpMode } from "./host";

/**
 * JVM flag tuning and heap planning for Java 25 / GraalVM on dedicated Minecraft servers.
 * Ported from tools/scripts/start.py. Thread counts are left to JDK 25 ergonomics.
 */

export const OS_RESERVE_CONTAINER = 256 * MiB;
export const OS_RESERVE_SMALL = 512 * MiB;
export const OS_RESERVE_DEFAULT = 1 * GiB;
export const NONHEAP_MIN = 1536 * MiB;
export const NONHEAP_FRACTION = 0.15;
export const MIN_HEAP = 2 * GiB;
export const MAX_HEAP: Record<GcKind, number> = { g1: 16 * GiB, zgc: 24 * GiB };
export const HEAP_ALIGN = 256 * MiB;
export const G1_LARGE_HEAP = 12 * GiB;

export type GcKind = "g1" | "zgc";

/**
 * Computes the heap in bytes: RAM - OS reserve - non-heap reserve - extra reserve, capped and aligned.
 */
export function planHeap(
  ram: number,
  container: boolean,
  extraReserve = 0,
  gc: GcKind = "g1"
): number {
  let osReserve: number;
  if (container) {
    osReserve = OS_RESERVE_CONTAINER;
  } else if (ram > 4 * GiB) {
    osReserve = OS_RESERVE_DEFAULT;
  } else {
    osReserve = OS_RESERVE_SMALL;
  }
  const nonheap = Math.max(NONHEAP_MIN, Math.floor(NONHEAP_FRACTION * ram));
  const heap = Math.min(ram - osReserve - nonheap - extraReserve, MAX_HEAP[gc]);
  return Math.max(0, Math.floor(heap / HEAP_ALIGN) * HEAP_ALIGN);
}

export interface BuildJvmFlagsOptions {
  heap: string | number;
  gc: GcKind;
  cpus: number;
  cpuOverride: boolean;
  thp: ThpMode;
  oracleGraal: boolean;
  compactHeaders: boolean;
}

/**
 * Builds the JVM flag list. Thread counts are left to JDK 25 ergonomics.
 */
export function buildJvmFlags(options: BuildJvmFlagsOptions): string[] {
  const { heap, gc, cpus, cpuOverride, thp, oracleGraal, compactHeaders } = options;
  const heapArg = typeof heap === "string" ? heap : formatSize(heap);
  const flags: string[] = [
    `-Xms${heapArg}`,
    `-Xmx${heapArg}`,
    "-XX:+ExitOnOutOfMemoryError",
    "-XX:+AlwaysPreTouch",
    "-XX:+DisableExplicitGC",
    "-XX:+PerfDisableSharedMem",
  ];

  if (compactHeaders) {
    flags.push("-XX:+UseCompactObjectHeaders");
  }

  if (cpuOverride) {
    flags.push(`-XX:ActiveProcessorCount=${cpus}`);
  }

  const [thpEnabled, thpShmem] = thp;
  const thpEnabledValid = thpEnabled === "always" || thpEnabled === "madvise";
  const thpShmemValid = thpShmem === "advise" || thpShmem === "within_size" || thpShmem === "always";
  if (thpEnabledValid && (gc !== "zgc" || thpShmemValid)) {
    flags.push("-XX:+UseTransparentHugePages");
  }

  if (gc === "zgc") {
    flags.push("-XX:+UseZGC");
  } else {
    let large = false;
    try {
      large = parseSize(heapArg) > G1_LARGE_HEAP;
    } catch {
      large = false;
    }
    flags.push(
      "-XX:+UseG1GC",
      "-XX:+UnlockExperimentalVMOptions",
      `-XX:G1NewSizePercent=${large ? 40 : 30}`,
      `-XX:G1MaxNewSizePercent=${large ? 50 : 40}`,
      `-XX:G1HeapRegionSize=${large ? "16M" : "8M"}`,
      "-XX:G1ReservePercent=15",
      "-XX:G1HeapWastePercent=5",
      "-XX:G1MixedGCCountTarget=4",
      `-XX:InitiatingHeapOccupancyPercent=${large ? 20 : 15}`,
      "-XX:G1MixedGCLiveThresholdPercent=90",
      "-XX:G1RSetUpdatingPauseTimePercent=5",
      "-XX:SurvivorRatio=32",
      "-XX:MaxTenuringThreshold=1",
      "-Dusing.aikars.flags=https://mcflags.emc.gs",
      "-Daikars.new.flags=true"
    );
  }

  if (oracleGraal) {
    // Oracle GraalVM-only option; GraalVM CE rejects it.
    flags.push("-Djdk.graal.TuneInlinerExploration=1");
  }

  flags.push(
    "-Dfile.encoding=UTF-8",
    "-Dlog4j2.formatMsgNoLookups=true"
  );

  return flags;
}
