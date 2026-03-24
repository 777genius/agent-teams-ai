import { getAppDataPath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import type { AttachmentMediaType, TaskAttachmentMeta } from '@shared/types';

const logger = createLogger('Service:TeamTaskAttachmentStore');

const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024; // 20 MB

export class TeamTaskAttachmentStore {
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

  private sanitizeStoredFilename(original: string): string {
    const raw = String(original ?? '').trim();
    const base = raw ? (raw.split(/[\\/]/).pop() ?? raw) : '';
    const cleaned = base
      .replace(/\0/g, '')
      .replace(/[\r\n\t]/g, ' ')
      .replace(/[\\/]/g, '_')
      .trim();
    if (!cleaned) return 'attachment';
    // Keep filenames bounded to avoid OS/path length issues.
    return cleaned.length > 180 ? cleaned.slice(0, 180) : cleaned;
  }

  /** Returns the file path for a stored attachment (new format). */
  private getStoredFilePath(
    teamName: string,
    taskId: string,
    attachmentId: string,
    filename: string
  ): string {
    this.assertSafePathSegment('attachmentId', attachmentId);
    const safeName = this.sanitizeStoredFilename(filename);
    return path.join(this.getTaskDir(teamName, taskId), `${attachmentId}--${safeName}`);
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

    const filePath = this.getStoredFilePath(teamName, taskId, attachmentId, filename);
    await fs.promises.writeFile(filePath, buffer);

    const meta: TaskAttachmentMeta = {
      id: attachmentId,
      filename,
      mimeType,
      size: buffer.length,
      addedAt: new Date().toISOString(),
      filePath,
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

    // Clean up empty directory
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
