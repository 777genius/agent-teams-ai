import {
  estimateTaskAttachmentDecodedBytes,
  isCanonicalTaskAttachmentBase64,
  isCanonicalTaskAttachmentId,
  TEAM_TASK_ATTACHMENT_MAX_BASE64_LENGTH,
  TEAM_TASK_ATTACHMENT_MAX_DECODED_BYTES,
} from '@features/team-task-board';
import {
  atomicCreateAsync,
  cleanupAtomicCreateTempLinks,
  type DurablePathRemovalProofHooks,
  removePathWithIdentityFenceAsync,
} from '@main/utils/atomicWrite';
import { getAppDataPath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  NodeTaskAttachmentMutationCoordinator,
  type TaskAttachmentMutationCoordinatorPort,
  type TaskAttachmentMutationGuard,
} from './TaskAttachmentMutationCoordinator';

import type { AttachmentMediaType, TaskAttachmentMeta } from '@shared/types';
import type { FileHandle } from 'fs/promises';

const logger = createLogger('Service:TeamTaskAttachmentStore');
const nodeTaskAttachmentMutationCoordinator = new NodeTaskAttachmentMutationCoordinator();

export interface TaskAttachmentAtomicCreatorPort {
  /**
   * Publishes bytes without overwriting an existing target. Implementations
   * must preserve EEXIST collisions and leave no partial target on failure.
   */
  createFileAtomically(filePath: string, data: Buffer): Promise<TaskAttachmentFileIdentity>;
  /** Pins the published inode until delete or rollback can identify its exact generation. */
  createGenerationGuard?(filePath: string): Promise<string>;
  cleanupPublishedTempLinks(filePath: string): Promise<void>;
}

export interface TaskAttachmentFileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface SavedTaskAttachmentReceipt {
  readonly filePath: string;
  readonly metadata: TaskAttachmentMeta;
  readonly identity: TaskAttachmentFileIdentity;
  readonly generationGuardPath?: string;
  readonly teamName: string;
  readonly taskId: string;
}

const nodeTaskAttachmentAtomicCreator: TaskAttachmentAtomicCreatorPort = {
  createFileAtomically: atomicCreateAsync,
  async createGenerationGuard(filePath) {
    const guardPath = path.join(path.dirname(filePath), `.review-create.${randomUUID()}.tmp`);
    await fs.promises.link(filePath, guardPath);
    return guardPath;
  },
  cleanupPublishedTempLinks: cleanupAtomicCreateTempLinks,
};
const TEAM_TASK_ATTACHMENT_DELETE_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 50,
} as const;

export class TeamTaskAttachmentStore {
  constructor(
    private readonly atomicCreator: TaskAttachmentAtomicCreatorPort = nodeTaskAttachmentAtomicCreator,
    private readonly mutationCoordinator: TaskAttachmentMutationCoordinatorPort = nodeTaskAttachmentMutationCoordinator
  ) {}

  private assertSafePathSegment(label: string, value: string): void {
    if (
      value.length === 0 ||
      value.trim().length === 0 ||
      value === '.' ||
      value === '..' ||
      value.includes('/') ||
      value.includes('\\') ||
      value.includes('..') ||
      value.includes('\0')
    ) {
      throw new Error(`Invalid ${label}`);
    }
  }

  /** Returns the directory for a specific task's attachments. */
  private getTaskDir(teamName: string, taskId: string): string {
    this.assertSafePathSegment('teamName', teamName);
    this.assertSafePathSegment('taskId', taskId);
    return path.join(getAppDataPath(), 'task-attachments', teamName, taskId);
  }

