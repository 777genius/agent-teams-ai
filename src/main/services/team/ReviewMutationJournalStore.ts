import { atomicWriteAsync, unlinkPathDurably } from '@main/utils/atomicWrite';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type {
  FileChangeWithContent,
  FileReviewDecision,
  HunkDecision,
  ReviewDecisionPersistenceScope,
  ReviewFileScope,
} from '@shared/types';

const JOURNAL_VERSION = 1;
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
const MAX_JOURNAL_RECORDS_PER_SCOPE = 64;
const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const SCOPE_KEY_PATTERN = /^(?:task|agent)-[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/;

export type ReviewMutationJournalPhase = 'prepared' | 'committed' | 'failed';

export interface ReviewMutationJournalRecord {
  version: 1;
  id: string;
  phase: ReviewMutationJournalPhase;
  teamName: string;
  persistenceScope: ReviewDecisionPersistenceScope;
  reviewScope: ReviewFileScope;
  decision: FileReviewDecision & { reviewKey: string };
  fileContent: FileChangeWithContent;
  createdAt: string;
  updatedAt: string;
  failure?: string;
}

export interface PrepareReviewMutationInput {
  teamName: string;
  persistenceScope: ReviewDecisionPersistenceScope;
  reviewScope: ReviewFileScope;
  decision: FileReviewDecision & { reviewKey: string };
  fileContent: FileChangeWithContent;
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
    if (!input.decision.reviewKey || input.fileContent.filePath !== input.decision.filePath) {
      throw new Error('Invalid review mutation journal decision');
    }
    const existing = await this.list(input.teamName, input.persistenceScope);
    if (existing.length >= MAX_JOURNAL_RECORDS_PER_SCOPE) {
      throw new Error('Too many pending review mutation journal records');
    }
    const now = new Date().toISOString();
    const record: ReviewMutationJournalRecord = {
      version: JOURNAL_VERSION,
      id: randomUUID(),
      phase: 'prepared',
      teamName: input.teamName,
      persistenceScope: input.persistenceScope,
      reviewScope: input.reviewScope,
      decision: input.decision,
      fileContent: input.fileContent,
      createdAt: now,
      updatedAt: now,
    };
    await this.writeRecord(record);
    return record;
  }

  async markCommitted(record: ReviewMutationJournalRecord): Promise<ReviewMutationJournalRecord> {
    const committed: ReviewMutationJournalRecord = {
      ...record,
      phase: 'committed',
      updatedAt: new Date().toISOString(),
      failure: undefined,
    };
    await this.writeRecord(committed);
    return committed;
  }

  async markFailed(record: ReviewMutationJournalRecord, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : 'Unknown review mutation failure';
    await this.writeRecord({
      ...record,
      phase: 'failed',
      updatedAt: new Date().toISOString(),
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

  async acknowledge(
    teamName: string,
    persistenceScope: ReviewDecisionPersistenceScope,
    hunkDecisions: Record<string, HunkDecision>,
    fileDecisions: Record<string, HunkDecision>
  ): Promise<void> {
    const records = await this.list(teamName, persistenceScope);
    await Promise.all(
      records
        .filter(
          (record) =>
            record.phase === 'committed' &&
            this.decisionPatchMatches(record, hunkDecisions, fileDecisions)
        )
        .map((record) => this.remove(record))
    );
  }

  private decisionPatchMatches(
    record: ReviewMutationJournalRecord,
    hunkDecisions: Record<string, HunkDecision>,
    fileDecisions: Record<string, HunkDecision>
  ): boolean {
    const { reviewKey, filePath, fileDecision } = record.decision;
    const actualFileDecision = fileDecisions[reviewKey] ?? fileDecisions[filePath] ?? 'pending';
    if (actualFileDecision !== fileDecision) return false;

    for (const [index, expected] of Object.entries(record.decision.hunkDecisions)) {
      const actual =
        hunkDecisions[`${reviewKey}:${index}`] ??
        hunkDecisions[`${filePath}:${index}`] ??
        'pending';
      if (actual !== expected) return false;
    }
    return true;
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
    const record = parsed as Partial<ReviewMutationJournalRecord>;
    const recordPersistenceScope = record.persistenceScope;
    if (
      record.version !== JOURNAL_VERSION ||
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
    return record as ReviewMutationJournalRecord;
  }
}
