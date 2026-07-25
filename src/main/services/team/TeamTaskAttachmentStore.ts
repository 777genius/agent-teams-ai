import { randomUUID } from 'node:crypto';

import { KeyedMutex } from '@features/internal-storage/main';
import {
  estimateTaskAttachmentDecodedBytes,
  isCanonicalTaskAttachmentBase64,
  isCanonicalTaskAttachmentId,
  TEAM_TASK_ATTACHMENT_MAX_BASE64_LENGTH,
  TEAM_TASK_ATTACHMENT_MAX_DECODED_BYTES,
} from '@features/team-task-board';
import { atomicCreateAsync } from '@main/utils/atomicWrite';
import { getAppDataPath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import type { AttachmentMediaType, TaskAttachmentMeta } from '@shared/types';

const logger = createLogger('Service:TeamTaskAttachmentStore');
const attachmentMutationMutex = new KeyedMutex();

export interface TaskAttachmentAtomicCreatorPort {
  /**
   * Publishes bytes without overwriting an existing target. Implementations
   * must preserve EEXIST collisions and leave no partial target on failure.
   */
  createFileAtomically(filePath: string, data: Buffer): Promise<TaskAttachmentFileIdentity>;
}

export interface TaskAttachmentFileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface SavedTaskAttachmentReceipt {
  readonly filePath: string;
  readonly metadata: TaskAttachmentMeta;
  readonly identity: TaskAttachmentFileIdentity;
  readonly teamName: string;
  readonly taskId: string;
}

const nodeTaskAttachmentAtomicCreator: TaskAttachmentAtomicCreatorPort = {
  createFileAtomically: atomicCreateAsync,
};

export class TeamTaskAttachmentStore {
  constructor(
    private readonly atomicCreator: TaskAttachmentAtomicCreatorPort = nodeTaskAttachmentAtomicCreator
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

  private getAttachmentMutationKey(teamName: string, taskId: string, attachmentId: string): string {
    this.assertSafePathSegment('attachmentId', attachmentId);
    return path.join(this.getTaskDir(teamName, taskId), `${attachmentId}--attachment`);
  }

  /** Returns a generation-unique path so stale rollback receipts can never address a later save. */
  private getStoredFilePath(teamName: string, taskId: string, attachmentId: string): string {
    return path.join(
      this.getTaskDir(teamName, taskId),
      `${attachmentId}--${randomUUID()}.attachment`
    );
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

    const mutationKey = this.getAttachmentMutationKey(teamName, taskId, attachmentId);
    return attachmentMutationMutex.run(mutationKey, async () => {
      const existingPath = await this.findAttachmentFilePath(teamName, taskId, attachmentId);
      if (existingPath) {
        const collision = new Error(
          `Task attachment already exists: ${attachmentId}`
        ) as NodeJS.ErrnoException;
        collision.code = 'EEXIST';
        throw collision;
      }

      const filePath = this.getStoredFilePath(teamName, taskId, attachmentId);
      const identity = await this.atomicCreator.createFileAtomically(filePath, buffer);
      const metadata: TaskAttachmentMeta = {
        id: attachmentId,
        filename,
        mimeType,
        size: buffer.length,
        addedAt: new Date().toISOString(),
        filePath,
      };

      logger.debug(`[${teamName}] Saved task attachment ${attachmentId} for task #${taskId}`);
      return { filePath, metadata, identity, teamName, taskId };
    });
  }

  async rollbackAttachment(receipt: SavedTaskAttachmentReceipt): Promise<void> {
    const mutationKey = this.getAttachmentMutationKey(
      receipt.teamName,
      receipt.taskId,
      receipt.metadata.id
    );
    const taskDirectory = this.getTaskDir(receipt.teamName, receipt.taskId);
    const filePath = path.resolve(receipt.filePath);
    if (
      path.dirname(filePath) !== path.resolve(taskDirectory) ||
      !path.basename(filePath).startsWith(`${receipt.metadata.id}--`)
    ) {
      throw new Error('Invalid task attachment rollback receipt');
    }
    await attachmentMutationMutex.run(mutationKey, async () => {
      let stats: fs.Stats;
      try {
        stats = await fs.promises.lstat(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      if (
        !stats.isFile() ||
        stats.isSymbolicLink() ||
        receipt.identity.ino === 0 ||
        stats.dev !== receipt.identity.dev ||
        stats.ino !== receipt.identity.ino
      ) {
        return;
      }

      try {
        await fs.promises.unlink(filePath);
        logger.debug(
          `[${receipt.teamName}] Rolled back task attachment ${receipt.metadata.id} for task #${receipt.taskId}`
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      await this.cleanupEmptyTaskDirectory(receipt.teamName, receipt.taskId);
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
    const lockKey = this.getAttachmentMutationKey(teamName, taskId, attachmentId);
    await attachmentMutationMutex.run(lockKey, async () => {
      const filePath = await this.findAttachmentFilePath(teamName, taskId, attachmentId, mimeType);
      if (!filePath) return;

      try {
        await fs.promises.unlink(filePath);
        logger.debug(`[${teamName}] Deleted task attachment ${attachmentId} for task #${taskId}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }

      await this.cleanupEmptyTaskDirectory(teamName, taskId);
    });
  }

  private async cleanupEmptyTaskDirectory(teamName: string, taskId: string): Promise<void> {
    const dir = this.getTaskDir(teamName, taskId);
    try {
      const entries = await fs.promises.readdir(dir);
      if (entries.length === 0) {
        await fs.promises.rm(dir, { recursive: true });
      }
    } catch {
      // ignore cleanup errors
    }
  }
}
