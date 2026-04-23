import { createHash } from 'crypto';
import { diffLines } from 'diff';
import { open, readFile } from 'fs/promises';
import * as path from 'path';

import { normalizePathForComparison } from '@shared/utils/platformPath';
import { createLogger } from '@shared/utils/logger';

import type {
  FileChangeSummary,
  FileEditEvent,
  FileEditTimeline,
  LedgerChangeRelation,
  LedgerContentState,
  SnippetDiff,
  TaskChangeJournalStamp,
  TaskChangeProvenance,
  TaskChangeScope,
  TaskChangeSetV2,
} from '@shared/types';

const logger = createLogger('Service:TaskChangeLedgerReader');

const TASK_CHANGE_JOURNAL_SCHEMA_VERSION = 1;
const TASK_CHANGE_SUMMARY_SCHEMA_VERSION = 2;
const TASK_CHANGE_FRESHNESS_SCHEMA_VERSION = 2;
const TASK_CHANGE_LEDGER_DIRNAME = '.board-task-changes';
const TASK_CHANGE_FRESHNESS_DIRNAME = '.board-task-change-freshness';
const MAX_TASK_ID_ARTIFACT_SEGMENT_LENGTH = 120;

function isWindowsReservedArtifactSegment(segment: string): boolean {
  const stem = segment.split('.')[0]?.toUpperCase() ?? '';
  return (
    !segment ||
    stem === 'CON' ||
    stem === 'PRN' ||
    stem === 'AUX' ||
    stem === 'NUL' ||
    /^COM[1-9]$/.test(stem) ||
    /^LPT[1-9]$/.test(stem)
  );
}

function encodeTaskId(taskId: string): string {
  const encoded = encodeURIComponent(taskId);
  return isWindowsReservedArtifactSegment(encoded) ||
    encoded.length > MAX_TASK_ID_ARTIFACT_SEGMENT_LENGTH
    ? `task-id-${createHash('sha256').update(taskId).digest('hex').slice(0, 32)}`
    : encoded;
}

function taskIdArtifactSegments(taskId: string): string[] {
  const safe = encodeTaskId(taskId);
  const legacy = encodeURIComponent(taskId);
  return safe === legacy ? [safe] : [safe, legacy];
}

function taskArtifactPathCandidates(
  projectDir: string,
  taskId: string,
  dirName: string,
  fileSuffix: string
): string[] {
  return taskIdArtifactSegments(taskId).map((segment) =>
    path.join(projectDir, dirName, `${segment}${fileSuffix}`)
  );
}

type LedgerConfidence = 'exact' | 'high' | 'medium' | 'low' | 'ambiguous';

interface LedgerContentRef {
  sha256: string;
  sizeBytes: number;
  blobRef?: string;
  unavailableReason?: string;
}

interface LedgerEvent {
  schemaVersion: typeof TASK_CHANGE_JOURNAL_SCHEMA_VERSION;
  eventId: string;
  taskId: string;
  taskRef: string;
  taskRefKind: 'canonical' | 'display' | 'unknown';
  phase: 'work' | 'review';
  executionSeq: number;
  sessionId: string;
  agentId?: string;
  memberName?: string;
  toolUseId: string;
  source:
    | 'file_edit'
    | 'file_write'
    | 'notebook_edit'
    | 'bash_simulated_sed'
    | 'shell_snapshot'
    | 'powershell_snapshot'
    | 'post_tool_hook_snapshot';
  operation: 'create' | 'modify' | 'delete';
  confidence: LedgerConfidence;
  workspaceRoot: string;
  worktreePath?: string;
  worktreeBranch?: string;
  baseWorkspaceRoot?: string;
  dirtyLeaderWarning?: string;
  filePath: string;
  relativePath: string;
  timestamp: string;
  toolStatus: 'succeeded' | 'failed' | 'killed' | 'backgrounded';
  before: LedgerContentRef | null;
  after: LedgerContentRef | null;
  beforeState?: LedgerContentState;
  afterState?: LedgerContentState;
  relation?: LedgerChangeRelation;
  oldString?: string;
  newString?: string;
  linesAdded?: number;
  linesRemoved?: number;
  replaceAll?: boolean;
  warnings?: string[];
}

interface LedgerNotice {
  schemaVersion: typeof TASK_CHANGE_JOURNAL_SCHEMA_VERSION;
  noticeId: string;
  taskId: string;
  taskRef: string;
  taskRefKind: 'canonical' | 'display' | 'unknown';
  phase: 'work' | 'review';
  executionSeq: number;
  sessionId: string;
  agentId?: string;
  memberName?: string;
  toolUseId: string;
  timestamp: string;
  severity: 'warning';
  message: string;
  code?: 'multi-scope-skipped' | 'journal-recovered' | 'writer-lock-stolen';
}

interface LedgerBundleFileV1 {
  filePath: string;
  relativePath: string;
  eventIds: string[];
  linesAdded: number;
  linesRemoved: number;
  isNewFile: boolean;
  latestAfterHash: string | null;
}

interface LedgerBundleV1 {
  schemaVersion: 1;
  source: 'task-change-ledger';
  taskId: string;
  generatedAt: string;
  eventCount: number;
  files: LedgerBundleFileV1[];
  totalLinesAdded: number;
  totalLinesRemoved: number;
  totalFiles: number;
  confidence: 'high' | 'medium' | 'low';
  warnings: string[];
  events: LedgerEvent[];
  notices?: LedgerNotice[];
}

interface LedgerSummaryContributorV2 {
  actorKey: string;
  agentId?: string;
  memberName?: string;
  eventCount: number;
  noticeCount: number;
  touchedFileCount: number;
  visibleFileCount: number;
  toolUseCount: number;
  cumulativeLinesAdded: number;
  cumulativeLinesRemoved: number;
  firstTimestamp: string;
  lastTimestamp: string;
}

