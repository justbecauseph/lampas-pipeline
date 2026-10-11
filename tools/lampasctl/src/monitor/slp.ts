import * as net from "node:net";

export interface MinecraftStatusVersion {
  name?: string;
  protocol?: number;
}

export interface MinecraftStatusPlayerSample {
  name: string;
  id: string;
}

export interface MinecraftStatusPlayers {
  max?: number;
  online?: number;
  sample?: MinecraftStatusPlayerSample[];
}

export interface MinecraftStatus {
  version?: MinecraftStatusVersion;
  players?: MinecraftStatusPlayers;
  description?: any;
  favicon?: string;
  enforcesSecureChat?: boolean;
  previewsChat?: boolean;
  [key: string]: any;
}

/**
 * Encodes an integer into Minecraft VarInt format (1 to 5 bytes).
 */
export function encodeVarInt(val: number): Buffer {
  let v = val >>> 0;
  const bytes: number[] = [];
  while (true) {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) {
      b |= 0x80;
    }
    bytes.push(b);
    if (v === 0) {
      break;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Decodes a Minecraft VarInt from a buffer starting at offset.
 */
export function decodeVarInt(
  buffer: Buffer,
  offset = 0
): { value: number; bytesRead: number } {
  let value = 0;
  let bytesRead = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buffer.length) {
      throw new Error("Buffer underflow while decoding VarInt");
    }
    const byte = buffer[offset + i];
    value |= (byte & 0x7f) << (7 * i);
    bytesRead++;
    if ((byte & 0x80) === 0) {
      return { value, bytesRead };
    }
  }
  throw new Error("VarInt is too wide (exceeds 5 bytes)");
}

/**
 * Constructs a Minecraft Handshake packet (Packet ID 0, next state 1 = status).
 */
export function createHandshakePacket(
  host: string,
  port: number,
  protocolVersion = 767
): Buffer {
  const hostBuf = Buffer.from(host, "utf-8");
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port, 0);

  const packetId = encodeVarInt(0);
  const protocolBuf = encodeVarInt(protocolVersion);
  const hostLenBuf = encodeVarInt(hostBuf.length);
  const nextStateBuf = encodeVarInt(1);

  const payload = Buffer.concat([
    packetId,
    protocolBuf,
    hostLenBuf,
    hostBuf,
    portBuf,
    nextStateBuf,
  ]);
  const lengthBuf = encodeVarInt(payload.length);
  return Buffer.concat([lengthBuf, payload]);
}

/**
 * Constructs a Minecraft Status Request packet (Packet ID 0).
 */
export function createStatusRequestPacket(): Buffer {
  const packetId = encodeVarInt(0);
  const lengthBuf = encodeVarInt(packetId.length);
  return Buffer.concat([lengthBuf, packetId]);
}

/**
 * Performs a Minecraft Server List Ping (SLP) handshake.
 * Returns parsed status JSON if joinable, rejects if offline or invalid.
 */
export function pingMinecraft(
  host: string,
  port: number,
  timeoutMs = 4000
): Promise<MinecraftStatus> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    let accumulated = Buffer.alloc(0);

    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(err);
      }
    };

    socket.setTimeout(timeoutMs);

    socket.on("timeout", () => {
      fail(new Error(`Timeout after ${timeoutMs}ms connecting to ${host}:${port}`));
    });

    socket.on("error", (err) => {
      fail(err);
    });

    socket.on("close", () => {
      if (!settled) {
        fail(new Error("Connection closed before status response was received"));
      }
    });

    socket.connect(port, host, () => {
      try {
        socket.write(createHandshakePacket(host, port));
        socket.write(createStatusRequestPacket());
      } catch (err: any) {
        fail(err);
      }
    });

    socket.on("data", (chunk: Buffer) => {
      accumulated = Buffer.concat([accumulated, chunk]);

      try {
        let offset = 0;
        let packetLen: number;
        let bytesRead1: number;

        try {
          const res = decodeVarInt(accumulated, offset);
          packetLen = res.value;
          bytesRead1 = res.bytesRead;
        } catch {
          // VarInt not yet complete, wait for more data
          return;
        }

        offset += bytesRead1;
        if (accumulated.length < offset + packetLen) {
          // Full packet not yet received
          return;
        }

        // Inside the packet payload:
        // 1. Packet ID (VarInt)
        const packetIdRes = decodeVarInt(accumulated, offset);
        if (packetIdRes.value !== 0) {
          throw new Error(`Unexpected packet ID in status response: ${packetIdRes.value}`);
        }
        offset += packetIdRes.bytesRead;

        // 2. JSON string length (VarInt)
        const jsonLenRes = decodeVarInt(accumulated, offset);
        const jsonLen = jsonLenRes.value;
        offset += jsonLenRes.bytesRead;

        if (accumulated.length < offset + jsonLen) {
          // Full string not yet received
          return;
        }

        const jsonBuf = accumulated.subarray(offset, offset + jsonLen);
        const jsonStr = jsonBuf.toString("utf-8");
        const parsed = JSON.parse(jsonStr) as MinecraftStatus;

        if (!settled) {
          settled = true;
          cleanup();
          resolve(parsed);
        }
      } catch (err: any) {
        fail(err);
      }
    });
  });
}
