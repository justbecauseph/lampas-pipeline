import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "../src/cli";
import {
  createRconPacket,
  parseRconPacket,
  resolveRconConfig,
  RconClient,
} from "../src/restart/rcon";
import {
  runScheduledRestart,
  formatRestartTimestamp,
  type ExecCommandFn,
} from "../src/restart/restart";

interface MockRconServer {
  server: net.Server;
  port: number;
  sockets: Set<net.Socket>;
  commands: string[];
  close: () => Promise<void>;
}

function startMockRconServer(options: {
  password?: string;
  multiPacketAuth?: boolean;
  onCommand?: (cmd: string) => string;
} = {}): Promise<MockRconServer> {
  const expectedPassword = options.password ?? "correct-password";
  const commands: string[] = [];
  const sockets = new Set<net.Socket>();

  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));

      let authed = false;
      let rxBuf = Buffer.alloc(0);

      socket.on("data", (chunk) => {
        rxBuf = Buffer.concat([rxBuf, chunk]);
        while (rxBuf.length >= 4) {
          const len = rxBuf.readInt32LE(0);
          const total = len + 4;
          if (rxBuf.length < total) break;
          const packetData = rxBuf.subarray(0, total);
          rxBuf = rxBuf.subarray(total);
          const packet = parseRconPacket(packetData);
          if (!packet) continue;

          if (packet.type === 3) { // SERVERDATA_AUTH
            if (packet.payload === expectedPassword) {
              authed = true;
              if (options.multiPacketAuth) {
                // Some servers emit empty type 0 before type 2 auth response
                socket.write(createRconPacket(packet.reqId, 0, ""));
              }
              socket.write(createRconPacket(packet.reqId, 2, ""));
            } else {
              // Auth failed: server sends reqId = -1
              socket.write(createRconPacket(-1, 2, ""));
            }
          } else if (packet.type === 2) { // SERVERDATA_EXECCOMMAND
            if (!authed) {
              socket.destroy();
              return;
            }
            commands.push(packet.payload);
            const resp = options.onCommand ? options.onCommand(packet.payload) : "";
            socket.write(createRconPacket(packet.reqId, 0, resp));
          }
        }
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        server,
        port: addr.port,
        sockets,
        commands,
        close: () =>
          new Promise<void>((res) => {
            for (const s of sockets) s.destroy();
            sockets.clear();
            server.close(() => res());
          }),
      });
    });

    server.on("error", reject);
  });
}

class FakeRconClient extends RconClient {
  private connected = false;

  constructor(private readonly failures: { connect?: Error; send?: Error } = {}) {
    super();
  }

  override get isConnected(): boolean {
    return this.connected;
  }

  override async connect(): Promise<void> {
    if (this.failures.connect) throw this.failures.connect;
    this.connected = true;
  }

  override async send(): Promise<string> {
    if (this.failures.send) throw this.failures.send;
    return "";
  }

  override close(): void {
    this.connected = false;
  }
}

const activeServiceExec: ExecCommandFn = async () => ({ code: 0, stdout: "active\n", stderr: "" });

async function captureRestartLog(run: () => Promise<number>): Promise<{ exitCode: number; lines: string[] }> {
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  try {
    const exitCode = await run();
    return { exitCode, lines: logSpy.mock.calls.map((args) => args.join(" ")) };
  } finally {
    logSpy.mockRestore();
  }
}

