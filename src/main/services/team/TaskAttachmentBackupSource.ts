import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  type DurableFileIdentity,
  getDurableFileIdentity,
  isSameDurableFileIdentity,
  removePathWithIdentityFenceAsync,
} from '@main/utils/atomicWrite';
import { getAppDataPath } from '@main/utils/pathDecoder';

import { shouldCollectTaskAttachmentBackupFile } from './TeamBackupFilePolicy';

import type { TaskAttachmentDeletionBackupFence } from './TaskAttachmentDeletionJournal';
import type { BackupFileDescriptor } from './TeamBackupFileCollection';

const TASK_ATTACHMENTS_DIRECTORY = 'task-attachments';

export interface PendingTaskAttachmentDeletionCompletion {
  readonly transactionIds: ReadonlySet<string>;
  readonly backedUpReplacements: ReadonlyMap<string, DurableFileIdentity>;
  readonly backupChanged: boolean;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export class TaskAttachmentBackupSource {
  constructor(private readonly deletionFence?: TaskAttachmentDeletionBackupFence) {}

  async reconcilePendingDeletions(): Promise<void> {
    await this.deletionFence?.reconcilePendingDeletions();
  }

  async getPendingTeams(): Promise<ReadonlySet<string>> {
    return (await this.deletionFence?.getPendingTeams()) ?? new Set<string>();
  }

  async settlePendingDeletions(
    teamName: string,
    backupDirectory: string,
    fileStats: Record<string, unknown>,
    onBackupChanged?: () => Promise<void>
  ): Promise<void> {
    const completion = await this.preparePendingDeletionCompletion(
      teamName,
      backupDirectory,
      fileStats
    );
    if (completion?.backupChanged) await onBackupChanged?.();
    await this.completePendingDeletionSnapshot(teamName, completion);
  }

  private async preparePendingDeletionCompletion(
    teamName: string,
    backupDirectory: string,
    fileStats: Record<string, unknown>
  ): Promise<PendingTaskAttachmentDeletionCompletion | null> {
    if (!this.deletionFence) return null;
    const candidates = await this.deletionFence.getCompletionCandidates(teamName);
    const transactionIds = new Set(candidates.map((candidate) => candidate.transactionId));
    const backupChanged = await this.prunePendingBackups(teamName, backupDirectory, fileStats);
    const backedUpReplacements = new Map<string, DurableFileIdentity>();
    const exclusions = await this.deletionFence.getBackupExclusions(teamName);
    const taskAttachmentRoot = path.resolve(getAppDataPath(), TASK_ATTACHMENTS_DIRECTORY, teamName);
    for (const candidate of candidates) {
      const resolvedSourcePath = path.resolve(candidate.originalPath);
      if (exclusions.has(resolvedSourcePath)) continue;
      const backupRelativePath = this.getBackupRelativePath(taskAttachmentRoot, resolvedSourcePath);
      if (!backupRelativePath) continue;
      try {
        const before = getDurableFileIdentity(await fs.promises.lstat(resolvedSourcePath));
        const [sourceBytes, backupBytes] = await Promise.all([
          fs.promises.readFile(resolvedSourcePath),
          fs.promises.readFile(path.join(backupDirectory, backupRelativePath)),
        ]);
        const afterStats = await fs.promises.lstat(resolvedSourcePath);
        const after = getDurableFileIdentity(afterStats);
        if (
          afterStats.isFile() &&
          !afterStats.isSymbolicLink() &&
          isSameDurableFileIdentity(before, after) &&
          sourceBytes.equals(backupBytes)
        ) {
          backedUpReplacements.set(resolvedSourcePath, after);
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return { transactionIds, backedUpReplacements, backupChanged };
  }

  private async completePendingDeletionSnapshot(
    teamName: string,
    completion: PendingTaskAttachmentDeletionCompletion | null
  ): Promise<void> {
    if (!this.deletionFence || !completion) return;
    await this.deletionFence.completePendingDeletions(
      teamName,
      completion.transactionIds,
      completion.backedUpReplacements
    );
  }

  async collect(teamName: string): Promise<{ files: BackupFileDescriptor[]; hasErrors: boolean }> {
    const files: BackupFileDescriptor[] = [];
    let hasErrors = false;
    const exclusions =
      (await this.deletionFence?.getBackupExclusions(teamName)) ?? new Set<string>();
    const teamDirectory = path.join(getAppDataPath(), TASK_ATTACHMENTS_DIRECTORY, teamName);
    let taskDirectories: fs.Dirent[];
    try {
      taskDirectories = await fs.promises.readdir(teamDirectory, { withFileTypes: true });
    } catch (error) {
      return { files, hasErrors: !isMissing(error) };
    }

    for (const taskDirectory of taskDirectories) {
      if (!taskDirectory.isDirectory()) continue;
      const taskDirectoryPath = path.join(teamDirectory, taskDirectory.name);
      try {
        const attachments = await fs.promises.readdir(taskDirectoryPath, {
          withFileTypes: true,
        });
        for (const attachment of attachments) {
          if (!attachment.isFile() || !shouldCollectTaskAttachmentBackupFile(attachment.name)) {
            continue;
          }
          const sourcePath = path.join(taskDirectoryPath, attachment.name);
          if (exclusions.has(path.resolve(sourcePath))) continue;
          files.push({
            sourcePath,
            relPath: `${TASK_ATTACHMENTS_DIRECTORY}/${taskDirectory.name}/${attachment.name}`,
          });
        }
      } catch (error) {
        if (!isMissing(error)) hasErrors = true;
      }
    }
    return { files, hasErrors };
  }

  collectSync(teamName: string): BackupFileDescriptor[] {
    const files: BackupFileDescriptor[] = [];
    const teamDirectory = path.join(getAppDataPath(), TASK_ATTACHMENTS_DIRECTORY, teamName);
    let taskDirectories: fs.Dirent[];
    try {
      taskDirectories = fs.readdirSync(teamDirectory, { withFileTypes: true });
    } catch {
      return files;
    }

    for (const taskDirectory of taskDirectories) {
      if (!taskDirectory.isDirectory()) continue;
      const taskDirectoryPath = path.join(teamDirectory, taskDirectory.name);
      try {
        const attachments = fs.readdirSync(taskDirectoryPath, { withFileTypes: true });
        for (const attachment of attachments) {
          if (!attachment.isFile() || !shouldCollectTaskAttachmentBackupFile(attachment.name)) {
            continue;
          }
          const sourcePath = path.join(taskDirectoryPath, attachment.name);
          files.push({
            sourcePath,
            relPath: `${TASK_ATTACHMENTS_DIRECTORY}/${taskDirectory.name}/${attachment.name}`,
          });
        }
      } catch {
        // Shutdown backup is best-effort.
      }
    }
    return files;
  }

  async prunePendingBackups(
    teamName: string,
    backupDirectory: string,
    fileStats: Record<string, unknown>
  ): Promise<boolean> {
    const exclusions =
      (await this.deletionFence?.getBackupExclusions(teamName)) ?? new Set<string>();
    const taskAttachmentRoot = path.resolve(getAppDataPath(), TASK_ATTACHMENTS_DIRECTORY, teamName);
    let changed = false;
    for (const excludedPath of exclusions) {
      const backupRelativePath = this.getBackupRelativePath(taskAttachmentRoot, excludedPath);
      if (!backupRelativePath) continue;
      const backupPath = path.join(backupDirectory, backupRelativePath);
      const removal = await removePathWithIdentityFenceAsync(backupPath, {
        force: true,
        durability: 'strict',
      });
      if (removal === 'changed') {
        throw new Error(`Task attachment backup changed while pruning: ${backupRelativePath}`);
      }
      try {
        await fs.promises.lstat(backupPath);
        throw new Error(
          `Task attachment backup was republished while pruning: ${backupRelativePath}`
        );
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      changed = Reflect.deleteProperty(fileStats, backupRelativePath) || changed;
    }
    return changed;
  }

  private getBackupRelativePath(taskAttachmentRoot: string, excludedPath: string): string | null {
    const relativePath = path.relative(taskAttachmentRoot, path.resolve(excludedPath));
    if (
      !relativePath ||
      relativePath === '..' ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      return null;
    }
    return `${TASK_ATTACHMENTS_DIRECTORY}/${relativePath.split(path.sep).join('/')}`;
  }
}
