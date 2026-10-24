import { executeReviewFileTransaction } from '../io/index.js';
import { normalizePathForComparison } from '../../platformPath.js';
import { buildReviewChunkContextHashes } from './reviewChunks.js';
import { AsyncLocalStorage } from 'async_hooks';
import type {
  ApplyReviewDiskTransition,
  ApplyReviewRequest,
  ApplyReviewResult,
  ConflictCheckResult,
  FileChangeWithContent,
  LedgerChangeRelation,
  RejectResult,
  ReviewMutationDiskPostimage,
  SnippetDiff,
} from '../../contracts.js';

export interface ReviewApplyMutationHooks {
  checkpointDiskTransitions: (transitions: readonly ApplyReviewDiskTransition[]) => Promise<void>;
  initialDiskTransitions?: readonly ApplyReviewDiskTransition[];
  publishedCreate?: (filePath: string, identity: { dev: number; ino: number }) => void;
}

export interface ReviewApplyMutationContext {
  hooks?: ReviewApplyMutationHooks;
  observedPreimages: Map<string, ApplyReviewDiskTransition>;
  plannedTransitions: Map<string, ApplyReviewDiskTransition>;
}

export const reviewApplyMutationContext = new AsyncLocalStorage<ReviewApplyMutationContext>();

export type ApplyErrorCode = NonNullable<ApplyReviewResult['errors'][number]['code']>;

export type LedgerApplyOutcome =
  | { handled: false }
  | { handled: true; status: 'applied' | 'skipped' }
  | { handled: true; status: 'conflict' | 'error'; error: string; code: ApplyErrorCode };

export type CurrentTextReadResult =
  | { missing: true; content: '' }
  | { missing: false; content: string }
  | { missing: false; content: ''; error: string };

export type ReviewFileTransitionState = 'before' | 'after' | 'both';

export type ReviewRenameTransitionState =
  | 'accepted'
  | 'rejected'
  | 'both'
  | 'restoring'
  | 'reapplying'
  | 'legacy-reapplying';

export function getCurrentTextReadError(result: CurrentTextReadResult): string | null {
  return 'error' in result ? result.error : null;
}

export const fileMutationQueues = new Map<string, Promise<void>>();

export async function withFileMutationLock<T>(
  filePath: string,
  operation: () => Promise<T>
): Promise<T> {
  return withFileMutationLocks([filePath], operation);
}

export async function withFileMutationLocks<T>(
  filePaths: readonly string[],
  operation: () => Promise<T>
): Promise<T> {
  const keys = [
    ...new Set(
      filePaths.map((filePath) => {
        const normalized = normalizePathForComparison(filePath).normalize('NFC');
        return process.platform === 'darwin' || process.platform === 'win32'
          ? normalized.toLowerCase()
          : normalized;
      })
    ),
  ].sort();

  const acquire = (index: number): Promise<T> => {
    const key = keys[index];
    return key ? withFileMutationKeyLock(key, () => acquire(index + 1)) : operation();
  };

  return acquire(0);
}

export async function withFileMutationKeyLock<T>(
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = fileMutationQueues.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queueTail = previous.then(
    () => current,
    () => current
  );
  fileMutationQueues.set(key, queueTail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (fileMutationQueues.get(key) === queueTail) {
      fileMutationQueues.delete(key);
    }
  }
}

export function buildReviewChunkHashIndexMap(
  original: string,
  modified: string
): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const [rawIndex, hash] of Object.entries(
    buildReviewChunkContextHashes(original, modified)
  )) {
    const index = Number(rawIndex);
    const arr = map.get(hash);
    if (arr) arr.push(index);
    else map.set(hash, [index]);
  }
  return map;
}

