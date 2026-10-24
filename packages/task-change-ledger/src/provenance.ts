import type {
  LedgerContentState,
  TaskChangeJournalStamp,
  TaskChangeProvenance,
} from './contracts.js';
import { normalizeSummaryChangeKey } from './ledgerPaths.js';
import type { LedgerFreshnessV2, LedgerSummaryBundleV2 } from './ledgerTypes.js';
import { normalizePathForComparison } from './platformPath.js';
import { createHash } from 'node:crypto';

export function bundleMatchesFreshness(
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

export function buildLedgerProvenance(
  journalStamp: TaskChangeJournalStamp,
  integrity: 'ok' | 'recovered' | 'partial',
  bundleSchemaVersion?: number
): TaskChangeProvenance {
  return {
    sourceKind: 'ledger',
    sourceFingerprint: hashFingerprintPayload({
      journalStamp,
      integrity,
      ...(bundleSchemaVersion ? { bundleSchemaVersion } : {}),
    }),
    journalStamp,
    ...(bundleSchemaVersion ? { bundleSchemaVersion } : {}),
    integrity,
  };
}

export function buildLedgerProvenanceFromJournal(
  journalStamp: TaskChangeJournalStamp,
  bundleSchemaVersion?: number,
  integrity: 'ok' | 'recovered' | 'partial' = 'ok'
): TaskChangeProvenance {
  return buildLedgerProvenance(journalStamp, integrity, bundleSchemaVersion);
}

export function buildLedgerProvenanceFromSummaryBundle(
  bundle: LedgerSummaryBundleV2,
  journalStamp: TaskChangeJournalStamp = bundle.journalStamp
): TaskChangeProvenance {
  return {
    sourceKind: 'ledger',
    sourceFingerprint: hashFingerprintPayload(buildProjectedSummaryIdentity(bundle)),
    journalStamp,
    bundleSchemaVersion: bundle.schemaVersion,
    integrity: bundle.integrity,
  };
}

export function buildProjectedSummaryIdentity(bundle: LedgerSummaryBundleV2): unknown {
  return {
    kind: 'ledger-summary-v2-projected-identity',
    schemaVersion: bundle.schemaVersion,
    bundleKind: bundle.bundleKind,
    taskId: bundle.taskId,
    integrity: bundle.integrity,
    totalFiles: bundle.totalFiles,
    totalLinesAdded: bundle.totalLinesAdded,
    totalLinesRemoved: bundle.totalLinesRemoved,
    diffStatCompleteness: bundle.diffStatCompleteness,
    confidence: bundle.confidence,
    files: [...bundle.files]
      .map((file) => ({
        changeKey: normalizeSummaryChangeKey(file),
        filePath: normalizePathForComparison(file.filePath),
        relativePath: normalizePathForComparison(file.relativePath),
        displayPath: file.displayPath ? normalizePathForComparison(file.displayPath) : undefined,
        linesAdded: file.linesAdded,
        linesRemoved: file.linesRemoved,
        diffStatKnown: file.diffStatKnown,
        latestOperation: file.latestOperation,
        createdInTask: file.createdInTask,
        deletedInTask: file.deletedInTask,
        baselineExists: file.baselineExists,
        finalExists: file.finalExists,
        latestBeforeHash: file.latestBeforeHash,
        latestAfterHash: file.latestAfterHash,
        latestBeforeState: contentStateFingerprint(file.latestBeforeState),
        latestAfterState: contentStateFingerprint(file.latestAfterState),
        contentAvailability: file.contentAvailability,
        reviewability: file.reviewability,
        relation: file.relation
          ? {
              kind: file.relation.kind,
              oldPath: normalizePathForComparison(file.relation.oldPath),
              newPath: normalizePathForComparison(file.relation.newPath),
            }
          : undefined,
        worktreePath: file.worktreePath ? normalizePathForComparison(file.worktreePath) : undefined,
        worktreeBranch: file.worktreeBranch,
        baseWorkspaceRoot: file.baseWorkspaceRoot
          ? normalizePathForComparison(file.baseWorkspaceRoot)
          : undefined,
      }))
      .sort(
        (left, right) =>
          left.changeKey.localeCompare(right.changeKey) ||
          left.filePath.localeCompare(right.filePath)
      ),
  };
}

export function contentStateFingerprint(state: LedgerContentState | undefined): unknown {
  if (!state) {
    return undefined;
  }
  return {
    exists: state.exists,
    sha256: state.sha256,
    sizeBytes: state.sizeBytes,
    unavailableReason: state.unavailableReason,
  };
}

export function hashFingerprintPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
