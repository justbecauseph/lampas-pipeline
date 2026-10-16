import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { readServerPropertiesMap } from "../sync";

export const RCON_PACKET_TYPE = {
  RESPONSE_VALUE: 0,
  EXECCOMMAND: 2,
  AUTH_RESPONSE: 2,
  AUTH: 3,
} as const;

export interface RconPacket {
  length: number;
  reqId: number;
  type: number;
  payload: string;
}

export interface ResolveRconConfigOptions {
  host?: string;
  port?: number;
  password?: string;
  targetDir?: string;
}

export type RconPasswordSource = "option" | "env" | "minecraft-env" | "server.properties" | "default";

export interface RconConfig {
  host: string;
  port: number;
  password?: string;
  passwordSource: RconPasswordSource;
  serverPropertiesFound: boolean;
}

/**
 * Encodes a Minecraft RCON packet.
 *
 * Packet layout (Little-Endian):
 * - 4 bytes: Length (total size of remaining fields: reqId(4) + type(4) + payload(N) + null(1) + pad(1))
 * - 4 bytes: Request ID
 * - 4 bytes: Type (3=AUTH, 2=EXECCOMMAND, 0=RESPONSE_VALUE, 2=AUTH_RESPONSE)
 * - N bytes: Payload string
 * - 1 byte:  Null terminator (\0)
 * - 1 byte:  Null pad (\0)
 */
export function createRconPacket(reqId: number, type: number, payload: string): Buffer {
  const payloadBuf = Buffer.from(payload, "utf-8");
  const length = payloadBuf.length + 10;
  const totalLength = 4 + length;
  const buf = Buffer.alloc(totalLength);
  buf.writeInt32LE(length, 0);
  buf.writeInt32LE(reqId, 4);
  buf.writeInt32LE(type, 8);
  if (payloadBuf.length > 0) {
    payloadBuf.copy(buf, 12);
  }
  buf[12 + payloadBuf.length] = 0;
  buf[12 + payloadBuf.length + 1] = 0;
  return buf;
}

/**
 * Parses a Minecraft RCON packet from a buffer.
 * Returns null if buffer contains less than a full packet.
 */
export function parseRconPacket(buf: Buffer): RconPacket | null {
  if (buf.length < 4) {
    return null;
  }
  const length = buf.readInt32LE(0);
  if (length < 10 || buf.length < length + 4) {
    return null;
  }
  const reqId = buf.readInt32LE(4);
  const type = buf.readInt32LE(8);
  const payloadEnd = 4 + length - 2;
  const slice = buf.subarray(12, payloadEnd);
  const nullIdx = slice.indexOf(0);
  const payload = (nullIdx !== -1 ? slice.subarray(0, nullIdx) : slice).toString("utf-8");

  return { length, reqId, type, payload };
}

/**
 * Resolves Minecraft RCON connection configuration from flags, environment variables,
 * `.minecraft-env`, or `server.properties`.
 */
export function resolveRconConfig(options: ResolveRconConfigOptions = {}): RconConfig {
  const targetDir = options.targetDir || process.cwd();
  const props = readServerPropertiesMap(targetDir);

  let envVars: Record<string, string> = {};
  const envPath = path.join(targetDir, ".minecraft-env");
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, "utf-8");
      for (const rawLine of content.split(/\r?\n/)) {
        let line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        if (line.startsWith("export ")) line = line.slice(7).trim();
        const eqIdx = line.indexOf("=");
        if (eqIdx !== -1) {
          envVars[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
        }
      }
    } catch {}
  }

  // 1. Host resolution: options -> env -> .minecraft-env -> default 127.0.0.1
  const host =
    options.host ||
    process.env.RCON_HOST ||
    envVars.RCON_HOST ||
    "127.0.0.1";

  // 2. Port resolution: options -> env -> .minecraft-env -> server.properties -> default 25575
  let port: number | undefined = options.port;
  if (port === undefined && process.env.RCON_PORT) {
    const parsed = parseInt(process.env.RCON_PORT, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 65535) port = parsed;
  }
  if (port === undefined && envVars.RCON_PORT) {
    const parsed = parseInt(envVars.RCON_PORT, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 65535) port = parsed;
  }
  if (port === undefined && props["rcon.port"]) {
    const parsed = parseInt(props["rcon.port"], 10);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 65535) port = parsed;
  }
  if (port === undefined) {
    port = 25575;
  }

  // 3. Password resolution: options -> env -> .minecraft-env -> server.properties -> default ""
  let password = "";
  let passwordSource: RconPasswordSource = "default";
  if (options.password !== undefined) {
    password = options.password;
    passwordSource = "option";
  } else if (process.env.RCON_PASSWORD !== undefined) {
    password = process.env.RCON_PASSWORD;
    passwordSource = "env";
  } else if (envVars.RCON_PASSWORD !== undefined) {
    password = envVars.RCON_PASSWORD;
    passwordSource = "minecraft-env";
  } else if (props["rcon.password"] !== undefined) {
    password = props["rcon.password"];
    passwordSource = "server.properties";
  }

  const serverPropertiesFound = fs.existsSync(path.join(targetDir, "server.properties"));

  return { host, port, password, passwordSource, serverPropertiesFound };
}

