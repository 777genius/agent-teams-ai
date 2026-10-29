import { projectCapturedReviewEvidence } from './capturedReviewEvidence.js';
import type { ChangesWithEvidence } from './capturedReviewEvidence.js';
import { LedgerArtifactReader } from './LedgerArtifactReader.js';
import { LedgerFileReader } from './LedgerFileReader.js';
import type {
  FileChangeSummary,
  TaskChangeProvenance,
  TaskChangeScope,
  TaskChangeSetV2,
} from './contracts.js';
import {
  addReviewDiagnostic,
  buildReviewDiagnosticsFromWarnings,
  collectReviewDiagnostics,
  collectWarnings,
  withSummaryStateDiagnostics,
} from './diagnostics.js';
import { buildSnippets, eventToSnippet, projectJournalEventsForUi } from './eventProjection.js';
import {
  buildFallbackFilesFromGroupedSnippets,
  buildFallbackScope,
  buildTimeline,
  groupSnippets,
  mapV2Scope,
  mapV2SummaryFile,
} from './fileProjection.js';
import { groupKeyForFileSummary } from './ledgerPaths.js';
import type {
  JournalData,
  LedgerBundleV1,
  LedgerSummaryBundleV2,
  SummaryBundleRead,
} from './ledgerTypes.js';
import {
  buildLedgerProvenanceFromJournal,
  buildLedgerProvenanceFromSummaryBundle,
  bundleMatchesFreshness,
  hashFingerprintPayload,
} from './provenance.js';
import { createTaskChangeDiagnosticFromWarning } from './reviewability.js';

export interface TaskChangeLedgerReaderOptions {
  debug?: (message: string) => void;
}

/** Shared read-only ledger algorithms for Desktop and Host, with no ambient app dependencies. */
export class TaskChangeLedgerReader {
  private readonly files = new LedgerFileReader();
  private readonly artifacts: LedgerArtifactReader;

  constructor(options: TaskChangeLedgerReaderOptions = {}) {
    this.artifacts = new LedgerArtifactReader(this.files, options.debug);
  }

  async readTaskChanges(params: {
    teamName: string;
    taskId: string;
    projectDir: string;
    projectPath?: string;
    includeDetails: boolean;
  }): Promise<TaskChangeSetV2 | null> {
    return (await this.readTaskChangesWithEvidence(params)).changes;
  }

  async readTaskChangesWithEvidence(params: {
    teamName: string;
    taskId: string;
    projectDir: string;
    projectPath?: string;
    includeDetails: boolean;
  }): Promise<ChangesWithEvidence<TaskChangeSetV2 | null>> {
    const bundleRead = await this.tryReadSummaryBundleV2(
      params.projectDir,
      params.taskId,
      params.projectPath
    );

    if (params.includeDetails) {
      const journal = await this.artifacts.readJournalData(params.projectDir, params.taskId);
      if (journal) {
        return { changes: await this.buildDetailedResult({
          teamName: params.teamName,
          taskId: params.taskId,
          projectDir: params.projectDir,
          projectPath: params.projectPath,
          journal,
          bundle: bundleRead?.bundle,
          provenance:
            bundleRead?.provenance ??
            buildLedgerProvenanceFromJournal(
              (await this.artifacts.readJournalStampFromDisk(params.projectDir, params.taskId)) ??
                {},
              undefined,
              journal.recovered ? 'recovered' : 'ok'
            ),
        }), evidence: projectCapturedReviewEvidence(journal.events) };
      }

      const legacy = await this.artifacts.readLegacyBundleV1(params.projectDir, params.taskId);
      if (legacy) {
        return { changes: await this.buildLegacyResult({
          teamName: params.teamName,
          taskId: params.taskId,
          projectDir: params.projectDir,
          projectPath: params.projectPath,
          bundle: legacy,
          includeDetails: true,
        }), evidence: [] };
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
        return { changes: {
          ...result,
          warnings: [
            ...result.warnings,
            'Ledger journal was unavailable; detailed snippets could not be loaded.',
          ],
        }, evidence: [] };
      }

      return { changes: null, evidence: [] };
    }

    if (bundleRead?.mode === 'validated') {
      return { changes: await this.buildSummaryResultFromBundle({
        teamName: params.teamName,
        taskId: params.taskId,
        projectPath: params.projectPath,
        bundle: bundleRead.bundle,
        provenance: bundleRead.provenance,
      }), evidence: [] };
    }

    const journal = await this.artifacts.readJournalData(params.projectDir, params.taskId);
    if (journal) {
      return { changes: await this.buildJournalFallbackSummary({
        teamName: params.teamName,
        taskId: params.taskId,
        projectDir: params.projectDir,
        projectPath: params.projectPath,
        journal,
      }), evidence: projectCapturedReviewEvidence(journal.events) };
    }

    if (bundleRead) {
      return { changes: await this.buildSummaryResultFromBundle({
        teamName: params.teamName,
        taskId: params.taskId,
        projectPath: params.projectPath,
        bundle: bundleRead.bundle,
        provenance: bundleRead.provenance,
        extraWarnings: bundleRead.degradedWarning ? [bundleRead.degradedWarning] : undefined,
      }), evidence: [] };
    }

    const legacy = await this.artifacts.readLegacyBundleV1(params.projectDir, params.taskId);
    if (legacy) {
      return { changes: await this.buildLegacyResult({
        teamName: params.teamName,
        taskId: params.taskId,
        projectDir: params.projectDir,
        projectPath: params.projectPath,
        bundle: legacy,
        includeDetails: false,
      }), evidence: [] };
    }

    return { changes: null, evidence: [] };
  }

