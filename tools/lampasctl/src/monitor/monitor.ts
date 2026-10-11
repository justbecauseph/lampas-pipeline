import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { notifyServerOffline, notifyServerOnline, resolveWebhookUrl, type FetchFn } from "./discord";
import { pingMinecraft, type MinecraftStatus } from "./slp";

export interface MonitorState {
  status: "ONLINE" | "OFFLINE" | "UNKNOWN";
  last_changed: number;
}

export interface MonitorOptions {
  host?: string;
  port?: number;
  publicAddress?: string;
  webhookUrl?: string;
  stateFile?: string;
  intervalSec?: number;
  failureThreshold?: number;
  once?: boolean;
  targetDir?: string;
  pingTimeoutMs?: number;
  pingFn?: (host: string, port: number, timeoutMs?: number) => Promise<MinecraftStatus>;
  fetchFn?: FetchFn;
  signal?: AbortSignal;
  maxIterations?: number;
}

export function loadMonitorState(stateFile: string): MonitorState {
  if (fs.existsSync(stateFile)) {
    try {
      const raw = fs.readFileSync(stateFile, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.status === "string") {
        return {
          status: parsed.status,
          last_changed: parsed.last_changed ?? 0,
        };
      }
    } catch {
      // Fallback on read or JSON parse failure
    }
  }
  return { status: "UNKNOWN", last_changed: 0 };
}

export function saveMonitorState(stateFile: string, state: MonitorState): void {
  try {
    fs.mkdirSync(path.dirname(path.resolve(stateFile)), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8");
  } catch (err: any) {
    console.error(`[Monitor Warning] Could not save state: ${err.message}`);
  }
}

function formatLogTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs the Minecraft status monitor in either one-shot probe mode or persistent daemon mode.
 */
export async function runMonitor(options: MonitorOptions = {}): Promise<number> {
  const host = options.host || process.env.MC_HOST || "127.0.0.1";
  const port = options.port ?? (process.env.MC_PORT ? parseInt(process.env.MC_PORT, 10) : 25576);
  const publicAddress = options.publicAddress || process.env.MC_PUBLIC_ADDRESS || "play.lampas.town:25576";
  const webhookUrl = resolveWebhookUrl(options.webhookUrl, process.env, options.targetDir);
  const stateFile =
    options.stateFile ||
    process.env.MONITOR_STATE_FILE ||
    path.join(os.homedir(), ".lampas-monitor-state.json");
  const intervalSec = options.intervalSec ?? 10;
  const failureThreshold = options.failureThreshold ?? 2;
  const once = options.once ?? false;
  const pingTimeoutMs = options.pingTimeoutMs ?? 4000;
  const pingFn = options.pingFn ?? pingMinecraft;
  const fetchFn = options.fetchFn ?? fetch;

  if (once) {
    try {
      const status = await pingFn(host, port, pingTimeoutMs);
      const ver = status.version?.name || "unknown";
      const online = status.players?.online ?? 0;
      const max = status.players?.max ?? 0;
      console.log(`[Monitor] Server at ${host}:${port} is ONLINE (${ver}, ${online}/${max} players)`);
      return 0;
    } catch (err: any) {
      console.error(`[Monitor] Server at ${host}:${port} is OFFLINE: ${err.message}`);
      return 1;
    }
  }

  console.log(`[Monitor] Starting Lampas Minecraft Server Discord Monitor...`);
  console.log(`[Monitor] Polling target: ${host}:${port} every ${intervalSec}s (Threshold: ${failureThreshold})`);
  console.log(`[Monitor] Public address advertised: ${publicAddress}`);

  const state = loadMonitorState(stateFile);
  let consecutiveFailures = 0;
  let currentStatus = state.status;

  const controller = new AbortController();
  const activeSignal = options.signal || controller.signal;

  let cleanupSignals: (() => void) | undefined;
  if (!options.signal && typeof process !== "undefined" && process.on) {
    const onSig = () => {
      controller.abort();
    };
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);
    cleanupSignals = () => {
      process.removeListener("SIGINT", onSig);
      process.removeListener("SIGTERM", onSig);
    };
  }

  let iterationsRemaining = options.maxIterations;

  try {
    while (!activeSignal.aborted) {
      try {
        const statusInfo = await pingFn(host, port, pingTimeoutMs);
        consecutiveFailures = 0;

        if (currentStatus !== "ONLINE") {
          console.log(`[${formatLogTimestamp()}] Server transitioned from ${currentStatus} -> ONLINE`);
          await notifyServerOnline({ webhookUrl, info: statusInfo, publicAddress, fetchFn });
          currentStatus = "ONLINE";
          state.status = "ONLINE";
          state.last_changed = Math.floor(Date.now() / 1000);
          saveMonitorState(stateFile, state);
        }
      } catch (err: any) {
        consecutiveFailures++;
        if (currentStatus === "ONLINE") {
          console.log(
            `[${formatLogTimestamp()}] Server ping failed (${consecutiveFailures}/${failureThreshold}): ${err.message}`
          );
        }

        if (consecutiveFailures >= failureThreshold && currentStatus !== "OFFLINE") {
          console.log(`[${formatLogTimestamp()}] Failure threshold reached. Transitioning -> OFFLINE`);
          await notifyServerOffline({
            webhookUrl,
            publicAddress,
            downtimeEpoch: Math.floor(Date.now() / 1000),
            fetchFn,
          });
          currentStatus = "OFFLINE";
          state.status = "OFFLINE";
          state.last_changed = Math.floor(Date.now() / 1000);
          saveMonitorState(stateFile, state);
        }
      }

      if (iterationsRemaining !== undefined) {
        iterationsRemaining--;
        if (iterationsRemaining <= 0) {
          break;
        }
      }

      if (activeSignal.aborted) {
        break;
      }

      await sleep(intervalSec * 1000, activeSignal);
    }
  } finally {
    cleanupSignals?.();
  }

  return 0;
}
