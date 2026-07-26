import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  atomicWriteAsync,
  cleanupAtomicCreateTempLinks,
  type DurableFileIdentity,
  removePathWithIdentityFenceAsync,
  syncDirectoryDurably,
} from '@main/utils/atomicWrite';
import { getAppDataPath } from '@main/utils/pathDecoder';

import { isTaskAttachmentGenerationGuardName } from './TaskAttachmentArtifacts';
import {
  isSameTaskAttachmentFileIdentity,
  type PinnedTaskAttachmentGeneration,
  removeTaskAttachmentGenerationPin,
  type TaskAttachmentFileIdentity,
} from './TaskAttachmentGenerationLifecycle';

const JOURNAL_VERSION = 1;
const JOURNAL_DIRECTORY = 'task-attachment-deletion-intents';
const TRANSACTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TaskAttachmentDeletionPhase = 'prepared' | 'committed' | 'detached' | 'removed';

export interface TaskAttachmentDeletionIntent {
  readonly version: typeof JOURNAL_VERSION;
  readonly transactionId: string;
  readonly teamName: string;
  readonly taskId: string;
  readonly attachmentId: string;
  readonly originalPath: string;
  readonly pinPath: string;
  readonly detachedPath: string;
  readonly identity: TaskAttachmentFileIdentity;
  readonly phase: TaskAttachmentDeletionPhase;
  readonly requestedAt: string;
  readonly updatedAt: string;
}

export type TaskAttachmentReferenceReader = (
  teamName: string,
  taskId: string,
  attachmentId: string
) => Promise<boolean>;

export interface TaskAttachmentDeletionBackupFence {
  reconcilePendingDeletions(): Promise<void>;
  getBackupExclusions(teamName: string): Promise<ReadonlySet<string>>;
  getBackupExclusionsSync(teamName: string): ReadonlySet<string>;
  getPendingTeams(): Promise<ReadonlySet<string>>;
  getPendingPaths(teamName: string): Promise<ReadonlySet<string>>;
  completePendingDeletions(
    teamName: string,
    backedUpReplacements: ReadonlyMap<string, DurableFileIdentity>
  ): Promise<void>;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function assertSafeSegment(label: string, value: string): void {
  if (
    !value ||
    value.trim() !== value ||
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

function isTaskAttachmentIdentity(value: unknown): value is TaskAttachmentFileIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Partial<TaskAttachmentFileIdentity>;
  return (
    typeof identity.dev === 'number' &&
    Number.isFinite(identity.dev) &&
    typeof identity.ino === 'number' &&
    Number.isFinite(identity.ino) &&
    typeof identity.birthtimeMs === 'number' &&
    Number.isFinite(identity.birthtimeMs) &&
    typeof identity.size === 'number' &&
    Number.isSafeInteger(identity.size) &&
    identity.size >= 0
  );
}

export class TaskAttachmentDeletionJournal {
  constructor(
    private readonly cleanupPublishedTempLinks: (
      filePath: string
    ) => Promise<void> = cleanupAtomicCreateTempLinks
  ) {}

  async prepare(
    teamName: string,
    taskId: string,
    attachmentId: string,
    generation: PinnedTaskAttachmentGeneration
  ): Promise<TaskAttachmentDeletionIntent> {
    this.assertScope(teamName, taskId, attachmentId);
    const transactionId = randomUUID();
    const now = new Date().toISOString();
    const intent: TaskAttachmentDeletionIntent = {
      version: JOURNAL_VERSION,
      transactionId,
      teamName,
      taskId,
      attachmentId,
      originalPath: generation.originalPath,
      pinPath: generation.pinPath,
      detachedPath: path.join(
        path.dirname(generation.originalPath),
        `.attachment-delete.${transactionId}.staged`
      ),
      identity: generation.identity,
      phase: 'prepared',
      requestedAt: now,
      updatedAt: now,
    };
    this.assertIntentPaths(intent);
    await this.save(intent);
    return intent;
  }

  async finalize(intent: TaskAttachmentDeletionIntent): Promise<void> {
    this.assertScope(intent.teamName, intent.taskId, intent.attachmentId);
    this.assertIntentPaths(intent);
    const committed =
      intent.phase === 'prepared' ? await this.updatePhase(intent, 'committed') : intent;
    const removal = await removePathWithIdentityFenceAsync(committed.originalPath, {
      force: true,
      durability: 'strict',
      validateDetached: async (detachedPath) => {
        try {
          const stats = await fs.promises.lstat(detachedPath);
          return (
            stats.isFile() &&
            !stats.isSymbolicLink() &&
            isSameTaskAttachmentFileIdentity(stats, committed.identity)
          );
        } catch {
          return false;
        }
      },
      proofHooks: {
        detachedPath: committed.detachedPath,
        onDetachedValidated: async (detachedPath) => {
          await this.updatePhase(committed, 'detached');
          await this.cleanupPublishedTempLinks(detachedPath);
        },
        onRemovalDurable: async () => undefined,
      },
    });

    if (removal === 'changed') {
      const current = await this.lstatOrNull(committed.originalPath);
      if (current && isSameTaskAttachmentFileIdentity(current, committed.identity)) {
        throw new Error('Task attachment deletion staging path changed; recovery remains fenced');
      }
    }

    await removeTaskAttachmentGenerationPin(committed.pinPath, committed.identity);
    await this.updatePhase(committed, 'removed');
  }

  async abort(intent: TaskAttachmentDeletionIntent): Promise<void> {
    this.assertScope(intent.teamName, intent.taskId, intent.attachmentId);
    this.assertIntentPaths(intent);
    await removeTaskAttachmentGenerationPin(intent.pinPath, intent.identity);
    await this.remove(intent);
  }

  async complete(intent: TaskAttachmentDeletionIntent): Promise<void> {
    this.assertScope(intent.teamName, intent.taskId, intent.attachmentId);
    this.assertIntentPaths(intent);
    if (intent.phase !== 'removed') {
      throw new Error('Task attachment deletion is not ready for journal completion');
    }
    await this.remove(intent);
  }

  async loadAll(): Promise<TaskAttachmentDeletionIntent[]> {
    const directory = this.getJournalDirectory();
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }

    const intents: TaskAttachmentDeletionIntent[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      intents.push(await this.readIntent(path.join(directory, entry.name), entry.name));
    }
    return intents;
  }

  loadAllSync(): TaskAttachmentDeletionIntent[] {
    const directory = this.getJournalDirectory();
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => {
        const intentPath = path.join(directory, entry.name);
        return this.parsePersistedIntent(fs.readFileSync(intentPath, 'utf8'), entry.name);
      });
  }