  private async tryReadSummaryBundleV2(
    projectDir: string,
    taskId: string,
    _projectPath?: string
  ): Promise<SummaryBundleRead | null> {
    const [bundle, freshness, journalStamp] = await Promise.all([
      this.artifacts.readSummaryBundleV2(projectDir, taskId),
      this.artifacts.readFreshnessV2(projectDir, taskId),
      this.artifacts.readJournalStampFromDisk(projectDir, taskId),
    ]);
    if (!bundle) {
      return null;
    }

    const provenance = buildLedgerProvenanceFromSummaryBundle(bundle);

    if (
      freshness &&
      bundleMatchesFreshness(bundle, freshness) &&
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
        provenance: buildLedgerProvenanceFromSummaryBundle(bundle, journalStamp),
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

  private buildSummaryResultFromBundle(params: {
    teamName: string;
    taskId: string;
    projectPath?: string;
    bundle: LedgerSummaryBundleV2;
    provenance: TaskChangeProvenance;
    extraWarnings?: string[];
  }): TaskChangeSetV2 {
    const warnings = [...params.bundle.warnings, ...(params.extraWarnings ?? [])];
    return {
      teamName: params.teamName,
      taskId: params.taskId,
      files: params.bundle.files.map((file) => mapV2SummaryFile(file, params.projectPath)),
      totalLinesAdded: params.bundle.totalLinesAdded,
      totalLinesRemoved: params.bundle.totalLinesRemoved,
      totalFiles: params.bundle.totalFiles,
      confidence: params.bundle.confidence,
      computedAt: params.bundle.generatedAt,
      scope: mapV2Scope(params.taskId, params.bundle.scope, params.bundle.files),
      warnings,
      reviewDiagnostics: withSummaryStateDiagnostics(
        buildReviewDiagnosticsFromWarnings(warnings, 'ledger'),
        {
          integrity: params.bundle.integrity,
          diffStatCompleteness: params.bundle.diffStatCompleteness,
        }
      ),
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
    const projectedEvents = projectJournalEventsForUi(params.journal.events);
    const snippets = await buildSnippets(this.files, params.projectDir, projectedEvents);
    const groupedSnippets = groupSnippets(snippets);
    const warnings = collectWarnings(projectedEvents, params.journal.notices, {
      recovered: params.journal.recovered,
    });
    const reviewDiagnostics = collectReviewDiagnostics(projectedEvents, params.journal.notices, {
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
        const groupKey = groupKeyForFileSummary(file.filePath, file.relation, file.worktreePath);
        const entry = groupedSnippets.get(groupKey);
        return {
          ...mapV2SummaryFile(file, params.projectPath),
          snippets: entry?.snippets ?? [],
          timeline: entry ? buildTimeline(file.filePath, entry.snippets) : undefined,
        };
      });
      totalLinesAdded = params.bundle.totalLinesAdded;
      totalLinesRemoved = params.bundle.totalLinesRemoved;
      totalFiles = params.bundle.totalFiles;
      confidence = params.bundle.confidence;
      scope = mapV2Scope(params.taskId, params.bundle.scope, params.bundle.files);
      diffStatCompleteness = params.bundle.diffStatCompleteness;
    } else {
      const fallback = buildFallbackFilesFromGroupedSnippets(groupedSnippets, params.projectPath);
      files = fallback.files;
      totalLinesAdded = fallback.totalLinesAdded;
      totalLinesRemoved = fallback.totalLinesRemoved;
      totalFiles = fallback.files.length;
      confidence = projectedEvents.some((event) => event.confidence === 'low')
        ? 'low'
        : projectedEvents.some((event) => event.confidence === 'medium')
          ? 'medium'
          : 'high';
      scope = buildFallbackScope(params.taskId, files, projectedEvents, params.journal.notices);
      diffStatCompleteness = fallback.files.every((file) => file.diffStatKnown !== false)
        ? 'complete'
        : 'partial';
      const fallbackWarning =
        'Ledger detail view fell back to journal reconstruction because summary bundle v2 was unavailable.';
      warnings.push(fallbackWarning);
      addReviewDiagnostic(
        reviewDiagnostics,
        createTaskChangeDiagnosticFromWarning(fallbackWarning, 'summary')
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
      reviewDiagnostics: withSummaryStateDiagnostics(reviewDiagnostics, {
        integrity: params.bundle?.integrity ?? params.provenance.integrity,
        diffStatCompleteness,
      }),
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
    const provenance = buildLedgerProvenanceFromJournal(
      (await this.artifacts.readJournalStampFromDisk(params.projectDir, params.taskId)) ?? {},
      undefined,
      params.journal.recovered ? 'recovered' : 'ok'
    );
    const projectedEvents = projectJournalEventsForUi(params.journal.events);
    const snippets = projectedEvents.map((event) => eventToSnippet(event, null, null));
    const grouped = groupSnippets(snippets);
    const fallback = buildFallbackFilesFromGroupedSnippets(grouped, params.projectPath);
    const fallbackWarning = 'Task change summary fell back to journal reconstruction.';
    const warnings = [
      ...collectWarnings(projectedEvents, params.journal.notices, {
        recovered: params.journal.recovered,
      }),
      fallbackWarning,
    ];
    const reviewDiagnostics = collectReviewDiagnostics(projectedEvents, params.journal.notices, {
      recovered: params.journal.recovered,
    });
    addReviewDiagnostic(
      reviewDiagnostics,
      createTaskChangeDiagnosticFromWarning(fallbackWarning, 'summary')
    );
    const diffStatCompleteness = fallback.files.every((file) => file.diffStatKnown !== false)
      ? 'complete'
      : 'partial';
    return {
      teamName: params.teamName,
      taskId: params.taskId,
      files: fallback.files.map((file) => ({ ...file, snippets: [] })),
      totalLinesAdded: fallback.totalLinesAdded,
      totalLinesRemoved: fallback.totalLinesRemoved,
      totalFiles: fallback.files.length,
      confidence: projectedEvents.some((event) => event.confidence === 'low')
        ? 'low'
        : projectedEvents.some((event) => event.confidence === 'medium')
          ? 'medium'
          : 'high',
      computedAt: new Date().toISOString(),
      scope: buildFallbackScope(
        params.taskId,
        fallback.files,
        projectedEvents,
        params.journal.notices
      ),
      warnings,
      reviewDiagnostics: withSummaryStateDiagnostics(reviewDiagnostics, {
        integrity: provenance.integrity,
        diffStatCompleteness,
      }),
      diffStatCompleteness,
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
      ? await buildSnippets(this.files, params.projectDir, params.bundle.events)
      : params.bundle.events.map((event) => eventToSnippet(event, null, null));
    const grouped = groupSnippets(snippets);
    const fallback = buildFallbackFilesFromGroupedSnippets(grouped, params.projectPath);
    const warnings = new Set<string>(params.bundle.warnings ?? []);
    warnings.add(
      'Task change ledger used legacy bundle v1 compatibility mode; summary was derived from legacy events.'
    );
    for (const notice of params.bundle.notices ?? []) warnings.add(notice.message);
    const warningList = [...warnings];
    const diffStatCompleteness = fallback.files.every((file) => file.diffStatKnown !== false)
      ? 'complete'
      : 'partial';

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
      scope: buildFallbackScope(
        params.taskId,
        fallback.files,
        params.bundle.events,
        params.bundle.notices ?? []
      ),
      warnings: warningList,
      reviewDiagnostics: withSummaryStateDiagnostics(
        buildReviewDiagnosticsFromWarnings(warningList, 'ledger'),
        { diffStatCompleteness }
      ),
      diffStatCompleteness,
      provenance: {
        sourceKind: 'ledger',
        sourceFingerprint: hashFingerprintPayload({
          legacyTaskId: params.taskId,
          generatedAt: params.bundle.generatedAt,
          eventCount: params.bundle.eventCount,
        }),
      },
    };
  }
}