/** Formats an RCON or socket error as its message plus the error code when the message lacks it. */
export function describeRconError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as NodeJS.ErrnoException).code;
  const message = err.message || code || err.name;
  return code && !message.includes(code) ? `${message} (${code})` : message;
}

/**
 * Native Minecraft RCON client over TCP.
 */
export class RconClient {
  private socket: net.Socket | null = null;
  private rxBuffer = Buffer.alloc(0);
  private nextReqId = 1;
  private authenticated = false;
  private lastErrorReason: string | null = null;
  private pendingRequests = new Map<
    number,
    { resolve: (payload: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private authPending: {
    reqId: number;
    timer: NodeJS.Timeout;
    resolve: () => void;
    reject: (err: Error) => void;
  } | null = null;

  get isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed && this.authenticated;
  }

  /** Why the socket dropped after connect() succeeded, or null. Each connect() clears it. */
  get lastError(): string | null {
    return this.lastErrorReason;
  }

  async connect(host: string, port: number, password: string, timeoutMs = 5000): Promise<void> {
    this.close();
    this.lastErrorReason = null;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = new net.Socket();
      this.socket = socket;

      const timeoutTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.close();
          reject(new Error(`Timeout (${timeoutMs}ms) waiting for RCON connection/authentication to ${host}:${port}`));
        }
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeoutTimer);
      };

      socket.on("error", (err) => {
        if (!settled) {
          settled = true;
          cleanup();
          this.close();
          reject(err);
        } else {
          this.handleSocketError(err);
        }
      });

      socket.on("close", () => {
        if (!settled) {
          settled = true;
          cleanup();
          this.close();
          reject(new Error("RCON socket closed unexpectedly during authentication"));
        } else {
          this.handleSocketClose();
        }
      });

      socket.on("data", (chunk: Buffer) => {
        this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
        this.processIncomingPackets((packet) => {
          if (!this.authenticated && this.authPending) {
            if (packet.reqId === -1) {
              settled = true;
              cleanup();
              this.close();
              reject(new Error("RCON authentication failed: invalid password"));
              return;
            }
            if (packet.type === 2 && packet.reqId === this.authPending.reqId) {
              this.authenticated = true;
              this.lastErrorReason = null;
              this.authPending = null;
              settled = true;
              cleanup();
              resolve();
              return;
            }
            // Some servers send an empty SERVERDATA_RESPONSE_VALUE (type 0) before auth response
            if (packet.type === 0 && packet.reqId === this.authPending.reqId) {
              return;
            }
          } else {
            this.dispatchPacket(packet);
          }
        });
      });

      socket.connect(port, host, () => {
        const authReqId = this.nextReqId++;
        this.authPending = {
          reqId: authReqId,
          timer: timeoutTimer,
          resolve: () => {},
          reject: () => {},
        };
        const authPacket = createRconPacket(authReqId, 3, password);
        socket.write(authPacket);
      });
    });
  }

  async send(command: string, timeoutMs = 5000): Promise<string> {
    if (!this.socket || !this.authenticated) {
      throw new Error("RCON client is not connected or authenticated");
    }

    const reqId = this.nextReqId++;
    if (this.nextReqId > 0x7fffffff) {
      this.nextReqId = 1;
    }

    const packet = createRconPacket(reqId, 2, command);

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        reject(new Error(`Timeout (${timeoutMs}ms) waiting for RCON command response: "${command}"`));
      }, timeoutMs);

      this.pendingRequests.set(reqId, { resolve, reject, timer });
      this.socket?.write(packet);
    });
  }

  close(): void {
    this.authenticated = false;
    if (this.authPending) {
      clearTimeout(this.authPending.timer);
      this.authPending = null;
    }
    for (const [, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("RCON client closed"));
    }
    this.pendingRequests.clear();

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.rxBuffer = Buffer.alloc(0);
  }

  private processIncomingPackets(onPacket: (packet: RconPacket) => void): void {
    while (this.rxBuffer.length >= 4) {
      const packetLength = this.rxBuffer.readInt32LE(0);
      const totalLength = packetLength + 4;
      if (this.rxBuffer.length < totalLength) {
        break;
      }
      const packetData = this.rxBuffer.subarray(0, totalLength);
      this.rxBuffer = this.rxBuffer.subarray(totalLength);
      const packet = parseRconPacket(packetData);
      if (packet) {
        onPacket(packet);
      }
    }
  }

  private dispatchPacket(packet: RconPacket): void {
    const pending = this.pendingRequests.get(packet.reqId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(packet.reqId);
      pending.resolve(packet.payload);
    }
  }

  private handleSocketClose(): void {
    this.authenticated = false;
    const reason = "RCON socket closed by remote server";
    // An error that arrived first on this connection is the more specific reason.
    if (this.lastErrorReason === null) {
      this.lastErrorReason = reason;
    }
    for (const [, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
    this.socket = null;
  }

  private handleSocketError(err: Error): void {
    this.authenticated = false;
    this.lastErrorReason = describeRconError(err);
    for (const [, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }
}
