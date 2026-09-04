import * as fs from "node:fs";
import * as path from "node:path";
import { copyFileAtomic, ensureDir, readJsonFile, replaceFile, temporarySibling } from "./utils";

export interface TransactionJournalData {
  txId: string;
  startedAt: string;
  targetDir: string;
  overwrittenFiles: string[];
  deletedFiles: string[];
  newFiles: string[];
  hadServerProperties: boolean;
  hadInstallationJson: boolean;
  hadRuntimeJar: boolean;
  hadRuntimeJson: boolean;
}

export class DeploymentTransaction {
  public readonly txDir: string;
  private journal: TransactionJournalData;
  private snapshotted = false;

  constructor(public readonly targetDir: string) {
    const txId = `tx-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.txDir = path.join(targetDir, ".lampas", ".tx-rollback");
    this.journal = {
      txId,
      startedAt: new Date().toISOString(),
      targetDir,
      overwrittenFiles: [],
      deletedFiles: [],
      newFiles: [],
      hadServerProperties: false,
      hadInstallationJson: false,
      hadRuntimeJar: false,
      hadRuntimeJson: false,
    };
  }

  private async persistJournal(): Promise<void> {
    ensureDir(this.txDir);
    const journalPath = path.join(this.txDir, "journal.json");
    const tempPath = temporarySibling(journalPath);
    const content = JSON.stringify(this.journal, null, 2);
    await fs.promises.writeFile(tempPath, content, "utf-8");
    await replaceFile(tempPath, journalPath);
  }

  public async snapshot(options: {
    toDownload: Array<{ path: string }>;
    toDelete: string[];
  }): Promise<void> {
    ensureDir(this.txDir);
    const overwrittenDir = path.join(this.txDir, "overwritten");
    const deletedDir = path.join(this.txDir, "deleted");

    // 1. Snapshot files in toDownload that already exist on disk (they will be overwritten)
    // or register them in newFiles before downloading begins
    for (const f of options.toDownload) {
      const fullPath = path.join(this.targetDir, f.path);
      if (fs.existsSync(fullPath)) {
        const dest = path.join(overwrittenDir, f.path);
        ensureDir(path.dirname(dest));
        fs.copyFileSync(fullPath, dest);
        this.journal.overwrittenFiles.push(f.path);
      } else {
        if (!this.journal.newFiles.includes(f.path)) {
          this.journal.newFiles.push(f.path);
        }
      }
    }

    // 2. Snapshot files in toDelete that exist on disk
    for (const relPath of options.toDelete) {
      const fullPath = path.join(this.targetDir, relPath);
      if (fs.existsSync(fullPath)) {
        const dest = path.join(deletedDir, relPath);
        ensureDir(path.dirname(dest));
        fs.copyFileSync(fullPath, dest);
        this.journal.deletedFiles.push(relPath);
      }
    }

    // 3. Snapshot server.properties if present
    const propsPath = path.join(this.targetDir, "server.properties");
    if (fs.existsSync(propsPath)) {
      fs.copyFileSync(propsPath, path.join(this.txDir, "server.properties"));
      this.journal.hadServerProperties = true;
    }

    // 4. Snapshot .lampas/installation.json if present
    const statePath = path.join(this.targetDir, ".lampas", "installation.json");
    if (fs.existsSync(statePath)) {
      fs.copyFileSync(statePath, path.join(this.txDir, "installation.json"));
      this.journal.hadInstallationJson = true;
    }

    // 5. Snapshot .lampas/runtime/ if present
    const runtimeJarPath = path.join(this.targetDir, ".lampas", "runtime", "fabric-server-launch.jar");
    if (fs.existsSync(runtimeJarPath)) {
      const dest = path.join(this.txDir, "runtime", "fabric-server-launch.jar");
      ensureDir(path.dirname(dest));
      fs.copyFileSync(runtimeJarPath, dest);
      this.journal.hadRuntimeJar = true;
    }

    const runtimeJsonPath = path.join(this.targetDir, ".lampas", "runtime", "runtime.json");
    if (fs.existsSync(runtimeJsonPath)) {
      const dest = path.join(this.txDir, "runtime", "runtime.json");
      ensureDir(path.dirname(dest));
      fs.copyFileSync(runtimeJsonPath, dest);
      this.journal.hadRuntimeJson = true;
    }

    this.snapshotted = true;
    await this.persistJournal();
  }

  public async recordNewFile(relPath: string): Promise<void> {
    if (!this.journal.overwrittenFiles.includes(relPath) && !this.journal.newFiles.includes(relPath)) {
      this.journal.newFiles.push(relPath);
      await this.persistJournal();
    }
  }

  public async rollback(): Promise<void> {
    if (!this.snapshotted && !fs.existsSync(path.join(this.txDir, "journal.json"))) {
      return;
    }
    await DeploymentTransaction.rollbackFromDir(this.targetDir, this.txDir, this.journal);
  }

  public async commit(): Promise<void> {
    if (fs.existsSync(this.txDir)) {
      await fs.promises.rm(this.txDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  public static async recoverIfInterrupted(targetDir: string): Promise<boolean> {
    const txDir = path.join(targetDir, ".lampas", ".tx-rollback");
    const journalPath = path.join(txDir, "journal.json");
    if (fs.existsSync(journalPath)) {
      console.warn(`  ⚠ [Deployment Recovery] Detected incomplete deployment transaction. Rolling back...`);
      try {
        const journal = readJsonFile<TransactionJournalData>(journalPath);
        await DeploymentTransaction.rollbackFromDir(targetDir, txDir, journal);
        return true;
      } catch (err: any) {
        console.error(`  ✗ [Recovery Error] Failed to recover from journal: ${err.message}`);
        throw new Error(
          `Cannot recover interrupted deployment transaction: ${err.message}`,
          { cause: err }
        );
      }
    }
    return false;
  }

  private static async rollbackFromDir(
    targetDir: string,
    txDir: string,
    journal: TransactionJournalData
  ): Promise<void> {
    // 1. Remove newly created files
    for (const relPath of journal.newFiles) {
      const fullPath = path.join(targetDir, relPath);
      if (fs.existsSync(fullPath)) {
        await fs.promises.unlink(fullPath).catch(() => {});
      }
    }

    // 2. Restore overwritten files
    const overwrittenDir = path.join(txDir, "overwritten");
    for (const relPath of journal.overwrittenFiles) {
      const backupPath = path.join(overwrittenDir, relPath);
      const targetPath = path.join(targetDir, relPath);
      if (fs.existsSync(backupPath)) {
        ensureDir(path.dirname(targetPath));
        await copyFileAtomic(backupPath, targetPath);
      }
    }

    // 3. Restore deleted files
    const deletedDir = path.join(txDir, "deleted");
    for (const relPath of journal.deletedFiles) {
      const backupPath = path.join(deletedDir, relPath);
      const targetPath = path.join(targetDir, relPath);
      if (fs.existsSync(backupPath)) {
        ensureDir(path.dirname(targetPath));
        await copyFileAtomic(backupPath, targetPath);
      }
    }

    // 4. Restore server.properties
    const propsTarget = path.join(targetDir, "server.properties");
    const propsBackup = path.join(txDir, "server.properties");
    if (journal.hadServerProperties && fs.existsSync(propsBackup)) {
      await copyFileAtomic(propsBackup, propsTarget);
    } else if (!journal.hadServerProperties && fs.existsSync(propsTarget)) {
      await fs.promises.unlink(propsTarget).catch(() => {});
    }

    // 5. Restore .lampas/runtime/
    const runtimeJarTarget = path.join(targetDir, ".lampas", "runtime", "fabric-server-launch.jar");
    const runtimeJarBackup = path.join(txDir, "runtime", "fabric-server-launch.jar");
    if (journal.hadRuntimeJar && fs.existsSync(runtimeJarBackup)) {
      ensureDir(path.dirname(runtimeJarTarget));
      await copyFileAtomic(runtimeJarBackup, runtimeJarTarget);
    } else if (!journal.hadRuntimeJar && fs.existsSync(runtimeJarTarget)) {
      await fs.promises.unlink(runtimeJarTarget).catch(() => {});
    }

    const runtimeJsonTarget = path.join(targetDir, ".lampas", "runtime", "runtime.json");
    const runtimeJsonBackup = path.join(txDir, "runtime", "runtime.json");
    if (journal.hadRuntimeJson && fs.existsSync(runtimeJsonBackup)) {
      ensureDir(path.dirname(runtimeJsonTarget));
      await copyFileAtomic(runtimeJsonBackup, runtimeJsonTarget);
    } else if (!journal.hadRuntimeJson && fs.existsSync(runtimeJsonTarget)) {
      await fs.promises.unlink(runtimeJsonTarget).catch(() => {});
    }

    // 6. Restore .lampas/installation.json
    const stateTarget = path.join(targetDir, ".lampas", "installation.json");
    const stateBackup = path.join(txDir, "installation.json");
    if (journal.hadInstallationJson && fs.existsSync(stateBackup)) {
      ensureDir(path.dirname(stateTarget));
      await copyFileAtomic(stateBackup, stateTarget);
    } else if (!journal.hadInstallationJson && fs.existsSync(stateTarget)) {
      await fs.promises.unlink(stateTarget).catch(() => {});
    }

    // 7. Clean up any staged runtime directory
    const stagingDir = path.join(targetDir, ".lampas", "runtime", ".tmp-staging");
    if (fs.existsSync(stagingDir)) {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }

    // 8. Clean up txDir
    await fs.promises.rm(txDir, { recursive: true, force: true }).catch(() => {});
    console.log(`  ✓ [Deployment Rollback Complete] Successfully restored previous installation state`);
  }
}
