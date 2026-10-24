import type { ReviewWriterContext } from './ports.js';
import type {
  ApplyReviewResult,
  ApplyReviewRequest,
  FileReviewDecision,
  FileChangeWithContent,
  ReviewPersistedStateSnapshot,
  ReviewFileScope,
  ReviewDecisionPersistenceScope,
  ReviewMutationDiskPostimage,
} from '../../contracts.js';
import { MAX_REVIEW_DECISIONS } from './limits.js';
import {
  resolveReviewPathAuthorization,
  validateAuthorizedReviewFilePath,
  getAuthoritativeReviewedFile,
  normalizeReviewPathForIdentity,
  resolveAuthoritativeFileContent,
} from './scopeAuthorization.js';
import {
  parseDecisionPersistenceScope,
  assertReviewDecisionShape,
  assertSnippetShapes,
  validateSnippetPaths,
} from './validation.js';
import { resolveDisplayedReviewSnapshot } from './displayedSnapshots.js';
import type { ReviewPathAuthorization } from './displayedSnapshots.js';
import { withReviewDecisionPersistenceLock } from './persistenceLock.js';
import { recoverReviewMutationJournal } from './recovery.js';
import {
  assertCurrentReviewDecisionRevision,
  applyJournalDecisionBatchDisk,
  mergeReviewMutationDiskPostimages,
  commitReviewMutationDecisions,
} from './decisionBatch.js';
import { assertExactApplyReviewHistoryTransition } from './applyHistoryAdmission.js';
import { bindNewReviewHistorySnapshots } from './historyBinding.js';
import { applyStandaloneDecisions } from './standaloneMutations.js';

export async function handleApplyDecisions(
  env: Pick<
    ReviewWriterContext,
    | 'applier'
    | 'assertActive'
    | 'authorization'
    | 'changes'
    | 'content'
    | 'coordinator'
    | 'decisions'
    | 'journal'
    | 'locks'
    | 'logger'
    | 'queues'
    | 'snapshots'
  >,
  requestValue: unknown
): Promise<ApplyReviewResult> {
  if (!requestValue || typeof requestValue !== 'object' || Array.isArray(requestValue)) {
    throw new Error('Invalid request object');
  }
  const request = requestValue as ApplyReviewRequest;
  if (!Array.isArray(request.decisions) || request.decisions.length > MAX_REVIEW_DECISIONS) {
    throw new Error('Invalid request: decisions array required');
  }
  return (async () => {
    const { scope, authorization } = await resolveReviewPathAuthorization(env, request, {
      requireIdentity: true,
    });
    const persistenceScope = parseDecisionPersistenceScope(request.decisionPersistenceScope, scope);
    const validatedDecisions: FileReviewDecision[] = [];
    const fileContents = new Map<string, FileChangeWithContent>();
    const decisionPaths = new Set<string>();
    const decisionReviewKeys = new Set<string>();
    for (const decision of request.decisions) {
      assertReviewDecisionShape(decision);
      const filePath = await validateAuthorizedReviewFilePath(authorization, decision.filePath, {
        requireReviewedFile: true,
        rejectHardlinks: true,
      });
      const authoritativeFile = getAuthoritativeReviewedFile(authorization, filePath);
      const authoritativeReviewKey = authoritativeFile.changeKey ?? authoritativeFile.filePath;
      const normalizedDecisionPath = normalizeReviewPathForIdentity(filePath);
      if (
        decisionPaths.has(normalizedDecisionPath) ||
        decisionReviewKeys.has(authoritativeReviewKey)
      ) {
        throw new Error('Duplicate reviewed file in Apply decisions');
      }
      decisionPaths.add(normalizedDecisionPath);
      decisionReviewKeys.add(authoritativeReviewKey);
      if (persistenceScope && decision.reviewKey !== authoritativeReviewKey) {
        throw new Error('Durable reviewKey does not match the authoritative review identity');
      }
      assertSnippetShapes(authoritativeFile.snippets);
      await validateSnippetPaths(authorization, authoritativeFile.snippets, {
        requireReviewedFile: true,
        rejectHardlinks: true,
      });
      const hasLedgerSnapshot = authoritativeFile.snippets.some(
        (snippet) => !!snippet.ledger && !snippet.isError
      );
      fileContents.set(
        filePath,
        hasLedgerSnapshot
          ? await resolveAuthoritativeFileContent(env, scope, authorization, filePath)
          : resolveDisplayedReviewSnapshot(
              env,
              decision.contentSnapshotToken,
              scope.teamName,
              filePath,
              authoritativeFile.snippets
            )
      );
      validatedDecisions.push({
        filePath,
        ...(decision.reviewKey ? { reviewKey: decision.reviewKey } : {}),
        fileDecision: decision.fileDecision,
        hunkDecisions: decision.hunkDecisions,
        ...(decision.hunkContextHashes ? { hunkContextHashes: decision.hunkContextHashes } : {}),
      });
    }
    const validatedRequest: ApplyReviewRequest = {
      teamName: scope.teamName,
      ...(scope.taskId ? { taskId: scope.taskId } : {}),
      ...(authorization.resolutionMemberName
        ? { memberName: authorization.resolutionMemberName }
        : {}),
      ...(persistenceScope ? { decisionPersistenceScope: persistenceScope } : {}),
      decisions: validatedDecisions,
    };
    let result: ApplyReviewResult;
    if (!persistenceScope) {
      result = await (env.assertActive(),
      applyStandaloneDecisions(env, validatedRequest, fileContents));
    } else {
      if (validatedDecisions.some((decision) => !decision.reviewKey)) {
        throw new Error('Durable review mutation requires a stable reviewKey');
      }
      if (!request.persistedState) {
        throw new Error('Durable review mutation requires an exact post-operation state');
      }
      if (
        !Number.isSafeInteger(request.expectedDecisionRevision) ||
        request.expectedDecisionRevision! < 0
      ) {
        throw new Error('Durable review mutation requires an exact decision revision');
      }
      env.assertActive();
      env.decisions.assertValidSnapshot(request.persistedState);
      assertPersistedStateIncludesDecisions(request.persistedState, validatedDecisions);
      result = await applyDecisionsWithDurableJournal(
        env,
        scope,
        authorization,
        persistenceScope,
        validatedDecisions as (FileReviewDecision & {
          reviewKey: string;
        })[],
        fileContents,
        request.persistedState,
        request.expectedDecisionRevision!
      );
    }
    // Invalidate resolved file content cache after applying decisions so subsequent
    // diff operations read the latest disk state (avoids "stuck" decisions in instant-apply flows).
    try {
      for (const d of validatedRequest.decisions) {
        env.assertActive();
        env.content.invalidateFile(d.filePath);
      }
    } catch (error) {
      env.logger.debug('applyDecisions cache invalidation failed:', error);
    }
    return result;
  })();
}

