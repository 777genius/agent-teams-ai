import type { ReviewWriterContext } from './ports.js';
import type {
  ReviewDraftHistorySnapshot,
  ReviewDraftHistoryConflictCandidateSummary,
  ReviewDraftHistoryEntry,
} from '../storage/draftContracts.js';
import { withReviewDecisionPersistenceLock } from './persistenceLock.js';
import {
  resolveReviewPathAuthorization,
  validateAuthorizedReviewFilePath,
  normalizeReviewPathForIdentity,
} from './scopeAuthorization.js';
import { parseReviewScopeKey } from './historyBinding.js';
import type { ReviewConflictResolution } from '../../contracts.js';

import * as path from 'path';

export async function handleLoadDraftHistory(
  env: Pick<
    ReviewWriterContext,
    'assertActive' | 'authorization' | 'changes' | 'drafts' | 'locks' | 'queues'
  >,
  teamName: string,
  scopeKey: string,
  scopeToken: string
): Promise<ReviewDraftHistorySnapshot | null> {
  return (async () => {
    const persistenceScope = { scopeKey, scopeToken };
    return withReviewDecisionPersistenceLock(env, teamName, persistenceScope, async () => {
      const { authorization } = await resolveReviewPathAuthorization(
        env,
        parseReviewScopeKey(teamName, scopeKey),
        { requireIdentity: true }
      );
      const snapshot = await (env.assertActive(), env.drafts.load(teamName, scopeKey, scopeToken));
      for (const filePath of Object.keys(snapshot?.entries ?? {})) {
        await validateAuthorizedReviewFilePath(authorization, filePath, {
          requireReviewedFile: true,
        });
      }
      return snapshot;
    });
  })();
}

export async function handleLoadDraftHistoryConflictCandidates(
  env: Pick<
    ReviewWriterContext,
    'assertActive' | 'authorization' | 'changes' | 'drafts' | 'locks' | 'queues'
  >,
  teamName: string,
  scopeKey: string,
  scopeToken: string
): Promise<ReviewDraftHistoryConflictCandidateSummary[]> {
  return (async () => {
    const persistenceScope = { scopeKey, scopeToken };
    return withReviewDecisionPersistenceLock(env, teamName, persistenceScope, async () => {
      const { authorization } = await resolveReviewPathAuthorization(
        env,
        parseReviewScopeKey(teamName, scopeKey),
        { requireIdentity: true }
      );
      const candidates = await (env.assertActive(),
      env.drafts.loadConflictCandidateSummaries(teamName, scopeKey, scopeToken));
      return Promise.all(
        candidates.map(async (candidate) => {
          const isCurrentReviewedFile =
            path.isAbsolute(path.normalize(candidate.filePath)) &&
            authorization.reviewedFiles?.has(normalizeReviewPathForIdentity(candidate.filePath));
          if (candidate.origin === 'prior-snapshot' && !isCurrentReviewedFile) {
            return { ...candidate, recoverability: 'file-not-in-current-review' as const };
          }
          await validateAuthorizedReviewFilePath(authorization, candidate.filePath, {
            requireReviewedFile: true,
          });
          return candidate;
        })
      );
    });
  })();
}

export async function handleResolveDraftHistoryConflictCandidate(
  env: Pick<
    ReviewWriterContext,
    'assertActive' | 'authorization' | 'changes' | 'drafts' | 'locks' | 'queues'
  >,
  teamName: string,
  scopeKey: string,
  scopeToken: string,
  candidateId: string,
  resolution: ReviewConflictResolution,
  expectedCurrentRevision: number,
  expectedCurrentGeneration: string | null
): Promise<ReviewDraftHistoryEntry | null> {
  return (async () => {
    const persistenceScope = { scopeKey, scopeToken };
    return withReviewDecisionPersistenceLock(env, teamName, persistenceScope, async () => {
      const { authorization } = await resolveReviewPathAuthorization(
        env,
        parseReviewScopeKey(teamName, scopeKey),
        { requireIdentity: true }
      );
      const candidate = await (env.assertActive(),
      env.drafts.loadConflictCandidate(teamName, scopeKey, scopeToken, candidateId));
      if (resolution === 'recover-candidate') {
        await validateAuthorizedReviewFilePath(authorization, candidate.filePath, {
          requireReviewedFile: true,
        });
      }
      return (
        env.assertActive(),
        env.drafts.resolveConflictCandidate(
          teamName,
          scopeKey,
          scopeToken,
          candidateId,
          resolution,
          expectedCurrentRevision,
          expectedCurrentGeneration
        )
      );
    });
  })();
}

