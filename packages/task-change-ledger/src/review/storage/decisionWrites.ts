import { atomicWriteAsync, unlinkPathDurably } from '../io/atomicPersistence.js';
import { assertConstrainedPersistenceDirectory } from '../io/safePersistenceDirectory.js';
import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';
import type {
  FileReviewDecision,
  HunkDecision,
  ReviewRedoAction,
  ReviewUndoAction,
} from '../../contracts.js';
import {
  MAX_STORED_DECISIONS_BYTES,
  MAX_STORED_KEY_LENGTH,
  type StoredReviewDecisionsDataV6,
  type LoadedReviewDecisions,
  type InternalLoadedReviewDecisions,
  InvalidReviewDecisionDataError,
  type DecisionContext,
} from './DecisionTypes.js';

export function createDecisionWrites(getContext: () => DecisionContext) {
  return {
    async save(
      teamName: string,
      scopeKey: string,
      data: {
        scopeToken: string;
        hunkDecisions: Record<string, HunkDecision>;
        fileDecisions: Record<string, HunkDecision>;
        hunkContextHashesByFile?: Record<string, Record<number, string>>;
        reviewActionHistory?: ReviewUndoAction[];
        reviewRedoHistory?: ReviewRedoAction[];
        expectedRevision?: number;
        mutationId?: string;
      }
    ): Promise<number> {
      const ctx = getContext();
      ctx.assertSafeScope(teamName, scopeKey, data.scopeToken);
      ctx.assertValidSnapshot(data);
      if (
        (data.expectedRevision !== undefined &&
          (!Number.isSafeInteger(data.expectedRevision) || data.expectedRevision < 0)) ||
        (data.mutationId !== undefined &&
          (typeof data.mutationId !== 'string' ||
            data.mutationId.length === 0 ||
            data.mutationId.length > 256))
      ) {
        throw new Error('Invalid review decision revision metadata');
      }
      try {
        const current = await ctx.loadInternal(teamName, scopeKey, data.scopeToken);
        const currentRevision = current?.revision ?? 0;
        const targetSnapshot = {
          hunkDecisions: data.hunkDecisions,
          fileDecisions: data.fileDecisions,
          hunkContextHashesByFile: data.hunkContextHashesByFile,
          reviewActionHistory: data.reviewActionHistory ?? [],
          reviewRedoHistory: data.reviewRedoHistory ?? [],
        };
        const currentSnapshot = current
          ? {
              hunkDecisions: current.hunkDecisions,
              fileDecisions: current.fileDecisions,
              hunkContextHashesByFile: current.hunkContextHashesByFile,
              reviewActionHistory: current.reviewActionHistory,
              reviewRedoHistory: current.reviewRedoHistory,
            }
          : null;
        if (data.expectedRevision !== undefined && data.expectedRevision !== currentRevision) {
          const exactSnapshotMatches =
            currentSnapshot !== null && isDeepStrictEqual(currentSnapshot, targetSnapshot);
          const committedMutationRetry =
            data.mutationId !== undefined && current?.lastMutationId === data.mutationId;
          // Generic Accept/Reject and clear requests do not have a mutation id. Exact
          // equality of the complete durable snapshot proves the requested outcome is
          // already canonical, even if later idempotent writers advanced the revision.
          const committedGenericRetry =
            data.mutationId === undefined &&
            currentRevision > data.expectedRevision &&
            exactSnapshotMatches;
          if ((committedMutationRetry && exactSnapshotMatches) || committedGenericRetry) {
            return currentRevision;
          }
          if (!exactSnapshotMatches && data.mutationId === undefined) {
            await ctx.writeConflictCandidate(
              teamName,
              scopeKey,
              data.scopeToken,
              data.expectedRevision,
              currentRevision,
              targetSnapshot
            );
          }
          throw new Error('Review decisions changed; refusing stale state overwrite');
        }
        // Opening or reloading Changes must be read-only. Generic renderer saves can be
        // redundantly scheduled after hydration; an exact current snapshot is already
        // durable and must not advance the CAS revision or rewrite the file.
        if (
          data.mutationId === undefined &&
          current?.storageVersion === 6 &&
          currentSnapshot !== null &&
          isDeepStrictEqual(currentSnapshot, targetSnapshot)
        ) {
          return currentRevision;
        }
        const revision = currentRevision + 1;
        const compactedHistory = ctx.encodeHistoryV6(
          targetSnapshot.reviewActionHistory,
          targetSnapshot.reviewRedoHistory
        );
        const payload: StoredReviewDecisionsDataV6 = {
          version: 6,
          scopeKey,
          scopeToken: data.scopeToken,
          hunkDecisions: targetSnapshot.hunkDecisions,
          fileDecisions: targetSnapshot.fileDecisions,
          hunkContextHashesByFile: targetSnapshot.hunkContextHashesByFile,
          ...compactedHistory,
          revision,
          ...(data.mutationId ? { lastMutationId: data.mutationId } : {}),
          updatedAt: new Date().toISOString(),
        };
        const filePath = ctx.getV2FilePath(teamName, scopeKey, data.scopeToken);
        const serialized = JSON.stringify(payload, null, 2);
        if (Buffer.byteLength(serialized, 'utf8') > MAX_STORED_DECISIONS_BYTES) {
          throw new Error(
            'Review Undo/Redo history exceeds the 128 MiB durable storage limit. Start a new review scope or reduce retained history before retrying.'
          );
        }
        await atomicWriteAsync(filePath, serialized, {
          mode: 0o600,
          durability: 'strict',
          syncDirectory: true,
        });
        await ctx.pruneScopeDir(teamName, scopeKey, filePath);
        return revision;
      } catch (error) {
        ctx.logger.error(
          `Failed to save review decisions for ${teamName}/${scopeKey}: ${String(error)}`
        );
        throw error;
      }
    },
    async mergeFileDecisionPatch(
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      decision: FileReviewDecision & { reviewKey: string }
    ): Promise<void> {
      const ctx = getContext();
      ctx.assertSafeScope(teamName, scopeKey, scopeToken);
      if (
        !decision.reviewKey ||
        decision.reviewKey.length > MAX_STORED_KEY_LENGTH ||
        decision.reviewKey.includes('\0')
      ) {
        throw new Error('Invalid review decision patch key');
      }
      const current: LoadedReviewDecisions = (await ctx.load(teamName, scopeKey, scopeToken)) ?? {
        hunkDecisions: {},
        fileDecisions: {},
        hunkContextHashesByFile: {},
        reviewActionHistory: [],
        reviewRedoHistory: [],
        revision: 0,
      };
      const hunkDecisions = { ...current.hunkDecisions };
      const fileDecisions = { ...current.fileDecisions };
      const hunkContextHashesByFile = { ...(current.hunkContextHashesByFile ?? {}) };
      const prefixes = [`${decision.reviewKey}:`, `${decision.filePath}:`];
      for (const key of Object.keys(hunkDecisions)) {
        if (prefixes.some((prefix) => key.startsWith(prefix))) delete hunkDecisions[key];
      }
      delete fileDecisions[decision.reviewKey];
      delete fileDecisions[decision.filePath];
      delete hunkContextHashesByFile[decision.reviewKey];
      delete hunkContextHashesByFile[decision.filePath];

      for (const [index, value] of Object.entries(decision.hunkDecisions)) {
        if (value !== 'pending') hunkDecisions[`${decision.reviewKey}:${index}`] = value;
      }
      if (decision.fileDecision !== 'pending') {
        fileDecisions[decision.reviewKey] = decision.fileDecision;
      }
      if (decision.hunkContextHashes) {
        hunkContextHashesByFile[decision.reviewKey] = decision.hunkContextHashes;
      }

      await ctx.save(teamName, scopeKey, {
        scopeToken,
        hunkDecisions,
        fileDecisions,
        hunkContextHashesByFile,
        reviewActionHistory: current.reviewActionHistory,
        reviewRedoHistory: current.reviewRedoHistory,
      });
    },
    async clear(teamName: string, scopeKey: string, scopeToken?: string): Promise<void> {
      const ctx = getContext();
      ctx.assertSafeScope(teamName, scopeKey, scopeToken);
      try {
        if (scopeToken) {
          const exactPath = ctx.getV2FilePath(teamName, scopeKey, scopeToken);
          if (await assertConstrainedPersistenceDirectory(ctx.teamsRoot, path.dirname(exactPath))) {
            await unlinkPathDurably(exactPath).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error;
            });
          }
          const legacyPath = ctx.getLegacyFilePath(teamName, scopeKey);
          let legacy;
          try {
            legacy = await ctx.loadFromPath(legacyPath, scopeToken, scopeKey);
          } catch (error) {
            if (!(error instanceof InvalidReviewDecisionDataError)) throw error;
            // Explicit recovery: a corrupt coarse legacy snapshot cannot safely serve
            // any exact token, so discarding it is the only deterministic clear action.
            await unlinkPathDurably(legacyPath).catch((unlinkError: NodeJS.ErrnoException) => {
              if (unlinkError.code !== 'ENOENT') throw unlinkError;
            });
            return;
          }
          if (legacy) {
            await unlinkPathDurably(legacyPath).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error;
            });
          }
          return;
        }
        if (
          await assertConstrainedPersistenceDirectory(ctx.teamsRoot, ctx.getLegacyDirPath(teamName))
        ) {
          await fs.promises.unlink(ctx.getLegacyFilePath(teamName, scopeKey)).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          });
        }
        if (
          await assertConstrainedPersistenceDirectory(
            ctx.teamsRoot,
            ctx.getV2DirPath(teamName, scopeKey)
          )
        ) {
          await fs.promises.rm(ctx.getV2DirPath(teamName, scopeKey), {
            recursive: true,
            force: true,
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          ctx.logger.error(
            `Failed to clear review decisions for ${teamName}/${scopeKey}: ${String(error)}`
          );
          throw error;
        }
      }
    },
    async clearUnreadableExactScope(
      teamName: string,
      scopeKey: string,
      scopeToken: string
    ): Promise<void> {
      const ctx = getContext();
      ctx.assertSafeScope(teamName, scopeKey, scopeToken);
      const exactPath = ctx.getV2FilePath(teamName, scopeKey, scopeToken);
      const legacyPath = ctx.getLegacyFilePath(teamName, scopeKey);
      let exactUnreadable = false;
      let legacyUnreadable = false;
      let exact: InternalLoadedReviewDecisions | null = null;
      let legacy: InternalLoadedReviewDecisions | null = null;

      try {
        exact = await ctx.loadFromPath(exactPath, scopeToken, scopeKey);
      } catch (error) {
        if (!(error instanceof InvalidReviewDecisionDataError)) throw error;
        exactUnreadable = true;
      }
      if (exact) {
        throw new Error(
          'Saved review decisions became readable; refusing destructive recovery discard'
        );
      }

      try {
        legacy = await ctx.loadFromPath(legacyPath, scopeToken, scopeKey);
      } catch (error) {
        if (!(error instanceof InvalidReviewDecisionDataError)) throw error;
        legacyUnreadable = true;
      }
      if (legacy) {
        // A corrupt exact snapshot can hide a valid legacy fallback. Remove only the corrupt
        // blocker and make the renderer hydrate the readable state instead of deleting it.
        if (exactUnreadable) {
          await unlinkPathDurably(exactPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
        throw new Error(
          'Saved review decisions became readable; refusing destructive recovery discard'
        );
      }

      if (exactUnreadable) {
        await unlinkPathDurably(exactPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
      if (legacyUnreadable) {
        await unlinkPathDurably(legacyPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    },
  };
}
