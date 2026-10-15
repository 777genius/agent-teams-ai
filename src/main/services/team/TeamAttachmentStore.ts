import {
  type DurablePathRemovalProofHooks,
  removePathWithIdentityFenceAsync,
} from '@main/utils/atomicWrite';
import { atomicCreateAsync } from '@main/utils/atomicWrite';
import { getAppDataPath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';
import { withFileLock } from './fileLock';

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
  size?: number;
  sha256?: string;
  nativeAttachmentDeliveryVersion?: 1;
}

interface PendingNativeAttachmentDescriptor {
  schemaVersion: 1;
  state: 'pending';
  attachments: StoredAttachmentIndex[];
}

export interface NativeStoredAttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  filePath: string;
  sha256: string;
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

  private getPendingNativePath(teamName: string, messageId: string): string {
    return path.join(this.getMessageDir(teamName, messageId), '_pending-native.json');
  }

  private getMessageLockPath(teamName: string, messageId: string): string {
    return `${this.getMessageDir(teamName, messageId)}.lock`;
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
    if (attachments.length === 0) return new Map();

    return withFileLock(this.getMessageLockPath(teamName, messageId), async () => {
      const filePaths = new Map<string, string>();
      const dir = this.getMessageDir(teamName, messageId);
      await fs.promises.mkdir(dir, { recursive: true });

      const existingIndex = await this.readStoredIndex(teamName, messageId, false);
      const pendingNative = await this.readPendingNativeDescriptor(teamName, messageId);
      const nativeOwners = [existingIndex, pendingNative].filter((index) =>
        this.isNativeOwnedIndex(index)
      );
      if (nativeOwners.length > 0) {
        const nativeRequest = this.toNativeStoredAttachments(teamName, messageId, attachments);
        for (const owner of nativeOwners) {
          await this.assertExactNativeBundle(owner, nativeRequest);
        }
        await this.completeNativeOwnedBundle(teamName, messageId, nativeRequest, attachments);
        for (const attachment of nativeRequest) filePaths.set(attachment.id, attachment.filePath);
        return filePaths;
      }

      const indexEntries: StoredAttachmentIndex[] = [];
      for (const att of attachments) {
        const buffer = this.decodeLegacyAttachment(att);
        if (buffer.length > MAX_ATTACHMENT_SIZE) {
          logger.warn(`[${teamName}] Skipping oversized or invalid attachment ${att.id}`);
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
        indexEntries.push({ id: att.id, filename: att.filename, mimeType: att.mimeType });
      }

      if (indexEntries.length > 0) {
        await atomicWriteAsync(
          this.getIndexPath(teamName, messageId),
          JSON.stringify(indexEntries, null, 2)
        );
      }

      logger.debug(
        `[${teamName}] Saved ${filePaths.size} attachment file(s) for message ${messageId}`
      );
      return filePaths;
    });
  }

  /**
   * Atomically complete a native-owned bundle. The canonical index is published last;
   * identical retries may complete files left by an interrupted or ENOSPC save.
   */
  async saveNativeAttachments(
    teamName: string,
    messageId: string,
    attachments: AttachmentPayload[]
  ): Promise<NativeStoredAttachmentMeta[]> {
    await this.assertManagedBundlePaths(teamName, messageId, attachments);
    return withFileLock(this.getMessageLockPath(teamName, messageId), async () => {
      const stored = this.toNativeStoredAttachments(teamName, messageId, attachments);
      const existingIndex = await this.readStoredIndex(teamName, messageId, true);
      const pendingNative = await this.readPendingNativeDescriptor(teamName, messageId);
      if (existingIndex.length > 0) {
        await this.assertExactNativeBundle(existingIndex, stored);
      }
      if (pendingNative.length > 0) {
        await this.assertExactNativeBundle(pendingNative, stored);
      }

      await fs.promises.mkdir(this.getMessageDir(teamName, messageId), {
        recursive: true,
        mode: 0o700,
      });
      if (pendingNative.length === 0 && !this.isNativeOwnedIndex(existingIndex)) {
        await this.createPendingNativeDescriptor(
          teamName,
          messageId,
          stored.map((attachment) => this.toStoredAttachmentIndex(attachment))
        );
      }
      await this.completeNativeOwnedBundle(teamName, messageId, stored, attachments);
      for (const attachment of stored) {
        attachment.filePath = await this.verifyNativeArtifact(teamName, messageId, attachment);
      }
      return stored;
    });
  }

  /** Pin the bytes and managed pathname to the same artifact before returning a descriptor. */
  private async verifyNativeArtifact(
    teamName: string,
    messageId: string,
    attachment: NativeStoredAttachmentMeta
  ): Promise<string> {
    // Only the configured app-data parent may be aliased. Managed descendants must be real dirs.
    const canonicalBase = await fs.promises.realpath(getAppDataPath());
    const directories = [
      canonicalBase,
      path.join(canonicalBase, 'attachments'),
      path.join(canonicalBase, 'attachments', teamName),
      path.join(canonicalBase, 'attachments', teamName, messageId),
    ];
    const sameIdentity = (left: fs.Stats, right: fs.Stats): boolean =>
      left.dev === right.dev && left.ino === right.ino;
    const directoryStats: fs.Stats[] = [];
    for (const directory of directories) {
      const stat = await fs.promises.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Attachment directory must not be a symlink');
      directoryStats.push(stat);
    }
    const canonicalPath = path.join(directories[3], path.basename(attachment.filePath));
    const leaf = await fs.promises.lstat(canonicalPath);
    if (!leaf.isFile() || leaf.isSymbolicLink())
      throw new Error('Attachment artifact must be a regular file');
    const handle = await fs.promises.open(
      canonicalPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
    );
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !sameIdentity(leaf, opened))
        throw new Error(`Attachment artifact changed: ${attachment.id}`);
      const bytes = await handle.readFile();
      if (
        bytes.length !== attachment.size ||
        createHash('sha256').update(bytes).digest('hex') !== attachment.sha256
      ) {
        throw new Error(`Attachment artifact changed: ${attachment.id}`);
      }
      const verified = await handle.stat();
      if (
        !sameIdentity(opened, verified) ||
        opened.size !== verified.size ||
        opened.mtimeMs !== verified.mtimeMs ||
        opened.ctimeMs !== verified.ctimeMs
      )
        throw new Error(`Attachment artifact changed: ${attachment.id}`);
      // Identity checks remain mandatory when O_NOFOLLOW is unavailable (including Windows).
      if ((await fs.promises.realpath(getAppDataPath())) !== canonicalBase)
        throw new Error('Attachment managed parent changed');
      for (let index = 0; index < directories.length; index += 1) {
        const current = await fs.promises.lstat(directories[index]);
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          !sameIdentity(directoryStats[index], current)
        )
          throw new Error('Attachment managed directory changed');
      }
      const current = await fs.promises.lstat(canonicalPath);
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        !sameIdentity(verified, current) ||
        current.size !== verified.size ||
        current.mtimeMs !== verified.mtimeMs ||
        current.ctimeMs !== verified.ctimeMs
      )
        throw new Error(`Attachment artifact changed: ${attachment.id}`);
      // Never resolve the leaf after its read: that lookup could select an unchecked outside target.
      return canonicalPath;
    } finally {
      await handle.close();
    }
  }

  private async completeNativeOwnedBundle(
    teamName: string,
    messageId: string,
    stored: readonly NativeStoredAttachmentMeta[],
    attachments: readonly AttachmentPayload[]
  ): Promise<void> {
    for (let index = 0; index < stored.length; index += 1) {
      await this.createOrReuseImmutableAttachment(stored[index], attachments[index]);
    }

    const indexEntries: StoredAttachmentIndex[] = stored.map((attachment) =>
      this.toStoredAttachmentIndex(attachment)
    );
    await atomicWriteAsync(
      this.getIndexPath(teamName, messageId),
      JSON.stringify(indexEntries, null, 2),
      { mode: 0o600, directoryMode: 0o700, durability: 'strict', syncDirectory: true }
    );
  }

  private toNativeStoredAttachments(
    teamName: string,
    messageId: string,
    attachments: AttachmentPayload[]
  ): NativeStoredAttachmentMeta[] {
    const ids = new Set<string>();
    return attachments.map((attachment) => {
      this.assertSafePathSegment('attachmentId', attachment.id);
      if (ids.has(attachment.id)) throw new Error(`Duplicate attachment ID: ${attachment.id}`);
      ids.add(attachment.id);
      const buffer = this.decodeNativeAttachment(attachment);
      if (buffer === null) throw new Error(`Invalid attachment data: ${attachment.id}`);
      if (buffer.length !== attachment.size) {
        throw new Error(`Attachment size mismatch: ${attachment.id}`);
      }
      return {
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: buffer.length,
        filePath: this.getStoredFilePath(teamName, messageId, attachment.id, attachment.filename),
        sha256: createHash('sha256').update(buffer).digest('hex'),
      };
    });
  }

  private async assertRegularArtifact(filePath: string, allowMissing = false): Promise<void> {
    try {
      const stat = await fs.promises.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error('Attachment artifact must be a regular file');
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  private async assertManagedBundlePaths(
    teamName: string,
    messageId: string,
    attachments: readonly AttachmentPayload[]
  ): Promise<void> {
    await fs.promises.mkdir(getAppDataPath(), { recursive: true, mode: 0o700 });
    const root = path.join(getAppDataPath(), 'attachments');
    const directories = [root, this.getTeamDir(teamName), this.getMessageDir(teamName, messageId)];
    for (const directory of directories) {
      try {
        const stat = await fs.promises.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error('Attachment directory must not be a symlink');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await fs.promises
          .mkdir(directory, { mode: 0o700 })
          .catch((failure: NodeJS.ErrnoException) => {
            if (failure.code !== 'EEXIST') throw failure;
          });
        const created = await fs.promises.lstat(directory);
        if (!created.isDirectory() || created.isSymbolicLink())
          throw new Error('Attachment directory must not be a symlink');
      }
    }
    for (const artifact of [
      this.getIndexPath(teamName, messageId),
      this.getPendingNativePath(teamName, messageId),
      `${this.getMessageLockPath(teamName, messageId)}.lock`,
      ...attachments.map((item) =>
        this.getStoredFilePath(teamName, messageId, item.id, item.filename)
      ),
    ]) {
      await this.assertRegularArtifact(artifact, true);
    }
  }

  private decodeLegacyAttachment(attachment: AttachmentPayload): Buffer {
    return Buffer.from(attachment.data, 'base64');
  }

  private decodeNativeAttachment(attachment: AttachmentPayload): Buffer | null {
    try {
      if (
        attachment.data.length === 0 ||
        attachment.data.length % 4 !== 0 ||
        attachment.data.length > Math.ceil(MAX_ATTACHMENT_SIZE / 3) * 4
      ) {
        return null;
      }
      const buffer = Buffer.from(attachment.data, 'base64');
      return buffer.toString('base64') === attachment.data && buffer.length <= MAX_ATTACHMENT_SIZE
        ? buffer
        : null;
    } catch {
      return null;
    }
  }

  private toStoredAttachmentIndex(attachment: NativeStoredAttachmentMeta): StoredAttachmentIndex {
    return {
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      sha256: attachment.sha256,
      nativeAttachmentDeliveryVersion: 1,
    };
  }

  private async readPendingNativeDescriptor(
    teamName: string,
    messageId: string
  ): Promise<StoredAttachmentIndex[]> {
    try {
      const raw = await fs.promises.readFile(
        this.getPendingNativePath(teamName, messageId),
        'utf8'
      );
      const parsed = JSON.parse(raw) as Partial<PendingNativeAttachmentDescriptor>;
      if (
        parsed.schemaVersion !== 1 ||
        parsed.state !== 'pending' ||
        !Array.isArray(parsed.attachments) ||
        !this.isNativeOwnedIndex(parsed.attachments)
      ) {
        throw new Error('Pending native attachment descriptor is invalid');
      }
      return parsed.attachments;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async createPendingNativeDescriptor(
    teamName: string,
    messageId: string,
    attachments: StoredAttachmentIndex[]
  ): Promise<void> {
    const descriptor: PendingNativeAttachmentDescriptor = {
      schemaVersion: 1,
      state: 'pending',
      attachments,
    };
    try {
      await atomicCreateAsync(
        this.getPendingNativePath(teamName, messageId),
        JSON.stringify(descriptor, null, 2),
        { mode: 0o600 }
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.readPendingNativeDescriptor(teamName, messageId);
      await this.assertExactNativeBundle(
        existing,
        this.fromStoredAttachmentIndex(teamName, messageId, attachments)
      );
    }
  }

  private fromStoredAttachmentIndex(
    teamName: string,
    messageId: string,
    attachments: readonly StoredAttachmentIndex[]
  ): NativeStoredAttachmentMeta[] {
    return attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size ?? 0,
      filePath: this.getStoredFilePath(teamName, messageId, attachment.id, attachment.filename),
      sha256: attachment.sha256 ?? '',
    }));
  }

  private async readStoredIndex(
    teamName: string,
    messageId: string,
    strict: boolean
  ): Promise<StoredAttachmentIndex[]> {
    try {
      const raw = await fs.promises.readFile(this.getIndexPath(teamName, messageId), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('Attachment index is invalid');
      return parsed as StoredAttachmentIndex[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      if (strict) throw error;
      return [];
    }
  }

  private isNativeOwnedIndex(index: readonly StoredAttachmentIndex[]): boolean {
    return index.length > 0 && index.every((entry) => entry.nativeAttachmentDeliveryVersion === 1);
  }

  private async assertExactNativeBundle(
    existing: readonly StoredAttachmentIndex[],
    incoming: readonly NativeStoredAttachmentMeta[]
  ): Promise<void> {
    if (existing.length !== incoming.length) {
      throw new Error('Attachment bundle conflict for immutable message ID');
    }
    for (let index = 0; index < incoming.length; index += 1) {
      const left = existing[index];
      const right = incoming[index];
      if (
        left?.id !== right.id ||
        left.filename !== right.filename ||
        left.mimeType !== right.mimeType ||
        left.size !== right.size ||
        left.sha256 !== right.sha256
      ) {
        throw new Error(`Attachment bundle conflict for immutable message ID: ${right.id}`);
      }
      await this.assertRegularArtifact(right.filePath, true);
      const current = await fs.promises.readFile(right.filePath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (current === null) continue;
      if (createHash('sha256').update(current).digest('hex') !== right.sha256) {
        throw new Error(`Attachment artifact changed for immutable message ID: ${right.id}`);
      }
    }
  }

  private async createOrReuseImmutableAttachment(
    attachment: NativeStoredAttachmentMeta,
    payload: AttachmentPayload
  ): Promise<void> {
    const data = this.decodeNativeAttachment(payload);
    if (data === null) throw new Error(`Invalid attachment data: ${attachment.id}`);
    try {
      await atomicCreateAsync(attachment.filePath, data, { mode: 0o600 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await this.assertRegularArtifact(attachment.filePath);
    const current = await fs.promises.readFile(attachment.filePath);
    if (createHash('sha256').update(current).digest('hex') !== attachment.sha256) {
      throw new Error(`Attachment artifact conflict: ${attachment.id}`);
    }
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
