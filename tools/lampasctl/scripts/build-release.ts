import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as zlib from "node:zlib";
import * as fflate from "fflate";

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

export function resolveHostTarget(): TargetDefinition {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "win32") {
    return arch === "arm64"
      ? RELEASE_TARGETS.find((t) => t.id === "windows_arm64")!
      : RELEASE_TARGETS.find((t) => t.id === "windows_x64")!;
  }
  if (platform === "darwin") {
    return arch === "arm64"
      ? RELEASE_TARGETS.find((t) => t.id === "darwin_arm64")!
      : RELEASE_TARGETS.find((t) => t.id === "darwin_x64")!;
  }
  return arch === "arm64"
    ? RELEASE_TARGETS.find((t) => t.id === "linux_arm64")!
    : RELEASE_TARGETS.find((t) => t.id === "linux_x64")!;
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

/**
 * Creates a valid POSIX ustar tar.gz archive for a single executable file with 0755 permissions.
 */
export function createTarGzArchive(filename: string, fileData: Uint8Array): Uint8Array {
  const header = Buffer.alloc(512);
  const now = Math.floor(Date.now() / 1000);

  // Filename (0..99)
  header.write(filename, 0, 100, "utf-8");
  // File mode (100..107) -> 0755
  header.write("0000755\0", 100, 8, "ascii");
  // Owner UID (108..115)
  header.write("0000000\0", 108, 8, "ascii");
  // Group GID (116..123)
  header.write("0000000\0", 116, 8, "ascii");
  // File size in octal (124..135)
  const sizeOctal = fileData.length.toString(8).padStart(11, "0") + "\0";
  header.write(sizeOctal, 124, 12, "ascii");
  // Modification time in octal (136..147)
  const mtimeOctal = now.toString(8).padStart(11, "0") + "\0";
  header.write(mtimeOctal, 136, 12, "ascii");
  // Checksum placeholder (148..155) -> 8 spaces
  header.fill(0x20, 148, 156);
  // Type flag (156) -> '0' regular file
  header.write("0", 156, 1, "ascii");
  // Magic (257..262) -> "ustar\0"
  header.write("ustar\0", 257, 6, "ascii");
  // Version (263..264) -> "00"
  header.write("00", 263, 2, "ascii");
  // Uname (265..296)
  header.write("lampas\0", 265, 32, "utf-8");
  // Gname (297..328)
  header.write("lampas\0", 297, 32, "utf-8");

  // Calculate checksum
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i];
  }
  const checksumOctal = checksum.toString(8).padStart(6, "0") + "\0 ";
  header.write(checksumOctal, 148, 8, "ascii");

  // Pad data to 512-byte block
  const remainder = fileData.length % 512;
  const paddingLength = remainder === 0 ? 0 : 512 - remainder;
  const padding = Buffer.alloc(paddingLength);

  // End of archive indicator (two 512-byte zero blocks)
  const endBlocks = Buffer.alloc(1024);

  const tarBuffer = Buffer.concat([header, fileData, padding, endBlocks]);
  return zlib.gzipSync(tarBuffer, { level: 9 });
}

export function createZipArchive(filename: string, fileData: Uint8Array): Uint8Array {
  return fflate.zipSync({
    [filename]: fileData,
  }, { level: 9 });
}

export async function buildTarget(options: {
  target: TargetDefinition;
  version: string;
  outDir: string;
  packageArchive?: boolean;
}): Promise<{
  target: TargetDefinition;
  executablePath: string;
  archivePath?: string;
  archiveSha256?: string;
}> {
  const { target, version, outDir, packageArchive } = options;
  fs.mkdirSync(outDir, { recursive: true });

  const tempExeDir = path.join(outDir, `.tmp-${target.id}`);
  fs.mkdirSync(tempExeDir, { recursive: true });
  const rawExePath = path.join(tempExeDir, target.exeName);

  const cliEntry = path.resolve(__dirname, "../src/cli.ts");
  console.log(`[Build] Compiling lampasctl v${version} for target '${target.id}' (${target.bunTarget})...`);

  const buildResult = await Bun.build({
    entrypoints: [cliEntry],
    compile: {
      target: target.bunTarget as any,
      outfile: rawExePath,
    },
    minify: true,
    define: {
      LAMPASCTL_VERSION: JSON.stringify(version),
    },
  });

  if (!buildResult.success) {
    const errorDetails = buildResult.logs.map((l) => l.message).join("\n");
    throw new Error(`Failed to compile target '${target.id}':\n${errorDetails}`);
  }

  const rawBytes = fs.readFileSync(rawExePath);
  console.log(`  ✓ Built executable: ${rawExePath} (${(rawBytes.length / 1024 / 1024).toFixed(2)} MB)`);

  let archivePath: string | undefined;
  let archiveSha256: string | undefined;

  if (packageArchive) {
    const archiveName = `lampasctl_${version}_${target.id}${target.archiveExt}`;
    archivePath = path.join(outDir, archiveName);

    console.log(`  📦 Packaging ${archiveName}...`);
    let archiveData: Uint8Array;
    if (target.archiveExt === ".tar.gz") {
      archiveData = createTarGzArchive(target.exeName, rawBytes);
    } else {
      archiveData = createZipArchive(target.exeName, rawBytes);
    }

    fs.writeFileSync(archivePath, archiveData);
    archiveSha256 = crypto.createHash("sha256").update(archiveData).digest("hex");
    console.log(`  ✓ Created package: ${archivePath} (SHA256: ${archiveSha256.substring(0, 12)}...)`);
  }

  // If not packaging or for local host build, also output standalone binary to outDir
  const finalExePath = path.join(outDir, target.exeName);
  if (!fs.existsSync(finalExePath) || finalExePath !== rawExePath) {
    fs.copyFileSync(rawExePath, finalExePath);
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(finalExePath, 0o755);
      } catch {}
    }
  }

  // Cleanup temp dir
  fs.rmSync(tempExeDir, { recursive: true, force: true });

  return {
    target,
    executablePath: finalExePath,
    archivePath,
    archiveSha256,
  };
}

