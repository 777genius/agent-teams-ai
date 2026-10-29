import { atomicWriteAsync } from '../io/atomicPersistence.js';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type {
  ReviewDraftHistoryConflictCandidate,
  ReviewDraftHistoryEntry,
} from './draftContracts.js';
import {
  MAX_FILE_PATH_LENGTH,
  MAX_HISTORY_ENTRY_BYTES,
  MAX_CONFLICT_CANDIDATES_PER_SCOPE,
  MAX_CONFLICT_CANDIDATES_PER_LOGICAL_SCOPE,
  type StoredReviewDraftHistoryConflictCandidateV1,
  type StoredReviewDraftHistoryConflictCandidateV2,
  type SaveReviewDraftHistoryEntryInput,
  InvalidReviewDraftHistoryError,
  getScopeTokenHash,
  isValidGeneration,
  type DraftContext,
} from './DraftTypes.js';

export function createDraftConflictPersistence(getContext: () => DraftContext) {
  return {
    getConflictCandidateIdentityPayload(input: {
      scopeKey: string;
      scopeTokenHash: string;
      expectedRevision: number;
      expectedGeneration: string | null;
      filePath: string;
      entry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'> | null;
    }): object {
      if (input.entry === null) {
        return {
          scopeKey: input.scopeKey,
          scopeTokenHash: input.scopeTokenHash,
          expectedRevision: input.expectedRevision,
          expectedGeneration: input.expectedGeneration,
          filePath: input.filePath,
          entry: null,
        };
      }
      return {
        scopeKey: input.scopeKey,
        scopeTokenHash: input.scopeTokenHash,
        expectedRevision: input.expectedRevision,
        expectedGeneration: input.expectedGeneration,
        entry: input.entry,
      };
    },
    parseConflictCandidate(
      value: unknown,
      scopeKey: string,
      sourceScopeHash: string,
      currentScopeHash: string
    ): ReviewDraftHistoryConflictCandidate {
      const ctx = getContext();
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new InvalidReviewDraftHistoryError('Invalid review draft conflict candidate');
      }
      const candidate = value as Partial<
        StoredReviewDraftHistoryConflictCandidateV1 | StoredReviewDraftHistoryConflictCandidateV2
      >;
      if (!/^[a-f0-9]{64}$/.test(sourceScopeHash) || !/^[a-f0-9]{64}$/.test(currentScopeHash)) {
        throw new InvalidReviewDraftHistoryError(
          'Invalid review draft conflict candidate scope hash'
        );
      }
      const scopeTokenHash = sourceScopeHash;
      const isTombstone = candidate.version === 2 && candidate.entry === null;
      if (
        (candidate.version !== 1 && !isTombstone) ||
        candidate.scopeKey !== scopeKey ||
        candidate.scopeTokenHash !== scopeTokenHash ||
        typeof candidate.id !== 'string' ||
        !/^[a-f0-9]{64}$/.test(candidate.id) ||
        typeof candidate.capturedAt !== 'string' ||
        !Number.isFinite(Date.parse(candidate.capturedAt)) ||
        typeof candidate.filePath !== 'string' ||
        candidate.filePath.length === 0 ||
        candidate.filePath.length > MAX_FILE_PATH_LENGTH ||
        candidate.filePath.includes('\0') ||
        typeof candidate.expectedRevision !== 'number' ||
        !Number.isSafeInteger(candidate.expectedRevision) ||
        candidate.expectedRevision < 0 ||
        (candidate.expectedRevision === 0
          ? candidate.expectedGeneration !== null
          : !isValidGeneration(candidate.expectedGeneration)) ||
        typeof candidate.observedCurrentRevision !== 'number' ||
        !Number.isSafeInteger(candidate.observedCurrentRevision) ||
        candidate.observedCurrentRevision < 0 ||
        (candidate.observedCurrentRevision === 0
          ? candidate.observedCurrentGeneration !== null
          : !isValidGeneration(candidate.observedCurrentGeneration)) ||
        (isTombstone
          ? candidate.expectedRevision !== 0 || candidate.expectedGeneration !== null
          : !candidate.entry ||
            typeof candidate.entry !== 'object' ||
            Array.isArray(candidate.entry))
      ) {
        throw new InvalidReviewDraftHistoryError('Invalid review draft conflict candidate');
      }
      const entry = isTombstone ? null : candidate.entry!;
      if (entry) {
        ctx.assertEntry({
          ...entry,
          expectedRevision: candidate.expectedRevision,
          expectedGeneration: candidate.expectedGeneration as string | null,
        });
        if (candidate.filePath !== entry.filePath) {
          throw new InvalidReviewDraftHistoryError('Mismatched review draft conflict file');
        }
      }
      const identity = ctx.getConflictCandidateIdentityPayload({
        scopeKey,
        scopeTokenHash,
        expectedRevision: candidate.expectedRevision,
        expectedGeneration: candidate.expectedGeneration as string | null,
        filePath: candidate.filePath,
        entry,
      });
      const expectedId = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
      if (candidate.id !== expectedId) {
        throw new InvalidReviewDraftHistoryError('Mismatched review draft conflict identity');
      }
      return {
        id: candidate.id,
        capturedAt: candidate.capturedAt,
        origin: sourceScopeHash === currentScopeHash ? 'current-snapshot' : 'prior-snapshot',
        filePath: candidate.filePath,
        expectedRevision: candidate.expectedRevision,
        expectedGeneration: candidate.expectedGeneration as string | null,
        observedCurrentRevision: candidate.observedCurrentRevision,
        observedCurrentGeneration: candidate.observedCurrentGeneration as string | null,
        entry,
      };
    },
    async loadConflictCandidateFromPath(
      filePath: string,
      scopeKey: string,
      sourceScopeHash: string,
      currentScopeHash: string
    ): Promise<ReviewDraftHistoryConflictCandidate> {
      const ctx = getContext();
      let handle: fs.promises.FileHandle | null = null;
      try {
        const pathStats = await fs.promises.lstat(filePath);
        if (pathStats.isSymbolicLink()) {
          throw new Error('Unsafe review draft conflict candidate symlink');
        }
        handle = await fs.promises.open(filePath, 'r');
        const stats = await handle.stat();
        if (
          !stats.isFile() ||
          stats.nlink !== 1 ||
          stats.size > MAX_HISTORY_ENTRY_BYTES ||
          stats.dev !== pathStats.dev ||
          stats.ino !== pathStats.ino
        ) {
          throw new Error('Unsafe or oversized review draft conflict candidate');
        }
        const raw = await handle.readFile({ encoding: 'utf8' });
        const latestPathStats = await fs.promises.lstat(filePath);
        if (
          latestPathStats.isSymbolicLink() ||
          latestPathStats.dev !== stats.dev ||
          latestPathStats.ino !== stats.ino
        ) {
          throw new Error('Review draft conflict candidate changed while being read');
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch (error) {
          throw new InvalidReviewDraftHistoryError('Corrupted review draft conflict candidate', {
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
          throw new InvalidReviewDraftHistoryError(
            'Mismatched review draft conflict candidate filename'
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
          .filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry))
          .map(async (entry) => {
            const filePath = path.join(dirPath, entry);
            try {
              const stats = await fs.promises.lstat(filePath);
              return stats.isFile() && !stats.isSymbolicLink() ? filePath : null;
            } catch {
              return null;
            }
          })
      );
      const existing = candidates.filter(
        (entry): entry is string => entry !== null && entry !== replacementPath
      );
      if (
        !existing.includes(protectedPath) &&
        existing.length >= MAX_CONFLICT_CANDIDATES_PER_SCOPE
      ) {
        throw new Error(
          `Too many unresolved manual-edit recovery copies (${MAX_CONFLICT_CANDIDATES_PER_SCOPE}). Resolve one before saving another branch.`
        );
      }
      const logicalScopeCandidates = (await ctx.inspectConflictScopes(teamName, scopeKey))
        .candidatePaths;
      const retainedLogicalScopeCandidates = [...logicalScopeCandidates].filter(
        (candidatePath) => candidatePath !== replacementPath
      );
      if (
        !retainedLogicalScopeCandidates.includes(protectedPath) &&
        retainedLogicalScopeCandidates.length >= MAX_CONFLICT_CANDIDATES_PER_LOGICAL_SCOPE
      ) {
        throw new Error(
          `Too many unresolved manual-edit recovery copies for this task or agent (${MAX_CONFLICT_CANDIDATES_PER_LOGICAL_SCOPE}). Resolve one before saving another branch.`
        );
      }
    },
    async writeConflictCandidate(
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      input: SaveReviewDraftHistoryEntryInput,
      observedCurrentRevision: number,
      observedCurrentGeneration: string | null,
      replacementPath?: string
    ): Promise<ReviewDraftHistoryConflictCandidate> {
      const ctx = getContext();
      const { expectedRevision, expectedGeneration, ...entry } = input;
      const scopeTokenHash = getScopeTokenHash(scopeToken);
      const identity = ctx.getConflictCandidateIdentityPayload({
        scopeKey,
        scopeTokenHash,
        expectedRevision,
        expectedGeneration,
        filePath: entry.filePath,
        entry,
      });
      const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
      const candidate: StoredReviewDraftHistoryConflictCandidateV1 = {
        version: 1,
        id,
        scopeKey,
        scopeTokenHash,
        capturedAt: new Date().toISOString(),
        filePath: entry.filePath,
        expectedRevision,
        expectedGeneration,
        observedCurrentRevision,
        observedCurrentGeneration,
        entry,
      };
      const serialized = JSON.stringify(candidate);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_HISTORY_ENTRY_BYTES) {
        throw new Error('Review draft recovery candidate exceeds the durable storage limit');
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
      return {
        id,
        capturedAt: candidate.capturedAt,
        origin: 'current-snapshot',
        filePath: entry.filePath,
        expectedRevision,
        expectedGeneration,
        observedCurrentRevision,
        observedCurrentGeneration,
        entry,
      };
    },
    async writeEmptyConflictCandidate(
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      filePath: string,
      replacementPath?: string
    ): Promise<ReviewDraftHistoryConflictCandidate> {
      const ctx = getContext();
      const scopeTokenHash = getScopeTokenHash(scopeToken);
      const identity = ctx.getConflictCandidateIdentityPayload({
        scopeKey,
        scopeTokenHash,
        expectedRevision: 0,
        expectedGeneration: null,
        filePath,
        entry: null,
      });
      const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
      const candidate: StoredReviewDraftHistoryConflictCandidateV2 = {
        version: 2,
        id,
        scopeKey,
        scopeTokenHash,
        capturedAt: new Date().toISOString(),
        filePath,
        expectedRevision: 0,
        expectedGeneration: null,
        observedCurrentRevision: 0,
        observedCurrentGeneration: null,
        entry: null,
      };
      const serialized = JSON.stringify(candidate);
      const candidatePath = ctx.getConflictCandidatePath(teamName, scopeKey, scopeToken, id);
      await ctx.ensureConflictCandidateDir(teamName, scopeKey, scopeToken);
      await ctx.assertConflictCandidateCapacity(
        teamName,
        scopeKey,
        scopeToken,
        candidatePath,
        replacementPath
      );
      await atomicWriteAsync(candidatePath, serialized, {
        mode: 0o600,
        durability: 'strict',
        syncDirectory: true,
      });
      return { ...candidate, origin: 'current-snapshot' };
    },
  };
}