interface LedgerSummaryScopeV2 {
  confidence: TaskChangeScope['confidence'];
  primaryActorKey?: string;
  primaryAgentId?: string;
  primaryMemberName?: string;
  memberName: string;
  agentIds: string[];
  memberNames?: string[];
  startTimestamp: string;
  endTimestamp: string;
  toolUseIds: string[];
  toolUseCount: number;
  toolUseIdsTruncated?: boolean;
  phaseSet: Array<'work' | 'review'>;
  executionSeqRange?: { start: number; end: number };
  confidenceBreakdown?: TaskChangeScope['confidenceBreakdown'];
  visibleFileCount: number;
  contributors: LedgerSummaryContributorV2[];
  worktreePaths?: string[];
  worktreeBranches?: string[];
  baseWorkspaceRoots?: string[];
  dirtyLeaderWarnings?: string[];
}

interface LedgerSummaryFileV2 {
  changeKey: string;
  filePath: string;
  relativePath: string;
  displayPath?: string;
  linesAdded: number;
  linesRemoved: number;
  diffStatKnown: boolean;
  eventCount: number;
  firstTimestamp: string;
  lastTimestamp: string;
  latestOperation: 'create' | 'modify' | 'delete';
  createdInTask: boolean;
  deletedInTask: boolean;
  baselineExists?: boolean;
  finalExists?: boolean;
  latestBeforeHash: string | null;
  latestAfterHash: string | null;
  latestBeforeState?: LedgerContentState;
  latestAfterState?: LedgerContentState;
  contentAvailability: 'full-text' | 'hash-only' | 'metadata-only';
  reviewability: 'full-text' | 'partial-text' | 'metadata-only';
  relation?: LedgerChangeRelation;
  worktreePath?: string;
  worktreeBranch?: string;
  baseWorkspaceRoot?: string;
  dirtyLeaderWarning?: string;
  primaryActorKey?: string;
  agentIds: string[];
  memberNames?: string[];
  executionSeqRange?: { start: number; end: number };
  warnings?: string[];
}

interface LedgerSummaryBundleV2 {
  schemaVersion: typeof TASK_CHANGE_SUMMARY_SCHEMA_VERSION;
  source: 'task-change-ledger';
  bundleKind: 'summary';
  taskId: string;
  generatedAt: string;
  journalStamp: TaskChangeJournalStamp;
  integrity: 'ok' | 'recovered' | 'partial';
  eventCount: number;
  noticeCount: number;
  scope: LedgerSummaryScopeV2;
  files: LedgerSummaryFileV2[];
  totalLinesAdded: number;
  totalLinesRemoved: number;
  diffStatCompleteness: 'complete' | 'partial';
  totalFiles: number;
  confidence: 'high' | 'medium' | 'low';
  warningCount: number;
  warnings: string[];
}

interface LedgerFreshnessV2 {
  schemaVersion: typeof TASK_CHANGE_FRESHNESS_SCHEMA_VERSION;
  source: 'task-change-ledger';
  taskId: string;
  updatedAt: string;
  journalStamp: TaskChangeJournalStamp;
  eventCount: number;
  noticeCount: number;
  integrity: 'ok' | 'recovered' | 'partial';
  bundleSchemaVersion: 2;
  bundleKind: 'summary';
}

type JournalReadResult<T> = {
  entries: T[];
  recovered: boolean;
};

type JournalData = {
  events: LedgerEvent[];
  notices: LedgerNotice[];
  recovered: boolean;
};

type SummaryBundleRead = {
  bundle: LedgerSummaryBundleV2;
  provenance: TaskChangeProvenance;
  mode: 'validated' | 'degraded';
  degradedWarning?: string;
};

export class TaskChangeLedgerReader {
  async readTaskChanges(params: {
    teamName: string;
    taskId: string;
    projectDir: string;
    projectPath?: string;
    includeDetails: boolean;
  }): Promise<TaskChangeSetV2 | null> {
    const bundleRead = await this.tryReadSummaryBundleV2(
      params.projectDir,
      params.taskId,
      params.projectPath
    );

    if (params.includeDetails) {
      const journal = await this.readJournalData(params.projectDir, params.taskId);
      if (journal) {
        return this.buildDetailedResult({
          teamName: params.teamName,
          taskId: params.taskId,
          projectDir: params.projectDir,
          projectPath: params.projectPath,
          journal,
          bundle: bundleRead?.bundle,
          provenance:
            bundleRead?.provenance ??
            this.buildLedgerProvenanceFromJournal(
              (await this.readJournalStampFromDisk(params.projectDir, params.taskId)) ?? {},
              undefined,
              journal.recovered ? 'recovered' : 'ok'
            ),
        });
      }

      const legacy = await this.readLegacyBundleV1(params.projectDir, params.taskId);
      if (legacy) {
        return this.buildLegacyResult({
          teamName: params.teamName,
          taskId: params.taskId,
          projectDir: params.projectDir,
          projectPath: params.projectPath,
          bundle: legacy,
          includeDetails: true,
        });
      }

      if (bundleRead) {
        const result = this.buildSummaryResultFromBundle({
          teamName: params.teamName,
          taskId: params.taskId,
          projectPath: params.projectPath,
          bundle: bundleRead.bundle,
          provenance: bundleRead.provenance,
          extraWarnings: bundleRead.degradedWarning ? [bundleRead.degradedWarning] : undefined,
        });
        return {
          ...result,
          warnings: [
            ...result.warnings,
            'Ledger journal was unavailable; detailed snippets could not be loaded.',
          ],
        };
      }

      return null;
    }

    if (bundleRead?.mode === 'validated') {
      return this.buildSummaryResultFromBundle({
        teamName: params.teamName,
        taskId: params.taskId,
        projectPath: params.projectPath,
        bundle: bundleRead.bundle,
        provenance: bundleRead.provenance,
      });
    }

    const journal = await this.readJournalData(params.projectDir, params.taskId);
    if (journal) {
      return this.buildJournalFallbackSummary({
        teamName: params.teamName,
        taskId: params.taskId,
        projectDir: params.projectDir,
        projectPath: params.projectPath,
        journal,
      });
    }

    if (bundleRead) {
      return this.buildSummaryResultFromBundle({
        teamName: params.teamName,
        taskId: params.taskId,
        projectPath: params.projectPath,
        bundle: bundleRead.bundle,
        provenance: bundleRead.provenance,
        extraWarnings: bundleRead.degradedWarning ? [bundleRead.degradedWarning] : undefined,
      });
    }

    const legacy = await this.readLegacyBundleV1(params.projectDir, params.taskId);
    if (legacy) {
      return this.buildLegacyResult({
        teamName: params.teamName,
        taskId: params.taskId,
        projectDir: params.projectDir,
        projectPath: params.projectPath,
        bundle: legacy,
        includeDetails: false,
      });
    }

    return null;
  }

