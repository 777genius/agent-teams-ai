import {
  type DurablePathRemovalProofHooks,
  removePathWithIdentityFenceAsync,
} from '@main/utils/atomicWrite';
import { getAppDataPath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';

import type { AttachmentFileData, AttachmentPayload } from '@shared/types';

const logger = createLogger('Service:TeamAttachmentStore');

const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024; // 20 MB per file
const MAX_ATTACHMENTS_FILE_BYTES = 64 * 1024 * 1024; // 64MB legacy JSON cap
const TEAM_ATTACHMENT_DELETE_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 50,
} as const;

/** Per-attachment metadata stored in the index file. */
interface StoredAttachmentIndex {
  id: string;
  filename: string;
  mimeType: string;
}

export class TeamAttachmentStore {
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

  private sanitizeStoredFilename(original: string): string {
    const raw = String(original ?? '').trim();
    const base = raw ? (raw.split(/[\\/]/).pop() ?? raw) : '';
    const cleaned = base
      .replace(/\0/g, '')
      .replace(/[\r\n\t]/g, ' ')
      .replace(/[\\/]/g, '_')
      .trim();
    if (!cleaned) return 'attachment';
    return cleaned.length > 180 ? cleaned.slice(0, 180) : cleaned;
  }

  /** Base directory for all message attachments of a team. */
  private getTeamDir(teamName: string): string {
    this.assertSafePathSegment('teamName', teamName);
    return path.join(getAppDataPath(), 'attachments', teamName);
  }

  async deleteTeamAttachments(
    teamName: string,
    isDeletionTargetCurrent: (detachedPath?: string) => Promise<boolean> = async () => true,
    proofHooks?: DurablePathRemovalProofHooks
  ): Promise<boolean> {
    const teamDir = this.getTeamDir(teamName);
    const removal = await removePathWithIdentityFenceAsync(teamDir, {
      ...TEAM_ATTACHMENT_DELETE_OPTIONS,
      durability: 'strict',
      reservePublicDirectory: true,
      validateDetached: (detachedPath) => isDeletionTargetCurrent(detachedPath),
      ...(proofHooks ? { proofHooks } : {}),
    });
    return proofHooks ? removal === 'deleted' : removal !== 'changed';
  }

  /** Directory for a specific message's attachments (new file-based format). */
  private getMessageDir(teamName: string, messageId: string): string {
    this.assertSafePathSegment('messageId', messageId);
    return path.join(this.getTeamDir(teamName), messageId);
  }

  /** Path to the metadata index file inside a message attachment directory. */
  private getIndexPath(teamName: string, messageId: string): string {
    return path.join(this.getMessageDir(teamName, messageId), '_index.json');
  }

  /** Legacy JSON bundle path (old format). */
  private getLegacyFilePath(teamName: string, messageId: string): string {
    this.assertSafePathSegment('messageId', messageId);
    return path.join(this.getTeamDir(teamName), `${messageId}.json`);
  }

  /** Stored file path for an individual attachment. */
  private getStoredFilePath(
    teamName: string,
    messageId: string,
    attachmentId: string,
    filename: string
  ): string {
    this.assertSafePathSegment('attachmentId', attachmentId);
    const safeName = this.sanitizeStoredFilename(filename);
    return path.join(this.getMessageDir(teamName, messageId), `${attachmentId}--${safeName}`);
  }

  /**
   * Save message attachments as individual files on disk.
   * Returns a Map of attachmentId → absolute file path for each saved file.
   */
  async saveAttachments(
    teamName: string,
    messageId: string,
    attachments: AttachmentPayload[]
  ): Promise<Map<string, string>> {
    const filePaths = new Map<string, string>();
    if (attachments.length === 0) return filePaths;

    const dir = this.getMessageDir(teamName, messageId);
    await fs.promises.mkdir(dir, { recursive: true });

    const indexEntries: StoredAttachmentIndex[] = [];

    for (const att of attachments) {
      const buffer = Buffer.from(att.data, 'base64');
      if (buffer.length > MAX_ATTACHMENT_SIZE) {
        logger.warn(
          `[${teamName}] Skipping oversized attachment ${att.id} (${(buffer.length / (1024 * 1024)).toFixed(1)} MB)`
        );
        continue;
      }

      const storedPath = this.getStoredFilePath(teamName, messageId, att.id, att.filename);
      try {
        await atomicWriteAsync(storedPath, buffer);
      } catch (writeError) {
        logger.warn(`[${teamName}] Failed to write attachment ${att.id}: ${writeError}`);
        continue;
      }
      filePaths.set(att.id, storedPath);

      indexEntries.push({
        id: att.id,
        filename: att.filename,
        mimeType: att.mimeType,
      });
    }

    // Write metadata index for successful files (mimeType, original filename)
    if (indexEntries.length > 0) {
      const indexPath = this.getIndexPath(teamName, messageId);
      await atomicWriteAsync(indexPath, JSON.stringify(indexEntries, null, 2));
    }

    logger.debug(
      `[${teamName}] Saved ${filePaths.size} attachment file(s) for message ${messageId}`
    );
    return filePaths;
  }