describe("RCON packet protocol (rcon.ts)", () => {
  test("encodes and parses RCON packet roundtrip", () => {
    const reqId = 1234;
    const type = 2; // SERVERDATA_EXECCOMMAND
    const payload = "say Hello World";

    const encoded = createRconPacket(reqId, type, payload);
    expect(encoded.length).toBe(4 + payload.length + 10);

    const parsed = parseRconPacket(encoded);
    expect(parsed).not.toBeNull();
    expect(parsed!.reqId).toBe(reqId);
    expect(parsed!.type).toBe(type);
    expect(parsed!.payload).toBe(payload);
    expect(parsed!.length).toBe(payload.length + 10);
  });

  test("handles empty payload packet with min length (14 bytes on wire)", () => {
    const encoded = createRconPacket(1, 0, "");
    expect(encoded.length).toBe(14);
    expect(encoded.readInt32LE(0)).toBe(10); // length field = 10
    expect(encoded.readInt32LE(4)).toBe(1);  // reqId
    expect(encoded.readInt32LE(8)).toBe(0);  // type
    expect(encoded[12]).toBe(0);             // null terminator
    expect(encoded[13]).toBe(0);             // null pad

    const parsed = parseRconPacket(encoded);
    expect(parsed).not.toBeNull();
    expect(parsed!.payload).toBe("");
    expect(parsed!.length).toBe(10);
  });

  test("handles UTF-8 multi-byte payload strings correctly", () => {
    const unicodeStr = "§6Lampas Server: 🚀 Reiniciando servidor...";
    const encoded = createRconPacket(42, 2, unicodeStr);
    const parsed = parseRconPacket(encoded);

    expect(parsed).not.toBeNull();
    expect(parsed!.payload).toBe(unicodeStr);
    expect(parsed!.reqId).toBe(42);
    expect(parsed!.type).toBe(2);
  });

  test("returns null when buffer length is less than 4 bytes", () => {
    expect(parseRconPacket(Buffer.alloc(0))).toBeNull();
    expect(parseRconPacket(Buffer.alloc(3))).toBeNull();
  });

  test("returns null when length field is less than minimum 10", () => {
    const buf = Buffer.alloc(14);
    buf.writeInt32LE(9, 0); // Invalid length < 10
    expect(parseRconPacket(buf)).toBeNull();
  });

  test("returns null when buffer has fewer bytes than declared length + 4", () => {
    const buf = Buffer.alloc(10);
    buf.writeInt32LE(20, 0); // Declares length 20, but buf is only 10 bytes
    expect(parseRconPacket(buf)).toBeNull();
  });

  test("extracts payload even when trailing buffer has subsequent packet data", () => {
    const packet1 = createRconPacket(1, 2, "cmd1");
    const packet2 = createRconPacket(2, 2, "cmd2");
    const combined = Buffer.concat([packet1, packet2]);

    const parsed = parseRconPacket(combined);
    expect(parsed).not.toBeNull();
    expect(parsed!.reqId).toBe(1);
    expect(parsed!.payload).toBe("cmd1");
  });
});