export function generateChecksums(outDir: string): string {
  const files = fs.readdirSync(outDir).filter((f) => f.startsWith("lampasctl_") && (f.endsWith(".tar.gz") || f.endsWith(".zip")));
  files.sort();

  const lines: string[] = [];
  for (const file of files) {
    const filePath = path.join(outDir, file);
    const content = fs.readFileSync(filePath);
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    lines.push(`${hash}  ${file}`);
  }

  const checksumContent = lines.join("\n") + "\n";
  const sumsPath = path.join(outDir, "SHA256SUMS");
  fs.writeFileSync(sumsPath, checksumContent, "utf-8");
  console.log(`\n[Checksums] Generated ${sumsPath} with ${files.length} entries.`);
  return sumsPath;
}

export function parseCliArgs(args: string[]): {
  targets: TargetDefinition[];
  version: string;
  outDir: string;
  packageArchive: boolean;
  generateSums: boolean;
} {
  let targetArg = "host";
  let versionArg = process.env.LAMPASCTL_VERSION || "dev";
  let outDir = path.resolve(process.cwd(), "dist");
  let packageArchive = false;
  let generateSums = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--target" || arg === "-t") {
      targetArg = args[++i];
    } else if (arg === "--version" || arg === "-v") {
      versionArg = args[++i];
    } else if (arg === "--out" || arg === "-o") {
      outDir = path.resolve(process.cwd(), args[++i]);
    } else if (arg === "--package" || arg === "-p") {
      packageArchive = true;
    } else if (arg === "--checksum" || arg === "-c") {
      generateSums = true;
    }
  }

  const version = cleanVersion(versionArg);

  let targets: TargetDefinition[];
  if (targetArg === "all") {
    targets = RELEASE_TARGETS;
    packageArchive = true;
    generateSums = true;
  } else if (targetArg === "host") {
    targets = [resolveHostTarget()];
  } else {
    const found = RELEASE_TARGETS.find((t) => t.id === targetArg || t.bunTarget === targetArg);
    if (!found) {
      console.error(`Unknown target '${targetArg}'. Supported targets:`);
      console.error(`  - host`);
      console.error(`  - all`);
      for (const t of RELEASE_TARGETS) {
        console.error(`  - ${t.id} (${t.bunTarget})`);
      }
      process.exit(1);
    }
    targets = [found];
  }

  return {
    targets,
    version,
    outDir,
    packageArchive,
    generateSums,
  };
}

async function main() {
  const { targets, version, outDir, packageArchive, generateSums } = parseCliArgs(process.argv.slice(2));

  console.log("=================================================");
  console.log(`⚡ lampasctl Release Builder`);
  console.log(`Version:    ${version}`);
  console.log(`Targets:    ${targets.map((t) => t.id).join(", ")}`);
  console.log(`Output Dir: ${outDir}`);
  console.log(`Packaging:  ${packageArchive ? "Enabled" : "Disabled"}`);
  console.log("=================================================\n");

  const results = [];
  for (const target of targets) {
    const result = await buildTarget({
      target,
      version,
      outDir,
      packageArchive,
    });
    results.push(result);
  }

  if (generateSums || (packageArchive && targets.length > 1)) {
    generateChecksums(outDir);
  }

  console.log(`\n✨ Successfully built ${results.length} lampasctl distribution(s)!`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("\n❌ Build failed:", err);
    process.exit(1);
  });
}