  /**
   * Returns a Map of attachmentId → absolute file path.
   * Only available for new file-based format. Legacy JSON bundles have no individual file paths.
   */
  async getAttachmentFilePaths(teamName: string, messageId: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    // Try new file-based format first
    const dir = this.getMessageDir(teamName, messageId);
    try {
      const entries = await fs.promises.readdir(dir);
      for (const entry of entries) {
        if (entry === '_index.json') continue;
        const dashIdx = entry.indexOf('--');
        if (dashIdx > 0) {
          const attachmentId = entry.slice(0, dashIdx);
          result.set(attachmentId, path.join(dir, entry));
        }
      }
      if (result.size > 0) return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    // No new-format files found — not available for legacy format
    return result;
  }

  /**
   * Read attachment data (base64) for rendering in UI.
   * Supports both new file-based format and legacy JSON bundle.
   */
  async getAttachments(teamName: string, messageId: string): Promise<AttachmentFileData[]> {
    // Try new file-based format first
    const newResult = await this.readNewFormatAttachments(teamName, messageId);
    if (newResult !== null) return newResult;

    // Fallback to legacy JSON format
    return this.readLegacyAttachments(teamName, messageId);
  }

  /** Read attachments from new file-based directory format. */
  private async readNewFormatAttachments(
    teamName: string,
    messageId: string
  ): Promise<AttachmentFileData[] | null> {
    const indexPath = this.getIndexPath(teamName, messageId);

    let indexRaw: string;
    try {
      indexRaw = await fs.promises.readFile(indexPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    let index: StoredAttachmentIndex[];
    try {
      const parsed = JSON.parse(indexRaw) as unknown;
      if (!Array.isArray(parsed)) return null;
      index = parsed as StoredAttachmentIndex[];
    } catch {
      return null;
    }

    const result: AttachmentFileData[] = [];
    for (const entry of index) {
      if (!entry || typeof entry.id !== 'string') continue;
      const filename =
        typeof entry.filename === 'string' && entry.filename ? entry.filename : 'attachment';
      const mimeType =
        typeof entry.mimeType === 'string' && entry.mimeType
          ? entry.mimeType
          : 'application/octet-stream';
      const filePath = this.getStoredFilePath(teamName, messageId, entry.id, filename);
      try {
        const buffer = await fs.promises.readFile(filePath);
        result.push({
          id: entry.id,
          data: buffer.toString('base64'),
          mimeType,
          filePath,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
    }

    return result;
  }

  /** Read attachments from legacy JSON bundle format. */
  private async readLegacyAttachments(
    teamName: string,
    messageId: string
  ): Promise<AttachmentFileData[]> {
    const filePath = this.getLegacyFilePath(teamName, messageId);

    let raw: string;
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile() || stat.size > MAX_ATTACHMENTS_FILE_BYTES) {
        return [];
      }
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }

    if (!Array.isArray(parsed)) {
      return [];
    }

    const result: AttachmentFileData[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Partial<AttachmentFileData>;
      if (
        typeof row.id !== 'string' ||
        typeof row.data !== 'string' ||
        typeof row.mimeType !== 'string'
      ) {
        continue;
      }
      result.push({
        id: row.id,
        data: row.data,
        mimeType: row.mimeType,
      });
    }

    return result;
  }

  // TODO: add deleteAttachments(teamName, messageId) for cleanup on failed/cancelled sends.
  // Best-effort removal of attachment files — useful for retry/cancel flows.
}
