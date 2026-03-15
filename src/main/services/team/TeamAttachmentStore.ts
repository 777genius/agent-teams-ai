import { getAppDataPath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';

import type { AttachmentFileData, AttachmentPayload } from '@shared/types';

const logger = createLogger('Service:TeamAttachmentStore');

const MAX_ATTACHMENTS_FILE_BYTES = 64 * 1024 * 1024; // 64MB safety cap

export class TeamAttachmentStore {
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

  private getDir(teamName: string): string {
    this.assertSafePathSegment('teamName', teamName);
    return path.join(getAppDataPath(), 'attachments', teamName);
  }

  private getFilePath(teamName: string, messageId: string): string {
    this.assertSafePathSegment('messageId', messageId);
    return path.join(this.getDir(teamName), `${messageId}.json`);
  }

  async saveAttachments(
    teamName: string,
    messageId: string,
    attachments: AttachmentPayload[]
  ): Promise<void> {
    if (attachments.length === 0) return;

    const fileData: AttachmentFileData[] = attachments.map((a) => ({
      id: a.id,
      data: a.data,
      mimeType: a.mimeType,
    }));

    await atomicWriteAsync(this.getFilePath(teamName, messageId), JSON.stringify(fileData));
    logger.debug(
      `[${teamName}] Saved ${attachments.length} attachment(s) for message ${messageId}`
    );
  }

  async getAttachments(teamName: string, messageId: string): Promise<AttachmentFileData[]> {
    const filePath = this.getFilePath(teamName, messageId);

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
}
