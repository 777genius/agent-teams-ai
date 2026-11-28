import { atomicWriteAsync, unlinkPathDurably } from '../io/atomicPersistence.js';
import {
  assertConstrainedPersistenceDirectory,
  ensureConstrainedPersistenceDirectory,
} from '../io/safePersistenceDirectory.js';
import * as fs from 'fs';
import * as path from 'path';
import type { ReviewDraftHistoryEntry } from './draftContracts.js';
import {
  STORE_VERSION,
  TEAM_NAME_PATTERN,
  SCOPE_KEY_PATTERN,
  MAX_SCOPE_TOKEN_LENGTH,
  MAX_FILE_PATH_LENGTH,
  MAX_HISTORY_FILE_BYTES,
  MAX_HISTORY_ENTRY_BYTES,
  MAX_HISTORY_ENTRIES,
  MAX_EXACT_SCOPES_PER_LOGICAL_SCOPE,
  type StoredReviewDraftHistory,
  type SaveReviewDraftHistoryEntryInput,
  InvalidReviewDraftHistoryError,
  getScopeTokenHash,
  isSerializedEditorState,
  isValidGeneration,
  getLegacyGeneration,
  type DraftContext,
} from './DraftTypes.js';

export function createDraftPersistence(getContext: () => DraftContext) {
  return {
    assertSafeScope(teamName: string, scopeKey: string, scopeToken: string): void {
      if (typeof teamName !== 'string' || !TEAM_NAME_PATTERN.test(teamName)) {
        throw new Error('Invalid review draft history team name');
      }
      if (typeof scopeKey !== 'string' || !SCOPE_KEY_PATTERN.test(scopeKey)) {
        throw new Error('Invalid review draft history scope key');
      }
      if (
        typeof scopeToken !== 'string' ||
        scopeToken.length === 0 ||
        scopeToken.length > MAX_SCOPE_TOKEN_LENGTH ||
        scopeToken.includes('\0')
      ) {
        throw new Error('Invalid review draft history scope token');
      }
    },
    assertEntry(input: SaveReviewDraftHistoryEntryInput): void {
      if (
        typeof input.filePath !== 'string' ||
        input.filePath.length === 0 ||
        input.filePath.length > MAX_FILE_PATH_LENGTH ||
        input.filePath.includes('\0') ||
        input.codec !== 'codemirror-history-v1' ||
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 0 ||
        (input.expectedRevision === 0
          ? input.expectedGeneration !== null
          : !isValidGeneration(input.expectedGeneration)) ||
        !Number.isSafeInteger(input.revision) ||
        input.revision <= input.expectedRevision ||
        (input.diskBaseline !== null && typeof input.diskBaseline !== 'string') ||
        !isSerializedEditorState(input.editorState)
      ) {
        throw new Error('Invalid review draft history entry');
      }
      const serialized = JSON.stringify(input);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_HISTORY_ENTRY_BYTES) {
        throw new Error('Review draft history entry exceeds the durable storage limit');
      }
    },
    getScopeDir(teamName: string, scopeKey: string): string {
      const ctx = getContext();
      return path.join(
        ctx.teamsRoot,
        teamName,
        'review-decisions',
        'draft-history',
        'v1',
        encodeURIComponent(scopeKey)
      );
    },
    getFilePath(teamName: string, scopeKey: string, scopeToken: string): string {
      const ctx = getContext();
      return path.join(
        ctx.getScopeDir(teamName, scopeKey),
        `${getScopeTokenHash(scopeToken)}.json`
      );
    },
    getConflictCandidateDir(teamName: string, scopeKey: string, scopeToken: string): string {
      const ctx = getContext();
      return ctx.getConflictCandidateDirByScopeHash(
        teamName,
        scopeKey,
        getScopeTokenHash(scopeToken)
      );
    },
    getConflictScopeDir(teamName: string, scopeKey: string): string {
      const ctx = getContext();
      return path.join(
        ctx.teamsRoot,
        teamName,
        'review-decisions',
        'draft-history',
        'conflicts',
        'v1',
        encodeURIComponent(scopeKey)
      );
    },
    getConflictCandidateDirByScopeHash(
      teamName: string,
      scopeKey: string,
      scopeHash: string
    ): string {
      const ctx = getContext();
      if (!/^[a-f0-9]{64}$/.test(scopeHash)) {
        throw new Error('Invalid review draft history conflict scope hash');
      }
      return path.join(ctx.getConflictScopeDir(teamName, scopeKey), scopeHash);
    },
    async inspectConflictScopes(
      teamName: string,
      scopeKey: string
    ): Promise<{ scopeHashes: Set<string>; candidatePaths: Set<string> }> {
      const ctx = getContext();
      const rootPath = ctx.getConflictScopeDir(teamName, scopeKey);
      if (!(await assertConstrainedPersistenceDirectory(ctx.teamsRoot, rootPath))) {
        return { scopeHashes: new Set(), candidatePaths: new Set() };
      }
      const scopeEntries = await fs.promises.readdir(rootPath);
      const scopeHashes = new Set<string>();
      const candidatePaths = new Set<string>();
      for (const scopeHash of scopeEntries.filter((entry) => /^[a-f0-9]{64}$/.test(entry))) {
        const scopeDir = ctx.getConflictCandidateDirByScopeHash(teamName, scopeKey, scopeHash);
        if (!(await assertConstrainedPersistenceDirectory(ctx.teamsRoot, scopeDir))) continue;
        const entries = await fs.promises.readdir(scopeDir);
        for (const entry of entries.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
          scopeHashes.add(scopeHash);
          candidatePaths.add(path.join(scopeDir, entry));
        }
      }
      return { scopeHashes, candidatePaths };
    },
    getConflictCandidatePath(
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      candidateId: string
    ): string {
      const ctx = getContext();
      if (!/^[a-f0-9]{64}$/.test(candidateId)) {
        throw new Error('Invalid review draft history conflict candidate id');
      }
      return path.join(
        ctx.getConflictCandidateDir(teamName, scopeKey, scopeToken),
        `${candidateId}.json`
      );
    },
    async ensureConflictCandidateDir(
      teamName: string,
      scopeKey: string,
      scopeToken: string
    ): Promise<string> {
      const ctx = getContext();
      const dirPath = ctx.getConflictCandidateDir(teamName, scopeKey, scopeToken);
      await ensureConstrainedPersistenceDirectory(ctx.teamsRoot, dirPath);
      return dirPath;
    },
    parseStoredData(
      value: unknown,
      scopeKey: string,
      scopeToken: string
    ): StoredReviewDraftHistory {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new InvalidReviewDraftHistoryError('Invalid review draft history payload');
      }
      const data = value as Partial<StoredReviewDraftHistory>;
      if (
        data.version !== STORE_VERSION ||
        data.scopeKey !== scopeKey ||
        data.scopeTokenHash !== getScopeTokenHash(scopeToken) ||
        typeof data.updatedAt !== 'string' ||
        !data.entries ||
        typeof data.entries !== 'object' ||
        Array.isArray(data.entries)
      ) {
        throw new InvalidReviewDraftHistoryError('Mismatched review draft history payload');
      }
      const entries = Object.entries(data.entries);
      if (entries.length > MAX_HISTORY_ENTRIES) {
        throw new InvalidReviewDraftHistoryError('Too many review draft history entries');
      }
      for (const [filePath, entry] of entries) {
        const candidate = entry as Partial<ReviewDraftHistoryEntry>;
        if (
          !entry ||
          typeof entry !== 'object' ||
          Array.isArray(entry) ||
          entry.filePath !== filePath ||
          entry.codec !== 'codemirror-history-v1' ||
          filePath.length === 0 ||
          filePath.length > MAX_FILE_PATH_LENGTH ||
          filePath.includes('\0') ||
          !Number.isSafeInteger(entry.revision) ||
          entry.revision < 1 ||
          (entry.diskBaseline !== null && typeof entry.diskBaseline !== 'string') ||
          typeof entry.updatedAt !== 'string' ||
          (candidate.generation !== undefined && !isValidGeneration(candidate.generation)) ||
          !isSerializedEditorState(entry.editorState) ||
          Buffer.byteLength(JSON.stringify(entry), 'utf8') > MAX_HISTORY_ENTRY_BYTES
        ) {
          throw new InvalidReviewDraftHistoryError('Invalid review draft history entry');
        }
        if (candidate.generation === undefined) {
          candidate.generation = getLegacyGeneration(
            entry as Omit<ReviewDraftHistoryEntry, 'generation'>
          );
        }
      }
      return data as StoredReviewDraftHistory;
    },
    async readStored(
      teamName: string,
      scopeKey: string,
      scopeToken: string
    ): Promise<StoredReviewDraftHistory | null> {
      const ctx = getContext();
      const filePath = ctx.getFilePath(teamName, scopeKey, scopeToken);
      if (!(await assertConstrainedPersistenceDirectory(ctx.teamsRoot, path.dirname(filePath)))) {
        return null;
      }
      let handle: fs.promises.FileHandle | null = null;
      try {
        const pathStats = await fs.promises.lstat(filePath);
        if (pathStats.isSymbolicLink()) {
          throw new Error('Unsafe review draft history symlink');
        }
        handle = await fs.promises.open(filePath, 'r');
        const stats = await handle.stat();
        if (
          !stats.isFile() ||
          stats.nlink !== 1 ||
          stats.size > MAX_HISTORY_FILE_BYTES ||
          stats.dev !== pathStats.dev ||
          stats.ino !== pathStats.ino
        ) {
          throw new Error('Unsafe or oversized review draft history file');
        }
        const raw = await handle.readFile({ encoding: 'utf8' });
        const latestPathStats = await fs.promises.lstat(filePath);
        if (
          latestPathStats.isSymbolicLink() ||
          latestPathStats.dev !== stats.dev ||
          latestPathStats.ino !== stats.ino
        ) {
          throw new Error('Review draft history changed while being read');
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch (error) {
          throw new InvalidReviewDraftHistoryError('Corrupted review draft history file', {
            cause: error,
          });
        }
        return ctx.parseStoredData(parsed, scopeKey, scopeToken);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        ctx.logger.error(`Failed to read review draft history at ${filePath}: ${String(error)}`);
        throw error;
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },
    async writeStored(
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      entries: Record<string, ReviewDraftHistoryEntry>
    ): Promise<void> {
      const ctx = getContext();
      const payload: StoredReviewDraftHistory = {
        version: STORE_VERSION,
        scopeKey,
        scopeTokenHash: getScopeTokenHash(scopeToken),
        entries,
        updatedAt: new Date().toISOString(),
      };
      const serialized = JSON.stringify(payload);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_HISTORY_FILE_BYTES) {
        throw new Error('Review draft history exceeds the durable storage limit');
      }
      const filePath = ctx.getFilePath(teamName, scopeKey, scopeToken);
      await ensureConstrainedPersistenceDirectory(ctx.teamsRoot, path.dirname(filePath));
      await atomicWriteAsync(filePath, serialized, {
        mode: 0o600,
        durability: 'strict',
        syncDirectory: true,
      });
      await ctx.pruneScopeDir(teamName, scopeKey, ctx.getFilePath(teamName, scopeKey, scopeToken));
    },
    async pruneScopeDir(teamName: string, scopeKey: string, protectedPath: string): Promise<void> {
      const ctx = getContext();
      const scopeDir = ctx.getScopeDir(teamName, scopeKey);
      await ensureConstrainedPersistenceDirectory(ctx.teamsRoot, scopeDir);
      let entries: string[];
      try {
        entries = await fs.promises.readdir(scopeDir);
      } catch {
        return;
      }
      const candidates = await Promise.all(
        entries
          .filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry))
          .map(async (entry) => {
            const filePath = path.join(scopeDir, entry);
            try {
              const stats = await fs.promises.lstat(filePath);
              return stats.isFile() && !stats.isSymbolicLink()
                ? { filePath, mtimeMs: stats.mtimeMs }
                : null;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
              throw error;
            }
          })
      );
      const conflictScopes = await ctx.inspectConflictScopes(teamName, scopeKey);
      const protectedPaths = new Set([
        protectedPath,
        ...[...conflictScopes.scopeHashes].map((scopeHash) =>
          path.join(scopeDir, `${scopeHash}.json`)
        ),
      ]);
      const existing = candidates.filter(
        (entry): entry is { filePath: string; mtimeMs: number } => entry !== null
      );
      const protectedExistingCount = existing.filter((entry) =>
        protectedPaths.has(entry.filePath)
      ).length;
      const unprotectedRetention = Math.max(
        0,
        MAX_EXACT_SCOPES_PER_LOGICAL_SCOPE - protectedExistingCount
      );
      const stale = existing
        .filter((entry) => !protectedPaths.has(entry.filePath))
        .sort((left, right) => {
          return right.mtimeMs - left.mtimeMs;
        })
        .slice(unprotectedRetention);
      await Promise.all(
        stale.map((entry) => unlinkPathDurably(entry.filePath).catch(() => undefined))
      );
    },
  };
}
