import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "../src/cli";
import {
  decodeVarInt,
  encodeVarInt,
  createHandshakePacket,
  createStatusRequestPacket,
  pingMinecraft,
  type MinecraftStatus,
} from "../src/monitor/slp";
import {
  resolveWebhookUrl,
  sendDiscordWebhook,
  notifyServerOnline,
  notifyServerOffline,
  type FetchFn,
} from "../src/monitor/discord";
import {
  loadMonitorState,
  saveMonitorState,
  runMonitor,
} from "../src/monitor/monitor";

function startMockSlpServer(
  handler: (socket: net.Socket) => void
): Promise<{ server: net.Server; port: number; sockets: Set<net.Socket> }> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((sock) => {
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
      handler(sock);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port, sockets });
    });
    server.on("error", reject);
  });
}

function closeServer(server: net.Server, sockets?: Set<net.Socket>): Promise<void> {
  return new Promise((resolve) => {
    if (sockets) {
      for (const s of sockets) {
        s.destroy();
      }
      sockets.clear();
    }
    server.close(() => resolve());
  });
}

function createStandardSlpHandler(statusObj: object | string) {
  return (socket: net.Socket) => {
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        const hs = decodeVarInt(buf, 0);
        const reqOffset = hs.bytesRead + hs.value;
        if (buf.length > reqOffset) {
          const req = decodeVarInt(buf, reqOffset);
          if (buf.length >= reqOffset + req.bytesRead + req.value) {
            const jsonStr =
              typeof statusObj === "string" ? statusObj : JSON.stringify(statusObj);
            const jsonBytes = Buffer.from(jsonStr, "utf-8");
            const packetId = encodeVarInt(0);
            const jsonLen = encodeVarInt(jsonBytes.length);
            const payload = Buffer.concat([packetId, jsonLen, jsonBytes]);
            const packetLen = encodeVarInt(payload.length);
            socket.write(Buffer.concat([packetLen, payload]));
          }
        }
      } catch {
        // Wait for more data
      }
    });
  };
}

describe("Minecraft SLP VarInt encoding and decoding", () => {
  test("encodes and decodes standard VarInt values", () => {
    const testCases = [
      { val: 0, expected: [0x00] },
      { val: 1, expected: [0x01] },
      { val: 127, expected: [0x7f] },
      { val: 128, expected: [0x80, 0x01] },
      { val: 255, expected: [0xff, 0x01] },
      { val: 767, expected: [0xff, 0x05] },
      { val: 2147483647, expected: [0xff, 0xff, 0xff, 0xff, 0x07] },
      { val: -1, expected: [0xff, 0xff, 0xff, 0xff, 0x0f] },
    ];

    for (const { val, expected } of testCases) {
      const encoded = encodeVarInt(val);
      expect(Array.from(encoded)).toEqual(expected);

      const decoded = decodeVarInt(encoded);
      expect(decoded.value).toBe(val);
      expect(decoded.bytesRead).toBe(expected.length);
    }
  });

  test("decodes VarInt with offset", () => {
    const prefix = Buffer.from([0xaa, 0xbb]);
    const varint = encodeVarInt(767);
    const combined = Buffer.concat([prefix, varint]);

    const decoded = decodeVarInt(combined, 2);
    expect(decoded.value).toBe(767);
    expect(decoded.bytesRead).toBe(2);
  });

  test("throws error on buffer underflow or truncated VarInt", () => {
    expect(() => decodeVarInt(Buffer.alloc(0))).toThrow("Buffer underflow");
    expect(() => decodeVarInt(Buffer.from([0x80]))).toThrow("Buffer underflow");
  });

  test("throws error when VarInt exceeds 5 bytes", () => {
    const overlong = Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x01]);
    expect(() => decodeVarInt(overlong)).toThrow("VarInt is too wide");
  });

  test("builds handshake and status request packets correctly", () => {
    const hs = createHandshakePacket("play.lampas.town", 25576, 767);
    expect(hs.length).toBeGreaterThan(0);
    const hsLen = decodeVarInt(hs, 0);
    expect(hs.length).toBe(hsLen.bytesRead + hsLen.value);

    const req = createStatusRequestPacket();
    expect(Array.from(req)).toEqual([0x01, 0x00]);
  });
});

