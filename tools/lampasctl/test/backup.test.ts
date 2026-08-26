import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { backupDirectory, formatTimestamp } from "../src/backup";

describe("world backup utility", () => {
  test("formatTimestamp outputs a valid timestamp format with milliseconds", () => {
    const ts = formatTimestamp(new Date("2026-08-26T17:30:12.456Z"));
    expect(ts).toBe("2026-08-26_173012_456");
  });

  test("skips backup when source directory does not exist", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-backup-test-"));
    try {
      const result = await backupDirectory({
        source: path.join(dir, "nonexistent-world"),
        destinationRoot: path.join(dir, ".backups"),
      });
      expect(result).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips backup when source directory is empty", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-backup-test-"));
    try {
      const worldDir = path.join(dir, "world");
      fs.mkdirSync(worldDir);
      const result = await backupDirectory({
        source: worldDir,
        destinationRoot: path.join(dir, ".backups"),
      });
      expect(result).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates timestamped copy of world directory when content exists", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-backup-test-"));
    try {
      const worldDir = path.join(dir, "world");
      fs.mkdirSync(path.join(worldDir, "region"), { recursive: true });
      fs.writeFileSync(path.join(worldDir, "level.dat"), "level-data-binary");
      fs.writeFileSync(path.join(worldDir, "region", "r.0.0.mca"), "region-chunk-data");

      const backupsDir = path.join(dir, ".backups");
      const backupPath = await backupDirectory({
        source: worldDir,
        destinationRoot: backupsDir,
        label: "world",
      });

      expect(backupPath).toBeDefined();
      expect(fs.existsSync(backupPath!)).toBe(true);
      expect(fs.existsSync(path.join(backupPath!, "level.dat"))).toBe(true);
      expect(fs.existsSync(path.join(backupPath!, "region", "r.0.0.mca"))).toBe(true);
      expect(fs.readFileSync(path.join(backupPath!, "level.dat"), "utf-8")).toBe("level-data-binary");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
