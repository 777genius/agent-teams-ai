import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import { LedgerFileReader } from './LedgerFileReader.js';
import {
  TASK_CHANGE_FRESHNESS_DIRNAME,
  TASK_CHANGE_FRESHNESS_SCHEMA_VERSION,
  TASK_CHANGE_JOURNAL_SCHEMA_VERSION,
  TASK_CHANGE_LEDGER_DIRNAME,
  TASK_CHANGE_LEDGER_READ_LIMITS,
  TASK_CHANGE_SUMMARY_SCHEMA_VERSION,
  taskArtifactPathCandidates,
} from './artifactPaths.js';
import type { TaskChangeJournalStamp } from './contracts.js';
import type {
  JournalData,
  JournalReadResult,
  LedgerBundleV1,
  LedgerEvent,
  LedgerFreshnessV2,
  LedgerNotice,
  LedgerSummaryBundleV2,
} from './ledgerTypes.js';
import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';

export class LedgerArtifactReader {
  constructor(
    private readonly files: LedgerFileReader,
    private readonly debug?: (message: string) => void
  ) {}

  async readSummaryBundleV2(
    projectDir: string,
    taskId: string
  ): Promise<LedgerSummaryBundleV2 | null> {
    const bundlePaths = taskArtifactPathCandidates(
      projectDir,
      taskId,
      path.join(TASK_CHANGE_LEDGER_DIRNAME, 'bundles'),
      '.json'
    );
    for (const bundlePath of bundlePaths) {
      try {
        const buffer = await this.files.readConfinedLedgerFile(
          projectDir,
          bundlePath,
          TASK_CHANGE_LEDGER_READ_LIMITS.metadataBytes
        );
        if (!buffer) continue;
        const raw = buffer.toString('utf8');
        const parsed = JSON.parse(raw) as Partial<LedgerSummaryBundleV2>;
        if (
          parsed?.schemaVersion !== TASK_CHANGE_SUMMARY_SCHEMA_VERSION ||
          parsed.source !== 'task-change-ledger' ||
          parsed.bundleKind !== 'summary' ||
          parsed.taskId !== taskId ||
          !Array.isArray(parsed.files)
        ) {
          return null;
        }
        return parsed as LedgerSummaryBundleV2;
      } catch {
        continue;
      }
    }
    this.debug?.(`No v2 task-change bundle for ${taskId}.`);
    return null;
  }

  async readFreshnessV2(projectDir: string, taskId: string): Promise<LedgerFreshnessV2 | null> {
    const freshnessPaths = taskArtifactPathCandidates(
      projectDir,
      taskId,
      TASK_CHANGE_FRESHNESS_DIRNAME,
      '.json'
    );
    for (const freshnessPath of freshnessPaths) {
      try {
        const buffer = await this.files.readConfinedLedgerFile(
          projectDir,
          freshnessPath,
          TASK_CHANGE_LEDGER_READ_LIMITS.metadataBytes
        );
        if (!buffer) continue;
        const raw = buffer.toString('utf8');
        const parsed = JSON.parse(raw) as Partial<LedgerFreshnessV2>;
        if (
          parsed?.schemaVersion !== TASK_CHANGE_FRESHNESS_SCHEMA_VERSION ||
          parsed.source !== 'task-change-ledger' ||
          parsed.taskId !== taskId ||
          parsed.bundleKind !== 'summary'
        ) {
          return null;
        }
        return parsed as LedgerFreshnessV2;
      } catch {
        continue;
      }
    }
    return null;
  }

  async readLegacyBundleV1(projectDir: string, taskId: string): Promise<LedgerBundleV1 | null> {
    const bundlePaths = taskArtifactPathCandidates(
      projectDir,
      taskId,
      path.join(TASK_CHANGE_LEDGER_DIRNAME, 'bundles'),
      '.json'
    );
    for (const bundlePath of bundlePaths) {
      try {
        const buffer = await this.files.readConfinedLedgerFile(
          projectDir,
          bundlePath,
          TASK_CHANGE_LEDGER_READ_LIMITS.metadataBytes
        );
        if (!buffer) continue;
        const raw = buffer.toString('utf8');
        const parsed = JSON.parse(raw) as Partial<LedgerBundleV1>;
        if (
          parsed?.schemaVersion !== 1 ||
          parsed.source !== 'task-change-ledger' ||
          parsed.taskId !== taskId ||
          !Array.isArray(parsed.events) ||
          parsed.events.length > TASK_CHANGE_LEDGER_READ_LIMITS.journalEntries
        ) {
          return null;
        }
        return parsed as LedgerBundleV1;
      } catch {
        continue;
      }
    }
    return null;
  }

