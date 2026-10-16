import { spawn } from "node:child_process";
import { RconClient, resolveRconConfig, type RconPasswordSource } from "./rcon";

export type ExecCommandFn = (
  cmd: string,
  args: string[]
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface ScheduledRestartOptions {
  targetDir?: string;
  serviceName?: string;
  countdownMinutes?: number;
  immediate?: boolean;
  rconHost?: string;
  rconPort?: number;
  rconPassword?: string;
  dryRun?: boolean;
  sleepFn?: (ms: number) => Promise<void>;
  rconClientFactory?: () => RconClient;
  execCommandFn?: ExecCommandFn;
}

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export const defaultExecCommand: ExecCommandFn = (cmd, args) => {
  return new Promise((resolve) => {
    try {
      const cp = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      cp.stdout?.on("data", (d) => {
        stdout += d.toString();
      });
      cp.stderr?.on("data", (d) => {
        stderr += d.toString();
      });
      cp.on("error", (err) => {
        resolve({ code: 1, stdout, stderr: err.message });
      });
      cp.on("close", (code) => {
        resolve({ code: code ?? 1, stdout, stderr });
      });
    } catch (err: any) {
      resolve({ code: 1, stdout: "", stderr: err.message });
    }
  });
};

export function formatRestartTimestamp(date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `[${year}-${month}-${day} ${hours}:${minutes}:${seconds} UTC]`;
}

const RCON_PASSWORD_SOURCE_LABELS: Record<RconPasswordSource, string> = {
  option: "password from --rcon-password",
  env: "password from RCON_PASSWORD",
  "minecraft-env": "password from .minecraft-env",
  "server.properties": "password from server.properties",
  default: "no password configured",
};

/** Formats an RCON or socket error as its message plus the error code when the message lacks it. */
export function describeRconError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as NodeJS.ErrnoException).code;
  const message = err.message || code || err.name;
  return code && !message.includes(code) ? `${message} (${code})` : message;
}

/**
 * Runs the scheduled or immediate Minecraft server restart sequence.
 * Connects to RCON to broadcast countdown warnings and trigger `save-all`,
 * then restarts the systemd service and verifies active status.
 */
