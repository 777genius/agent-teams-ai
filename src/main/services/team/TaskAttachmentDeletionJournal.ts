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
import { lock } from 'proper-lockfile';

import { isTaskAttachmentGenerationGuardName } from './TaskAttachmentArtifacts';
import {
  hasTrustworthyTaskAttachmentFileIdentity,
  isSameTaskAttachmentFileIdentity,
  type PinnedTaskAttachmentGeneration,
  removeTaskAttachmentGenerationPin,
  type TaskAttachmentFileIdentity,
} from './TaskAttachmentGenerationLifecycle';

const JOURNAL_VERSION = 1;
const JOURNAL_DIRECTORY = 'task-attachment-deletion-intents';
const TRANSACTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPLETION_INTENT_FILE_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.completion\.json$/i;

export type TaskAttachmentDeletionPhase =
  | 'prepared'
  | 'committed'
  | 'detached'
  | 'removed'
  | 'aborted';

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
  getPendingTeams(): Promise<ReadonlySet<string>>;
  getCompletionCandidates(
    teamName: string
  ): Promise<ReadonlyArray<{ transactionId: string; originalPath: string }>>;
  completePendingDeletions(
    teamName: string,
    transactionIds: ReadonlySet<string>,
    backedUpReplacements: ReadonlyMap<string, DurableFileIdentity>,
    canComplete?: () => boolean
  ): Promise<void>;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function syncDirectoryDurablySync(directoryPath: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(directoryPath, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const unsupported =
      code === 'EINVAL' ||
      code === 'ENOSYS' ||
      code === 'ENOTSUP' ||
      code === 'EOPNOTSUPP' ||
      (process.platform === 'win32' &&
        (code === 'EACCES' || code === 'EPERM' || code === 'EISDIR' || code === 'EBADF'));
    if (!unsupported) throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
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

function isSamePersistedIdentity(
  left: TaskAttachmentFileIdentity,
  right: TaskAttachmentFileIdentity
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs &&
    left.size === right.size
  );
}

interface PersistedIntentSnapshot {
  readonly intent: TaskAttachmentDeletionIntent;
  readonly raw: string;
}

export class TaskAttachmentDeletionJournal {
  constructor(
    private readonly cleanupPublishedTempLinks: (
      filePath: string
    ) => Promise<void> = cleanupAtomicCreateTempLinks,
    private readonly afterRemovalDurable: (
      intent: TaskAttachmentDeletionIntent
    ) => Promise<void> = async () => undefined,
    private readonly afterCompletionValidation: (
      intent: TaskAttachmentDeletionIntent
    ) => void = () => undefined
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
    if (!hasTrustworthyTaskAttachmentFileIdentity(intent.identity)) {
      throw new Error('Task attachment identity is not trustworthy enough for deletion');
    }
    const current = await this.readCurrentSnapshot(intent);
    if (!current) return;
    if (current.intent.phase === 'aborted') {
      throw new Error('Task attachment deletion was already aborted');
    }
    if (current.intent.phase === 'removed') {
      await removeTaskAttachmentGenerationPin(current.intent.pinPath, current.intent.identity);
      return;
    }
    const committed =
      current.intent.phase === 'prepared'
        ? await this.advancePhase(current.intent, 'committed')
        : current.intent;
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
          await this.advancePhase(committed, 'detached');
          await this.cleanupPublishedTempLinks(detachedPath);
        },
        onRemovalDurable: async () => {
          const removed = await this.advancePhase(committed, 'removed');
          await this.afterRemovalDurable(removed);
        },
      },
    });

    if (removal !== 'deleted') {
      const current = await this.lstatOrNull(committed.originalPath);
      if (current && isSameTaskAttachmentFileIdentity(current, committed.identity)) {
        throw new Error('Task attachment deletion staging path changed; recovery remains fenced');
      }
      throw new Error('Task attachment deletion has no durable removal proof');
    }

    await removeTaskAttachmentGenerationPin(committed.pinPath, committed.identity);
  }

  async abort(intent: TaskAttachmentDeletionIntent): Promise<void> {
    this.assertScope(intent.teamName, intent.taskId, intent.attachmentId);
    this.assertIntentPaths(intent);
    const current = await this.readCurrentSnapshot(intent);
    if (!current) return;
    let aborted = current.intent;
    if (aborted.phase !== 'aborted') {
      if (aborted.phase !== 'prepared') {
        throw new Error(`Cannot abort task attachment deletion in ${aborted.phase} phase`);
      }
      aborted = await this.transitionPreparedToAborted(aborted);
    }
    await removeTaskAttachmentGenerationPin(aborted.pinPath, aborted.identity);
    await this.remove(aborted);
  }

  async complete(
    intent: TaskAttachmentDeletionIntent,
    canComplete: () => boolean = () => true
  ): Promise<void> {
    this.assertScope(intent.teamName, intent.taskId, intent.attachmentId);
    this.assertIntentPaths(intent);
    const intentPath = this.getIntentPath(intent.transactionId);
    const release = await this.acquirePhaseLock(intentPath);
    try {
      this.completeUnderPhaseLock(intent, canComplete);
    } finally {
      await release().catch(() => undefined);
    }
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
    for (const entry of this.selectJournalEntries(directory, entries)) {
      intents.push(
        await this.readIntent(path.join(directory, entry.name), `${entry.transactionId}.json`)
      );
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

    return this.selectJournalEntries(directory, entries).map((entry) => {
      const intentPath = path.join(directory, entry.name);
      return this.parsePersistedIntent(
        fs.readFileSync(intentPath, 'utf8'),
        `${entry.transactionId}.json`
      );
    });
  }

  private async advancePhase(
    intent: TaskAttachmentDeletionIntent,
    phase: Exclude<TaskAttachmentDeletionPhase, 'prepared'>
  ): Promise<TaskAttachmentDeletionIntent> {
    const phaseRank: Record<Exclude<TaskAttachmentDeletionPhase, 'aborted'>, number> = {
      prepared: 0,
      committed: 1,
      detached: 2,
      removed: 3,
    };
    if (phase === 'aborted') {
      throw new Error('Aborted phase requires an exact prepared-phase transition');
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.readCurrentSnapshot(intent);
      if (!current) throw new Error('Task attachment deletion intent disappeared');
      if (current.intent.phase === 'aborted') {
        throw new Error('Task attachment deletion was already aborted');
      }
      if (phaseRank[current.intent.phase] >= phaseRank[phase]) return current.intent;
      const updated: TaskAttachmentDeletionIntent = {
        ...current.intent,
        phase,
        updatedAt: new Date().toISOString(),
      };
      if (await this.compareAndSwap(current, updated)) return updated;
    }
    throw new Error('Task attachment deletion phase changed too frequently');
  }

  private async transitionPreparedToAborted(
    intent: TaskAttachmentDeletionIntent
  ): Promise<TaskAttachmentDeletionIntent> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.readCurrentSnapshot(intent);
      if (!current) throw new Error('Task attachment deletion intent disappeared');
      if (current.intent.phase === 'aborted') return current.intent;
      if (current.intent.phase !== 'prepared') {
        throw new Error(`Cannot abort task attachment deletion in ${current.intent.phase} phase`);
      }
      const aborted: TaskAttachmentDeletionIntent = {
        ...current.intent,
        phase: 'aborted',
        updatedAt: new Date().toISOString(),
      };
      if (await this.compareAndSwap(current, aborted)) return aborted;
    }
    throw new Error('Task attachment deletion phase changed too frequently');
  }

  private async compareAndSwap(
    current: PersistedIntentSnapshot,
    next: TaskAttachmentDeletionIntent
  ): Promise<boolean> {
    const intentPath = this.getIntentPath(current.intent.transactionId);
    const release = await this.acquirePhaseLock(intentPath);
    try {
      const latest = await this.readCurrentSnapshot(current.intent);
      if (!latest || latest.raw !== current.raw) return false;
      await atomicWriteAsync(intentPath, JSON.stringify(next, null, 2), {
        durability: 'strict',
        syncDirectory: true,
      });
      return true;
    } finally {
      await release().catch(() => undefined);
    }
  }

  private acquirePhaseLock(intentPath: string): Promise<() => Promise<void>> {
    return lock(intentPath, {
      lockfilePath: `${intentPath}.phase.lock`,
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: {
        retries: 50,
        factor: 1.2,
        minTimeout: 10,
        maxTimeout: 250,
        randomize: true,
      },
    });
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
    const current = await this.readCurrentSnapshot(intent);
    if (!current) return;
    const intentPath = this.getIntentPath(intent.transactionId);
    const removal = await removePathWithIdentityFenceAsync(intentPath, {
      force: true,
      durability: 'strict',
      validateDetached: async (detachedPath) => {
        try {
          const raw = await fs.promises.readFile(detachedPath, 'utf8');
          return raw === current.raw;
        } catch {
          return false;
        }
      },
    });
    if (removal === 'changed') {
      throw new Error('Task attachment deletion intent changed while removing it');
    }
  }

  private completeUnderPhaseLock(
    expected: TaskAttachmentDeletionIntent,
    canComplete: () => boolean
  ): void {
    const intentPath = this.getIntentPath(expected.transactionId);
    const detachedPath = this.getCompletionIntentPath(expected.transactionId);
    const current = this.readCompletionSnapshotSync(expected, intentPath, detachedPath);
    if (!current) return;
    if (current.intent.phase !== 'removed') {
      throw new Error('Task attachment deletion is not ready for journal completion');
    }

    if (current.path === intentPath) {
      fs.renameSync(intentPath, detachedPath);
      syncDirectoryDurablySync(path.dirname(intentPath));
    }
    const detached = this.readSnapshotSync(detachedPath, expected);
    if (detached.raw !== current.raw) {
      this.restoreCompletionIntentSync(detachedPath, intentPath);
      throw new Error('Task attachment deletion intent changed while removing it');
    }
    if (!canComplete()) {
      this.restoreCompletionIntentSync(detachedPath, intentPath);
      return;
    }

    // This hook makes the post-validation boundary observable in tests. The
    // final generation check and durable removal below are deliberately
    // synchronous, so shutdown cannot interleave between them in this process.
    this.afterCompletionValidation(detached.intent);
    if (!canComplete()) {
      this.restoreCompletionIntentSync(detachedPath, intentPath);
      return;
    }
    fs.unlinkSync(detachedPath);
    syncDirectoryDurablySync(path.dirname(detachedPath));
  }

  private readCompletionSnapshotSync(
    expected: TaskAttachmentDeletionIntent,
    intentPath: string,
    detachedPath: string
  ): (PersistedIntentSnapshot & { path: string }) | null {
    const intentExists = fs.existsSync(intentPath);
    const detachedExists = fs.existsSync(detachedPath);
    if (!intentExists && !detachedExists) return null;
    if (intentExists && detachedExists) {
      const current = this.readSnapshotSync(intentPath, expected);
      const detached = this.readSnapshotSync(detachedPath, expected);
      if (current.raw !== detached.raw) {
        throw new Error('Multiple task attachment deletion intent generations exist');
      }
      fs.unlinkSync(detachedPath);
      syncDirectoryDurablySync(path.dirname(detachedPath));
      return { ...current, path: intentPath };
    }
    const currentPath = intentExists ? intentPath : detachedPath;
    return { ...this.readSnapshotSync(currentPath, expected), path: currentPath };
  }

  private readSnapshotSync(
    snapshotPath: string,
    expected: TaskAttachmentDeletionIntent
  ): PersistedIntentSnapshot {
    const descriptor = fs.openSync(
      snapshotPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
    try {
      const stats = fs.fstatSync(descriptor);
      if (!stats.isFile()) {
        throw new Error('Task attachment deletion intent is not a file');
      }
      const raw = fs.readFileSync(descriptor, 'utf8');
      const intent = this.parsePersistedIntent(raw, `${expected.transactionId}.json`);
      this.assertSameIntentIdentity(intent, expected);
      return { intent, raw };
    } finally {
      fs.closeSync(descriptor);
    }
  }

  private restoreCompletionIntentSync(detachedPath: string, intentPath: string): void {
    try {
      fs.linkSync(detachedPath, intentPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new Error('Task attachment deletion intent was replaced during completion', {
        cause: error,
      });
    }
    fs.unlinkSync(detachedPath);
    syncDirectoryDurablySync(path.dirname(intentPath));
  }

  private selectJournalEntries(
    directory: string,
    entries: readonly fs.Dirent[]
  ): { name: string; transactionId: string }[] {
    const selected = new Map<string, { name: string; transactionId: string }>();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const completionMatch = COMPLETION_INTENT_FILE_PATTERN.exec(entry.name);
      const transactionId = completionMatch?.[1] ?? path.basename(entry.name, '.json');
      if (
        (!entry.name.endsWith('.json') && !completionMatch) ||
        !TRANSACTION_ID_PATTERN.test(transactionId)
      ) {
        continue;
      }
      const existing = selected.get(transactionId);
      if (existing && existing.name !== entry.name) {
        const expectedFileName = `${transactionId}.json`;
        const existingRaw = fs.readFileSync(path.join(directory, existing.name), 'utf8');
        const candidateRaw = fs.readFileSync(path.join(directory, entry.name), 'utf8');
        const existingIntent = this.parsePersistedIntent(existingRaw, expectedFileName);
        const candidateIntent = this.parsePersistedIntent(candidateRaw, expectedFileName);
        if (existingRaw !== candidateRaw || existingIntent.phase !== candidateIntent.phase) {
          throw new Error(`Multiple task attachment deletion intent generations: ${transactionId}`);
        }
        const canonicalName = `${transactionId}.json`;
        selected.set(transactionId, {
          name: existing.name === canonicalName ? existing.name : entry.name,
          transactionId,
        });
        continue;
      }
      selected.set(transactionId, { name: entry.name, transactionId });
    }
    return [...selected.values()];
  }

  private async readIntent(
    intentPath: string,
    expectedFileName: string
  ): Promise<TaskAttachmentDeletionIntent> {
    const raw = await fs.promises.readFile(intentPath, 'utf8');
    return this.parsePersistedIntent(raw, expectedFileName);
  }

  private async readCurrentSnapshot(
    expected: TaskAttachmentDeletionIntent
  ): Promise<PersistedIntentSnapshot | null> {
    const intentPath = this.getIntentPath(expected.transactionId);
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(intentPath, 'r');
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw new Error('Task attachment deletion intent is not a file');
      const raw = await handle.readFile('utf8');
      const intent = this.parsePersistedIntent(raw, path.basename(intentPath));
      this.assertSameIntentIdentity(intent, expected);
      return { intent, raw };
    } finally {
      await handle.close();
    }
  }

  private assertSameIntentIdentity(
    persisted: TaskAttachmentDeletionIntent,
    expected: TaskAttachmentDeletionIntent
  ): void {
    if (
      persisted.transactionId !== expected.transactionId ||
      persisted.teamName !== expected.teamName ||
      persisted.taskId !== expected.taskId ||
      persisted.attachmentId !== expected.attachmentId ||
      persisted.originalPath !== expected.originalPath ||
      persisted.pinPath !== expected.pinPath ||
      persisted.detachedPath !== expected.detachedPath ||
      persisted.requestedAt !== expected.requestedAt ||
      !isSamePersistedIdentity(persisted.identity, expected.identity)
    ) {
      throw new Error('Task attachment deletion intent identity changed');
    }
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
        candidate.phase !== 'removed' &&
        candidate.phase !== 'aborted') ||
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

  private getCompletionIntentPath(transactionId: string): string {
    if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
      throw new Error('Invalid task attachment deletion transaction');
    }
    return path.join(this.getJournalDirectory(), `${transactionId}.completion.json`);
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
