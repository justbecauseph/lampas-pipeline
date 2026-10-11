import * as fs from "node:fs";
import * as path from "node:path";
import type { MinecraftStatus } from "./slp";

export type FetchFn = (input: any, init?: any) => Promise<Response>;

export interface NotifyOnlineOptions {
  webhookUrl: string;
  info: MinecraftStatus;
  publicAddress?: string;
  fetchFn?: FetchFn;
}

export interface NotifyOfflineOptions {
  webhookUrl: string;
  publicAddress?: string;
  downtimeEpoch?: number;
  fetchFn?: FetchFn;
}

function extractWebhookFromEnvFile(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    for (const rawLine of content.split(/\r?\n/)) {
      let line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      if (line.startsWith("export ")) {
        line = line.slice(7).trim();
      }
      if (line.startsWith("DISCORD_WEBHOOK_URL=")) {
        let val = line.slice("DISCORD_WEBHOOK_URL=".length).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        return val.trim();
      }
    }
  } catch {
    // Ignore read errors
  }
  return undefined;
}

/**
 * Resolves DISCORD_WEBHOOK_URL checking:
 * 1. Explicit override URL
 * 2. Environment variable DISCORD_WEBHOOK_URL
 * 3. <targetDir>/.minecraft-env
 * 4. /home/server/.minecraft-env
 */
export function resolveWebhookUrl(
  overrideUrl?: string,
  env?: Record<string, string | undefined>,
  targetDir?: string
): string {
  if (overrideUrl && overrideUrl.trim()) {
    return overrideUrl.trim();
  }

  const envVars = env ?? (typeof process !== "undefined" ? process.env : {});
  const fromEnv = envVars.DISCORD_WEBHOOK_URL;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.trim();
  }

  if (targetDir) {
    const fromTarget = extractWebhookFromEnvFile(path.join(targetDir, ".minecraft-env"));
    if (fromTarget) {
      return fromTarget;
    }
  }

  const fromHomeServer = extractWebhookFromEnvFile("/home/server/.minecraft-env");
  if (fromHomeServer) {
    return fromHomeServer;
  }

  return "";
}

/**
 * Dispatches payload to configured Discord webhook endpoint.
 */
export async function sendDiscordWebhook(
  webhookUrl: string,
  payload: any,
  fetchFn: FetchFn = fetch
): Promise<boolean> {
  const url = webhookUrl ? webhookUrl.trim() : "";
  if (!url) {
    console.error("[Monitor Error] No webhook URL configured.");
    return false;
  }

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "LampasStatusMonitor/1.0",
      },
      body: JSON.stringify(payload),
    });

    if (res.status === 200 || res.status === 204) {
      return true;
    }
    console.error(`[Monitor Error] Discord webhook returned HTTP ${res.status}`);
    return false;
  } catch (err: any) {
    console.error(`[Monitor Error] Failed to send Discord webhook: ${err.message}`);
    return false;
  }
}

/**
 * Sends green online alert embed to Discord.
 */
export async function notifyServerOnline(options: NotifyOnlineOptions): Promise<boolean> {
  const { webhookUrl, info, fetchFn } = options;
  const publicAddress = options.publicAddress || "play.lampas.town:25576";
  const nowIso = new Date().toISOString();
  const players = info.players || {};
  const versionInfo = info.version || {};
  const verName = versionInfo.name || "26.2 (Fabric)";
  const onlinePlayers = players.online ?? 0;
  const maxPlayers = players.max ?? 300;

  const payload = {
    username: "Lampas Status",
    embeds: [
      {
        title: "🟢 Lampas 2 Server is Online",
        description: "The Minecraft server has initialized and is accepting player connections.",
        color: 3066993, // Green (#2ecc71)
        fields: [
          { name: "Server Address", value: `\`${publicAddress}\``, inline: true },
          { name: "Version", value: verName, inline: true },
          { name: "Players Online", value: `${onlinePlayers} / ${maxPlayers}`, inline: true },
        ],
        timestamp: nowIso,
        footer: { text: "play.lampas.town • System Health Monitor" },
      },
    ],
  };

  return sendDiscordWebhook(webhookUrl, payload, fetchFn);
}

/**
 * Sends red offline alert embed to Discord.
 */
export async function notifyServerOffline(options: NotifyOfflineOptions): Promise<boolean> {
  const { webhookUrl, fetchFn } = options;
  const publicAddress = options.publicAddress || "play.lampas.town:25576";
  const nowIso = new Date().toISOString();
  const downtimeEpoch = options.downtimeEpoch ?? Math.floor(Date.now() / 1000);

  const payload = {
    username: "Lampas Status",
    embeds: [
      {
        title: "🔴 Lampas 2 Server is Offline",
        description: "The Minecraft server is currently stopped or unreachable. Player connections are unavailable.",
        color: 15158332, // Red (#e74c3c)
        fields: [
          { name: "Server Address", value: `\`${publicAddress}\``, inline: true },
          { name: "Status", value: "Offline / Unreachable", inline: true },
          { name: "Downtime Started", value: `<t:${downtimeEpoch}:R>`, inline: true },
        ],
        timestamp: nowIso,
        footer: { text: "play.lampas.town • System Health Monitor" },
      },
    ],
  };

  return sendDiscordWebhook(webhookUrl, payload, fetchFn);
}