export class ReviewMutationApplyResultError extends Error {
  constructor(readonly result: ApplyReviewResult) {
    super(result.errors[0]?.error ?? 'Review mutation could not be applied safely');
  }
}

export function assertPersistedStateIncludesDecisions(
  state: ReviewPersistedStateSnapshot,
  decisions: readonly FileReviewDecision[]
): void {
  for (const decision of decisions) {
    const reviewKey = decision.reviewKey;
    if (!reviewKey) throw new Error('Durable review mutation requires a stable reviewKey');
    const actualFileDecision =
      state.fileDecisions[reviewKey] ?? state.fileDecisions[decision.filePath] ?? 'pending';
    if (actualFileDecision !== decision.fileDecision) {
      throw new Error('Durable review state does not match the requested file decision');
    }
    for (const [index, expected] of Object.entries(decision.hunkDecisions)) {
      const actual =
        state.hunkDecisions[`${reviewKey}:${index}`] ??
        state.hunkDecisions[`${decision.filePath}:${index}`] ??
        'pending';
      if (actual !== expected) {
        throw new Error('Durable review state does not match the requested hunk decision');
      }
    }
  }
}

export async function applyDecisionsWithDurableJournal(
  env: Pick<
    ReviewWriterContext,
    | 'applier'
    | 'assertActive'
    | 'authorization'
    | 'changes'
    | 'content'
    | 'coordinator'
    | 'decisions'
    | 'journal'
    | 'locks'
    | 'logger'
    | 'queues'
  >,
  scope: ReviewFileScope,
  authorization: ReviewPathAuthorization,
  persistenceScope: ReviewDecisionPersistenceScope,
  decisions: (FileReviewDecision & {
    reviewKey: string;
  })[],
  fileContents: Map<string, FileChangeWithContent>,
  persistedState: ReviewPersistedStateSnapshot,
  expectedDecisionRevision: number
): Promise<ApplyReviewResult> {
  return withReviewDecisionPersistenceLock(env, scope.teamName, persistenceScope, async () => {
    const diskPostimages = new Map<string, ReviewMutationDiskPostimage>();
    try {
      await recoverReviewMutationJournal(env, scope.teamName, persistenceScope);
      await assertCurrentReviewDecisionRevision(
        env,
        scope.teamName,
        persistenceScope,
        expectedDecisionRevision
      );
      const current = await (env.assertActive(),
      env.decisions.load(scope.teamName, persistenceScope.scopeKey, persistenceScope.scopeToken));
      assertExactApplyReviewHistoryTransition(persistedState, current, decisions, authorization);
      const boundPersistedState = await bindNewReviewHistorySnapshots(
        env,
        persistedState,
        current,
        scope,
        authorization
      );
      let result: ApplyReviewResult | null = null;
      await (env.assertActive(),
      env.coordinator.execute(
        {
          teamName: scope.teamName,
          persistenceScope,
          reviewScope: scope,
          kind: decisions.length > 1 ? 'bulk' : 'reject',
          decisions,
          fileContents: decisions.map((decision) => {
            const content = fileContents.get(decision.filePath);
            if (!content) throw new Error('Review mutation content is unavailable');
            return content;
          }),
          persistedState: boundPersistedState,
          expectedDecisionRevision,
        },
        {
          applyDisk: (record) =>
            applyJournalDecisionBatchDisk(
              env,
              record,
              (nextResult) => {
                result = nextResult;
              },
              (postimages) => mergeReviewMutationDiskPostimages(diskPostimages, postimages)
            ),
          commitDecisions: commitReviewMutationDecisions.bind(null, env),
        }
      ));
      const committed = await (env.assertActive(),
      env.decisions.load(scope.teamName, persistenceScope.scopeKey, persistenceScope.scopeToken));
      return {
        ...(result ?? { applied: 0, skipped: 0, conflicts: 0, errors: [] }),
        decisionRevision: committed?.revision ?? expectedDecisionRevision,
        committedReviewAction: committed?.reviewActionHistory.at(-1),
        diskPostimages: [...diskPostimages.values()],
      };
    } catch (error) {
      if (error instanceof ReviewMutationApplyResultError) {
        return { ...error.result, diskPostimages: [...diskPostimages.values()] };
      }
      throw error;
    }
  });
}
