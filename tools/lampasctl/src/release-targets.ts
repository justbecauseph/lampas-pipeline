import * as fs from "node:fs";

export interface TargetDefinition {
  id: string;
  bunTarget: string;
  os: "linux" | "windows" | "darwin";
  arch: "x64" | "arm64";
  musl?: boolean;
  exeName: string;
  archiveExt: ".tar.gz" | ".zip";
}

export const RELEASE_TARGETS: TargetDefinition[] = [
  {
    id: "linux_x64",
    bunTarget: "bun-linux-x64-baseline",
    os: "linux",
    arch: "x64",
    exeName: "lampasctl",
    archiveExt: ".tar.gz",
  },
  {
    id: "linux_arm64",
    bunTarget: "bun-linux-arm64",
    os: "linux",
    arch: "arm64",
    exeName: "lampasctl",
    archiveExt: ".tar.gz",
  },
  {
    id: "linux_x64_musl",
    bunTarget: "bun-linux-x64-baseline-musl",
    os: "linux",
    arch: "x64",
    musl: true,
    exeName: "lampasctl",
    archiveExt: ".tar.gz",
  },
  {
    id: "linux_arm64_musl",
    bunTarget: "bun-linux-arm64-musl",
    os: "linux",
    arch: "arm64",
    musl: true,
    exeName: "lampasctl",
    archiveExt: ".tar.gz",
  },
  {
    id: "windows_x64",
    bunTarget: "bun-windows-x64-baseline",
    os: "windows",
    arch: "x64",
    exeName: "lampasctl.exe",
    archiveExt: ".zip",
  },
  {
    id: "windows_arm64",
    bunTarget: "bun-windows-arm64",
    os: "windows",
    arch: "arm64",
    exeName: "lampasctl.exe",
    archiveExt: ".zip",
  },
  {
    id: "darwin_x64",
    bunTarget: "bun-darwin-x64",
    os: "darwin",
    arch: "x64",
    exeName: "lampasctl",
    archiveExt: ".tar.gz",
  },
  {
    id: "darwin_arm64",
    bunTarget: "bun-darwin-arm64",
    os: "darwin",
    arch: "arm64",
    exeName: "lampasctl",
    archiveExt: ".tar.gz",
  },
];

function findTarget(id: string): TargetDefinition {
  return RELEASE_TARGETS.find((t) => t.id === id)!;
}

/** True when the Linux host uses musl libc (Alpine and similar), detected from the musl dynamic loader. */
export function isMuslHost(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return fs.readdirSync("/lib").some((name) => name.startsWith("ld-musl-"));
  } catch {
    return false;
  }
}

/**
 * The release target for the given platform and architecture (default: this process).
 * `musl` selects the musl Linux build; it defaults to false so host builds keep the glibc target.
 */
export function resolveHostTarget(
  options: { platform?: NodeJS.Platform; arch?: string; musl?: boolean } = {}
): TargetDefinition {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  if (platform === "win32") {
    return findTarget(arch === "arm64" ? "windows_arm64" : "windows_x64");
  }
  if (platform === "darwin") {
    return findTarget(arch === "arm64" ? "darwin_arm64" : "darwin_x64");
  }
  const suffix = options.musl ? "_musl" : "";
  return findTarget(arch === "arm64" ? `linux_arm64${suffix}` : `linux_x64${suffix}`);
}

export function cleanVersion(rawVersion?: string): string {
  if (!rawVersion || rawVersion === "dev") return "dev";
  let v = rawVersion.trim();
  if (v.startsWith("lampasctl-v")) {
    v = v.substring("lampasctl-v".length);
  } else if (v.startsWith("v")) {
    v = v.substring(1);
  }
  return v;
}

/** Release archive file name, e.g. `lampasctl_1.2.0_linux_x64.tar.gz`. */
export function releaseArchiveName(version: string, target: TargetDefinition): string {
  return `lampasctl_${version}_${target.id}${target.archiveExt}`;
}
