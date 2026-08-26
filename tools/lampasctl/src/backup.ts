import * as fs from "node:fs";
import * as path from "node:path";

export interface BackupOptions {
  source: string;
  destinationRoot: string;
  label?: string;
}

export function formatTimestamp(date = new Date()): string {
  const pad = (n: number, width = 2) => n.toString().padStart(width, "0");
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());
  const ms = pad(date.getUTCMilliseconds(), 3);
  return `${year}-${month}-${day}_${hours}${minutes}${seconds}_${ms}`;
}

export async function backupDirectory(options: BackupOptions): Promise<string | undefined> {
  const { source, destinationRoot, label = "world" } = options;

  if (!fs.existsSync(source)) {
    return undefined;
  }

  const stat = fs.statSync(source);
  if (!stat.isDirectory()) {
    return undefined;
  }

  const entries = fs.readdirSync(source);
  if (entries.length === 0) {
    return undefined;
  }

  fs.mkdirSync(destinationRoot, { recursive: true });

  const timestamp = formatTimestamp();
  let backupFolderName = `${label}_${timestamp}`;
  let backupDest = path.join(destinationRoot, backupFolderName);
  let counter = 1;

  while (fs.existsSync(backupDest)) {
    backupFolderName = `${label}_${timestamp}_${counter++}`;
    backupDest = path.join(destinationRoot, backupFolderName);
  }

  fs.cpSync(source, backupDest, { recursive: true });

  console.log(`[Backup] Created backup of '${path.basename(source)}' at: ${backupDest}`);
  return backupDest;
}
