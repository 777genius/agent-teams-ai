import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  getDurablePathIdentity,
  isSameDurablePathIdentity,
  removePathWithIdentityFenceAsync,
} from '@main/utils/atomicWrite';
import { getTeamsBasePath } from '@main/utils/pathDecoder';

import { TaskAttachmentBackupSource } from './TaskAttachmentBackupSource';
import {
  type BackupFileDescriptor,
  collectRecursiveFiles,
  collectRecursiveFilesSync,
} from './TeamBackupFileCollection';
import {
  enumerateBackupFiles,
  enumerateTeamFilesSync,
  enumerateTeamFilesWithErrors,
} from './TeamBackupFileEnumerator';

import type { BackupManifest } from './teamBackupManifest';

const MEMBER_WORK_SYNC_BACKUP_DIR = '.member-work-sync';
const TASK_ATTACHMENTS_BACKUP_PREFIX = 'task-attachments/';

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isSpecializedBackupFile(descriptor: BackupFileDescriptor): boolean {
  return (
    descriptor.relPath.startsWith(TASK_ATTACHMENTS_BACKUP_PREFIX) ||
    descriptor.relPath.startsWith(`${MEMBER_WORK_SYNC_BACKUP_DIR}/`)
  );
}

export class TeamBackupFileSet {
  constructor(private readonly taskAttachments: TaskAttachmentBackupSource) {}

  async collect(
    teamName: string
  ): Promise<{ files: BackupFileDescriptor[]; hasErrors: boolean }> {
    const generic = await enumerateTeamFilesWithErrors(teamName);
    const taskAttachments = await this.taskAttachments.collect(teamName);
    let workSyncFiles: BackupFileDescriptor[] = [];
    let workSyncHasErrors = false;
    try {
      workSyncFiles = await collectRecursiveFiles(
        path.join(getTeamsBasePath(), teamName, MEMBER_WORK_SYNC_BACKUP_DIR),
        MEMBER_WORK_SYNC_BACKUP_DIR
      );
    } catch (error) {
      workSyncHasErrors = !isEnoent(error);
    }
    return {
      files: generic.files
        .filter((descriptor) => !isSpecializedBackupFile(descriptor))
        .concat(workSyncFiles, taskAttachments.files),
      hasErrors: generic.hasErrors || workSyncHasErrors || taskAttachments.hasErrors,
    };
  }

  collectSync(teamName: string): BackupFileDescriptor[] {
    let workSyncFiles: BackupFileDescriptor[] = [];
    try {
      workSyncFiles = collectRecursiveFilesSync(
        path.join(getTeamsBasePath(), teamName, MEMBER_WORK_SYNC_BACKUP_DIR),
        MEMBER_WORK_SYNC_BACKUP_DIR
      );
    } catch {
      // Shutdown backup is best-effort.
    }
    return enumerateTeamFilesSync(teamName)
      .filter((descriptor) => !isSpecializedBackupFile(descriptor))
      .concat(workSyncFiles, this.taskAttachments.collectSync(teamName));
  }

  async pruneStaleBackups(
    sourceFiles: BackupFileDescriptor[],
    backupDirectory: string,
    manifest: BackupManifest,
    assertPublicationCurrent: () => Promise<void>
  ): Promise<boolean> {
    const backupFiles = await enumerateBackupFiles(backupDirectory);
    const sourceRelPaths = new Set(sourceFiles.map((file) => file.relPath));
    const backupRelPaths = new Set(backupFiles);
    let changed = false;

    for (const manifestRelPath of Object.keys(manifest.fileStats)) {
      if (!sourceRelPaths.has(manifestRelPath) && !backupRelPaths.has(manifestRelPath)) {
        delete manifest.fileStats[manifestRelPath];
        changed = true;
      }
    }

    for (const backupRelPath of backupFiles) {
      if (backupRelPath === 'manifest.json' || sourceRelPaths.has(backupRelPath)) continue;
      const backupPath = path.join(backupDirectory, backupRelPath);
      try {
        await assertPublicationCurrent();
        const observed = getDurablePathIdentity(await fs.promises.lstat(backupPath));
        const removal = await removePathWithIdentityFenceAsync(backupPath, {
          force: true,
          validateDetached: async (_detachedPath, identity) => {
            await assertPublicationCurrent();
            return isSameDurablePathIdentity(identity, observed);
          },
        });
        if (removal !== 'changed') {
          changed = Reflect.deleteProperty(manifest.fileStats, backupRelPath) || changed;
        }
      } catch (error) {
        if (!isEnoent(error)) throw error;
        changed = Reflect.deleteProperty(manifest.fileStats, backupRelPath) || changed;
      }
    }
    return changed;
  }
}
