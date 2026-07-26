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
import * as fs from 'fs';
import * as path from 'path';

import { isTaskAttachmentGenerationGuardName } from './TaskAttachmentArtifacts';
import {
  type DetachedTaskAttachmentGeneration,
  detachTaskAttachmentGeneration,
  finalizeDetachedTaskAttachmentGeneration,
  removeTaskAttachmentGenerationPin,
  restoreDetachedTaskAttachmentGeneration,
  type TaskAttachmentFileIdentity,
} from './TaskAttachmentGenerationLifecycle';
import {
  NodeTaskAttachmentMutationCoordinator,
  type TaskAttachmentMutationCoordinatorPort,
  type TaskAttachmentMutationGuard,
} from './TaskAttachmentMutationCoordinator';

import type { AttachmentMediaType, TaskAttachmentMeta } from '@shared/types';

const logger = createLogger('Service:TeamTaskAttachmentStore');
const nodeTaskAttachmentMutationCoordinator = new NodeTaskAttachmentMutationCoordinator();

export interface TaskAttachmentAtomicCreatorPort {
  /**
   * Publishes bytes without overwriting an existing target. Implementations
   * must preserve EEXIST collisions and leave no partial target on failure.
   */
  createPinnedFileAtomically(
    filePath: string,
    data: Buffer
  ): Promise<{ identity: TaskAttachmentFileIdentity; generationGuardPath: string }>;
  cleanupPublishedTempLinks(filePath: string): Promise<void>;
}

export type { TaskAttachmentFileIdentity } from './TaskAttachmentGenerationLifecycle';

export interface SavedTaskAttachmentReceipt {
  readonly filePath: string;
  readonly metadata: TaskAttachmentMeta;
  readonly identity: TaskAttachmentFileIdentity;
  readonly generationGuardPath?: string;
  readonly teamName: string;
  readonly taskId: string;
}

export interface StagedTaskAttachmentDeletionReceipt {
  readonly attachmentId: string;
  readonly teamName: string;
  readonly taskId: string;
  readonly generation: DetachedTaskAttachmentGeneration;
}

export interface TaskAttachmentTransaction {
  saveAttachmentWithReceipt(
    attachmentId: string,
    filename: string,
    mimeType: AttachmentMediaType,
    base64Data: string
  ): Promise<SavedTaskAttachmentReceipt>;
  finalizeAttachment(receipt: SavedTaskAttachmentReceipt): Promise<void>;
  rollbackAttachment(receipt: SavedTaskAttachmentReceipt): Promise<void>;
  stageAttachmentDeletion(
    attachmentId: string,
    mimeType: AttachmentMediaType
  ): Promise<StagedTaskAttachmentDeletionReceipt | null>;
  finalizeAttachmentDeletion(receipt: StagedTaskAttachmentDeletionReceipt): Promise<void>;
  rollbackAttachmentDeletion(receipt: StagedTaskAttachmentDeletionReceipt): Promise<void>;
  markCommitted(): void;
}