  async deleteTeamAttachments(
    teamName: string,
    isDeletionTargetCurrent: (detachedPath?: string) => Promise<boolean> = async () => true,
    proofHooks?: DurablePathRemovalProofHooks
  ): Promise<boolean> {
    this.assertSafePathSegment('teamName', teamName);
    const attachmentsDir = path.join(getAppDataPath(), 'task-attachments');
    const removal = await removePathWithIdentityFenceAsync(path.join(attachmentsDir, teamName), {
      ...TEAM_TASK_ATTACHMENT_DELETE_OPTIONS,
      durability: 'strict',
      reservePublicDirectory: true,
      validateDetached: (detachedPath) => isDeletionTargetCurrent(detachedPath),
      ...(proofHooks ? { proofHooks } : {}),
    });
    return proofHooks ? removal === 'deleted' : removal !== 'changed';
  }

  private getTaskMutationKey(teamName: string, taskId: string): string {
    this.assertSafePathSegment('teamName', teamName);
    this.assertSafePathSegment('taskId', taskId);
    return path.join(getAppDataPath(), 'task-attachment-mutation-locks', teamName, taskId);
  }

  private async runTaskMutation<T>(
    teamName: string,
    taskId: string,
    operation: (guard: TaskAttachmentMutationGuard) => Promise<T>
  ): Promise<T> {
    const mutationKey = this.getTaskMutationKey(teamName, taskId);
    return this.mutationCoordinator.run(mutationKey, async (guard) => {
      try {
        return await operation(guard);
      } finally {
        await this.cleanupEmptyTaskDirectory(teamName, taskId);
      }
    });
  }

  /** A stable target lets the filesystem enforce same-ID uniqueness across app processes. */
  private getStoredFilePath(teamName: string, taskId: string, attachmentId: string): string {
    return path.join(this.getTaskDir(teamName, taskId), `${attachmentId}--attachment`);
  }