describe("RconClient network exchange", () => {
  test("authenticates and executes command successfully", async () => {
    const mock = await startMockRconServer({
      password: "my-test-password",
      onCommand: (cmd) => `Executed: ${cmd}`,
    });

    try {
      const client = new RconClient();
      expect(client.isConnected).toBe(false);

      await client.connect("127.0.0.1", mock.port, "my-test-password");
      expect(client.isConnected).toBe(true);

      const res = await client.send("save-all");
      expect(res).toBe("Executed: save-all");
      expect(mock.commands).toEqual(["save-all"]);

      client.close();
      expect(client.isConnected).toBe(false);
    } finally {
      await mock.close();
    }
  });

  test("handles multi-packet auth where server sends empty type 0 before type 2", async () => {
    const mock = await startMockRconServer({
      password: "pass",
      multiPacketAuth: true,
      onCommand: () => "OK",
    });

    try {
      const client = new RconClient();
      await client.connect("127.0.0.1", mock.port, "pass");
      expect(client.isConnected).toBe(true);

      const res = await client.send("list");
      expect(res).toBe("OK");
      client.close();
    } finally {
      await mock.close();
    }
  });

  test("rejects authentication when server responds with reqId = -1", async () => {
    const mock = await startMockRconServer({
      password: "secret-password",
    });

    try {
      const client = new RconClient();
      let rejected = false;
      try {
        await client.connect("127.0.0.1", mock.port, "wrong-password");
      } catch (err: any) {
        rejected = true;
        expect(err.message).toContain("invalid password");
      }
      expect(rejected).toBe(true);
      expect(client.isConnected).toBe(false);
    } finally {
      await mock.close();
    }
  });

  test("rejects connection if host/port is unreachable", async () => {
    const client = new RconClient();
    let rejected = false;
    try {
      // Connect to unused local port with short timeout
      await client.connect("127.0.0.1", 1, "test", 500);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(client.isConnected).toBe(false);
  });

  test("rejects send() if client is not connected", async () => {
    const client = new RconClient();
    let rejected = false;
    try {
      await client.send("test");
    } catch (err: any) {
      rejected = true;
      expect(err.message).toContain("not connected or authenticated");
    }
    expect(rejected).toBe(true);
  });

  test("handles socket disconnection while command is pending", async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      let rxBuf = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        rxBuf = Buffer.concat([rxBuf, chunk]);
        while (rxBuf.length >= 4) {
          const len = rxBuf.readInt32LE(0);
          if (rxBuf.length < len + 4) break;
          const packet = parseRconPacket(rxBuf.subarray(0, len + 4));
          rxBuf = rxBuf.subarray(len + 4);
          if (packet?.type === 3) {
            socket.write(createRconPacket(packet.reqId, 2, ""));
          } else if (packet?.type === 2) {
            // Abruptly destroy socket before responding
            socket.destroy();
          }
        }
      });
    });

    await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const client = new RconClient();
      await client.connect("127.0.0.1", port, "pwd");

      let sendFailed = false;
      try {
        await client.send("abrupt-command");
      } catch {
        sendFailed = true;
      }
      expect(sendFailed).toBe(true);
      client.close();
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});

describe("resolveRconConfig", () => {
  const origEnv = { ...process.env };

  test("uses explicit options if provided", () => {
    const config = resolveRconConfig({
      host: "custom.host",
      port: 25580,
      password: "custom-pass",
    });
    expect(config.host).toBe("custom.host");
    expect(config.port).toBe(25580);
    expect(config.password).toBe("custom-pass");
    expect(config.passwordSource).toBe("option");
  });

  test("falls back to process.env variables", () => {
    process.env.RCON_HOST = "env.host";
    process.env.RCON_PORT = "25585";
    process.env.RCON_PASSWORD = "env-pass";
    try {
      const config = resolveRconConfig();
      expect(config.host).toBe("env.host");
      expect(config.port).toBe(25585);
      expect(config.password).toBe("env-pass");
      expect(config.passwordSource).toBe("env");
    } finally {
      process.env = { ...origEnv };
    }
  });

  test("falls back to .minecraft-env in targetDir", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-test-rcon-env-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, ".minecraft-env"),
        "export RCON_HOST=target-host\nRCON_PORT=25590\nRCON_PASSWORD=target-pwd\n"
      );
      delete process.env.RCON_HOST;
      delete process.env.RCON_PORT;
      delete process.env.RCON_PASSWORD;

      const config = resolveRconConfig({ targetDir: tmpDir });
      expect(config.host).toBe("target-host");
      expect(config.port).toBe(25590);
      expect(config.password).toBe("target-pwd");
      expect(config.passwordSource).toBe("minecraft-env");
      expect(config.serverPropertiesFound).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      process.env = { ...origEnv };
    }
  });

  test("falls back to server.properties in targetDir", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-test-rcon-props-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "server.properties"),
        "rcon.port=25599\nrcon.password=props-secret\nenable-rcon=true\n"
      );
      delete process.env.RCON_HOST;
      delete process.env.RCON_PORT;
      delete process.env.RCON_PASSWORD;

      const config = resolveRconConfig({ targetDir: tmpDir });
      expect(config.host).toBe("127.0.0.1");
      expect(config.port).toBe(25599);
      expect(config.password).toBe("props-secret");
      expect(config.passwordSource).toBe("server.properties");
      expect(config.serverPropertiesFound).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      process.env = { ...origEnv };
    }
  });

  test("falls back to defaults (127.0.0.1, 25575, empty password)", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-test-rcon-empty-"));
    try {
      delete process.env.RCON_HOST;
      delete process.env.RCON_PORT;
      delete process.env.RCON_PASSWORD;

      const config = resolveRconConfig({ targetDir: emptyDir });
      expect(config.host).toBe("127.0.0.1");
      expect(config.port).toBe(25575);
      expect(config.password).toBe("");
      expect(config.passwordSource).toBe("default");
      expect(config.serverPropertiesFound).toBe(false);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
      process.env = { ...origEnv };
    }
  });
});

