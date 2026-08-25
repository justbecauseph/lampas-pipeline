import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { computeFileHashesStreaming, downloadFileVerified, withAbortTimeout } from "../src/utils";

describe("withAbortTimeout", () => {
  test("aborts an operation whose response body never completes", async () => {
    let wasAborted = false;

    const operation = withAbortTimeout(
      "reading a test response body",
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              wasAborted = true;
              reject(signal.reason);
            },
            { once: true }
          );
        }),
      10
    );

    await expect(operation).rejects.toThrow("Timed out after 10ms while reading a test response body");
    expect(wasAborted).toBe(true);
  });
});

describe("streaming file utilities", () => {
  test("calculates all hashes in one streamed pass", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-hash-"));
    const file = path.join(dir, "fixture.bin");
    const content = Buffer.alloc(1024 * 1024, 0x5a);
    fs.writeFileSync(file, content);
    try {
      const result = await computeFileHashesStreaming(file);
      expect(result.size).toBe(content.length);
      expect(result.sha256).toBe(createHash("sha256").update(content).digest("hex"));
      expect(result.sha512).toBe(createHash("sha512").update(content).digest("hex"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not promote a hash-mismatched download", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-download-"));
    const destination = path.join(dir, "blob");
    try {
      await expect(downloadFileVerified(
        "data:application/octet-stream;base64,Y29ycnVwdA==",
        destination,
        { expectedHash: "0".repeat(64), attempts: 1 }
      )).rejects.toThrow("Failed to download");
      expect(fs.existsSync(destination)).toBe(false);
      expect(fs.readdirSync(dir).some((name) => name.includes(".partial."))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("follows 302 redirect and verifies hash and size", async () => {
    const payload = Buffer.from("lampas-cli-download-redirected-bytes");
    const sha256 = createHash("sha256").update(payload).digest("hex");

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === `/api/v1/blobs/${sha256}`) {
          return new Response(null, {
            status: 302,
            headers: { Location: `http://127.0.0.1:${server.port}/s3/blobs/${sha256}` },
          });
        }
        if (url.pathname === `/s3/blobs/${sha256}`) {
          return new Response(payload, {
            status: 200,
            headers: { "Content-Length": payload.length.toString() },
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-download-302-"));
    const destination = path.join(dir, "target.bin");

    try {
      const bytes = await downloadFileVerified(
        `http://127.0.0.1:${server.port}/api/v1/blobs/${sha256}`,
        destination,
        { expectedHash: sha256, expectedSize: payload.length, attempts: 1 }
      );

      expect(bytes).toBe(payload.length);
      expect(fs.existsSync(destination)).toBe(true);
      expect(fs.readFileSync(destination).equals(payload)).toBe(true);
    } finally {
      server.stop(true);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
