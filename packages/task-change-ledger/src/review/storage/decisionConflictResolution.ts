import { unlinkPathDurably } from '../io/atomicPersistence.js';
import { quarantineConstrainedPersistenceFile } from '../io/safePersistenceDirectory.js';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';
import type {
  ReviewConflictResolution,
  ReviewDecisionConflictCandidate,
  ReviewDecisionConflictCandidateSummary,
  ReviewPersistedStateSnapshot,
} from '../../contracts.js';
import {
  EXACT_SCOPE_FILE_PATTERN,
  EXACT_SCOPE_HASH_PATTERN,
  InvalidReviewDecisionDataError,
  shouldQuarantineDecisionConflictCandidate,
  type DecisionContext,
} from './DecisionTypes.js';

export function createDecisionConflictResolution(getContext: () => DecisionContext) {
  return {
    async mapConflictCandidates<T extends { id: string; capturedAt: string }>(
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      mapCandidate: (candidate: ReviewDecisionConflictCandidate) => T
    ): Promise<T[]> {
      const ctx = getContext();
      ctx.assertSafeScope(teamName, scopeKey, scopeToken);
      const currentScopeHash = createHash('sha256').update(scopeToken).digest('hex');
      const conflictScopes = await ctx.inspectConflictScopes(teamName, scopeKey);
      const currentRevision =
        (await ctx.loadInternal(teamName, scopeKey, scopeToken))?.revision ?? 0;
      const candidates: T[] = [];
      let quarantinedCount = 0;
      for (const sourceScopeHash of [...conflictScopes.scopeHashes].sort()) {
        const dirPath = ctx.getConflictCandidateDirByScopeHash(teamName, scopeKey, sourceScopeHash);
        const entries = await fs.promises.readdir(dirPath);
        for (const entry of entries.filter((name) => EXACT_SCOPE_FILE_PATTERN.test(name))) {
          const candidatePath = path.join(dirPath, entry);
          try {
            const candidate = await ctx.loadConflictCandidateFromPath(
              candidatePath,
              scopeKey,
              sourceScopeHash,
              currentScopeHash
            );
            candidates.push(
              mapCandidate({ ...candidate, observedCurrentRevision: currentRevision })
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            if (!shouldQuarantineDecisionConflictCandidate(error)) throw error;
            try {
              await quarantineConstrainedPersistenceFile(
                ctx.teamsRoot,
                candidatePath,
                path.join(dirPath, 'quarantine')
              );
            } catch (quarantineError) {
              if ((quarantineError as NodeJS.ErrnoException).code === 'ENOENT') continue;
              throw quarantineError;
            }
            quarantinedCount += 1;
            ctx.logger.warn(`Quarantined unreadable review recovery copy: ${String(error)}`);
          }
        }
      }
      if (quarantinedCount > 0) {
        throw new InvalidReviewDecisionDataError(
          `${quarantinedCount} unreadable review recovery copy was quarantined; retry recovery check`
        );
      }
      return candidates.sort(
        (left, right) =>
          Date.parse(right.capturedAt) - Date.parse(left.capturedAt) ||
          left.id.localeCompare(right.id)
      );
    },
    async loadConflictCandidates(
      teamName: string,
      scopeKey: string,
      scopeToken: string
    ): Promise<ReviewDecisionConflictCandidate[]> {
      const ctx = getContext();
      return ctx.mapConflictCandidates(teamName, scopeKey, scopeToken, (candidate) => candidate);
    },
    async loadConflictCandidateSummaries(
      teamName: string,
      scopeKey: string,
      scopeToken: string
    ): Promise<ReviewDecisionConflictCandidateSummary[]> {
      const ctx = getContext();
      return ctx.mapConflictCandidates(teamName, scopeKey, scopeToken, (candidate) => ({
        id: candidate.id,
        capturedAt: candidate.capturedAt,
        origin: candidate.origin,
        recoverability:
          candidate.origin === 'current-snapshot' ? 'recoverable' : 'different-review-snapshot',
        expectedRevision: candidate.expectedRevision,
        observedCurrentRevision: candidate.observedCurrentRevision,
        hunkDecisionCount: Object.keys(candidate.state.hunkDecisions).length,
        fileDecisionCount: Object.keys(candidate.state.fileDecisions).length,
        undoDepth: candidate.state.reviewActionHistory.length,
        redoDepth: candidate.state.reviewRedoHistory.length,
      }));
    },
    async locateConflictCandidate(
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      candidateId: string
    ): Promise<{ candidatePath: string; candidate: ReviewDecisionConflictCandidate }> {
      const ctx = getContext();
      if (!EXACT_SCOPE_HASH_PATTERN.test(candidateId)) {
        throw new Error('Invalid review decision conflict candidate id');
      }
      const currentScopeHash = createHash('sha256').update(scopeToken).digest('hex');
      const conflictScopes = await ctx.inspectConflictScopes(teamName, scopeKey);
      let located: { candidatePath: string; candidate: ReviewDecisionConflictCandidate } | null =
        null;
      for (const sourceScopeHash of conflictScopes.scopeHashes) {
        const candidatePath = path.join(
          ctx.getConflictCandidateDirByScopeHash(teamName, scopeKey, sourceScopeHash),
          `${candidateId}.json`
        );
        try {
          const candidate = await ctx.loadConflictCandidateFromPath(
            candidatePath,
            scopeKey,
            sourceScopeHash,
            currentScopeHash
          );
          if (located) throw new Error('Ambiguous review decision conflict candidate');
          located = { candidatePath, candidate };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
      }
      if (!located) throw new Error('Review decision recovery copy is unavailable');
      return located;
    },
    async loadConflictCandidate(
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      candidateId: string
    ): Promise<ReviewDecisionConflictCandidate> {
      const ctx = getContext();
      ctx.assertSafeScope(teamName, scopeKey, scopeToken);
      const { candidate } = await ctx.locateConflictCandidate(
        teamName,
        scopeKey,
        scopeToken,
        candidateId
      );
      const observedCurrentRevision =
        (await ctx.loadInternal(teamName, scopeKey, scopeToken))?.revision ?? 0;
      return { ...candidate, observedCurrentRevision };
    },
    async resolveConflictCandidate(
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      candidateId: string,
      resolution: ReviewConflictResolution,
      expectedCurrentRevision: number
    ): Promise<number> {
      const ctx = getContext();
      ctx.assertSafeScope(teamName, scopeKey, scopeToken);
      if (
        (resolution !== 'recover-candidate' && resolution !== 'keep-current') ||
        !Number.isSafeInteger(expectedCurrentRevision) ||
        expectedCurrentRevision < 0
      ) {
        throw new Error('Invalid review decision conflict resolution');
      }
      const { candidatePath, candidate } = await ctx.locateConflictCandidate(
        teamName,
        scopeKey,
        scopeToken,
        candidateId
      );
      const current = await ctx.loadInternal(teamName, scopeKey, scopeToken);
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== expectedCurrentRevision) {
        throw new Error('Saved review state changed again; reload recovery choices');
      }
      if (resolution === 'keep-current') {
        await unlinkPathDurably(candidatePath);
        return currentRevision;
      }
      if (candidate.origin !== 'current-snapshot') {
        throw new Error(
          'Recovery copy belongs to a different review snapshot; refusing unsafe replacement'
        );
      }
      const currentSnapshot: ReviewPersistedStateSnapshot = current
        ? {
            hunkDecisions: current.hunkDecisions,
            fileDecisions: current.fileDecisions,
            hunkContextHashesByFile: current.hunkContextHashesByFile,
            reviewActionHistory: current.reviewActionHistory,
            reviewRedoHistory: current.reviewRedoHistory,
          }
        : {
            hunkDecisions: {},
            fileDecisions: {},
            hunkContextHashesByFile: {},
            reviewActionHistory: [],
            reviewRedoHistory: [],
          };
      if (isDeepStrictEqual(candidate.state, currentSnapshot)) {
        await unlinkPathDurably(candidatePath);
        return currentRevision;
      }
      if (
        !isDeepStrictEqual(
          ctx.getDiskBackedHistory(candidate.state),
          ctx.getDiskBackedHistory(currentSnapshot)
        )
      ) {
        throw new Error(
          'Recovery branches contain different disk-backed history; refusing unsafe replacement'
        );
      }
      // Recover is an explicit branch swap, not a destructive overwrite. Publish the
      // current canonical branch first so a crash or a mistaken choice remains reversible.
      await ctx.writeConflictCandidate(
        teamName,
        scopeKey,
        scopeToken,
        currentRevision,
        currentRevision + 1,
        currentSnapshot,
        candidatePath
      );
      const revision = await ctx.save(teamName, scopeKey, {
        scopeToken,
        ...candidate.state,
        expectedRevision: currentRevision,
      });
      await unlinkPathDurably(candidatePath);
      return revision;
    },
  };
}
