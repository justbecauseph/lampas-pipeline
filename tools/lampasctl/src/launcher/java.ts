import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Locates the preferred Java binary (JAVA_BIN, JAVA_HOME, SDKMAN GraalVM, system Java, etc.).
 * Mirror of tools/scripts/start.py find_java_binary.
 */
export function findJavaBinary(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir()
): string {
  const envBin = env.JAVA_BIN;
  if (envBin && fs.existsSync(envBin)) {
    return envBin;
  }

  const javaHome = env.JAVA_HOME;
  if (javaHome) {
    const candidate = path.join(javaHome, "bin", platform === "win32" ? "java.exe" : "java");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  if (platform !== "win32") {
    const sdkmanJava = path.join(home, ".sdkman", "candidates", "java", "current", "bin", "java");
    try {
      if (fs.existsSync(sdkmanJava)) {
        fs.accessSync(sdkmanJava, fs.constants.X_OK);
        return sdkmanJava;
      }
    } catch {
      // not executable or does not exist
    }
  }

  const pathEnv = env.PATH ?? env.Path ?? env.path;
  const whichJava = Bun.which("java", pathEnv !== undefined ? { PATH: pathEnv } : undefined);
  if (whichJava) {
    return whichJava;
  }

  return "java";
}

/**
 * Detects Oracle GraalVM from the runtime's release file (GraalVM CE reports a different IMPLEMENTOR).
 * Mirror of tools/scripts/start.py is_oracle_graalvm.
 */
export function isOracleGraalvm(javaBin: string): boolean {
  const isBare = !javaBin.includes("/") && !javaBin.includes("\\");
  const resolved = isBare ? (Bun.which(javaBin) ?? javaBin) : javaBin;
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    return false;
  }

  const releasePath = path.join(path.dirname(path.dirname(real)), "release");
  try {
    const release = fs.readFileSync(releasePath, "utf-8");
    return release.includes("GRAALVM_VERSION=") && release.includes('IMPLEMENTOR="Oracle Corporation"');
  } catch {
    return false;
  }
}