  private async tryReadSummaryBundleV2(
    projectDir: string,
    taskId: string,
    _projectPath?: string
  ): Promise<SummaryBundleRead | null> {
    const [bundle, freshness, journalStamp] = await Promise.all([
      this.readSummaryBundleV2(projectDir, taskId),
      this.readFreshnessV2(projectDir, taskId),
      this.readJournalStampFromDisk(projectDir, taskId),
    ]);
    if (!bundle) {
      return null;
    }

    const provenance = this.buildLedgerProvenance(
      bundle.journalStamp,
      bundle.integrity,
      bundle.schemaVersion
    );

    if (
      freshness &&
      this.bundleMatchesFreshness(bundle, freshness) &&
      freshness.integrity !== 'partial'
    ) {
      return { bundle, provenance, mode: 'validated' };
    }

    if (
      !freshness &&
      journalStamp &&
      JSON.stringify(journalStamp) === JSON.stringify(bundle.journalStamp) &&
      bundle.integrity !== 'partial'
    ) {
      return {
        bundle,
        provenance: this.buildLedgerProvenance(
          journalStamp,
          bundle.integrity,
          bundle.schemaVersion
        ),
        mode: 'validated',
      };
    }

    if (!freshness && !journalStamp) {
      return {
        bundle,
        provenance,
        mode: 'degraded',
        degradedWarning:
          'Task change summary used bundle v2 without live validation because freshness and journal files were unavailable.',
      };
    }

    return {
      bundle,
      provenance,
      mode: 'degraded',
      degradedWarning:
        'Task change summary bypassed bundle v2 fast-path because bundle freshness did not match the current ledger generation.',
    };
  }

  private async readSummaryBundleV2(
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
        const raw = await readFile(bundlePath, 'utf8');
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
    logger.debug(`No v2 task-change bundle for ${taskId}.`);
    return null;
  }