describe("runScheduledRestart sequencer", () => {
  test("--immediate executes final sequence without countdown and succeeds", async () => {
    const mock = await startMockRconServer({ password: "pass" });
    const executedCmds: Array<{ cmd: string; args: string[] }> = [];

    const mockExec: ExecCommandFn = async (cmd, args) => {
      executedCmds.push({ cmd, args });
      return { code: 0, stdout: "active\n", stderr: "" };
    };

    try {
      const exitCode = await runScheduledRestart({
        serviceName: "lampas-server.service",
        immediate: true,
        rconHost: "127.0.0.1",
        rconPort: mock.port,
        rconPassword: "pass",
        sleepFn: async () => {},
        execCommandFn: mockExec,
      });

      expect(exitCode).toBe(0);
      expect(mock.commands).toEqual([
        "say [Scheduled Restart] Server is restarting now...",
        "save-all",
      ]);
      expect(executedCmds).toEqual([
        { cmd: "systemctl", args: ["restart", "lampas-server.service"] },
        { cmd: "systemctl", args: ["is-active", "--quiet", "lampas-server.service"] },
      ]);
    } finally {
      await mock.close();
    }
  });

  test("--dry-run performs RCON notices but skips systemctl restart", async () => {
    const mock = await startMockRconServer({ password: "pass" });
    let execCalled = false;
    const mockExec: ExecCommandFn = async () => {
      execCalled = true;
      return { code: 0, stdout: "", stderr: "" };
    };

    try {
      const exitCode = await runScheduledRestart({
        serviceName: "test-server.service",
        immediate: true,
        dryRun: true,
        rconHost: "127.0.0.1",
        rconPort: mock.port,
        rconPassword: "pass",
        sleepFn: async () => {},
        execCommandFn: mockExec,
      });

      expect(exitCode).toBe(0);
      expect(execCalled).toBe(false);
      expect(mock.commands).toEqual([
        "say [Scheduled Restart] Server is restarting now...",
        "save-all",
      ]);
    } finally {
      await mock.close();
    }
  });

  test("countdown broadcast stages execute with expected sleep delays and messages", async () => {
    const mock = await startMockRconServer({ password: "pass" });
    const recordedDelays: number[] = [];

    const mockExec: ExecCommandFn = async () => ({
      code: 0,
      stdout: "active\n",
      stderr: "",
    });

    try {
      const exitCode = await runScheduledRestart({
        serviceName: "lampas-server.service",
        countdownMinutes: 5,
        rconHost: "127.0.0.1",
        rconPort: mock.port,
        rconPassword: "pass",
        sleepFn: async (ms) => {
          recordedDelays.push(ms);
        },
        execCommandFn: mockExec,
      });

      expect(exitCode).toBe(0);
      // Delays: 120s (from 5m to 3m), 120s (from 3m to 1m), 60s (from 1m to 0m), 3s (after save-all), 3s (after systemctl restart)
      expect(recordedDelays).toEqual([120000, 120000, 60000, 3000, 3000]);

      expect(mock.commands).toEqual([
        "say [Scheduled Restart] Server will restart in 5 minutes...",
        "say [Scheduled Restart] Server will restart in 3 minutes.",
        "say [Scheduled Restart] Server will restart in 1 minute. Please find a safe place to disconnect!",
        "say [Scheduled Restart] Server is restarting now...",
        "save-all",
      ]);
    } finally {
      await mock.close();
    }
  });

  test("countdown stages with countdownMinutes = 3 skips 5-min warning", async () => {
    const mock = await startMockRconServer({ password: "pass" });
    const recordedDelays: number[] = [];

    try {
      const exitCode = await runScheduledRestart({
        countdownMinutes: 3,
        rconHost: "127.0.0.1",
        rconPort: mock.port,
        rconPassword: "pass",
        dryRun: true,
        sleepFn: async (ms) => {
          recordedDelays.push(ms);
        },
      });

      expect(exitCode).toBe(0);
      // 120s (from 3m to 1m), 60s (from 1m to 0m), 3s (after save-all)
      expect(recordedDelays).toEqual([120000, 60000, 3000]);
      expect(mock.commands).toEqual([
        "say [Scheduled Restart] Server will restart in 3 minutes.",
        "say [Scheduled Restart] Server will restart in 1 minute. Please find a safe place to disconnect!",
        "say [Scheduled Restart] Server is restarting now...",
        "save-all",
      ]);
    } finally {
      await mock.close();
    }
  });

  test("handles offline / unreachable RCON gracefully without failing restart", async () => {
    const executedCmds: Array<{ cmd: string; args: string[] }> = [];
    const mockExec: ExecCommandFn = async (cmd, args) => {
      executedCmds.push({ cmd, args });
      return { code: 0, stdout: "active\n", stderr: "" };
    };

    const exitCode = await runScheduledRestart({
      serviceName: "lampas-server.service",
      immediate: true,
      rconHost: "127.0.0.1",
      rconPort: 1, // Offline port
      rconPassword: "pass",
      sleepFn: async () => {},
      execCommandFn: mockExec,
    });

    expect(exitCode).toBe(0);
    expect(executedCmds).toEqual([
      { cmd: "systemctl", args: ["restart", "lampas-server.service"] },
      { cmd: "systemctl", args: ["is-active", "--quiet", "lampas-server.service"] },
    ]);
  });

  test("returns exit code 1 if systemctl is-active reports service failure", async () => {
    const mockExec: ExecCommandFn = async (cmd, args) => {
      if (cmd === "systemctl" && args[0] === "is-active") {
        return { code: 3, stdout: "inactive\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const exitCode = await runScheduledRestart({
      serviceName: "failing-server.service",
      immediate: true,
      sleepFn: async () => {},
      execCommandFn: mockExec,
    });

    expect(exitCode).toBe(1);
  });

  test("logs the RCON authentication error without logging the password", async () => {
    const { exitCode, lines } = await captureRestartLog(() =>
      runScheduledRestart({
        immediate: true,
        rconHost: "127.0.0.1",
        rconPort: 25575,
        rconPassword: "hunter2-secret",
        sleepFn: async () => {},
        rconClientFactory: () =>
          new FakeRconClient({ connect: new Error("RCON authentication failed: invalid password") }),
        execCommandFn: activeServiceExec,
      })
    );

    expect(exitCode).toBe(0);
    expect(lines.some((l) => l.includes("127.0.0.1:25575") && l.includes("RCON authentication failed: invalid password"))).toBe(true);
    expect(lines.filter((l) => l.includes("Skipping broadcast") && l.includes("invalid password"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("save-all") && l.includes("invalid password"))).toHaveLength(1);
    expect(lines.some((l) => l.includes("hunter2-secret"))).toBe(false);
  });

  test("logs the socket error code when the RCON connection is refused", async () => {
    const refused = Object.assign(new Error("Failed to connect"), { code: "ECONNREFUSED" });
    const { lines } = await captureRestartLog(() =>
      runScheduledRestart({
        immediate: true,
        rconPassword: "pass",
        sleepFn: async () => {},
        rconClientFactory: () => new FakeRconClient({ connect: refused }),
        execCommandFn: activeServiceExec,
      })
    );

    expect(lines.some((l) => l.includes("Failed to connect (ECONNREFUSED)"))).toBe(true);
  });

  test("logs the RCON error when a broadcast or command fails after connecting", async () => {
    const { exitCode, lines } = await captureRestartLog(() =>
      runScheduledRestart({
        immediate: true,
        rconPassword: "pass",
        sleepFn: async () => {},
        rconClientFactory: () =>
          new FakeRconClient({ send: new Error("RCON socket closed by remote server") }),
        execCommandFn: activeServiceExec,
      })
    );

    expect(exitCode).toBe(0);
    expect(lines.filter((l) => l.includes("RCON socket closed by remote server"))).toHaveLength(2);
  });

  test("warns with the directory when it has no server.properties and no password was given", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-test-restart-nodir-"));
    const savedPassword = process.env.RCON_PASSWORD;
    delete process.env.RCON_PASSWORD;
    try {
      const { exitCode, lines } = await captureRestartLog(() =>
        runScheduledRestart({
          targetDir: emptyDir,
          immediate: true,
          sleepFn: async () => {},
          rconClientFactory: () =>
            new FakeRconClient({ connect: new Error("RCON authentication failed: invalid password") }),
          execCommandFn: activeServiceExec,
        })
      );

      expect(exitCode).toBe(0);
      const warnings = lines.filter((l) => l.includes("Warning:"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`No server.properties in ${emptyDir}`);
      expect(warnings[0]).toContain("--target");
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
      if (savedPassword === undefined) delete process.env.RCON_PASSWORD;
      else process.env.RCON_PASSWORD = savedPassword;
    }
  });

  test("does not warn about the directory when the password comes from a flag, RCON_PASSWORD or server.properties", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-test-restart-nowarn-"));
    const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-test-restart-server-"));
    fs.writeFileSync(path.join(serverDir, "server.properties"), "enable-rcon=true\nrcon.password=props-secret\n");
    const savedPassword = process.env.RCON_PASSWORD;
    const run = (options: { targetDir: string; rconPassword?: string }) =>
      captureRestartLog(() =>
        runScheduledRestart({
          ...options,
          immediate: true,
          sleepFn: async () => {},
          rconClientFactory: () => new FakeRconClient(),
          execCommandFn: activeServiceExec,
        })
      );
    try {
      delete process.env.RCON_PASSWORD;
      const fromFlag = await run({ targetDir: emptyDir, rconPassword: "flag-secret" });
      const fromProperties = await run({ targetDir: serverDir });
      process.env.RCON_PASSWORD = "env-secret";
      const fromEnv = await run({ targetDir: emptyDir });

      for (const { lines } of [fromFlag, fromProperties, fromEnv]) {
        expect(lines.some((l) => l.includes("Warning:"))).toBe(false);
      }
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
      fs.rmSync(serverDir, { recursive: true, force: true });
      if (savedPassword === undefined) delete process.env.RCON_PASSWORD;
      else process.env.RCON_PASSWORD = savedPassword;
    }
  });

  test("formatRestartTimestamp produces valid UTC ISO-like timestamp string", () => {
    const ts = formatRestartTimestamp(new Date("2026-10-11T10:00:00Z"));
    expect(ts).toBe("[2026-10-11 10:00:00 UTC]");
  });
});

describe("CLI argument parsing for restart command", () => {
  test("parses restart command with flags and short options", () => {
    const parsed = parseArgs([
      "restart",
      "--immediate",
      "--service",
      "custom.service",
      "--countdown",
      "10",
      "-p",
      "25576",
      "--dry-run",
      "--rcon-password",
      "supersecret",
      "-t",
      "/srv/minecraft",
    ]);

    expect(parsed.command).toBe("restart");
    expect(parsed.flags.immediate).toBe("true");
    expect(parsed.flags.service).toBe("custom.service");
    expect(parsed.flags.countdown).toBe("10");
    expect(parsed.flags.port).toBe("25576");
    expect(parsed.flags["dry-run"]).toBe("true");
    expect(parsed.flags["rcon-password"]).toBe("supersecret");
    expect(parsed.flags.target).toBe("/srv/minecraft");
  });
});
