import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import type { AttachmentMediaType, TaskAttachmentMeta } from '@shared/types';

const logger = createLogger('Service:TeamTaskAttachmentStore');

const TASK_ATTACHMENTS_DIR = 'task-attachments';
const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024; // 20 MB

const ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set<AttachmentMediaType>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export class TeamTaskAttachmentStore {
  private assertSafePathSegment(label: string, value: string): void {
    if (
      value.length === 0 ||
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
    return path.join(getTeamsBasePath(), teamName, TASK_ATTACHMENTS_DIR, taskId);
  }

  /** Returns the file path for a specific attachment. */
  private getFilePath(teamName: string, taskId: string, attachmentId: string, ext: string): string {
    this.assertSafePathSegment('attachmentId', attachmentId);
    return path.join(this.getTaskDir(teamName, taskId), `${attachmentId}${ext}`);
  }

  /** Map MIME type to file extension. */
  private mimeToExt(mimeType: AttachmentMediaType): string {
    switch (mimeType) {
      case 'image/png':
        return '.png';
      case 'image/jpeg':
        return '.jpg';
      case 'image/gif':
        return '.gif';
      case 'image/webp':
        return '.webp';
    }
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
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new Error(`Unsupported MIME type: ${mimeType}`);
    }

    const trimmed = base64Data.trim();
    // Avoid allocating huge Buffers for obviously too-large payloads.
    // Base64 decoded size is roughly 3/4 of the string length minus padding.
    const padding = trimmed.endsWith('==') ? 2 : trimmed.endsWith('=') ? 1 : 0;
    const estimatedBytes = Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding);
    if (estimatedBytes > MAX_ATTACHMENT_SIZE) {
      throw new Error(
        `Attachment too large: ${(estimatedBytes / (1024 * 1024)).toFixed(1)} MB (max ${MAX_ATTACHMENT_SIZE / (1024 * 1024)} MB)`
      );
    }

    const buffer = Buffer.from(trimmed, 'base64');
    if (buffer.length > MAX_ATTACHMENT_SIZE) {
      throw new Error(
        `Attachment too large: ${(buffer.length / (1024 * 1024)).toFixed(1)} MB (max ${MAX_ATTACHMENT_SIZE / (1024 * 1024)} MB)`
      );
    }

    const dir = this.getTaskDir(teamName, taskId);
    await fs.promises.mkdir(dir, { recursive: true });

    const ext = this.mimeToExt(mimeType);
    const filePath = this.getFilePath(teamName, taskId, attachmentId, ext);
    await fs.promises.writeFile(filePath, buffer);

    const meta: TaskAttachmentMeta = {
      id: attachmentId,
      filename,
      mimeType,
      size: buffer.length,
      addedAt: new Date().toISOString(),
    };

    logger.debug(`[${teamName}] Saved task attachment ${attachmentId} for task #${taskId}`);
    return meta;
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
    const ext = this.mimeToExt(mimeType);
    const filePath = this.getFilePath(teamName, taskId, attachmentId, ext);

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
    const ext = this.mimeToExt(mimeType);
    const filePath = this.getFilePath(teamName, taskId, attachmentId, ext);

    try {
      await fs.promises.unlink(filePath);
      logger.debug(`[${teamName}] Deleted task attachment ${attachmentId} for task #${taskId}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    // Clean up empty directory
    const dir = this.getTaskDir(teamName, taskId);
    try {
      const entries = await fs.promises.readdir(dir);
      if (entries.length === 0) {
        await fs.promises.rmdir(dir);
      }
    } catch {
      // ignore cleanup errors
    }
  }
}