export async function runScheduledRestart(
  options: ScheduledRestartOptions = {}
): Promise<number> {
  const targetDir = options.targetDir || process.cwd();
  const serviceName = options.serviceName || "lampas-server.service";
  const countdownMinutes = options.countdownMinutes !== undefined ? options.countdownMinutes : 5;
  const immediate = Boolean(options.immediate);
  const dryRun = Boolean(options.dryRun);
  const sleepFn = options.sleepFn || defaultSleep;
  const execCommandFn = options.execCommandFn || defaultExecCommand;

  const log = (msg: string) => {
    console.log(`${formatRestartTimestamp()} [ScheduledRestart] ${msg}`);
  };

  log("==================================================");
  if (immediate) {
    log(`Starting immediate restart sequence for ${serviceName}`);
  } else {
    log(`Starting scheduled daily restart countdown (${countdownMinutes} min) for ${serviceName}`);
  }
  log("==================================================");

  const rconConfig = resolveRconConfig({
    targetDir,
    host: options.rconHost,
    port: options.rconPort,
    password: options.rconPassword,
  });
  const rconAddress = `${rconConfig.host}:${rconConfig.port}`;

  log(`Server directory: ${targetDir}`);
  log(`RCON ${rconAddress}, ${RCON_PASSWORD_SOURCE_LABELS[rconConfig.passwordSource]}`);
  if (!rconConfig.serverPropertiesFound && rconConfig.passwordSource === "default") {
    log(
      `Warning: No server.properties in ${targetDir} and no RCON password from --rcon-password, ` +
        "RCON_PASSWORD or .minecraft-env; using an empty password. " +
        "Pass --target <server directory> if this is not the server directory."
    );
  }

  // Last RCON error, logged with each skipped broadcast or command. Never includes the password.
  let rconError = "not connected";
  let rcon: RconClient | null = null;
  try {
    const client = options.rconClientFactory ? options.rconClientFactory() : new RconClient();
    await client.connect(rconConfig.host, rconConfig.port, rconConfig.password || "", 5000);
    rcon = client;
  } catch (err) {
    rconError = describeRconError(err);
    log(`Notice: RCON connection to ${rconAddress} failed: ${rconError}`);
  }

  const broadcast = async (msg: string) => {
    log(`Broadcasting: ${msg}`);
    if (!rcon || !rcon.isConnected) {
      log(`Notice: RCON unavailable (${rconError}). Skipping broadcast.`);
      return;
    }
    try {
      await rcon.send(`say ${msg}`);
      log("Broadcast sent successfully.");
    } catch (err) {
      rconError = describeRconError(err);
      log(`Notice: RCON broadcast failed: ${rconError}`);
    }
  };

  const sendCommand = async (cmd: string) => {
    log(`Executing RCON command: ${cmd}`);
    if (!rcon || !rcon.isConnected) {
      log(`Notice: RCON unavailable (${rconError}). Skipping ${cmd}.`);
      return;
    }
    try {
      await rcon.send(cmd);
      log("RCON command executed successfully.");
    } catch (err) {
      rconError = describeRconError(err);
      log(`Notice: RCON command ${cmd} failed: ${rconError}`);
    }
  };

  // Countdown warning stages
  if (!immediate && countdownMinutes > 0) {
    let remaining = countdownMinutes;

    if (remaining > 5) {
      await broadcast(`[Scheduled Restart] Server will restart in ${remaining} minutes...`);
      await sleepFn((remaining - 5) * 60 * 1000);
      remaining = 5;
    }

    if (remaining === 5) {
      await broadcast("[Scheduled Restart] Server will restart in 5 minutes...");
      await sleepFn(120 * 1000);
      remaining = 3;
    } else if (remaining > 3) {
      await broadcast(`[Scheduled Restart] Server will restart in ${remaining} minutes...`);
      await sleepFn((remaining - 3) * 60 * 1000);
      remaining = 3;
    }

    if (remaining === 3) {
      await broadcast("[Scheduled Restart] Server will restart in 3 minutes.");
      await sleepFn(120 * 1000);
      remaining = 1;
    } else if (remaining > 1) {
      await broadcast(`[Scheduled Restart] Server will restart in ${remaining} minutes...`);
      await sleepFn((remaining - 1) * 60 * 1000);
      remaining = 1;
    }

    if (remaining === 1) {
      await broadcast("[Scheduled Restart] Server will restart in 1 minute. Please find a safe place to disconnect!");
      await sleepFn(60 * 1000);
      remaining = 0;
    }
  }

  // Final restart sequence
  log("Target time reached. Initiating restart sequence...");
  await broadcast("[Scheduled Restart] Server is restarting now...");
  await sendCommand("save-all");
  await sleepFn(3000);

  if (rcon) {
    try {
      rcon.close();
    } catch {}
    rcon = null;
  }

  // Systemd service restart
  if (dryRun) {
    log(`Dry run: skipping systemctl restart ${serviceName}`);
    log("==================================================");
    log("Scheduled restart procedure finished.");
    log("==================================================");
    return 0;
  }

  log(`Restarting ${serviceName}...`);
  await execCommandFn("systemctl", ["restart", serviceName]);
  await sleepFn(3000);

  const statusRes = await execCommandFn("systemctl", ["is-active", "--quiet", serviceName]);
  if (statusRes.code === 0) {
    log(`✓ ${serviceName} restart triggered successfully.`);
    log("==================================================");
    log("Scheduled restart procedure finished.");
    log("==================================================");
    return 0;
  } else {
    log(`✗ Error: ${serviceName} failed to restart!`);
    log("==================================================");
    log("Scheduled restart procedure finished.");
    log("==================================================");
    return 1;
  }
}