  private async updatePhase(
    intent: TaskAttachmentDeletionIntent,
    phase: Exclude<TaskAttachmentDeletionPhase, 'prepared'>
  ): Promise<TaskAttachmentDeletionIntent> {
    const updated: TaskAttachmentDeletionIntent = {
      ...intent,
      phase,
      updatedAt: new Date().toISOString(),
    };
    await this.save(updated);
    return updated;
  }

  private async save(intent: TaskAttachmentDeletionIntent): Promise<void> {
    this.assertIntentPaths(intent);
    const directory = this.getJournalDirectory();
    await this.ensureDirectoryHierarchyDurably(directory);
    await atomicWriteAsync(
      this.getIntentPath(intent.transactionId),
      JSON.stringify(intent, null, 2),
      { durability: 'strict', syncDirectory: true }
    );
  }

  private async remove(intent: TaskAttachmentDeletionIntent): Promise<void> {
    const intentPath = this.getIntentPath(intent.transactionId);
    let raw: string;
    try {
      raw = await fs.promises.readFile(intentPath, 'utf8');
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    const persisted = this.parsePersistedIntent(raw, path.basename(intentPath));
    if (
      persisted.transactionId !== intent.transactionId ||
      persisted.teamName !== intent.teamName ||
      persisted.taskId !== intent.taskId ||
      persisted.attachmentId !== intent.attachmentId ||
      persisted.originalPath !== intent.originalPath ||
      persisted.pinPath !== intent.pinPath ||
      persisted.detachedPath !== intent.detachedPath ||
      !isSameTaskAttachmentFileIdentity(persisted.identity, intent.identity)
    ) {
      throw new Error('Task attachment deletion intent identity changed while removing it');
    }
    const removal = await removePathWithIdentityFenceAsync(intentPath, {
      force: true,
      durability: 'strict',
      validateDetached: async (detachedPath) => {
        try {
          return (await fs.promises.readFile(detachedPath, 'utf8')) === raw;
        } catch {
          return false;
        }
      },
    });
    if (removal === 'changed') {
      throw new Error('Task attachment deletion intent changed while removing it');
    }
  }

  private async readIntent(
    intentPath: string,
    expectedFileName: string
  ): Promise<TaskAttachmentDeletionIntent> {
    const raw = await fs.promises.readFile(intentPath, 'utf8');
    return this.parsePersistedIntent(raw, expectedFileName);
  }

  private parsePersistedIntent(
    raw: string,
    expectedFileName: string
  ): TaskAttachmentDeletionIntent {
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`Corrupt task attachment deletion intent: ${expectedFileName}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Invalid task attachment deletion intent: ${expectedFileName}`);
    }
    const candidate = value as Partial<TaskAttachmentDeletionIntent>;
    if (
      candidate.version !== JOURNAL_VERSION ||
      typeof candidate.transactionId !== 'string' ||
      !TRANSACTION_ID_PATTERN.test(candidate.transactionId) ||
      expectedFileName !== `${candidate.transactionId}.json` ||
      typeof candidate.teamName !== 'string' ||
      typeof candidate.taskId !== 'string' ||
      typeof candidate.attachmentId !== 'string' ||
      typeof candidate.originalPath !== 'string' ||
      typeof candidate.pinPath !== 'string' ||
      typeof candidate.detachedPath !== 'string' ||
      !isTaskAttachmentIdentity(candidate.identity) ||
      (candidate.phase !== 'prepared' &&
        candidate.phase !== 'committed' &&
        candidate.phase !== 'detached' &&
        candidate.phase !== 'removed') ||
      typeof candidate.requestedAt !== 'string' ||
      typeof candidate.updatedAt !== 'string'
    ) {
      throw new Error(`Invalid task attachment deletion intent: ${expectedFileName}`);
    }
    const intent = candidate as TaskAttachmentDeletionIntent;
    this.assertScope(intent.teamName, intent.taskId, intent.attachmentId);
    this.assertIntentPaths(intent);
    return intent;
  }

  private assertScope(teamName: string, taskId: string, attachmentId: string): void {
    assertSafeSegment('teamName', teamName);
    assertSafeSegment('taskId', taskId);
    assertSafeSegment('attachmentId', attachmentId);
  }

  private assertIntentPaths(intent: TaskAttachmentDeletionIntent): void {
    const taskDirectory = path.resolve(
      getAppDataPath(),
      'task-attachments',
      intent.teamName,
      intent.taskId
    );
    const originalPath = path.resolve(intent.originalPath);
    const pinPath = path.resolve(intent.pinPath);
    const detachedPath = path.resolve(intent.detachedPath);
    if (
      path.dirname(originalPath) !== taskDirectory ||
      !path.basename(originalPath).startsWith(`${intent.attachmentId}--`) ||
      path.dirname(pinPath) !== taskDirectory ||
      !isTaskAttachmentGenerationGuardName(path.basename(pinPath)) ||
      detachedPath !== path.join(taskDirectory, `.attachment-delete.${intent.transactionId}.staged`)
    ) {
      throw new Error('Invalid task attachment deletion intent paths');
    }
  }

  private getJournalDirectory(): string {
    return path.join(getAppDataPath(), JOURNAL_DIRECTORY);
  }

  private getIntentPath(transactionId: string): string {
    if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
      throw new Error('Invalid task attachment deletion transaction');
    }
    return path.join(this.getJournalDirectory(), `${transactionId}.json`);
  }

  private async ensureDirectoryHierarchyDurably(directoryPath: string): Promise<void> {
    const missingDirectories: string[] = [];
    let cursor = path.resolve(directoryPath);
    while (true) {
      try {
        const stats = await fs.promises.lstat(cursor);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
          throw new Error(`Task attachment deletion journal path is not a directory: ${cursor}`);
        }
        break;
      } catch (error) {
        if (!isMissing(error)) throw error;
        missingDirectories.push(cursor);
        const parent = path.dirname(cursor);
        if (parent === cursor) throw error;
        cursor = parent;
      }
    }
    for (const missingDirectory of missingDirectories.reverse()) {
      await fs.promises.mkdir(missingDirectory);
      await syncDirectoryDurably(path.dirname(missingDirectory));
    }
  }

  private async lstatOrNull(filePath: string): Promise<fs.Stats | null> {
    try {
      return await fs.promises.lstat(filePath);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }
}