  private async readFreshnessV2(
    projectDir: string,
    taskId: string
  ): Promise<LedgerFreshnessV2 | null> {
    const freshnessPaths = taskArtifactPathCandidates(
      projectDir,
      taskId,
      TASK_CHANGE_FRESHNESS_DIRNAME,
      '.json'
    );
    for (const freshnessPath of freshnessPaths) {
      try {
        const raw = await readFile(freshnessPath, 'utf8');
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

  private async readLegacyBundleV1(
    projectDir: string,
    taskId: string
  ): Promise<LedgerBundleV1 | null> {
    const bundlePaths = taskArtifactPathCandidates(
      projectDir,
      taskId,
      path.join(TASK_CHANGE_LEDGER_DIRNAME, 'bundles'),
      '.json'
    );
    for (const bundlePath of bundlePaths) {
      try {
        const raw = await readFile(bundlePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<LedgerBundleV1>;
        if (
          parsed?.schemaVersion !== 1 ||
          parsed.source !== 'task-change-ledger' ||
          parsed.taskId !== taskId ||
          !Array.isArray(parsed.events)
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

  private async readJournalData(projectDir: string, taskId: string): Promise<JournalData | null> {
    const [events, notices] = await Promise.all([
      this.readJournalEntries<LedgerEvent>({
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

    if (events.entries.length === 0 && notices.entries.length === 0) {
      return null;
    }

    return {
      events: events.entries,
      notices: notices.entries,
      recovered: events.recovered || notices.recovered,
    };
  }

  private async readJournalEntries<T extends { taskId: string; schemaVersion: number }>(params: {
    filePath: string | string[];
    taskId: string;
    schemaVersion: number;
    idField: 'eventId' | 'noticeId';
  }): Promise<JournalReadResult<T>> {
    let raw: string | null = null;
    for (const filePath of Array.isArray(params.filePath) ? params.filePath : [params.filePath]) {
      try {
        raw = await readFile(filePath, 'utf8');
        break;
      } catch {
        continue;
      }
    }
    if (raw === null) {
      return { entries: [], recovered: false };
    }

    const entries: T[] = [];
    const seenIds = new Set<string>();
    let recovered = false;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as T & Record<string, unknown>;
        const id = parsed?.[params.idField];
        if (
          parsed?.schemaVersion !== params.schemaVersion ||
          parsed.taskId !== params.taskId ||
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
    return { entries, recovered };
  }

  private bundleMatchesFreshness(
    bundle: LedgerSummaryBundleV2,
    freshness: LedgerFreshnessV2
  ): boolean {
    return (
      JSON.stringify(bundle.journalStamp) === JSON.stringify(freshness.journalStamp) &&
      bundle.eventCount === freshness.eventCount &&
      bundle.noticeCount === freshness.noticeCount &&
      freshness.bundleSchemaVersion === bundle.schemaVersion &&
      freshness.bundleKind === bundle.bundleKind
    );
  }

  private buildLedgerProvenance(
    journalStamp: TaskChangeJournalStamp,
    integrity: 'ok' | 'recovered' | 'partial',
    bundleSchemaVersion?: number
  ): TaskChangeProvenance {
    return {
      sourceKind: 'ledger',
      sourceFingerprint: this.hashFingerprintPayload({
        journalStamp,
        integrity,
        ...(bundleSchemaVersion ? { bundleSchemaVersion } : {}),
      }),
      journalStamp,
      ...(bundleSchemaVersion ? { bundleSchemaVersion } : {}),
      integrity,
    };
  }

  private buildLedgerProvenanceFromJournal(
    journalStamp: TaskChangeJournalStamp,
    bundleSchemaVersion?: number,
    integrity: 'ok' | 'recovered' | 'partial' = 'ok'
  ): TaskChangeProvenance {
    return this.buildLedgerProvenance(journalStamp, integrity, bundleSchemaVersion);
  }

  private hashFingerprintPayload(payload: unknown): string {
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  private async readJournalStampFromDisk(
    projectDir: string,
    taskId: string
  ): Promise<TaskChangeJournalStamp | null> {
    const readFileStamp = async (filePaths: string[]) => {
      let handle: Awaited<ReturnType<typeof open>> | null = null;
      for (const filePath of filePaths) {
        try {
          handle = await open(filePath, 'r');
          const fileStat = await handle.stat();
          if (!fileStat.isFile()) {
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

  private buildSummaryResultFromBundle(params: {
    teamName: string;
    taskId: string;
    projectPath?: string;
    bundle: LedgerSummaryBundleV2;
    provenance: TaskChangeProvenance;
    extraWarnings?: string[];
  }): TaskChangeSetV2 {
    return {
      teamName: params.teamName,
      taskId: params.taskId,
      files: params.bundle.files.map((file) => this.mapV2SummaryFile(file, params.projectPath)),
      totalLinesAdded: params.bundle.totalLinesAdded,
      totalLinesRemoved: params.bundle.totalLinesRemoved,
      totalFiles: params.bundle.totalFiles,
      confidence: params.bundle.confidence,
      computedAt: params.bundle.generatedAt,
      scope: this.mapV2Scope(params.taskId, params.bundle.scope, params.bundle.files),
      warnings: [...params.bundle.warnings, ...(params.extraWarnings ?? [])],
      diffStatCompleteness: params.bundle.diffStatCompleteness,
      provenance: params.provenance,
    };
  }

  private async buildDetailedResult(params: {
    teamName: string;
    taskId: string;
    projectDir: string;
    projectPath?: string;
    journal: JournalData;
    bundle?: LedgerSummaryBundleV2;
    provenance: TaskChangeProvenance;
  }): Promise<TaskChangeSetV2> {
    const snippets = await this.buildSnippets(params.projectDir, params.journal.events);
    const groupedSnippets = this.groupSnippets(snippets);
    const warnings = this.collectWarnings(params.journal.events, params.journal.notices, {
      recovered: params.journal.recovered,
    });

    let files: FileChangeSummary[];
    let totalLinesAdded: number;
    let totalLinesRemoved: number;
    let totalFiles: number;
    let confidence: TaskChangeSetV2['confidence'];
    let scope: TaskChangeScope;
    let diffStatCompleteness: 'complete' | 'partial' | undefined;

    if (params.bundle) {
      files = params.bundle.files.map((file) => {
        const groupKey = this.groupKeyForFileSummary(
          file.filePath,
          file.relation,
          file.worktreePath
        );
        const entry = groupedSnippets.get(groupKey);
        return {
          ...this.mapV2SummaryFile(file, params.projectPath),
          snippets: entry?.snippets ?? [],
          timeline: entry ? this.buildTimeline(file.filePath, entry.snippets) : undefined,
        };
      });
      totalLinesAdded = params.bundle.totalLinesAdded;
      totalLinesRemoved = params.bundle.totalLinesRemoved;
      totalFiles = params.bundle.totalFiles;
      confidence = params.bundle.confidence;
      scope = this.mapV2Scope(params.taskId, params.bundle.scope, params.bundle.files);
      diffStatCompleteness = params.bundle.diffStatCompleteness;
    } else {
      const fallback = this.buildFallbackFilesFromGroupedSnippets(
        groupedSnippets,
        params.projectPath
      );
      files = fallback.files;
      totalLinesAdded = fallback.totalLinesAdded;
      totalLinesRemoved = fallback.totalLinesRemoved;
      totalFiles = fallback.files.length;
      confidence = params.journal.events.some((event) => event.confidence === 'low')
        ? 'low'
        : params.journal.events.some((event) => event.confidence === 'medium')
          ? 'medium'
          : 'high';
      scope = this.buildFallbackScope(
        params.taskId,
        files,
        params.journal.events,
        params.journal.notices
      );
      diffStatCompleteness = fallback.files.every((file) => file.diffStatKnown !== false)
        ? 'complete'
        : 'partial';
      warnings.push(
        'Ledger detail view fell back to journal reconstruction because summary bundle v2 was unavailable.'
      );
    }

    return {
      teamName: params.teamName,
      taskId: params.taskId,
      files,
      totalLinesAdded,
      totalLinesRemoved,
      totalFiles,
      confidence,
      computedAt: params.bundle?.generatedAt ?? new Date().toISOString(),
      scope,
      warnings,
      ...(diffStatCompleteness ? { diffStatCompleteness } : {}),
      provenance: params.provenance,
    };
  }

  private async buildJournalFallbackSummary(params: {
    teamName: string;
    taskId: string;
    projectDir: string;
    projectPath?: string;
    journal: JournalData;
  }): Promise<TaskChangeSetV2> {
    const provenance = this.buildLedgerProvenanceFromJournal(
      (await this.readJournalStampFromDisk(params.projectDir, params.taskId)) ?? {},
      undefined,
      params.journal.recovered ? 'recovered' : 'ok'
    );
    const snippets = params.journal.events.map((event) => this.eventToSnippet(event, null, null));
    const grouped = this.groupSnippets(snippets);
    const fallback = this.buildFallbackFilesFromGroupedSnippets(grouped, params.projectPath);
    return {
      teamName: params.teamName,
      taskId: params.taskId,
      files: fallback.files.map((file) => ({ ...file, snippets: [] })),
      totalLinesAdded: fallback.totalLinesAdded,
      totalLinesRemoved: fallback.totalLinesRemoved,
      totalFiles: fallback.files.length,
      confidence: params.journal.events.some((event) => event.confidence === 'low')
        ? 'low'
        : params.journal.events.some((event) => event.confidence === 'medium')
          ? 'medium'
          : 'high',
      computedAt: new Date().toISOString(),
      scope: this.buildFallbackScope(
        params.taskId,
        fallback.files,
        params.journal.events,
        params.journal.notices
      ),
      warnings: [
        ...this.collectWarnings(params.journal.events, params.journal.notices, {
          recovered: params.journal.recovered,
        }),
        'Task change summary fell back to journal reconstruction.',
      ],
      diffStatCompleteness: fallback.files.every((file) => file.diffStatKnown !== false)
        ? 'complete'
        : 'partial',
      provenance,
    };
  }

  private async buildLegacyResult(params: {
    teamName: string;
    taskId: string;
    projectDir: string;
    projectPath?: string;
    bundle: LedgerBundleV1;
    includeDetails: boolean;
  }): Promise<TaskChangeSetV2> {
    const snippets = params.includeDetails
      ? await this.buildSnippets(params.projectDir, params.bundle.events)
      : params.bundle.events.map((event) => this.eventToSnippet(event, null, null));
    const grouped = this.groupSnippets(snippets);
    const fallback = this.buildFallbackFilesFromGroupedSnippets(grouped, params.projectPath);
    const warnings = new Set<string>(params.bundle.warnings ?? []);
    warnings.add(
      'Task change ledger used legacy bundle v1 compatibility mode; summary was derived from legacy events.'
    );
    for (const notice of params.bundle.notices ?? []) warnings.add(notice.message);

    return {
      teamName: params.teamName,
      taskId: params.taskId,
      files: params.includeDetails
        ? fallback.files
        : fallback.files.map((file) => ({ ...file, snippets: [], timeline: undefined })),
      totalLinesAdded: fallback.totalLinesAdded,
      totalLinesRemoved: fallback.totalLinesRemoved,
      totalFiles: fallback.files.length,
      confidence: params.bundle.confidence,
      computedAt: params.bundle.generatedAt,
      scope: this.buildFallbackScope(
        params.taskId,
        fallback.files,
        params.bundle.events,
        params.bundle.notices ?? []
      ),
      warnings: [...warnings],
      diffStatCompleteness: fallback.files.every((file) => file.diffStatKnown !== false)
        ? 'complete'
        : 'partial',
      provenance: {
        sourceKind: 'ledger',
        sourceFingerprint: this.hashFingerprintPayload({
          legacyTaskId: params.taskId,
          generatedAt: params.bundle.generatedAt,
          eventCount: params.bundle.eventCount,
        }),
      },
    };
  }

  private mapV2SummaryFile(file: LedgerSummaryFileV2, projectPath?: string): FileChangeSummary {
    const displayPath = file.displayPath ?? file.filePath;
    const filePath = this.normalizeLedgerFilePath(file.filePath);
    return {
      filePath,
      relativePath: this.relativePath(displayPath, projectPath, file.relativePath),
      snippets: [],
      linesAdded: file.linesAdded,
      linesRemoved: file.linesRemoved,
      isNewFile: Boolean(
        file.createdInTask && file.latestOperation !== 'delete' && file.relation?.kind !== 'rename'
      ),
      changeKey: this.normalizeSummaryChangeKey(file),
      diffStatKnown: file.diffStatKnown,
      ledgerSummary: {
        latestOperation: file.latestOperation,
        createdInTask: file.createdInTask,
        deletedInTask: file.deletedInTask,
        contentAvailability: file.contentAvailability,
        reviewability: file.reviewability,
        ...(file.relation ? { relation: file.relation } : {}),
        ...(file.latestBeforeState ? { beforeState: file.latestBeforeState } : {}),
        ...(file.latestAfterState ? { afterState: file.latestAfterState } : {}),
        ...(file.primaryActorKey ? { primaryActorKey: file.primaryActorKey } : {}),
        ...(file.agentIds.length > 0 ? { agentIds: file.agentIds } : {}),
        ...(file.memberNames ? { memberNames: file.memberNames } : {}),
        ...(file.executionSeqRange ? { executionSeqRange: file.executionSeqRange } : {}),
        ...(file.worktreePath ? { worktreePath: file.worktreePath } : {}),
        ...(file.worktreeBranch ? { worktreeBranch: file.worktreeBranch } : {}),
        ...(file.baseWorkspaceRoot ? { baseWorkspaceRoot: file.baseWorkspaceRoot } : {}),
        ...(file.dirtyLeaderWarning ? { dirtyLeaderWarning: file.dirtyLeaderWarning } : {}),
      },
    };
  }

  private normalizeSummaryChangeKey(file: LedgerSummaryFileV2): string {
    if (file.relation) {
      return this.relationChangeKey(file.relation, file.worktreePath);
    }
    const slashNormalized = file.changeKey.replace(/\\/g, '/');
    const pathKeyMatch = /^(path|create|delete):(.+)$/.exec(slashNormalized);
    if (pathKeyMatch) {
      return `${pathKeyMatch[1]}:${normalizePathForComparison(pathKeyMatch[2] ?? '')}`;
    }
    return slashNormalized;
  }

  private mapV2Scope(
    taskId: string,
    scope: LedgerSummaryScopeV2,
    files: LedgerSummaryFileV2[]
  ): TaskChangeScope {
    return {
      taskId,
      memberName:
        scope.memberName ||
        scope.primaryMemberName ||
        scope.primaryAgentId ||
        scope.primaryActorKey ||
        '',
      startLine: 0,
      endLine: 0,
      startTimestamp: scope.startTimestamp,
      endTimestamp: scope.endTimestamp,
      toolUseIds: scope.toolUseIds,
      filePaths: files.map((file) => this.normalizeLedgerFilePath(file.filePath)),
      confidence: scope.confidence,
      ...(scope.primaryActorKey ? { primaryActorKey: scope.primaryActorKey } : {}),
      ...(scope.primaryAgentId ? { primaryAgentId: scope.primaryAgentId } : {}),
      ...(scope.primaryMemberName ? { primaryMemberName: scope.primaryMemberName } : {}),
      ...(scope.agentIds.length > 0 ? { agentIds: scope.agentIds } : {}),
      ...(scope.memberNames ? { memberNames: scope.memberNames } : {}),
      ...(scope.toolUseCount !== undefined ? { toolUseCount: scope.toolUseCount } : {}),
      ...(scope.toolUseIdsTruncated ? { toolUseIdsTruncated: true } : {}),
      ...(scope.phaseSet ? { phaseSet: scope.phaseSet } : {}),
      ...(scope.executionSeqRange ? { executionSeqRange: scope.executionSeqRange } : {}),
      ...(scope.confidenceBreakdown ? { confidenceBreakdown: scope.confidenceBreakdown } : {}),
      ...(scope.contributors ? { contributors: scope.contributors } : {}),
      ...(scope.worktreePaths ? { worktreePaths: scope.worktreePaths } : {}),
      ...(scope.worktreeBranches ? { worktreeBranches: scope.worktreeBranches } : {}),
      ...(scope.baseWorkspaceRoots ? { baseWorkspaceRoots: scope.baseWorkspaceRoots } : {}),
      ...(scope.dirtyLeaderWarnings ? { dirtyLeaderWarnings: scope.dirtyLeaderWarnings } : {}),
    };
  }

  private async buildSnippets(projectDir: string, events: LedgerEvent[]): Promise<SnippetDiff[]> {
    return Promise.all(
      events.map(async (event) => {
        const beforeContent = await this.readContentRef(projectDir, event.before);
        const afterContent = await this.readContentRef(projectDir, event.after);
        return this.eventToSnippet(event, beforeContent, afterContent);
      })
    );
  }

  private async readContentRef(
    projectDir: string,
    ref: LedgerContentRef | null
  ): Promise<string | null> {
    if (!ref?.blobRef) {
      return null;
    }
    try {
      return await readFile(
        path.join(projectDir, TASK_CHANGE_LEDGER_DIRNAME, 'blobs', ref.blobRef),
        'utf8'
      );
    } catch {
      return null;
    }
  }

  private eventToSnippet(
    event: LedgerEvent,
    beforeContent: string | null,
    afterContent: string | null
  ): SnippetDiff {
    const filePath = this.normalizeLedgerFilePath(event.filePath);
    return {
      toolUseId: event.toolUseId,
      filePath,
      toolName: this.mapToolName(event.source),
      type: this.mapSnippetType(event),
      oldString: event.oldString ?? beforeContent ?? '',
      newString: event.newString ?? afterContent ?? '',
      replaceAll: event.replaceAll ?? false,
      timestamp: event.timestamp,
      isError: false,
      ledger: {
        eventId: event.eventId,
        source: event.confidence === 'exact' ? 'ledger-exact' : 'ledger-snapshot',
        confidence: event.confidence,
        originalFullContent: beforeContent,
        modifiedFullContent: afterContent,
        beforeHash: event.before?.sha256 ?? null,
        afterHash: event.after?.sha256 ?? null,
        operation: event.operation,
        beforeState: event.beforeState,
        afterState: event.afterState,
        relation: event.relation,
        executionSeq: event.executionSeq,
        linesAdded: event.linesAdded,
        linesRemoved: event.linesRemoved,
        worktreePath: event.worktreePath,
        worktreeBranch: event.worktreeBranch,
        baseWorkspaceRoot: event.baseWorkspaceRoot,
        dirtyLeaderWarning: event.dirtyLeaderWarning,
        textAvailability:
          beforeContent !== null && afterContent !== null
            ? 'full-text'
            : event.oldString !== undefined || event.newString !== undefined
              ? 'patch-text'
              : 'unavailable',
      },
    };
  }

  private mapToolName(eventSource: LedgerEvent['source']): SnippetDiff['toolName'] {
    switch (eventSource) {
      case 'file_edit':
        return 'Edit';
      case 'file_write':
        return 'Write';
      case 'notebook_edit':
        return 'NotebookEdit';
      case 'bash_simulated_sed':
      case 'shell_snapshot':
        return 'Bash';
      case 'powershell_snapshot':
        return 'PowerShell';
      case 'post_tool_hook_snapshot':
        return 'PostToolUse';
    }
  }

  private mapSnippetType(event: LedgerEvent): SnippetDiff['type'] {
    if (event.source === 'file_write') {
      return event.operation === 'create' ? 'write-new' : 'write-update';
    }
    if (event.source === 'notebook_edit') {
      return 'notebook-edit';
    }
    if (event.source === 'shell_snapshot' || event.source === 'powershell_snapshot') {
      return 'shell-snapshot';
    }
    if (event.source === 'post_tool_hook_snapshot') {
      return 'hook-snapshot';
    }
    return 'edit';
  }

  private groupSnippets(
    snippets: SnippetDiff[]
  ): Map<string, { filePath: string; relation?: LedgerChangeRelation; snippets: SnippetDiff[] }> {
    const grouped = new Map<
      string,
      { filePath: string; relation?: LedgerChangeRelation; snippets: SnippetDiff[] }
    >();
    for (const snippet of snippets) {
      const groupKey = this.groupKeyForSnippet(snippet);
      const existing = grouped.get(groupKey);
      if (existing) {
        existing.snippets.push(snippet);
      } else {
        grouped.set(groupKey, {
          filePath: snippet.filePath,
          ...(snippet.ledger?.relation ? { relation: snippet.ledger.relation } : {}),
          snippets: [snippet],
        });
      }
    }
    return grouped;
  }

  private buildFallbackFilesFromGroupedSnippets(
    grouped: Map<
      string,
      { filePath: string; relation?: LedgerChangeRelation; snippets: SnippetDiff[] }
    >,
    projectPath?: string
  ): { files: FileChangeSummary[]; totalLinesAdded: number; totalLinesRemoved: number } {
    const files: FileChangeSummary[] = [];
    for (const entry of grouped.values()) {
      const relation = entry.relation ?? this.relationForSnippets(entry.snippets);
      let linesAdded = 0;
      let linesRemoved = 0;
      for (const snippet of entry.snippets) {
        if (
          typeof snippet.ledger?.linesAdded === 'number' ||
          typeof snippet.ledger?.linesRemoved === 'number'
        ) {
          linesAdded += snippet.ledger?.linesAdded ?? 0;
          linesRemoved += snippet.ledger?.linesRemoved ?? 0;
          continue;
        }
        const { added, removed } = this.countLineChanges(snippet.oldString, snippet.newString);
        linesAdded += added;
        linesRemoved += removed;
      }
      const displayPath = this.resolveGroupedDisplayPath(entry.filePath, relation, entry.snippets);
      const worktreeLedger = entry.snippets.find((snippet) => snippet.ledger?.worktreePath)?.ledger;
      files.push({
        filePath: displayPath,
        relativePath: this.relativePath(displayPath, projectPath),
        snippets: entry.snippets,
        linesAdded,
        linesRemoved,
        isNewFile:
          relation?.kind !== 'rename' &&
          entry.snippets.some(
            (snippet) => snippet.type === 'write-new' || snippet.ledger?.operation === 'create'
          ),
        changeKey: relation
          ? this.relationChangeKey(relation, worktreeLedger?.worktreePath)
          : `path:${normalizePathForComparison(displayPath)}`,
        diffStatKnown: true,
        ledgerSummary: {
          ...(relation ? { relation } : {}),
          latestOperation:
            entry.snippets[entry.snippets.length - 1]?.ledger?.operation ??
            (entry.snippets[entry.snippets.length - 1]?.type === 'write-new' ? 'create' : 'modify'),
          ...(worktreeLedger?.worktreePath ? { worktreePath: worktreeLedger.worktreePath } : {}),
          ...(worktreeLedger?.worktreeBranch
            ? { worktreeBranch: worktreeLedger.worktreeBranch }
            : {}),
          ...(worktreeLedger?.baseWorkspaceRoot
            ? { baseWorkspaceRoot: worktreeLedger.baseWorkspaceRoot }
            : {}),
          ...(worktreeLedger?.dirtyLeaderWarning
            ? { dirtyLeaderWarning: worktreeLedger.dirtyLeaderWarning }
            : {}),
        },
        timeline: this.buildTimeline(displayPath, entry.snippets),
      });
    }
    const totalLinesAdded = files.reduce((sum, file) => sum + file.linesAdded, 0);
    const totalLinesRemoved = files.reduce((sum, file) => sum + file.linesRemoved, 0);
    return { files, totalLinesAdded, totalLinesRemoved };
  }

  private buildFallbackScope(
    taskId: string,
    files: FileChangeSummary[],
    events: LedgerEvent[],
    notices: LedgerNotice[]
  ): TaskChangeScope {
    const primaryMemberName = events.find((event) => event.memberName)?.memberName;
    const primaryAgentId = events.find((event) => event.agentId)?.agentId;
    const worktreePaths = [
      ...new Set(events.flatMap((event) => (event.worktreePath ? [event.worktreePath] : []))),
    ].sort();
    const worktreeBranches = [
      ...new Set(events.flatMap((event) => (event.worktreeBranch ? [event.worktreeBranch] : []))),
    ].sort();
    const baseWorkspaceRoots = [
      ...new Set(
        events.flatMap((event) => (event.baseWorkspaceRoot ? [event.baseWorkspaceRoot] : []))
      ),
    ].sort();
    const dirtyLeaderWarnings = [
      ...new Set(
        events.flatMap((event) => (event.dirtyLeaderWarning ? [event.dirtyLeaderWarning] : []))
      ),
    ].sort();
    return {
      taskId,
      memberName: primaryMemberName ?? primaryAgentId ?? '',
      startLine: 0,
      endLine: 0,
      startTimestamp: events[0]?.timestamp ?? notices[0]?.timestamp ?? '',
      endTimestamp:
        events[events.length - 1]?.timestamp ?? notices[notices.length - 1]?.timestamp ?? '',
      toolUseIds: [
        ...new Set([...events.map((event) => event.toolUseId), ...notices.map((n) => n.toolUseId)]),
      ],
      filePaths: files.map((file) => file.filePath),
      confidence: {
        tier: events.some((event) => event.confidence !== 'exact') ? 2 : 1,
        label: events.some((event) => event.confidence !== 'exact') ? 'medium' : 'high',
        reason: 'Scoped by orchestrator task-change ledger',
      },
      ...(primaryMemberName ? { primaryMemberName } : {}),
      ...(primaryAgentId ? { primaryAgentId } : {}),
      ...(events.some((event) => !!event.memberName)
        ? {
            memberNames: [
              ...new Set(events.flatMap((event) => (event.memberName ? [event.memberName] : []))),
            ].sort(),
          }
        : {}),
      ...(events.length > 0
        ? {
            executionSeqRange: {
              start: Math.min(...events.map((event) => event.executionSeq)),
              end: Math.max(...events.map((event) => event.executionSeq)),
            },
          }
        : {}),
      ...(worktreePaths.length > 0 ? { worktreePaths } : {}),
      ...(worktreeBranches.length > 0 ? { worktreeBranches } : {}),
      ...(baseWorkspaceRoots.length > 0 ? { baseWorkspaceRoots } : {}),
      ...(dirtyLeaderWarnings.length > 0 ? { dirtyLeaderWarnings } : {}),
    };
  }

  private collectWarnings(
    events: LedgerEvent[],
    notices: LedgerNotice[],
    options: { recovered: boolean }
  ): string[] {
    const warnings = new Set<string>();
    for (const notice of notices) warnings.add(notice.message);
    for (const event of events) {
      for (const warning of event.warnings ?? []) warnings.add(warning);
      if (event.toolStatus === 'failed') {
        warnings.add(`Tool ${event.toolUseId} failed after changing files.`);
      }
      if (event.toolStatus === 'killed') {
        warnings.add(`Background tool ${event.toolUseId} was killed after changing files.`);
      }
    }
    if (options.recovered) {
      warnings.add('Task change ledger recovered from malformed journal lines.');
    }
    return [...warnings];
  }

  private buildTimeline(filePath: string, snippets: SnippetDiff[]): FileEditTimeline {
    const events: FileEditEvent[] = snippets.map((snippet, index) => {
      const { added, removed } = this.countLineChanges(snippet.oldString, snippet.newString);
      return {
        toolUseId: snippet.toolUseId,
        toolName: snippet.toolName,
        timestamp: snippet.timestamp,
        summary: this.summaryForSnippet(snippet, added, removed),
        linesAdded: added,
        linesRemoved: removed,
        snippetIndex: index,
      };
    });
    const firstMs = Date.parse(events[0]?.timestamp ?? '');
    const lastMs = Date.parse(events[events.length - 1]?.timestamp ?? '');
    return {
      filePath,
      events,
      durationMs:
        Number.isFinite(firstMs) && Number.isFinite(lastMs) ? Math.max(0, lastMs - firstMs) : 0,
    };
  }

  private summaryForSnippet(snippet: SnippetDiff, added: number, removed: number): string {
    if (snippet.type === 'write-new') return `Created file (${added} lines)`;
    if (snippet.type === 'write-update') return `Rewrote file (+${added}/-${removed})`;
    if (snippet.type === 'shell-snapshot') {
      return `${snippet.toolName === 'PowerShell' ? 'PowerShell' : 'Shell'} changed file (+${added}/-${removed})`;
    }
    if (snippet.type === 'hook-snapshot') return `Hook changed file (+${added}/-${removed})`;
    if (snippet.type === 'notebook-edit') return `Edited notebook (+${added}/-${removed})`;
    return `Edited file (+${added}/-${removed})`;
  }

  private countLineChanges(before: string, after: string): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    for (const change of diffLines(before, after)) {
      if (change.added) added += change.count ?? 0;
      if (change.removed) removed += change.count ?? 0;
    }
    return { added, removed };
  }

  private groupKeyForSnippet(snippet: SnippetDiff): string {
    return this.groupKeyForFileSummary(
      snippet.filePath,
      snippet.ledger?.relation,
      snippet.ledger?.worktreePath
    );
  }

  private groupKeyForFileSummary(
    filePath: string,
    relation?: LedgerChangeRelation,
    worktreePath?: string
  ): string {
    if (relation) {
      return this.relationChangeKey(relation, worktreePath);
    }
    return `path:${normalizePathForComparison(filePath)}`;
  }

  private relationChangeKey(relation: LedgerChangeRelation, worktreePath?: string): string {
    const pathPart = `${normalizePathForComparison(relation.oldPath)}->${normalizePathForComparison(relation.newPath)}`;
    return worktreePath
      ? `${relation.kind}:${normalizePathForComparison(worktreePath)}:${pathPart}`
      : `${relation.kind}:${pathPart}`;
  }

  private relationForSnippets(snippets: SnippetDiff[]): LedgerChangeRelation | undefined {
    return snippets.find((snippet) => snippet.ledger?.relation)?.ledger?.relation;
  }

  private resolveGroupedDisplayPath(
    fallbackPath: string,
    relation: LedgerChangeRelation | undefined,
    snippets: SnippetDiff[]
  ): string {
    if (!relation) {
      return fallbackPath;
    }

    const newPathSnippet = snippets.find((snippet) =>
      this.pathMatchesRelationPath(snippet.filePath, relation.newPath)
    );
    if (newPathSnippet) {
      return newPathSnippet.filePath;
    }

    const createdSnippet = snippets.find(
      (snippet) => snippet.ledger?.operation === 'create' || snippet.type === 'write-new'
    );
    if (createdSnippet) {
      return createdSnippet.filePath;
    }

    return (
      this.resolveRelatedPathFromRelation(fallbackPath, relation.oldPath, relation.newPath) ??
      fallbackPath
    );
  }

  private pathMatchesRelationPath(filePath: string, relationPath: string): boolean {
    const normalizedFilePath = filePath.replace(/\\/g, '/');
    const normalizedRelationPath = relationPath.replace(/\\/g, '/');
    return (
      normalizedFilePath === normalizedRelationPath ||
      normalizedFilePath.endsWith(`/${normalizedRelationPath}`)
    );
  }

  private resolveRelatedPathFromRelation(
    anchorPath: string,
    anchorRelationPath: string,
    targetRelationPath: string
  ): string | null {
    const normalizedAnchor = anchorPath.replace(/\\/g, '/');
    const normalizedAnchorRelation = anchorRelationPath.replace(/\\/g, '/');
    if (!normalizedAnchor.endsWith(normalizedAnchorRelation)) {
      return null;
    }

    return this.normalizeLedgerFilePath(
      `${normalizedAnchor.slice(0, normalizedAnchor.length - normalizedAnchorRelation.length)}${targetRelationPath.replace(/\\/g, '/')}`
    );
  }

  private normalizeLedgerFilePath(filePath: string): string {
    const slashPath = filePath.replace(/\\/g, '/');
    const isWindowsAbsolute = /^[A-Za-z]:\//.test(slashPath) || slashPath.startsWith('//');
    if (isWindowsAbsolute || (process.platform !== 'win32' && path.isAbsolute(filePath))) {
      return path.normalize(filePath);
    }
    return slashPath;
  }

  private relativePath(
    filePath: string,
    projectPath?: string,
    explicitRelativePath?: string
  ): string {
    if (explicitRelativePath) {
      return explicitRelativePath.replace(/\\/g, '/');
    }
    const normalizedFilePath = filePath.replace(/\\/g, '/');
    const normalizedProjectPath = projectPath?.replace(/\\/g, '/');
    const comparableFilePath = normalizePathForComparison(normalizedFilePath);
    const comparableProjectPath = normalizedProjectPath
      ? normalizePathForComparison(normalizedProjectPath)
      : undefined;
    if (
      normalizedProjectPath &&
      comparableProjectPath &&
      comparableFilePath.startsWith(`${comparableProjectPath}/`)
    ) {
      return normalizedFilePath.slice(normalizedProjectPath.length + 1);
    }
    return normalizedFilePath.split('/').slice(-3).join('/');
  }
}
