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

  test("keeps only the two newest matching backups by default", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-backup-test-"));
    try {
      const worldDir = path.join(dir, "world");
      const backupsDir = path.join(dir, ".backups");
      fs.mkdirSync(worldDir);
      fs.writeFileSync(path.join(worldDir, "level.dat"), "first");

      const firstBackup = await backupDirectory({ source: worldDir, destinationRoot: backupsDir });
      fs.writeFileSync(path.join(worldDir, "level.dat"), "second");
      const secondBackup = await backupDirectory({ source: worldDir, destinationRoot: backupsDir });

      const unrelatedBackup = path.join(backupsDir, "nether_2026-08-26_173012_456");
      fs.mkdirSync(unrelatedBackup);

      fs.writeFileSync(path.join(worldDir, "level.dat"), "third");
      const thirdBackup = await backupDirectory({ source: worldDir, destinationRoot: backupsDir });

      const worldBackups = fs.readdirSync(backupsDir).filter((name) => name.startsWith("world_"));
      expect(worldBackups).toHaveLength(2);
      expect(fs.existsSync(firstBackup!)).toBe(false);
      expect(fs.readFileSync(path.join(secondBackup!, "level.dat"), "utf-8")).toBe("second");
      expect(fs.readFileSync(path.join(thirdBackup!, "level.dat"), "utf-8")).toBe("third");
      expect(fs.existsSync(unrelatedBackup)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
