import {
  assertConstrainedPersistenceDirectory,
  ensureConstrainedPersistenceDirectory,
} from '../io/safePersistenceDirectory.js';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { HunkDecision, ReviewRedoAction, ReviewUndoAction } from '../../contracts.js';
import {
  TEAM_NAME_PATTERN,
  SCOPE_KEY_PATTERN,
  MAX_STORED_DECISIONS_BYTES,
  EXACT_SCOPE_FILE_PATTERN,
  EXACT_SCOPE_HASH_PATTERN,
  type DecisionContext,
} from './DecisionTypes.js';

export function createDecisionPaths(getContext: () => DecisionContext) {
  return {
    assertValidSnapshot(data: {
      hunkDecisions: Record<string, HunkDecision>;
      fileDecisions: Record<string, HunkDecision>;
      hunkContextHashesByFile?: Record<string, Record<number, string>>;
      reviewActionHistory?: ReviewUndoAction[];
      reviewRedoHistory?: ReviewRedoAction[];
    }): void {
      const ctx = getContext();
      if (
        !ctx.isDecisionRecord(data.hunkDecisions) ||
        !ctx.isDecisionRecord(data.fileDecisions) ||
        !ctx.isContextHashRecord(data.hunkContextHashesByFile) ||
        !ctx.isReviewActionHistory(data.reviewActionHistory ?? []) ||
        !ctx.isReviewRedoHistory(data.reviewRedoHistory ?? []) ||
        !ctx.hasDisjointReviewActionIds(
          data.reviewActionHistory ?? [],
          data.reviewRedoHistory ?? []
        )
      ) {
        throw new Error('Invalid review decisions payload');
      }
    },
    assertSafeScope(teamName: string, scopeKey: string, scopeToken?: string): void {
      if (typeof teamName !== 'string' || !TEAM_NAME_PATTERN.test(teamName)) {
        throw new Error('Invalid review decision team name');
      }
      if (typeof scopeKey !== 'string' || !SCOPE_KEY_PATTERN.test(scopeKey)) {
        throw new Error('Invalid review decision scope key');
      }
      if (
        scopeToken !== undefined &&
        (typeof scopeToken !== 'string' ||
          scopeToken.length === 0 ||
          scopeToken.length > MAX_STORED_DECISIONS_BYTES ||
          scopeToken.includes('\0'))
      ) {
        throw new Error('Invalid review decision scope token');
      }
    },
    getLegacyDirPath(teamName: string): string {
      const ctx = getContext();
      return path.join(ctx.teamsRoot, teamName, 'review-decisions');
    },
    getLegacyFilePath(teamName: string, scopeKey: string): string {
      const ctx = getContext();
      return path.join(ctx.getLegacyDirPath(teamName), `${scopeKey}.json`);
    },
    getV2DirPath(teamName: string, scopeKey: string): string {
      const ctx = getContext();
      return path.join(ctx.getLegacyDirPath(teamName), 'v2', encodeURIComponent(scopeKey));
    },
    getV2FilePath(teamName: string, scopeKey: string, scopeToken: string): string {
      const ctx = getContext();
      const scopeHash = createHash('sha256').update(scopeToken).digest('hex');
      return path.join(ctx.getV2DirPath(teamName, scopeKey), `${scopeHash}.json`);
    },
    getConflictCandidateDir(teamName: string, scopeKey: string, scopeToken: string): string {
      const ctx = getContext();
      const scopeHash = createHash('sha256').update(scopeToken).digest('hex');
      return ctx.getConflictCandidateDirByScopeHash(teamName, scopeKey, scopeHash);
    },
    getConflictScopeDir(teamName: string, scopeKey: string): string {
      const ctx = getContext();
      return path.join(
        ctx.getLegacyDirPath(teamName),
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
      if (!EXACT_SCOPE_HASH_PATTERN.test(scopeHash)) {
        throw new Error('Invalid review decision conflict scope hash');
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
      for (const scopeHash of scopeEntries.filter((entry) =>
        EXACT_SCOPE_HASH_PATTERN.test(entry)
      )) {
        const scopeDir = ctx.getConflictCandidateDirByScopeHash(teamName, scopeKey, scopeHash);
        if (!(await assertConstrainedPersistenceDirectory(ctx.teamsRoot, scopeDir))) continue;
        const entries = await fs.promises.readdir(scopeDir);
        for (const entry of entries.filter((name) => EXACT_SCOPE_FILE_PATTERN.test(name))) {
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
      if (!EXACT_SCOPE_HASH_PATTERN.test(candidateId)) {
        throw new Error('Invalid review decision conflict candidate id');
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
  };
}