export async function handleReplaceDraftHistoryConflictCandidate(
  env: Pick<
    ReviewWriterContext,
    'assertActive' | 'authorization' | 'changes' | 'drafts' | 'locks' | 'queues'
  >,
  teamName: string,
  scopeKey: string,
  scopeToken: string,
  expectedEntry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>,
  replacementEntry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>,
  expectedCurrentRevision: number,
  expectedCurrentGeneration: string | null
): Promise<ReviewDraftHistoryConflictCandidateSummary> {
  return (async () => {
    const persistenceScope = { scopeKey, scopeToken };
    return withReviewDecisionPersistenceLock(env, teamName, persistenceScope, async () => {
      const { authorization } = await resolveReviewPathAuthorization(
        env,
        parseReviewScopeKey(teamName, scopeKey),
        { requireIdentity: true }
      );
      await validateAuthorizedReviewFilePath(authorization, expectedEntry.filePath, {
        requireReviewedFile: true,
      });
      if (replacementEntry.filePath !== expectedEntry.filePath) {
        throw new Error('Manual-edit recovery update changed file identity');
      }
      const replacement = await (env.assertActive(),
      env.drafts.replaceConflictCandidate(
        teamName,
        scopeKey,
        scopeToken,
        expectedEntry,
        replacementEntry,
        expectedCurrentRevision,
        expectedCurrentGeneration
      ));
      return {
        id: replacement.id,
        capturedAt: replacement.capturedAt,
        origin: replacement.origin,
        recoverability: 'recoverable',
        filePath: replacement.filePath,
        expectedRevision: replacement.expectedRevision,
        expectedGeneration: replacement.expectedGeneration,
        observedCurrentRevision: replacement.observedCurrentRevision,
        observedCurrentGeneration: replacement.observedCurrentGeneration,
        entryRevision: replacement.entry?.revision ?? null,
      };
    });
  })();
}

export async function handleSaveDraftHistoryEntry(
  env: Pick<
    ReviewWriterContext,
    'assertActive' | 'authorization' | 'changes' | 'drafts' | 'locks' | 'queues'
  >,
  teamName: string,
  scopeKey: string,
  scopeToken: string,
  entry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>,
  expectedRevision: number,
  expectedGeneration: string | null
): Promise<ReviewDraftHistoryEntry> {
  return (async () => {
    const persistenceScope = { scopeKey, scopeToken };
    return withReviewDecisionPersistenceLock(env, teamName, persistenceScope, async () => {
      const { authorization } = await resolveReviewPathAuthorization(
        env,
        parseReviewScopeKey(teamName, scopeKey),
        { requireIdentity: true }
      );
      await validateAuthorizedReviewFilePath(authorization, entry.filePath, {
        requireReviewedFile: true,
      });
      return (
        env.assertActive(),
        env.drafts.saveEntry(teamName, scopeKey, scopeToken, {
          ...entry,
          expectedRevision,
          expectedGeneration,
        })
      );
    });
  })();
}

export async function handleClearDraftHistory(
  env: Pick<
    ReviewWriterContext,
    'assertActive' | 'authorization' | 'changes' | 'drafts' | 'locks' | 'queues'
  >,
  teamName: string,
  scopeKey: string,
  scopeToken: string,
  filePath: string | null = null,
  expectedRevision: number | null = null,
  expectedGeneration: string | null = null
): Promise<void> {
  return (async () => {
    const persistenceScope = { scopeKey, scopeToken };
    await withReviewDecisionPersistenceLock(env, teamName, persistenceScope, async () => {
      const { authorization } = await resolveReviewPathAuthorization(
        env,
        parseReviewScopeKey(teamName, scopeKey),
        { requireIdentity: true }
      );
      if (filePath !== null) {
        if (expectedRevision === null) {
          throw new Error('Clearing review draft history requires an exact revision');
        }
        await validateAuthorizedReviewFilePath(authorization, filePath, {
          requireReviewedFile: true,
        });
        await (env.assertActive(),
        env.drafts.clearEntry(
          teamName,
          scopeKey,
          scopeToken,
          filePath,
          expectedRevision,
          expectedGeneration
        ));
      } else {
        await (env.assertActive(), env.drafts.clearUnreadableScope(teamName, scopeKey, scopeToken));
      }
    });
  })();
}
