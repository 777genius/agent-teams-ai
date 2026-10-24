import {
  assertConstrainedPersistenceDirectory,
  ensureConstrainedPersistenceDirectory,
} from '../io/safePersistenceDirectory.js';
import * as fs from 'fs';
import * as path from 'path';
import {
  MAX_STORED_DECISIONS_BYTES,
  MAX_RETAINED_DECISION_SCOPES,
  EXACT_SCOPE_FILE_PATTERN,
  EXACT_SCOPE_HASH_PATTERN,
  type LoadedReviewDecisions,
  type InternalLoadedReviewDecisions,
  InvalidReviewDecisionDataError,
  type DecisionContext,
} from './DecisionTypes.js';

export function createDecisionPersistence(getContext: () => DecisionContext) {
  return {
    async loadFromPath(
      filePath: string,
      scopeToken?: string,
      expectedScopeKey?: string
    ): Promise<InternalLoadedReviewDecisions | null> {
      const ctx = getContext();
      if (!(await assertConstrainedPersistenceDirectory(ctx.teamsRoot, path.dirname(filePath)))) {
        return null;
      }
      let handle: fs.promises.FileHandle | null = null;
      let raw: string;
      try {
        const pathStats = await fs.promises.lstat(filePath);
        if (pathStats.isSymbolicLink()) {
          throw new Error('Unsafe review decisions symlink');
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
          throw new Error('Unsafe or oversized review decisions file');
        }
        raw = await handle.readFile({ encoding: 'utf8' });
        const latestPathStats = await fs.promises.lstat(filePath);
        if (
          latestPathStats.isSymbolicLink() ||
          latestPathStats.dev !== stats.dev ||
          latestPathStats.ino !== stats.ino
        ) {
          throw new Error('Review decisions changed while being read');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        ctx.logger.error(`Failed to read review decisions at ${filePath}: ${String(error)}`);
        throw error;
      } finally {
        try {
          await handle?.close();
        } catch {
          // The read is complete; close failure does not make the parsed snapshot ambiguous.
        }
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch (error) {
        ctx.logger.error(`Corrupted review decisions file at ${filePath}`);
        throw new InvalidReviewDecisionDataError(`Corrupted review decisions file at ${filePath}`, {
          cause: error,
        });
      }

      const data = ctx.parseStoredData(parsed);
      if (!data) {
        throw new InvalidReviewDecisionDataError(`Invalid review decisions payload at ${filePath}`);
      }
      if (
        'version' in data &&
        (data.version === 2 ||
          data.version === 3 ||
          data.version === 4 ||
          data.version === 5 ||
          data.version === 6) &&
        data.scopeKey !== expectedScopeKey
      ) {
        throw new InvalidReviewDecisionDataError(`Mismatched review decision scope at ${filePath}`);
      }
      return ctx.extractDecisions(data, scopeToken);
    },
    async getPendingMutationScopeHashes(teamName: string, scopeKey: string): Promise<Set<string>> {
      const ctx = getContext();
      const journalScopeDir = path.join(
        ctx.teamsRoot,
        teamName,
        'review-decisions',
        'mutation-journal',
        scopeKey
      );
      if (!(await assertConstrainedPersistenceDirectory(ctx.teamsRoot, journalScopeDir))) {
        return new Set();
      }
      let entries: string[];
      try {
        entries = await fs.promises.readdir(journalScopeDir);
      } catch {
        return new Set();
      }

      const pendingHashes = await Promise.all(
        entries
          .filter((entry) => EXACT_SCOPE_HASH_PATTERN.test(entry))
          .map(async (entry) => {
            try {
              const stats = await fs.promises.lstat(path.join(journalScopeDir, entry));
              return stats.isDirectory() && !stats.isSymbolicLink() ? entry : null;
            } catch {
              return null;
            }
          })
      );
      return new Set(pendingHashes.filter((entry): entry is string => entry !== null));
    },
    async pruneScopeDir(teamName: string, scopeKey: string, protectedPath: string): Promise<void> {
      const ctx = getContext();
      const dirPath = ctx.getV2DirPath(teamName, scopeKey);
      await ensureConstrainedPersistenceDirectory(ctx.teamsRoot, dirPath);
      let entries: string[];
      try {
        entries = await fs.promises.readdir(dirPath);
      } catch {
        return;
      }

      const files = await Promise.all(
        entries
          .filter((entry) => EXACT_SCOPE_FILE_PATTERN.test(entry))
          .map(async (entry) => {
            const filePath = path.join(dirPath, entry);
            try {
              const stats = await fs.promises.lstat(filePath);
              return stats.isFile() && !stats.isSymbolicLink()
                ? { filePath, mtimeMs: stats.mtimeMs }
                : null;
            } catch {
              return null;
            }
          })
      );

      const existingFiles = files.filter(
        (entry): entry is { filePath: string; mtimeMs: number } => entry !== null
      );
      if (existingFiles.length <= MAX_RETAINED_DECISION_SCOPES) return;

      const [pendingMutationHashes, conflictScopes] = await Promise.all([
        ctx.getPendingMutationScopeHashes(teamName, scopeKey),
        ctx.inspectConflictScopes(teamName, scopeKey),
      ]);
      const protectedPaths = new Set([
        protectedPath,
        ...[...pendingMutationHashes].map((scopeHash) => path.join(dirPath, `${scopeHash}.json`)),
        ...[...conflictScopes.scopeHashes].map((scopeHash) =>
          path.join(dirPath, `${scopeHash}.json`)
        ),
      ]);
      const protectedExistingCount = existingFiles.filter((entry) =>
        protectedPaths.has(entry.filePath)
      ).length;
      const unprotectedRetention = Math.max(
        0,
        MAX_RETAINED_DECISION_SCOPES - protectedExistingCount
      );
      const staleFiles = existingFiles
        .filter((entry) => !protectedPaths.has(entry.filePath))
        .sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath))
        .slice(unprotectedRetention);

      await Promise.all(
        staleFiles.map((entry) => fs.promises.unlink(entry.filePath).catch(() => undefined))
      );
    },
    async loadInternal(
      teamName: string,
      scopeKey: string,
      scopeToken?: string
    ): Promise<InternalLoadedReviewDecisions | null> {
      const ctx = getContext();
      ctx.assertSafeScope(teamName, scopeKey, scopeToken);
      if (scopeToken) {
        const exact = await ctx.loadFromPath(
          ctx.getV2FilePath(teamName, scopeKey, scopeToken),
          scopeToken,
          scopeKey
        );
        if (exact) {
          return exact;
        }
      }

      return ctx.loadFromPath(ctx.getLegacyFilePath(teamName, scopeKey), scopeToken, scopeKey);
    },
    async load(
      teamName: string,
      scopeKey: string,
      scopeToken?: string
    ): Promise<LoadedReviewDecisions | null> {
      const ctx = getContext();
      const loaded = await ctx.loadInternal(teamName, scopeKey, scopeToken);
      if (!loaded) return null;
      const {
        lastMutationId: _lastMutationId,
        storageVersion: _storageVersion,
        ...publicSnapshot
      } = loaded;
      return publicSnapshot;
    },
  };
}