const nodeTaskAttachmentAtomicCreator: TaskAttachmentAtomicCreatorPort = {
  async createPinnedFileAtomically(filePath, data) {
    const created = await atomicCreateAsync(filePath, data, { retainPin: true });
    return {
      identity: { dev: created.dev, ino: created.ino },
      generationGuardPath: created.pinPath!,
    };
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
  private readonly pendingCompensations = new WeakMap<object, { dismiss(): void }>();

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

  async runTaskTransaction<T>(
    teamName: string,
    taskId: string,
    operation: (transaction: TaskAttachmentTransaction) => Promise<T>
  ): Promise<T> {
    return this.runTaskMutation(teamName, taskId, (guard) =>
      operation({
        saveAttachmentWithReceipt: (attachmentId, filename, mimeType, base64Data) =>
          this.saveAttachmentWithReceiptInMutation(
            teamName,
            taskId,
            attachmentId,
            filename,
            mimeType,
            this.decodeAttachmentPayload(attachmentId, base64Data),
            guard
          ),
        finalizeAttachment: (receipt) =>
          this.finalizeTransactionReceipt(receipt, teamName, taskId, guard),
        rollbackAttachment: (receipt) =>
          this.rollbackTransactionReceipt(receipt, teamName, taskId, guard),
        stageAttachmentDeletion: (attachmentId, mimeType) =>
          this.stageAttachmentDeletionInMutation(teamName, taskId, attachmentId, mimeType, guard),
        finalizeAttachmentDeletion: (receipt) =>
          this.finalizeAttachmentDeletionInMutation(receipt, teamName, taskId),
        rollbackAttachmentDeletion: (receipt) =>
          this.rollbackAttachmentDeletionInMutation(receipt, teamName, taskId),
        markCommitted: () => guard.markCommitted(),
      })
    );
  }

  private async finalizeTransactionReceipt(
    receipt: SavedTaskAttachmentReceipt,
    teamName: string,
    taskId: string,
    _guard: TaskAttachmentMutationGuard
  ): Promise<void> {
    this.assertTransactionReceiptScope(receipt, teamName, taskId);
    await this.finalizeAttachmentInMutation(receipt).catch((error) => {
      logger.warn(
        `[${receipt.teamName}] Failed to finalize task attachment ${receipt.metadata.id} for task #${receipt.taskId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  }

  private rollbackTransactionReceipt(
    receipt: SavedTaskAttachmentReceipt,
    teamName: string,
    taskId: string,
    guard: TaskAttachmentMutationGuard
  ): Promise<void> {
    this.assertTransactionReceiptScope(receipt, teamName, taskId);
    return this.rollbackAttachmentInMutation(receipt, guard, true);
  }

  private assertTransactionReceiptScope(
    receipt: SavedTaskAttachmentReceipt,
    teamName: string,
    taskId: string
  ): void {
    if (receipt.teamName !== teamName || receipt.taskId !== taskId) {
      throw new Error('Task attachment receipt belongs to another transaction');
    }
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
    const buffer = this.decodeAttachmentPayload(attachmentId, base64Data);
    return this.runTaskMutation(teamName, taskId, async (guard) => {
      const receipt = await this.saveAttachmentWithReceiptInMutation(
        teamName,
        taskId,
        attachmentId,
        filename,
        mimeType,
        buffer,
        guard
      );
      guard.markCommitted();
      await this.finalizeAttachmentInMutation(receipt).catch((error) => {
        logger.warn(
          `[${teamName}] Failed to finalize task attachment ${attachmentId} for task #${taskId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
      return receipt.metadata;
    });
  }

  async saveAttachmentWithReceipt(
    teamName: string,
    taskId: string,
    attachmentId: string,
    filename: string,
    mimeType: AttachmentMediaType,
    base64Data: string
  ): Promise<SavedTaskAttachmentReceipt> {
    const buffer = this.decodeAttachmentPayload(attachmentId, base64Data);
    return this.runTaskMutation(teamName, taskId, (guard) =>
      this.saveAttachmentWithReceiptInMutation(
        teamName,
        taskId,
        attachmentId,
        filename,
        mimeType,
        buffer,
        guard
      )
    );
  }

  private async saveAttachmentWithReceiptInMutation(
    teamName: string,
    taskId: string,
    attachmentId: string,
    filename: string,
    mimeType: AttachmentMediaType,
    buffer: Buffer,
    guard: TaskAttachmentMutationGuard
  ): Promise<SavedTaskAttachmentReceipt> {
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
    const { identity, generationGuardPath } = await this.atomicCreator.createPinnedFileAtomically(
      filePath,
      buffer
    );
    const metadata: TaskAttachmentMeta = {
      id: attachmentId,
      filename,
      mimeType,
      size: buffer.length,
      addedAt: new Date().toISOString(),
      filePath,
    };
    const receipt = { filePath, metadata, identity, generationGuardPath, teamName, taskId };
    const compensation = guard.registerCompensation(async () => {
      await this.rollbackAttachmentInMutation(receipt, guard, false);
      await this.cleanupEmptyTaskDirectory(teamName, taskId);
    });
    this.pendingCompensations.set(receipt, compensation);
    guard.assertHealthy();

    logger.debug(`[${teamName}] Saved task attachment ${attachmentId} for task #${taskId}`);
    return receipt;
  }

  private decodeAttachmentPayload(attachmentId: string, base64Data: string): Buffer {
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

    return buffer;
  }

  async finalizeAttachment(receipt: SavedTaskAttachmentReceipt): Promise<void> {
    await this.runTaskMutation(receipt.teamName, receipt.taskId, () =>
      this.finalizeAttachmentInMutation(receipt)
    ).catch((error) => {
      logger.warn(
        `[${receipt.teamName}] Failed to finalize task attachment ${receipt.metadata.id} for task #${receipt.taskId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  }

  private async finalizeAttachmentInMutation(receipt: SavedTaskAttachmentReceipt): Promise<void> {
    const { generationGuardPath } = this.resolveReceiptPaths(receipt);
    this.dismissCompensation(receipt);
    if (!generationGuardPath) return;
    await removeTaskAttachmentGenerationPin(generationGuardPath, receipt.identity);
  }

  async rollbackAttachment(receipt: SavedTaskAttachmentReceipt): Promise<void> {
    await this.runTaskMutation(receipt.teamName, receipt.taskId, (guard) =>
      this.rollbackAttachmentInMutation(receipt, guard, true)
    );
  }

  private async rollbackAttachmentInMutation(
    receipt: SavedTaskAttachmentReceipt,
    guard: TaskAttachmentMutationGuard,
    enforceHealthyLock: boolean
  ): Promise<void> {
    const { filePath, generationGuardPath } = this.resolveReceiptPaths(receipt);
    if (enforceHealthyLock) guard.assertHealthy();
    const detached = await detachTaskAttachmentGeneration(filePath, receipt.identity);
    if (detached.kind === 'detached') {
      await finalizeDetachedTaskAttachmentGeneration(detached.receipt);
      logger.debug(
        `[${receipt.teamName}] Rolled back task attachment ${receipt.metadata.id} for task #${receipt.taskId}`
      );
    }
    if (generationGuardPath) {
      await removeTaskAttachmentGenerationPin(generationGuardPath, receipt.identity);
    }
    this.dismissCompensation(receipt);
  }

  private dismissCompensation(receipt: object): void {
    this.pendingCompensations.get(receipt)?.dismiss();
    this.pendingCompensations.delete(receipt);
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
      const receipt = await this.stageAttachmentDeletionInMutation(
        teamName,
        taskId,
        attachmentId,
        mimeType,
        guard
      );
      guard.markCommitted();
      if (receipt) {
        await this.finalizeAttachmentDeletionInMutation(receipt, teamName, taskId);
      }
    });
  }

  private async stageAttachmentDeletionInMutation(
    teamName: string,
    taskId: string,
    attachmentId: string,
    mimeType: AttachmentMediaType,
    guard: TaskAttachmentMutationGuard
  ): Promise<StagedTaskAttachmentDeletionReceipt | null> {
    const filePath = await this.findAttachmentFilePath(teamName, taskId, attachmentId, mimeType);
    if (!filePath) return null;

    guard.assertHealthy();
    const publicGeneration = await fs.promises
      .lstat(filePath)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    if (!publicGeneration) return null;
    if (!publicGeneration.isFile() || publicGeneration.isSymbolicLink()) {
      throw new Error('Task attachment is not a regular file');
    }
    guard.assertHealthy();
    const detached = await detachTaskAttachmentGeneration(filePath, {
      dev: publicGeneration.dev,
      ino: publicGeneration.ino,
    });
    if (detached.kind === 'missing') return null;
    if (detached.kind === 'changed') {
      throw new Error('Task attachment changed while staging deletion');
    }

    const receipt: StagedTaskAttachmentDeletionReceipt = {
      attachmentId,
      teamName,
      taskId,
      generation: detached.receipt,
    };
    const compensation = guard.registerCompensation(async () => {
      await this.rollbackStagedAttachmentDeletion(receipt);
      await this.cleanupEmptyTaskDirectory(teamName, taskId);
    });
    this.pendingCompensations.set(receipt, compensation);
    guard.assertHealthy();
    return receipt;
  }

  private async finalizeAttachmentDeletionInMutation(
    receipt: StagedTaskAttachmentDeletionReceipt,
    teamName: string,
    taskId: string
  ): Promise<void> {
    this.assertDeletionReceiptScope(receipt, teamName, taskId);
    this.dismissCompensation(receipt);
    try {
      try {
        await this.atomicCreator.cleanupPublishedTempLinks(receipt.generation.detachedPath);
      } catch (error) {
        logger.warn(
          `[${teamName}] Failed to clean task attachment generation pins for task #${taskId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      await finalizeDetachedTaskAttachmentGeneration(receipt.generation);
      logger.debug(
        `[${teamName}] Deleted task attachment ${receipt.attachmentId} for task #${taskId}`
      );
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to finalize task attachment deletion ${receipt.attachmentId} for task #${taskId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async rollbackAttachmentDeletionInMutation(
    receipt: StagedTaskAttachmentDeletionReceipt,
    teamName: string,
    taskId: string
  ): Promise<void> {
    this.assertDeletionReceiptScope(receipt, teamName, taskId);
    await this.rollbackStagedAttachmentDeletion(receipt);
  }

  private async rollbackStagedAttachmentDeletion(
    receipt: StagedTaskAttachmentDeletionReceipt
  ): Promise<void> {
    const outcome = await restoreDetachedTaskAttachmentGeneration(receipt.generation);
    if (outcome === 'conflict') {
      throw new Error('Task attachment deletion rollback would overwrite a newer generation');
    }
    this.dismissCompensation(receipt);
  }

  private assertDeletionReceiptScope(
    receipt: StagedTaskAttachmentDeletionReceipt,
    teamName: string,
    taskId: string
  ): void {
    if (receipt.teamName !== teamName || receipt.taskId !== taskId) {
      throw new Error('Task attachment deletion receipt belongs to another transaction');
    }
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
        !isTaskAttachmentGenerationGuardName(path.basename(generationGuardPath)))
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