  async readJournalData(projectDir: string, taskId: string): Promise<JournalData | null> {
    const [events, notices] = await Promise.all([
      this.readJournalEntries<LedgerEvent>({
        projectDir,
        filePath: taskArtifactPathCandidates(
          projectDir,
          taskId,
          path.join(TASK_CHANGE_LEDGER_DIRNAME, 'events'),
          '.jsonl'
        ),
        taskId,
        schemaVersion: TASK_CHANGE_JOURNAL_SCHEMA_VERSION,
        idField: 'eventId',
      }),
      this.readJournalEntries<LedgerNotice>({
        projectDir,
        filePath: taskArtifactPathCandidates(
          projectDir,
          taskId,
          path.join(TASK_CHANGE_LEDGER_DIRNAME, 'notices'),
          '.jsonl'
        ),
        taskId,
        schemaVersion: TASK_CHANGE_JOURNAL_SCHEMA_VERSION,
        idField: 'noticeId',
      }),
    ]);

    if (events.rejected || notices.rejected) {
      return null;
    }
    if (events.entries.length === 0 && notices.entries.length === 0) {
      return null;
    }

    return {
      events: events.entries,
      notices: notices.entries,
      recovered: events.recovered || notices.recovered,
    };
  }

  async readJournalEntries<T extends { schemaVersion: number }>(params: {
    projectDir: string;
    filePath: string | string[];
    taskId?: string;
    validate?: (row: Record<string, unknown>) => boolean;
    schemaVersion: number;
    idField: 'eventId' | 'noticeId';
  }): Promise<JournalReadResult<T>> {
    let raw: string | null = null;
    for (const filePath of Array.isArray(params.filePath) ? params.filePath : [params.filePath]) {
      let artifactExists = false;
      try {
        await lstat(filePath);
        artifactExists = true;
      } catch {
        // Try the next backwards-compatible task-id path.
      }
      const buffer = await this.files.readConfinedLedgerFile(
        params.projectDir,
        filePath,
        TASK_CHANGE_LEDGER_READ_LIMITS.journalBytes
      );
      if (buffer) {
        raw = buffer.toString('utf8');
        break;
      }
      if (artifactExists) {
        return { entries: [], recovered: true, rejected: true };
      }
    }
    if (raw === null) {
      return { entries: [], recovered: false, rejected: false };
    }

    const entries: T[] = [];
    const seenIds = new Set<string>();
    let recovered = false;
    let inspectedEntries = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      inspectedEntries++;
      if (inspectedEntries > TASK_CHANGE_LEDGER_READ_LIMITS.journalEntries) {
        return { entries: [], recovered: true, rejected: true };
      }
      try {
        const parsed = JSON.parse(line) as T & Record<string, unknown>;
        const id = parsed?.[params.idField];
        if (
          parsed?.schemaVersion !== params.schemaVersion ||
          (params.taskId !== undefined && parsed.taskId !== params.taskId) ||
          (params.validate !== undefined && !params.validate(parsed)) ||
          typeof id !== 'string'
        ) {
          recovered = true;
          continue;
        }
        if (seenIds.has(id)) {
          recovered = true;
          continue;
        }
        seenIds.add(id);
        entries.push(parsed);
      } catch {
        recovered = true;
      }
    }
    return { entries, recovered, rejected: false };
  }

  async readJournalStampFromDisk(
    projectDir: string,
    taskId: string
  ): Promise<TaskChangeJournalStamp | null> {
    const readFileStamp = async (filePaths: string[]) => {
      let handle: Awaited<ReturnType<typeof open>> | null = null;
      for (const filePath of filePaths) {
        try {
          const realFilePath = await this.files.resolveConfinedLedgerFile(projectDir, filePath);
          if (!realFilePath) {
            continue;
          }
          try {
            handle = await open(realFilePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(code ?? '')) {
              throw error;
            }
            const fallbackPath = await this.files.resolveConfinedLedgerFile(projectDir, filePath);
            if (fallbackPath !== realFilePath) {
              continue;
            }
            handle = await open(realFilePath, fsConstants.O_RDONLY);
          }
          const revalidatedPath = await this.files.resolveConfinedLedgerFile(projectDir, filePath);
          if (revalidatedPath !== realFilePath) {
            continue;
          }
          const fileStat = await handle.stat();
          if (
            !fileStat.isFile() ||
            fileStat.size < 0 ||
            fileStat.size > TASK_CHANGE_LEDGER_READ_LIMITS.journalBytes
          ) {
            continue;
          }
          const tailLength = Math.min(fileStat.size, 4096);
          const tail = Buffer.alloc(tailLength);
          if (tailLength > 0) {
            await handle.read(tail, 0, tailLength, fileStat.size - tailLength);
          }
          return {
            bytes: fileStat.size,
            mtimeMs: fileStat.mtimeMs,
            tailSha256: tailLength > 0 ? createHash('sha256').update(tail).digest('hex') : null,
          };
        } catch {
          continue;
        } finally {
          await handle?.close().catch(() => undefined);
          handle = null;
        }
      }
      return undefined;
    };

    const [events, notices] = await Promise.all([
      readFileStamp(
        taskArtifactPathCandidates(
          projectDir,
          taskId,
          path.join(TASK_CHANGE_LEDGER_DIRNAME, 'events'),
          '.jsonl'
        )
      ),
      readFileStamp(
        taskArtifactPathCandidates(
          projectDir,
          taskId,
          path.join(TASK_CHANGE_LEDGER_DIRNAME, 'notices'),
          '.jsonl'
        )
      ),
    ]);

    if (!events && !notices) {
      return null;
    }

    return {
      ...(events ? { events } : {}),
      ...(notices ? { notices } : {}),
    };
  }
}
