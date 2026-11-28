import { unlinkPathDurably } from '../io/atomicPersistence.js';
import { assertConstrainedPersistenceDirectory } from '../io/safePersistenceDirectory.js';
import { randomUUID } from 'crypto';
import * as path from 'path';
import type { ReviewDraftHistoryEntry } from './draftContracts.js';
import {
  MAX_FILE_PATH_LENGTH,
  MAX_HISTORY_ENTRIES,
  type SaveReviewDraftHistoryEntryInput,
  InvalidReviewDraftHistoryError,
  entriesEqual,
  isValidGeneration,
  type DraftContext,
} from './DraftTypes.js';

export function createDraftWrites(getContext: () => DraftContext) {
  return {
    async saveEntry(
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      input: SaveReviewDraftHistoryEntryInput
    ): Promise<ReviewDraftHistoryEntry> {
      const ctx = getContext();
      ctx.assertSafeScope(teamName, scopeKey, scopeToken);
      ctx.assertEntry(input);
      const stored = await ctx.readStored(teamName, scopeKey, scopeToken);
      const entries = { ...(stored?.entries ?? {}) };
      const existing = entries[input.filePath];
      const currentRevision = existing?.revision ?? 0;
      const currentGeneration = existing?.generation ?? null;
      if (
        input.expectedRevision !== currentRevision ||
        input.expectedGeneration !== currentGeneration
      ) {
        if (existing && entriesEqual(existing, input)) return existing;
        await ctx.writeConflictCandidate(
          teamName,
          scopeKey,
          scopeToken,
          input,
          currentRevision,
          currentGeneration
        );
        throw new Error('Review draft history changed; refusing stale state overwrite');
      }
      if (existing && entriesEqual(existing, input)) {
        return existing;
      }
      if (!existing && Object.keys(entries).length >= MAX_HISTORY_ENTRIES) {
        throw new Error('Too many review draft history entries');
      }
      const {
        expectedRevision: _expectedRevision,
        expectedGeneration: _expectedGeneration,
        ...entryInput
      } = input;
      const entry: ReviewDraftHistoryEntry = {
        ...entryInput,
        generation: randomUUID(),
        updatedAt: new Date().toISOString(),
      };
      entries[input.filePath] = entry;
      await ctx.writeStored(teamName, scopeKey, scopeToken, entries);
      return entry;
    },
    async clearEntry(
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      filePath: string,
      expectedRevision: number,
      expectedGeneration: string | null
    ): Promise<void> {
      const ctx = getContext();
      ctx.assertSafeScope(teamName, scopeKey, scopeToken);
      if (
        typeof filePath !== 'string' ||
        filePath.length === 0 ||
        filePath.length > MAX_FILE_PATH_LENGTH ||
        filePath.includes('\0')
      ) {
        throw new Error('Invalid review draft history file path');
      }
      if (
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 ||
        (expectedRevision === 0
          ? expectedGeneration !== null
          : !isValidGeneration(expectedGeneration))
      ) {
        throw new Error('Invalid review draft history revision');
      }
      const stored = await ctx.readStored(teamName, scopeKey, scopeToken);
      if (!stored || !(filePath in stored.entries)) return;
      if (
        stored.entries[filePath]?.revision !== expectedRevision ||
        stored.entries[filePath]?.generation !== expectedGeneration
      ) {
        throw new Error('Review draft history changed; refusing stale state overwrite');
      }
      const entries = { ...stored.entries };
      delete entries[filePath];
      if (Object.keys(entries).length === 0) {
        await unlinkPathDurably(ctx.getFilePath(teamName, scopeKey, scopeToken)).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          }
        );
        return;
      }
      await ctx.writeStored(teamName, scopeKey, scopeToken, entries);
    },
    async clearScope(teamName: string, scopeKey: string, scopeToken: string): Promise<void> {
      const ctx = getContext();
      ctx.assertSafeScope(teamName, scopeKey, scopeToken);
      const filePath = ctx.getFilePath(teamName, scopeKey, scopeToken);
      if (!(await assertConstrainedPersistenceDirectory(ctx.teamsRoot, path.dirname(filePath)))) {
        return;
      }
      await unlinkPathDurably(filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    },
    async clearUnreadableScope(
      teamName: string,
      scopeKey: string,
      scopeToken: string
    ): Promise<void> {
      const ctx = getContext();
      ctx.assertSafeScope(teamName, scopeKey, scopeToken);
      try {
        const current = await ctx.readStored(teamName, scopeKey, scopeToken);
        if (current) {
          throw new Error(
            'Saved manual edit history became readable; refusing destructive recovery discard'
          );
        }
        return;
      } catch (error) {
        if (!(error instanceof InvalidReviewDraftHistoryError)) throw error;
      }
      await ctx.clearScope(teamName, scopeKey, scopeToken);
    },
  };
}