describe("Minecraft SLP client (pingMinecraft)", () => {
  test("successfully connects, performs handshake, and parses status JSON", async () => {
    const mockStatus: MinecraftStatus = {
      version: { name: "26.2 (Fabric)", protocol: 767 },
      players: { max: 300, online: 12, sample: [] },
      description: "Lampas 2 Dedicated Server",
    };

    const { server, port, sockets } = await startMockSlpServer(createStandardSlpHandler(mockStatus));

    try {
      const result = await pingMinecraft("127.0.0.1", port, 2000);
      expect(result.version?.name).toBe("26.2 (Fabric)");
      expect(result.version?.protocol).toBe(767);
      expect(result.players?.online).toBe(12);
      expect(result.players?.max).toBe(300);
      expect(result.description).toBe("Lampas 2 Dedicated Server");
    } finally {
      await closeServer(server, sockets);
    }
  });

  test("rejects when server times out without sending data", async () => {
    const { server, port, sockets } = await startMockSlpServer((_sock) => {
      // Don't respond, let timeout trigger
    });

    try {
      await expect(pingMinecraft("127.0.0.1", port, 150)).rejects.toThrow("Timeout after 150ms");
    } finally {
      await closeServer(server, sockets);
    }
  });

  test("rejects when server closes connection immediately", async () => {
    const { server, port, sockets } = await startMockSlpServer((sock) => {
      sock.destroy();
    });

    try {
      await expect(pingMinecraft("127.0.0.1", port, 2000)).rejects.toThrow();
    } finally {
      await closeServer(server, sockets);
    }
  });

  test("rejects when target port refuses connection", async () => {
    // Find an unused port by briefly binding and closing
    const tempServer = net.createServer();
    const port = await new Promise<number>((resolve) => {
      tempServer.listen(0, "127.0.0.1", () => {
        const p = (tempServer.address() as net.AddressInfo).port;
        tempServer.close(() => resolve(p));
      });
    });

    await expect(pingMinecraft("127.0.0.1", port, 1000)).rejects.toThrow();
  });

  test("rejects when server returns invalid JSON", async () => {
    const { server, port, sockets } = await startMockSlpServer(createStandardSlpHandler("{ malformed json ..."));

    try {
      await expect(pingMinecraft("127.0.0.1", port, 2000)).rejects.toThrow();
    } finally {
      await closeServer(server, sockets);
    }
  });
});

