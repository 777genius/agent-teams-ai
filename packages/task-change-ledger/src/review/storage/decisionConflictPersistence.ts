import { atomicWriteAsync } from '../io/atomicPersistence.js';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type {
  ReviewDecisionConflictCandidate,
  ReviewPersistedStateSnapshot,
} from '../../contracts.js';
import {
  MAX_STORED_DECISIONS_BYTES,
  MAX_RETAINED_CONFLICT_CANDIDATES,
  MAX_RETAINED_LOGICAL_SCOPE_CONFLICT_CANDIDATES,
  EXACT_SCOPE_FILE_PATTERN,
  EXACT_SCOPE_HASH_PATTERN,
  type StoredReviewDecisionConflictCandidateV1,
  InvalidReviewDecisionDataError,
  type DecisionContext,
} from './DecisionTypes.js';

export function createDecisionConflictPersistence(getContext: () => DecisionContext) {
  return {
    getConflictCandidateIdentityPayload(
      candidate: Omit<
        StoredReviewDecisionConflictCandidateV1,
        'version' | 'id' | 'capturedAt' | 'observedCurrentRevision'
      >
    ): object {
      return {
        scopeKey: candidate.scopeKey,
        scopeTokenHash: candidate.scopeTokenHash,
        expectedRevision: candidate.expectedRevision,
        hunkDecisions: candidate.hunkDecisions,
        fileDecisions: candidate.fileDecisions,
        hunkContextHashesByFile: candidate.hunkContextHashesByFile,
        reviewActionHistory: candidate.reviewActionHistory,
        reviewRedoHistory: candidate.reviewRedoHistory,
        textBlobs: candidate.textBlobs,
        fileSummaryBlobs: candidate.fileSummaryBlobs,
      };
    },
    parseConflictCandidate(
      value: unknown,
      scopeKey: string,
      sourceScopeHash: string,
      currentScopeHash: string
    ): ReviewDecisionConflictCandidate {
      const ctx = getContext();
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new InvalidReviewDecisionDataError('Invalid review decision conflict candidate');
      }
      const candidate = value as Partial<StoredReviewDecisionConflictCandidateV1>;
      if (
        !EXACT_SCOPE_HASH_PATTERN.test(sourceScopeHash) ||
        !EXACT_SCOPE_HASH_PATTERN.test(currentScopeHash)
      ) {
        throw new InvalidReviewDecisionDataError('Invalid review decision conflict scope hash');
      }
      const expectedScopeTokenHash = sourceScopeHash;
      if (
        candidate.version !== 1 ||
        candidate.scopeKey !== scopeKey ||
        candidate.scopeTokenHash !== expectedScopeTokenHash ||
        typeof candidate.id !== 'string' ||
        !EXACT_SCOPE_HASH_PATTERN.test(candidate.id) ||
        typeof candidate.capturedAt !== 'string' ||
        !Number.isFinite(Date.parse(candidate.capturedAt)) ||
        !Number.isSafeInteger(candidate.expectedRevision) ||
        candidate.expectedRevision! < 0 ||
        !Number.isSafeInteger(candidate.observedCurrentRevision) ||
        candidate.observedCurrentRevision! < 0 ||
        !ctx.isDecisionRecord(candidate.hunkDecisions) ||
        !ctx.isDecisionRecord(candidate.fileDecisions) ||
        !ctx.isContextHashRecord(candidate.hunkContextHashesByFile)
      ) {
        throw new InvalidReviewDecisionDataError('Invalid review decision conflict candidate');
      }
      const decoded = ctx.decodeHistoryV6(candidate);
      if (
        !decoded ||
        !ctx.isReviewActionHistory(decoded.undo) ||
        !ctx.isReviewRedoHistory(decoded.redo) ||
        !ctx.hasDisjointReviewActionIds(decoded.undo, decoded.redo)
      ) {
        throw new InvalidReviewDecisionDataError(
          'Invalid review decision conflict candidate history'
        );
      }
      const identityPayload = ctx.getConflictCandidateIdentityPayload({
        scopeKey,
        scopeTokenHash: expectedScopeTokenHash,
        expectedRevision: candidate.expectedRevision!,
        hunkDecisions: candidate.hunkDecisions,
        fileDecisions: candidate.fileDecisions,
        hunkContextHashesByFile: candidate.hunkContextHashesByFile,
        reviewActionHistory: candidate.reviewActionHistory!,
        reviewRedoHistory: candidate.reviewRedoHistory!,
        textBlobs: candidate.textBlobs!,
        fileSummaryBlobs: candidate.fileSummaryBlobs!,
      });
      const expectedId = createHash('sha256').update(JSON.stringify(identityPayload)).digest('hex');
      if (candidate.id !== expectedId) {
        throw new InvalidReviewDecisionDataError(
          'Mismatched review decision conflict candidate identity'
        );
      }
      const state = {
        hunkDecisions: candidate.hunkDecisions,
        fileDecisions: candidate.fileDecisions,
        hunkContextHashesByFile: candidate.hunkContextHashesByFile,
        reviewActionHistory: decoded.undo,
        reviewRedoHistory: decoded.redo,
      };
      ctx.assertValidSnapshot(state);
      return {
        id: candidate.id,
        capturedAt: candidate.capturedAt,
        origin: sourceScopeHash === currentScopeHash ? 'current-snapshot' : 'prior-snapshot',
        expectedRevision: candidate.expectedRevision!,
        observedCurrentRevision: candidate.observedCurrentRevision!,
        state,
      };
    },
    async loadConflictCandidateFromPath(
      filePath: string,
      scopeKey: string,
      sourceScopeHash: string,
      currentScopeHash: string
    ): Promise<ReviewDecisionConflictCandidate> {
      const ctx = getContext();
      let handle: fs.promises.FileHandle | null = null;
      try {
        const pathStats = await fs.promises.lstat(filePath);
        if (pathStats.isSymbolicLink()) {
          throw new Error('Unsafe review decision conflict candidate symlink');
        }
        handle = await fs.promises.open(filePath, 'r');
        const stats = await handle.stat();
        if (
          !stats.isFile() ||
          stats.nlink !== 1 ||
          stats.size > MAX_STORED_DECISIONS_BYTES ||
          stats.dev !== pathStats.dev ||
          stats.ino !== pathStats.ino
        ) {
          throw new Error('Unsafe or oversized review decision conflict candidate');
        }
        const raw = await handle.readFile({ encoding: 'utf8' });
        const latestPathStats = await fs.promises.lstat(filePath);
        if (
          latestPathStats.isSymbolicLink() ||
          latestPathStats.dev !== stats.dev ||
          latestPathStats.ino !== stats.ino
        ) {
          throw new Error('Review decision conflict candidate changed while being read');
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch (error) {
          throw new InvalidReviewDecisionDataError('Corrupted review decision conflict candidate', {
            cause: error,
          });
        }
        const candidate = ctx.parseConflictCandidate(
          parsed,
          scopeKey,
          sourceScopeHash,
          currentScopeHash
        );
        if (path.basename(filePath) !== `${candidate.id}.json`) {
          throw new InvalidReviewDecisionDataError(
            'Mismatched review decision conflict candidate filename'
          );
        }
        return candidate;
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },
    async assertConflictCandidateCapacity(
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      protectedPath: string,
      replacementPath?: string
    ): Promise<void> {
      const ctx = getContext();
      const dirPath = ctx.getConflictCandidateDir(teamName, scopeKey, scopeToken);
      let entries: string[];
      try {
        entries = await fs.promises.readdir(dirPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      const candidates = await Promise.all(
        entries
          .filter((entry) => EXACT_SCOPE_FILE_PATTERN.test(entry))
          .map(async (entry) => {
            const filePath = path.join(dirPath, entry);
            try {
              const stats = await fs.promises.lstat(filePath);
              return stats.isFile() && !stats.isSymbolicLink() ? filePath : null;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
              throw error;
            }
          })
      );
      const existing = candidates.filter(
        (entry): entry is string => entry !== null && entry !== replacementPath
      );
      if (
        !existing.includes(protectedPath) &&
        existing.length >= MAX_RETAINED_CONFLICT_CANDIDATES
      ) {
        throw new Error(
          `Too many unresolved review recovery copies (${MAX_RETAINED_CONFLICT_CANDIDATES}). Resolve one before saving another branch.`
        );
      }
      const logicalScopeCandidates = (await ctx.inspectConflictScopes(teamName, scopeKey))
        .candidatePaths;
      const retainedLogicalScopeCandidates = [...logicalScopeCandidates].filter(
        (candidatePath) => candidatePath !== replacementPath
      );
      if (
        !retainedLogicalScopeCandidates.includes(protectedPath) &&
        retainedLogicalScopeCandidates.length >= MAX_RETAINED_LOGICAL_SCOPE_CONFLICT_CANDIDATES
      ) {
        throw new Error(
          `Too many unresolved review recovery copies for this task or agent (${MAX_RETAINED_LOGICAL_SCOPE_CONFLICT_CANDIDATES}). Resolve one before saving another branch.`
        );
      }
    },
    async writeConflictCandidate(
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      expectedRevision: number,
      observedCurrentRevision: number,
      state: ReviewPersistedStateSnapshot,
      replacementPath?: string
    ): Promise<void> {
      const ctx = getContext();
      const encodedHistory = ctx.encodeHistoryV6(
        state.reviewActionHistory,
        state.reviewRedoHistory
      );
      const scopeTokenHash = createHash('sha256').update(scopeToken).digest('hex');
      const identityFields = {
        scopeKey,
        scopeTokenHash,
        expectedRevision,
        hunkDecisions: state.hunkDecisions,
        fileDecisions: state.fileDecisions,
        hunkContextHashesByFile: state.hunkContextHashesByFile,
        ...encodedHistory,
      };
      const id = createHash('sha256')
        .update(JSON.stringify(ctx.getConflictCandidateIdentityPayload(identityFields)))
        .digest('hex');
      const candidate: StoredReviewDecisionConflictCandidateV1 = {
        version: 1,
        id,
        ...identityFields,
        capturedAt: new Date().toISOString(),
        observedCurrentRevision,
      };
      const serialized = JSON.stringify(candidate);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_STORED_DECISIONS_BYTES) {
        throw new Error('Review decision recovery candidate exceeds the durable storage limit');
      }
      const filePath = ctx.getConflictCandidatePath(teamName, scopeKey, scopeToken, id);
      await ctx.ensureConflictCandidateDir(teamName, scopeKey, scopeToken);
      await ctx.assertConflictCandidateCapacity(
        teamName,
        scopeKey,
        scopeToken,
        filePath,
        replacementPath
      );
      await atomicWriteAsync(filePath, serialized, {
        mode: 0o600,
        durability: 'strict',
        syncDirectory: true,
      });
    },
  };
}
