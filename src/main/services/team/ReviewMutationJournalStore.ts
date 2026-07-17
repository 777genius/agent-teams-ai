import { assertReviewMutationTransition } from '@features/review-mutations';
import { atomicWriteAsync, unlinkPathDurably } from '@main/utils/atomicWrite';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { ReviewMutationKind, ReviewMutationPhase } from '@features/review-mutations/contracts';
import type {
  FileChangeWithContent,
  FileReviewDecision,
  ReviewDecisionPersistenceScope,
  ReviewDirectDiskMutationStep,
  ReviewFileScope,
  ReviewPersistedStateSnapshot,
} from '@shared/types';

const JOURNAL_VERSION = 2;
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
const MAX_JOURNAL_RECORDS_PER_SCOPE = 64;
const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const SCOPE_KEY_PATTERN = /^(?:task|agent)-[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/;

export interface ReviewMutationJournalRecord {
  version: 2;
  id: string;
  phase: ReviewMutationPhase;
  kind: ReviewMutationKind;
  teamName: string;
  persistenceScope: ReviewDecisionPersistenceScope;
  reviewScope: ReviewFileScope;
  decisions: (FileReviewDecision & { reviewKey: string })[];
  fileContents: FileChangeWithContent[];
  decisionStatuses?: ('pending' | 'applied')[];
  diskSteps?: ReviewMutationJournalDiskStep[];
  persistedState?: ReviewPersistedStateSnapshot;
  expectedDecisionRevision?: number;
  createdAt: string;
  updatedAt: string;
  /** A handled application failure blocks automatic recovery until explicit retry/discard. */
  blocked?: boolean;
  failure?: string;
}

export interface PrepareReviewMutationInput {
  teamName: string;
  persistenceScope: ReviewDecisionPersistenceScope;
  reviewScope: ReviewFileScope;
  kind: ReviewMutationKind;
  decisions: (FileReviewDecision & { reviewKey: string })[];
  fileContents: FileChangeWithContent[];
  diskSteps?: ReviewMutationJournalDiskStep[];
  persistedState?: ReviewPersistedStateSnapshot;
  expectedDecisionRevision?: number;
}

export type ReviewMutationJournalDiskStep = ReviewDirectDiskMutationStep & {
  status: 'pending' | 'applied';
  /** Main-resolved immutable rename evidence needed after the renderer is gone. */
  authoritativeContent?: FileChangeWithContent;
};

interface LegacyReviewMutationJournalRecord {
  version: 1;
  id: string;
  phase: 'prepared' | 'committed' | 'failed';
  teamName: string;
  persistenceScope: ReviewDecisionPersistenceScope;
  reviewScope: ReviewFileScope;
  decision: FileReviewDecision & { reviewKey: string };
  fileContent: FileChangeWithContent;
  createdAt: string;
  updatedAt: string;
  failure?: string;
}

export class ReviewMutationJournalStore {
  private assertSafeScope(
    teamName: string,
    persistenceScope: ReviewDecisionPersistenceScope
  ): void {
    if (!TEAM_NAME_PATTERN.test(teamName)) {
      throw new Error('Invalid review mutation journal team name');
    }
    if (!SCOPE_KEY_PATTERN.test(persistenceScope.scopeKey)) {
      throw new Error('Invalid review mutation journal scope key');
    }
    if (
      !persistenceScope.scopeToken ||
      persistenceScope.scopeToken.length > MAX_JOURNAL_BYTES ||
      persistenceScope.scopeToken.includes('\0')
    ) {
      throw new Error('Invalid review mutation journal scope token');
    }
  }

  private getScopeDir(teamName: string, persistenceScope: ReviewDecisionPersistenceScope): string {
    const scopeHash = createHash('sha256').update(persistenceScope.scopeToken).digest('hex');
    return path.join(
      getTeamsBasePath(),
      teamName,
      'review-decisions',
      'mutation-journal',
      persistenceScope.scopeKey,
      scopeHash
    );
  }

  private getRecordPath(record: ReviewMutationJournalRecord): string {
    return path.join(
      this.getScopeDir(record.teamName, record.persistenceScope),
      `${record.id}.json`
    );
  }

  private async writeRecord(record: ReviewMutationJournalRecord): Promise<void> {
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_JOURNAL_BYTES) {
      throw new Error('Review mutation journal record exceeds the storage limit');
    }
    await atomicWriteAsync(this.getRecordPath(record), serialized, {
      durability: 'strict',
      syncDirectory: true,
    });
  }

  async prepare(input: PrepareReviewMutationInput): Promise<ReviewMutationJournalRecord> {
    this.assertSafeScope(input.teamName, input.persistenceScope);
    if (input.reviewScope.teamName !== input.teamName) {
      throw new Error('Review mutation journal review scope mismatch');
    }
    const hasDecisionBatch = input.decisions.length > 0;
    const hasDirectSteps = (input.diskSteps?.length ?? 0) > 0;
    const isDecisionOnlyHistoryMutation =
      !hasDecisionBatch &&
      !hasDirectSteps &&
      (input.kind === 'undo' || input.kind === 'redo') &&
      !!input.persistedState;
    if (
      (!isDecisionOnlyHistoryMutation && hasDecisionBatch === hasDirectSteps) ||
      (hasDecisionBatch &&
        (input.decisions.length !== input.fileContents.length ||
          input.decisions.some(
            (decision, index) =>
              !decision.reviewKey || input.fileContents[index]?.filePath !== decision.filePath
          ))) ||
      (hasDirectSteps && input.fileContents.length > 0)
    ) {
      throw new Error('Invalid review mutation journal decision');
    }
    const existing = await this.list(input.teamName, input.persistenceScope);
    if (existing.length > 0) {
      throw new Error('A review mutation is already pending for this decision scope');
    }
    const now = new Date().toISOString();
    const record: ReviewMutationJournalRecord = {
      version: JOURNAL_VERSION,
      id: randomUUID(),
      phase: 'prepared',
      kind: input.kind,
      teamName: input.teamName,
      persistenceScope: input.persistenceScope,
      reviewScope: input.reviewScope,
      decisions: input.decisions,
      fileContents: input.fileContents,
      decisionStatuses: hasDecisionBatch
        ? input.decisions.map(() => 'pending' as const)
        : undefined,
      diskSteps: input.diskSteps,
      persistedState: input.persistedState,
      expectedDecisionRevision: input.expectedDecisionRevision,
      createdAt: now,
      updatedAt: now,
    };
    await this.writeRecord(record);
    return record;
  }

  async transition(
    record: ReviewMutationJournalRecord,
    expectedPhase: ReviewMutationPhase,
    nextPhase: ReviewMutationPhase
  ): Promise<ReviewMutationJournalRecord> {
    assertReviewMutationTransition(expectedPhase, nextPhase);
    const current = this.parseRecord(
      await this.readRecord(this.getRecordPath(record)),
      record.id,
      record.teamName,
      record.persistenceScope
    );
    if (record.phase !== expectedPhase || current.phase !== expectedPhase) {
      throw new Error(
        `Review mutation phase changed concurrently: expected ${expectedPhase}, found ${current.phase}`
      );
    }
    const transitioned: ReviewMutationJournalRecord = {
      ...record,
      phase: nextPhase,
      updatedAt: new Date().toISOString(),
      blocked: undefined,
      failure: undefined,
    };
    await this.writeRecord(transitioned);
    return transitioned;
  }

  async checkpoint(record: ReviewMutationJournalRecord): Promise<ReviewMutationJournalRecord> {
    const current = this.parseRecord(
      await this.readRecord(this.getRecordPath(record)),
      record.id,
      record.teamName,
      record.persistenceScope
    );
    if (current.phase !== record.phase) {
      throw new Error(
        `Review mutation phase changed concurrently: expected ${record.phase}, found ${current.phase}`
      );
    }
    const checkpointed: ReviewMutationJournalRecord = {
      ...record,
      updatedAt: new Date().toISOString(),
    };
    await this.writeRecord(checkpointed);
    return checkpointed;
  }

  async markFailed(record: ReviewMutationJournalRecord, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : 'Unknown review mutation failure';
    await this.writeRecord({
      ...record,
      updatedAt: new Date().toISOString(),
      blocked: true,
      failure: message.slice(0, 2_000),
    });
  }

  async remove(record: ReviewMutationJournalRecord): Promise<void> {
    await unlinkPathDurably(this.getRecordPath(record)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  async clearScope(
    teamName: string,
    persistenceScope: ReviewDecisionPersistenceScope
  ): Promise<void> {
    this.assertSafeScope(teamName, persistenceScope);
    const records = await this.list(teamName, persistenceScope).catch(() => []);
    await Promise.all(records.map((record) => this.remove(record)));
    await fs.promises.rm(this.getScopeDir(teamName, persistenceScope), {
      recursive: true,
      force: true,
    });
  }

  async list(
    teamName: string,
    persistenceScope: ReviewDecisionPersistenceScope
  ): Promise<ReviewMutationJournalRecord[]> {
    this.assertSafeScope(teamName, persistenceScope);
    const scopeDir = this.getScopeDir(teamName, persistenceScope);
    let entries: string[];
    try {
      entries = await fs.promises.readdir(scopeDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const recordNames = entries
      .filter((entry) => /^[a-f0-9-]+\.json$/i.test(entry))
      .sort((left, right) => left.localeCompare(right));
    if (recordNames.length > MAX_JOURNAL_RECORDS_PER_SCOPE) {
      throw new Error('Too many pending review mutation journal records');
    }

    const records: ReviewMutationJournalRecord[] = [];
    for (const entry of recordNames) {
      const filePath = path.join(scopeDir, entry);
      const parsed = await this.readRecord(filePath);
      const record = this.parseRecord(
        parsed,
        path.basename(entry, '.json'),
        teamName,
        persistenceScope
      );
      records.push(record);
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private async readRecord(filePath: string): Promise<unknown> {
    let handle: fs.promises.FileHandle | null = null;
    try {
      const pathStats = await fs.promises.lstat(filePath);
      if (pathStats.isSymbolicLink()) {
        throw new Error('Unsafe review mutation journal symlink');
      }
      handle = await fs.promises.open(filePath, 'r');
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        stats.size > MAX_JOURNAL_BYTES ||
        stats.dev !== pathStats.dev ||
        stats.ino !== pathStats.ino
      ) {
        throw new Error('Unsafe or oversized review mutation journal record');
      }
      const raw = await handle.readFile({ encoding: 'utf8' });
      const latestPathStats = await fs.promises.lstat(filePath);
      if (
        latestPathStats.isSymbolicLink() ||
        latestPathStats.dev !== stats.dev ||
        latestPathStats.ino !== stats.ino
      ) {
        throw new Error('Review mutation journal changed while being read');
      }
      try {
        return JSON.parse(raw) as unknown;
      } catch (error) {
        throw new Error('Corrupted review mutation journal record', { cause: error });
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private parseRecord(
    parsed: unknown,
    expectedId: string,
    expectedTeamName: string,
    expectedScope: ReviewDecisionPersistenceScope
  ): ReviewMutationJournalRecord {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid review mutation journal record');
    }
    const maybeLegacy = parsed as Partial<LegacyReviewMutationJournalRecord>;
    if (maybeLegacy.version === 1) {
      return this.parseLegacyRecord(maybeLegacy, expectedId, expectedTeamName, expectedScope);
    }
    const record = parsed as Partial<ReviewMutationJournalRecord>;
    const recordPersistenceScope = record.persistenceScope;
    if (
      record.version !== JOURNAL_VERSION ||
      record.id !== expectedId ||
      !/^[a-f0-9-]+$/i.test(expectedId) ||
      (record.phase !== 'prepared' &&
        record.phase !== 'disk_applied' &&
        record.phase !== 'decisions_committed' &&
        record.phase !== 'complete') ||
      (record.kind !== 'reject' &&
        record.kind !== 'restore' &&
        record.kind !== 'rename' &&
        record.kind !== 'bulk' &&
        record.kind !== 'undo' &&
        record.kind !== 'redo') ||
      record.teamName !== expectedTeamName ||
      recordPersistenceScope?.scopeKey !== expectedScope.scopeKey ||
      recordPersistenceScope?.scopeToken !== expectedScope.scopeToken ||
      record.reviewScope?.teamName !== expectedTeamName ||
      !Array.isArray(record.decisions) ||
      !Array.isArray(record.fileContents) ||
      !this.hasValidPayload(record) ||
      typeof record.createdAt !== 'string' ||
      typeof record.updatedAt !== 'string' ||
      (record.expectedDecisionRevision !== undefined &&
        (!Number.isSafeInteger(record.expectedDecisionRevision) ||
          record.expectedDecisionRevision < 0)) ||
      (record.blocked !== undefined && typeof record.blocked !== 'boolean') ||
      (record.failure !== undefined && typeof record.failure !== 'string')
    ) {
      throw new Error('Invalid review mutation journal record');
    }
    const parsedRecord = record as ReviewMutationJournalRecord;
    return parsedRecord.decisions.length > 0 && !parsedRecord.decisionStatuses
      ? { ...parsedRecord, decisionStatuses: parsedRecord.decisions.map(() => 'pending') }
      : parsedRecord;
  }

  private hasValidPayload(record: Partial<ReviewMutationJournalRecord>): boolean {
    const decisions = record.decisions ?? [];
    const fileContents = record.fileContents ?? [];
    const diskSteps = record.diskSteps ?? [];
    const hasDecisionBatch = decisions.length > 0;
    const hasDirectSteps = diskSteps.length > 0;
    if (!hasDecisionBatch && !hasDirectSteps) {
      return (
        (record.kind === 'undo' || record.kind === 'redo') &&
        !!record.persistedState &&
        fileContents.length === 0
      );
    }
    if (hasDecisionBatch === hasDirectSteps) return false;
    if (hasDecisionBatch) {
      const statuses = record.decisionStatuses;
      return (
        decisions.length === fileContents.length &&
        (statuses === undefined ||
          (statuses.length === decisions.length &&
            statuses.every((status) => status === 'pending' || status === 'applied'))) &&
        decisions.every(
          (decision, index) =>
            typeof decision?.reviewKey === 'string' &&
            decision.reviewKey.length > 0 &&
            decision.reviewKey.length <= 32_768 &&
            fileContents[index]?.filePath === decision.filePath
        )
      );
    }
    if (fileContents.length > 0) return false;
    const ids = new Set<string>();
    return diskSteps.every((step) => {
      if (
        !step ||
        typeof step.id !== 'string' ||
        step.id.length === 0 ||
        step.id.length > 256 ||
        ids.has(step.id) ||
        (step.status !== 'pending' && step.status !== 'applied') ||
        typeof step.filePath !== 'string' ||
        step.filePath.length === 0 ||
        step.filePath.length > 32_768
      ) {
        return false;
      }
      ids.add(step.id);
      if (step.type === 'write') {
        return (
          (typeof step.expectedContent === 'string' || step.expectedContent === null) &&
          typeof step.content === 'string'
        );
      }
      if (step.type === 'delete') return typeof step.expectedContent === 'string';
      return (
        (step.type === 'restore-rejected-rename' || step.type === 'reapply-rejected-rename') &&
        !!step.expectation &&
        typeof step.expectation === 'object' &&
        !!step.authoritativeContent &&
        step.authoritativeContent.filePath === step.filePath
      );
    });
  }

  private parseLegacyRecord(
    record: Partial<LegacyReviewMutationJournalRecord>,
    expectedId: string,
    expectedTeamName: string,
    expectedScope: ReviewDecisionPersistenceScope
  ): ReviewMutationJournalRecord {
    const recordPersistenceScope = record.persistenceScope;
    if (
      record.id !== expectedId ||
      !/^[a-f0-9-]+$/i.test(expectedId) ||
      (record.phase !== 'prepared' && record.phase !== 'committed' && record.phase !== 'failed') ||
      record.teamName !== expectedTeamName ||
      recordPersistenceScope?.scopeKey !== expectedScope.scopeKey ||
      recordPersistenceScope?.scopeToken !== expectedScope.scopeToken ||
      record.reviewScope?.teamName !== expectedTeamName ||
      typeof record.decision?.reviewKey !== 'string' ||
      record.decision.reviewKey.length === 0 ||
      record.decision.reviewKey.length > 32_768 ||
      record.fileContent?.filePath !== record.decision.filePath ||
      typeof record.createdAt !== 'string' ||
      typeof record.updatedAt !== 'string' ||
      (record.failure !== undefined && typeof record.failure !== 'string')
    ) {
      throw new Error('Invalid review mutation journal record');
    }
    return {
      version: JOURNAL_VERSION,
      id: record.id,
      phase: record.phase === 'committed' ? 'disk_applied' : 'prepared',
      kind: 'reject',
      teamName: record.teamName,
      persistenceScope: recordPersistenceScope,
      reviewScope: record.reviewScope,
      decisions: [record.decision],
      fileContents: [record.fileContent],
      decisionStatuses: ['pending'],
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      blocked: record.phase === 'failed' ? true : undefined,
      failure: record.failure,
    };
  }
}