describe("Discord webhook integration", () => {
  test("resolves webhook URL with appropriate precedence", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-webhook-test-"));
    const envFile = path.join(tempDir, ".minecraft-env");
    fs.writeFileSync(envFile, 'DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/from-env-file"\n');

    try {
      // 1. Explicit override wins
      expect(
        resolveWebhookUrl("https://override.url", { DISCORD_WEBHOOK_URL: "https://from.env" }, tempDir)
      ).toBe("https://override.url");

      // 2. Environment variable wins over targetDir
      expect(
        resolveWebhookUrl(undefined, { DISCORD_WEBHOOK_URL: "https://from.env" }, tempDir)
      ).toBe("https://from.env");

      // 3. targetDir/.minecraft-env wins when no env variable
      expect(
        resolveWebhookUrl(undefined, {}, tempDir)
      ).toBe("https://discord.com/api/webhooks/from-env-file");

      // 4. Returns empty string if nothing configured
      expect(resolveWebhookUrl(undefined, {}, "/nonexistent/path")).toBe("");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("sendDiscordWebhook sends POST request and handles HTTP responses", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedHeaders: any = {};
    let capturedBody: any = null;

    const mockFetch: FetchFn = async (url, init) => {
      capturedUrl = url.toString();
      capturedMethod = init?.method || "";
      capturedHeaders = init?.headers;
      capturedBody = JSON.parse(init?.body as string);
      return new Response("", { status: 204 });
    };

    const payload = { content: "test message" };
    const success = await sendDiscordWebhook("https://discord.com/api/webhooks/123", payload, mockFetch);

    expect(success).toBe(true);
    expect(capturedUrl).toBe("https://discord.com/api/webhooks/123");
    expect(capturedMethod).toBe("POST");
    expect(capturedHeaders["Content-Type"]).toBe("application/json");
    expect(capturedHeaders["User-Agent"]).toBe("LampasStatusMonitor/1.0");
    expect(capturedBody).toEqual(payload);

    // Empty URL returns false
    const emptySuccess = await sendDiscordWebhook("", payload, mockFetch);
    expect(emptySuccess).toBe(false);

    // Error status returns false
    const errorFetch: FetchFn = async () => new Response("Error", { status: 500 });
    const failSuccess = await sendDiscordWebhook("https://discord.com/api/webhooks/123", payload, errorFetch);
    expect(failSuccess).toBe(false);
  });

  test("notifyServerOnline constructs correct embed payload", async () => {
    let dispatchedPayload: any = null;
    const mockFetch: FetchFn = async (_url, init) => {
      dispatchedPayload = JSON.parse(init?.body as string);
      return new Response("", { status: 200 });
    };

    const status: MinecraftStatus = {
      version: { name: "26.2 (Fabric)", protocol: 767 },
      players: { online: 5, max: 200 },
    };

    const res = await notifyServerOnline({
      webhookUrl: "https://discord.com/webhook",
      info: status,
      publicAddress: "play.lampas.town:25576",
      fetchFn: mockFetch,
    });

    expect(res).toBe(true);
    expect(dispatchedPayload.username).toBe("Lampas Status");
    expect(dispatchedPayload.embeds).toHaveLength(1);
    const embed = dispatchedPayload.embeds[0];
    expect(embed.title).toBe("🟢 Lampas 2 Server is Online");
    expect(embed.color).toBe(3066993); // Green (#2ecc71)
    expect(embed.fields).toEqual([
      { name: "Server Address", value: "`play.lampas.town:25576`", inline: true },
      { name: "Version", value: "26.2 (Fabric)", inline: true },
      { name: "Players Online", value: "5 / 200", inline: true },
    ]);
    expect(embed.footer.text).toBe("play.lampas.town • System Health Monitor");
    expect(embed.timestamp).toBeDefined();
  });

  test("notifyServerOffline constructs correct embed payload", async () => {
    let dispatchedPayload: any = null;
    const mockFetch: FetchFn = async (_url, init) => {
      dispatchedPayload = JSON.parse(init?.body as string);
      return new Response("", { status: 200 });
    };

    const res = await notifyServerOffline({
      webhookUrl: "https://discord.com/webhook",
      publicAddress: "play.lampas.town:25576",
      downtimeEpoch: 1728645600,
      fetchFn: mockFetch,
    });

    expect(res).toBe(true);
    expect(dispatchedPayload.username).toBe("Lampas Status");
    expect(dispatchedPayload.embeds).toHaveLength(1);
    const embed = dispatchedPayload.embeds[0];
    expect(embed.title).toBe("🔴 Lampas 2 Server is Offline");
    expect(embed.color).toBe(15158332); // Red (#e74c3c)
    expect(embed.fields).toEqual([
      { name: "Server Address", value: "`play.lampas.town:25576`", inline: true },
      { name: "Status", value: "Offline / Unreachable", inline: true },
      { name: "Downtime Started", value: "<t:1728645600:R>", inline: true },
    ]);
    expect(embed.footer.text).toBe("play.lampas.town • System Health Monitor");
  });
});

describe("Monitor state persistence", () => {
  test("loads UNKNOWN state when file does not exist", () => {
    const nonExistent = path.join(os.tmpdir(), "nonexistent-monitor-state.json");
    const state = loadMonitorState(nonExistent);
    expect(state.status).toBe("UNKNOWN");
    expect(state.last_changed).toBe(0);
  });

  test("saves and reloads state cleanly", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-state-test-"));
    const stateFile = path.join(tempDir, "state.json");

    try {
      saveMonitorState(stateFile, { status: "ONLINE", last_changed: 1234567 });
      const loaded = loadMonitorState(stateFile);
      expect(loaded.status).toBe("ONLINE");
      expect(loaded.last_changed).toBe(1234567);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("runMonitor logic & debouncing transitions", () => {
  test("--once mode returns 0 when ping succeeds", async () => {
    const mockPing = async () => ({
      version: { name: "26.2" },
      players: { online: 3, max: 100 },
    });

    const exitCode = await runMonitor({
      once: true,
      pingFn: mockPing,
    });

    expect(exitCode).toBe(0);
  });

  test("--once mode returns 1 when ping fails", async () => {
    const mockPing = async () => {
      throw new Error("Connection refused");
    };

    const exitCode = await runMonitor({
      once: true,
      pingFn: mockPing,
    });

    expect(exitCode).toBe(1);
  });

  test("debounces transition to OFFLINE until threshold is reached, then recovers to ONLINE", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-debounce-test-"));
    const stateFile = path.join(tempDir, "state.json");

    const sentWebhooks: string[] = [];
    const mockFetch: FetchFn = async (_url, init) => {
      const payload = JSON.parse(init?.body as string);
      const title = payload.embeds?.[0]?.title;
      sentWebhooks.push(title);
      return new Response("", { status: 200 });
    };

    // Ping sequence:
    // 1: Online (transitions UNKNOWN -> ONLINE, notification 1)
    // 2: Online (already ONLINE, no notification)
    // 3: Failure 1 (consecutiveFailures=1 < threshold 2, debounced, no offline notification)
    // 4: Failure 2 (consecutiveFailures=2 >= threshold 2, transitions -> OFFLINE, notification 2)
    // 5: Failure 3 (already OFFLINE, no duplicate notification)
    // 6: Online (transitions OFFLINE -> ONLINE, notification 3)
    let callIndex = 0;
    const mockPing = async () => {
      callIndex++;
      if (callIndex === 1 || callIndex === 2 || callIndex === 6) {
        return {
          version: { name: "26.2" },
          players: { online: 1, max: 200 },
        };
      }
      throw new Error("Server down");
    };

    try {
      const exitCode = await runMonitor({
        stateFile,
        webhookUrl: "https://discord.com/webhook",
        intervalSec: 0.01,
        failureThreshold: 2,
        pingFn: mockPing,
        fetchFn: mockFetch,
        maxIterations: 6,
      });

      expect(exitCode).toBe(0);
      expect(sentWebhooks).toEqual([
        "🟢 Lampas 2 Server is Online",
        "🔴 Lampas 2 Server is Offline",
        "🟢 Lampas 2 Server is Online",
      ]);

      const finalState = loadMonitorState(stateFile);
      expect(finalState.status).toBe("ONLINE");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("CLI argument parsing for monitor command", () => {
  test("parses monitor flags accurately", () => {
    const parsed = parseArgs([
      "monitor",
      "-p",
      "25576",
      "--host",
      "mc.lampas.town",
      "--public-address",
      "play.lampas.town:25576",
      "--webhook",
      "https://discord.com/webhook",
      "--interval",
      "15",
      "--threshold",
      "3",
      "--once",
    ]);

    expect(parsed.command).toBe("monitor");
    expect(parsed.flags.port).toBe("25576");
    expect(parsed.flags.host).toBe("mc.lampas.town");
    expect(parsed.flags["public-address"]).toBe("play.lampas.town:25576");
    expect(parsed.flags.webhook).toBe("https://discord.com/webhook");
    expect(parsed.flags.interval).toBe("15");
    expect(parsed.flags.threshold).toBe("3");
    expect(parsed.flags.once).toBe("true");
  });
});