  private async findAttachmentFilePath(
    teamName: string,
    taskId: string,
    attachmentId: string,
    _mimeType?: string
  ): Promise<string | null> {
    const dir = this.getTaskDir(teamName, taskId);

    // Canonical format: "<id>--<filename>"
    try {
      const entries = await fs.promises.readdir(dir);
      const prefix = `${attachmentId}--`;
      const matches = entries.filter((e) => e.startsWith(prefix));
      if (matches.length > 0) {
        return path.join(dir, matches[0]);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Non-directory or other IO errors should surface.
      throw error;
    }

    return null;
  }

  /**
   * Save an attachment to disk. Data is expected as a base64-encoded string.
   * Returns metadata for the saved attachment.
   */
  async saveAttachment(
    teamName: string,
    taskId: string,
    attachmentId: string,
    filename: string,
    mimeType: AttachmentMediaType,
    base64Data: string
  ): Promise<TaskAttachmentMeta> {
    const receipt = await this.saveAttachmentWithReceipt(
      teamName,
      taskId,
      attachmentId,
      filename,
      mimeType,
      base64Data
    );
    await this.finalizeAttachment(receipt);
    return receipt.metadata;
  }

  async saveAttachmentWithReceipt(
    teamName: string,
    taskId: string,
    attachmentId: string,
    filename: string,
    mimeType: AttachmentMediaType,
    base64Data: string
  ): Promise<SavedTaskAttachmentReceipt> {
    if (!isCanonicalTaskAttachmentId(attachmentId)) {
      throw new Error('Attachment ID must be a canonical UUID');
    }

    const encoded = base64Data;
    if (encoded.length > TEAM_TASK_ATTACHMENT_MAX_BASE64_LENGTH) {
      throw new Error('Attachment payload exceeds the 20 MiB decoded size limit');
    }
    if (!isCanonicalTaskAttachmentBase64(encoded)) {
      throw new Error('Invalid attachment base64 data');
    }

    // Avoid allocating huge Buffers for obviously too-large payloads.
    const estimatedBytes = estimateTaskAttachmentDecodedBytes(encoded);
    if (estimatedBytes > TEAM_TASK_ATTACHMENT_MAX_DECODED_BYTES) {
      throw new Error(
        `Attachment too large: ${(estimatedBytes / (1024 * 1024)).toFixed(1)} MB (max ${TEAM_TASK_ATTACHMENT_MAX_DECODED_BYTES / (1024 * 1024)} MB)`
      );
    }

    const buffer = Buffer.from(encoded, 'base64');
    if (
      buffer.toString('base64') !== encoded ||
      buffer.length > TEAM_TASK_ATTACHMENT_MAX_DECODED_BYTES
    ) {
      throw new Error(
        buffer.length > TEAM_TASK_ATTACHMENT_MAX_DECODED_BYTES
          ? `Attachment too large: ${(buffer.length / (1024 * 1024)).toFixed(1)} MB (max ${TEAM_TASK_ATTACHMENT_MAX_DECODED_BYTES / (1024 * 1024)} MB)`
          : 'Invalid attachment base64 data'
      );
    }

    return this.runTaskMutation(teamName, taskId, async (guard) => {
      const existingPath = await this.findAttachmentFilePath(teamName, taskId, attachmentId);
      if (existingPath) {
        const collision = new Error(
          `Task attachment already exists: ${attachmentId}`
        ) as NodeJS.ErrnoException;
        collision.code = 'EEXIST';
        throw collision;
      }

      const filePath = this.getStoredFilePath(teamName, taskId, attachmentId);
      guard.assertHealthy();
      const identity = await this.atomicCreator.createFileAtomically(filePath, buffer);
      let generationGuardPath: string | undefined;
      try {
        generationGuardPath = await this.atomicCreator.createGenerationGuard?.(filePath);
      } catch (error) {
        await this.atomicCreator.cleanupPublishedTempLinks(filePath).catch(() => undefined);
        await fs.promises.unlink(filePath).catch(() => undefined);
        throw error;
      }
      if (!generationGuardPath) {
        try {
          await this.atomicCreator.cleanupPublishedTempLinks(filePath);
        } catch (error) {
          logger.warn(
            `[${teamName}] Failed to clean published attachment temp links for task #${taskId}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
      const metadata: TaskAttachmentMeta = {
        id: attachmentId,
        filename,
        mimeType,
        size: buffer.length,
        addedAt: new Date().toISOString(),
        filePath,
      };

      logger.debug(`[${teamName}] Saved task attachment ${attachmentId} for task #${taskId}`);
      return { filePath, metadata, identity, generationGuardPath, teamName, taskId };
    });
  }

  async finalizeAttachment(receipt: SavedTaskAttachmentReceipt): Promise<void> {
    const { filePath, generationGuardPath } = this.resolveReceiptPaths(receipt);
    if (!generationGuardPath) return;

    await this.runTaskMutation(receipt.teamName, receipt.taskId, async (guard) => {
      let generationGuard: FileHandle | null = null;
      try {
        try {
          generationGuard = await fs.promises.open(
            generationGuardPath,
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        }

        const guardedIdentity = await generationGuard.stat();
        if (
          receipt.identity.ino === 0 ||
          guardedIdentity.dev !== receipt.identity.dev ||
          guardedIdentity.ino !== receipt.identity.ino
        ) {
          return;
        }

        guard.assertHealthy();
        let publishedIdentity: fs.Stats | null = null;
        try {
          publishedIdentity = await fs.promises.lstat(filePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (
          publishedIdentity?.isFile() &&
          !publishedIdentity.isSymbolicLink() &&
          publishedIdentity.dev === guardedIdentity.dev &&
          publishedIdentity.ino === guardedIdentity.ino
        ) {
          await this.atomicCreator.cleanupPublishedTempLinks(filePath);
          return;
        }

        await fs.promises.unlink(generationGuardPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      } finally {
        await generationGuard?.close();
      }
    }).catch((error) => {
      logger.warn(
        `[${receipt.teamName}] Failed to finalize task attachment ${receipt.metadata.id} for task #${receipt.taskId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  }

  async rollbackAttachment(receipt: SavedTaskAttachmentReceipt): Promise<void> {
    const { filePath, generationGuardPath } = this.resolveReceiptPaths(receipt);
    await this.runTaskMutation(receipt.teamName, receipt.taskId, async (guard) => {
      let generationGuard: FileHandle | null = null;
      if (generationGuardPath) {
        try {
          generationGuard = await fs.promises.open(
            generationGuardPath,
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        }
      }

      let stats: fs.Stats;
      try {
        const guardedIdentity = generationGuard ? await generationGuard.stat() : receipt.identity;
        try {
          stats = await fs.promises.lstat(filePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            if (generationGuardPath) {
              await fs.promises.unlink(generationGuardPath).catch(() => undefined);
            }
            return;
          }
          throw error;
        }
        if (
          !stats.isFile() ||
          stats.isSymbolicLink() ||
          receipt.identity.ino === 0 ||
          guardedIdentity.dev !== receipt.identity.dev ||
          guardedIdentity.ino !== receipt.identity.ino ||
          stats.dev !== guardedIdentity.dev ||
          stats.ino !== guardedIdentity.ino
        ) {
          if (generationGuardPath) {
            await fs.promises.unlink(generationGuardPath).catch(() => undefined);
          }
          return;
        }

        guard.assertHealthy();
        await this.atomicCreator.cleanupPublishedTempLinks(filePath);
        guard.assertHealthy();
        try {
          await fs.promises.unlink(filePath);
          logger.debug(
            `[${receipt.teamName}] Rolled back task attachment ${receipt.metadata.id} for task #${receipt.taskId}`
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      } finally {
        await generationGuard?.close();
      }
    });
  }

  /**
   * Read an attachment file and return its base64 data.
   */
  async getAttachment(
    teamName: string,
    taskId: string,
    attachmentId: string,
    mimeType: AttachmentMediaType
  ): Promise<string | null> {
    const filePath = await this.findAttachmentFilePath(teamName, taskId, attachmentId, mimeType);
    if (!filePath) return null;

    try {
      const buffer = await fs.promises.readFile(filePath);
      return buffer.toString('base64');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Delete an attachment file from disk.
   */
  async deleteAttachment(
    teamName: string,
    taskId: string,
    attachmentId: string,
    mimeType: AttachmentMediaType
  ): Promise<void> {
    await this.runTaskMutation(teamName, taskId, async (guard) => {
      const filePath = await this.findAttachmentFilePath(teamName, taskId, attachmentId, mimeType);
      if (!filePath) return;

      guard.assertHealthy();
      await this.atomicCreator.cleanupPublishedTempLinks(filePath);
      guard.assertHealthy();
      try {
        await fs.promises.unlink(filePath);
        logger.debug(`[${teamName}] Deleted task attachment ${attachmentId} for task #${taskId}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    });
  }

  private resolveReceiptPaths(receipt: SavedTaskAttachmentReceipt): {
    filePath: string;
    generationGuardPath: string | null;
  } {
    const taskDirectory = this.getTaskDir(receipt.teamName, receipt.taskId);
    const filePath = path.resolve(receipt.filePath);
    if (
      path.dirname(filePath) !== path.resolve(taskDirectory) ||
      !path.basename(filePath).startsWith(`${receipt.metadata.id}--`)
    ) {
      throw new Error('Invalid task attachment receipt');
    }
    const generationGuardPath = receipt.generationGuardPath
      ? path.resolve(receipt.generationGuardPath)
      : null;
    if (
      generationGuardPath &&
      (path.dirname(generationGuardPath) !== path.resolve(taskDirectory) ||
        !/^\.review-create\.[a-f0-9-]+\.tmp$/i.test(path.basename(generationGuardPath)))
    ) {
      throw new Error('Invalid task attachment generation guard');
    }
    return { filePath, generationGuardPath };
  }

  private async cleanupEmptyTaskDirectory(teamName: string, taskId: string): Promise<void> {
    const dir = this.getTaskDir(teamName, taskId);
    try {
      await fs.promises.rmdir(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST') return;
      logger.warn(
        `[${teamName}] Failed to clean task attachment directory for task #${taskId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}