export function mapRejectedHunkIndicesByHashStrict(
  original: string,
  modified: string,
  rejectedIndices: number[],
  hunkContextHashes: Record<number, string> | undefined
): { ok: true; indices: number[] } | { ok: false; code: ApplyErrorCode; error: string } {
  if (rejectedIndices.length === 0) {
    return { ok: true, indices: [] };
  }
  if (!hunkContextHashes || Object.keys(hunkContextHashes).length === 0) {
    return {
      ok: false,
      code: 'manual-review-required',
      error: 'Partial reject requires stable hunk context hashes.',
    };
  }

  const hashMap = buildReviewChunkHashIndexMap(original, modified);
  const out = new Set<number>();
  for (const idx of rejectedIndices) {
    const hash = hunkContextHashes[idx];
    if (!hash) {
      return {
        ok: false,
        code: 'manual-review-required',
        error: 'Partial reject is missing a hunk context hash.',
      };
    }
    const candidates = hashMap.get(hash);
    if (!candidates || candidates.length === 0) {
      return {
        ok: false,
        code: 'conflict',
        error: 'Partial reject hunk context changed; please re-review.',
      };
    }
    if (candidates.length > 1) {
      return {
        ok: false,
        code: 'conflict',
        error: 'Partial reject hunk context is ambiguous; please re-review.',
      };
    }
    out.add(candidates[0]);
  }
  return { ok: true, indices: [...out].sort((a, b) => a - b) };
}
export interface ApplierContext {
  assertCurrent: (() => void) | undefined;
  io: ReturnType<typeof import('./publicationIO.js').createPublicationIO>;
  classifyEditedFileTransition(
    filePath: string,
    beforeContent: string | null,
    afterContent: string | null
  ): Promise<ReviewFileTransitionState>;
  classifyRejectedRenameTransition(
    filePath: string,
    original: string | null,
    modified: string | null,
    snippets: SnippetDiff[]
  ): Promise<ReviewRenameTransitionState>;
  restoreRejectedRename(
    filePath: string,
    original: string | null,
    modified: string | null,
    snippets: SnippetDiff[]
  ): Promise<{ success: true }>;
  reapplyRejectedRename(
    filePath: string,
    original: string | null,
    snippets: SnippetDiff[]
  ): Promise<{ success: true }>;
  getRejectedRenamePostimages(
    original: string | null,
    modified: string | null,
    snippets: SnippetDiff[],
    direction: 'restore' | 'reapply'
  ): Promise<ReviewMutationDiskPostimage[]>;
  checkConflict(filePath: string, expectedModified: string): Promise<ConflictCheckResult>;
  rejectHunks(
    _teamName: string,
    filePath: string,
    original: string,
    modified: string,
    hunkIndices: number[],
    _snippets: SnippetDiff[],
    hunkContextHashes?: Record<number, string>
  ): Promise<RejectResult>;
  rejectFile(
    _teamName: string,
    filePath: string,
    original: string,
    modified: string
  ): Promise<RejectResult>;
  previewReject(
    _filePath: string,
    original: string,
    modified: string,
    hunkIndices: number[],
    snippets: SnippetDiff[]
  ): Promise<{ preview: string; hasConflicts: boolean }>;
  applyReviewDecisions(
    request: ApplyReviewRequest,
    fileContents?: Map<string, FileChangeWithContent>,
    hooks?: ReviewApplyMutationHooks
  ): Promise<ApplyReviewResult>;
  applyReviewDecisionsInContext(
    request: ApplyReviewRequest,
    fileContents: Map<string, FileChangeWithContent>
  ): Promise<ApplyReviewResult>;
  saveEditedFile(
    filePath: string,
    content: string,
    expectedCurrentContent: string | null
  ): Promise<{ success: boolean }>;
  deleteEditedFile(filePath: string, expectedCurrentContent: string): Promise<{ success: boolean }>;
  rejectNonLedgerNewFile(
    filePath: string,
    modified: string | null
  ): Promise<
    { status: 'applied' } | { status: 'conflict' | 'error'; error: string; code: ApplyErrorCode }
  >;
  tryApplyLedgerDecision(
    filePath: string,
    original: string | null,
    modified: string | null,
    fileRejected: boolean,
    allHunksRejected: boolean,
    rejectedHunkIndices: number[],
    hunkContextHashes: Record<number, string> | undefined,
    snippets: SnippetDiff[]
  ): Promise<LedgerApplyOutcome>;
  tryApplyLedgerDecisionLocked(
    filePath: string,
    original: string | null,
    modified: string | null,
    fileRejected: boolean,
    allHunksRejected: boolean,
    rejectedHunkIndices: number[],
    hunkContextHashes: Record<number, string> | undefined,
    ledgerSnippets: SnippetDiff[]
  ): Promise<LedgerApplyOutcome>;
  resolveLedgerOperation(snippets: SnippetDiff[]): 'create' | 'modify' | 'delete';
  resolveLedgerRelation(snippets: SnippetDiff[]): LedgerChangeRelation | undefined;
  resolveLedgerMutationPaths(filePath: string, snippets: SnippetDiff[]): string[];
  rejectLedgerRename(
    snippets: SnippetDiff[],
    relation: LedgerChangeRelation,
    original: string | null,
    hasUnavailableState: boolean
  ): Promise<LedgerApplyOutcome>;
  restoreRejectedLedgerRename(
    snippets: SnippetDiff[],
    relation: LedgerChangeRelation,
    original: string | null,
    modified: string | null
  ): Promise<void>;
  pathMatchesRelationPath(filePath: string, relationPath: string): boolean;
  resolveRelatedLedgerPath(
    anchorPath: string | undefined,
    anchorRelationPath: string,
    targetRelationPath: string
  ): string | null;
  normalizeRelationComparisonPath(filePath: string, caseInsensitive: boolean): string;
  isWindowsReviewPath(filePath: string): boolean;
  matchesRelationSuffix(normalizedPath: string, normalizedRelationPath: string): boolean;
  checkLedgerCurrentHash(
    filePath: string,
    expectedHash: string | undefined
  ): Promise<{ ok: true } | { ok: false; outcome: LedgerApplyOutcome }>;
  readCurrentText(filePath: string): Promise<CurrentTextReadResult>;
  getReviewFileTransactionFromTransition(
    transition: ApplyReviewDiskTransition
  ): Parameters<typeof executeReviewFileTransaction>[0] | null;
  resumeInitialReviewFileTransactions(context: ReviewApplyMutationContext): Promise<void>;
  finalizeReviewDiskTransitions(transitions: readonly ApplyReviewDiskTransition[]): Promise<void>;
  finalizeEditedFileTransaction(
    filePath: string,
    expectedContent: string | null,
    nextContent: string | null
  ): Promise<void>;
  finalizeRejectedRenameTransaction(
    filePath: string,
    original: string | null,
    modified: string | null,
    snippets: SnippetDiff[],
    direction: 'restore' | 'reapply'
  ): Promise<void>;
  checkpointPlannedDiskTransition(transition: ApplyReviewDiskTransition): Promise<void>;
  atomicReplaceTextFile(
    filePath: string,
    expectedCurrentContent: string,
    nextContent: string
  ): Promise<void>;
  moveExpectedTextFile(
    sourcePath: string,
    targetPath: string,
    expectedSourceContent: string,
    finalTargetContent: string
  ): Promise<void>;
  assertSafeExpectedFile(
    filePath: string,
    expectedCurrentContent: string
  ): Promise<{ dev: number; ino: number; mode: number }>;
  deleteExpectedTextFile(filePath: string, expectedCurrentContent: string): Promise<void>;
  pathsReferToSameFile(firstPath: string, secondPath: string): Promise<boolean>;
  hashText(content: string): string;
  tryStrictHunkLevelReject(
    original: string,
    modified: string,
    hunkIndices: number[]
  ): RejectResult | null;
}
