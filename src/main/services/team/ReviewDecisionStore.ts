import { atomicWriteAsync, unlinkPathDurably } from '@main/utils/atomicWrite';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';

import type {
  FileReviewDecision,
  HunkDecision,
  ReviewRedoAction,
  ReviewUndoAction,
} from '@shared/types';

const logger = createLogger('ReviewDecisionStore');
const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const SCOPE_KEY_PATTERN = /^(?:task|agent)-[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/;
const MAX_STORED_DECISIONS_BYTES = 128 * 1024 * 1024;
const MAX_STORED_DECISION_ENTRIES = 200_000;
const MAX_STORED_CONTEXT_FILES = 2_000;
const MAX_STORED_KEY_LENGTH = 32_768;
const MAX_STORED_REVIEW_ACTIONS = 100_000;

export interface ReviewDecisionsData {
  scopeToken?: string;
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
  /** filePath -> (hunkIndex -> contextHash) */
  hunkContextHashesByFile?: Record<string, Record<number, string>>;
  /** Ordered, self-contained Accept/Reject Undo history for this exact scope. */
  reviewActionHistory?: ReviewUndoAction[];
  /** Durable forward branch created by Undo and cleared by a new review action. */
  reviewRedoHistory?: ReviewRedoAction[];
  updatedAt: string;
}

interface ReviewDecisionsDataV2 extends ReviewDecisionsData {
  version: 2;
  scopeKey: string;
  scopeToken: string;
}

interface ReviewDecisionsDataV3 extends ReviewDecisionsData {
  version: 3;
  scopeKey: string;
  scopeToken: string;
  reviewActionHistory: ReviewUndoAction[];
}

interface ReviewDecisionsDataV4 extends ReviewDecisionsData {
  version: 4;
  scopeKey: string;
  scopeToken: string;
  reviewActionHistory: ReviewUndoAction[];
  revision: number;
  lastMutationId?: string;
}

interface ReviewDecisionsDataV5 extends ReviewDecisionsData {
  version: 5;
  scopeKey: string;
  scopeToken: string;
  reviewActionHistory: ReviewUndoAction[];
  reviewRedoHistory: ReviewRedoAction[];
  revision: number;
  lastMutationId?: string;
}

export interface LoadedReviewDecisions {
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
  hunkContextHashesByFile?: Record<string, Record<number, string>>;
  reviewActionHistory: ReviewUndoAction[];
  reviewRedoHistory: ReviewRedoAction[];
  revision: number;
}

interface InternalLoadedReviewDecisions extends LoadedReviewDecisions {
  lastMutationId?: string;
}

class InvalidReviewDecisionDataError extends Error {}

export class ReviewDecisionStore {
  assertValidSnapshot(data: {
    hunkDecisions: Record<string, HunkDecision>;
    fileDecisions: Record<string, HunkDecision>;
    hunkContextHashesByFile?: Record<string, Record<number, string>>;
    reviewActionHistory?: ReviewUndoAction[];
    reviewRedoHistory?: ReviewRedoAction[];
  }): void {
    if (
      !this.isDecisionRecord(data.hunkDecisions) ||
      !this.isDecisionRecord(data.fileDecisions) ||
      !this.isContextHashRecord(data.hunkContextHashesByFile) ||
      !this.isReviewActionHistory(data.reviewActionHistory ?? []) ||
      !this.isReviewRedoHistory(data.reviewRedoHistory ?? []) ||
      !this.hasDisjointReviewActionIds(data.reviewActionHistory ?? [], data.reviewRedoHistory ?? [])
    ) {
      throw new Error('Invalid review decisions payload');
    }
  }

  private assertSafeScope(teamName: string, scopeKey: string, scopeToken?: string): void {
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
  }

  private getLegacyDirPath(teamName: string): string {
    return path.join(getTeamsBasePath(), teamName, 'review-decisions');
  }

  private getLegacyFilePath(teamName: string, scopeKey: string): string {
    return path.join(this.getLegacyDirPath(teamName), `${scopeKey}.json`);
  }

  private getV2DirPath(teamName: string, scopeKey: string): string {
    return path.join(this.getLegacyDirPath(teamName), 'v2', encodeURIComponent(scopeKey));
  }

  private getV2FilePath(teamName: string, scopeKey: string, scopeToken: string): string {
    const scopeHash = createHash('sha256').update(scopeToken).digest('hex');
    return path.join(this.getV2DirPath(teamName, scopeKey), `${scopeHash}.json`);
  }

  private parseStoredData(
    parsed: unknown
  ):
    | ReviewDecisionsData
    | ReviewDecisionsDataV2
    | ReviewDecisionsDataV3
    | ReviewDecisionsDataV4
    | ReviewDecisionsDataV5
    | null {
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const data = parsed as Partial<ReviewDecisionsData> & {
      version?: number;
      scopeKey?: unknown;
      scopeToken?: unknown;
      reviewActionHistory?: unknown;
      reviewRedoHistory?: unknown;
      revision?: unknown;
      lastMutationId?: unknown;
    };
    const isExactScope =
      (data.version === 2 || data.version === 3 || data.version === 4 || data.version === 5) &&
      typeof data.scopeKey === 'string' &&
      typeof data.scopeToken === 'string';

    if (data.version !== undefined && !isExactScope) {
      return null;
    }

    if (
      !this.isDecisionRecord(data.hunkDecisions) ||
      !this.isDecisionRecord(data.fileDecisions) ||
      !this.isContextHashRecord(data.hunkContextHashesByFile) ||
      ((data.version === 3 || data.version === 4 || data.version === 5) &&
        !this.isReviewActionHistory(data.reviewActionHistory)) ||
      (data.version === 5 && !this.isReviewRedoHistory(data.reviewRedoHistory)) ||
      (data.version === 5 &&
        !this.hasDisjointReviewActionIds(
          data.reviewActionHistory as ReviewUndoAction[],
          data.reviewRedoHistory as ReviewRedoAction[]
        )) ||
      ((data.version === 4 || data.version === 5) &&
        (!Number.isSafeInteger(data.revision) ||
          (data.revision as number) < 1 ||
          (data.lastMutationId !== undefined &&
            (typeof data.lastMutationId !== 'string' ||
              data.lastMutationId.length === 0 ||
              data.lastMutationId.length > 256))))
    ) {
      return null;
    }

    return data as
      | ReviewDecisionsData
      | ReviewDecisionsDataV2
      | ReviewDecisionsDataV3
      | ReviewDecisionsDataV4
      | ReviewDecisionsDataV5;
  }

  private isReviewActionHistory(value: unknown): value is ReviewUndoAction[] {
    if (!Array.isArray(value) || value.length > MAX_STORED_REVIEW_ACTIONS) return false;
    const ids = new Set<string>();
    return value.every((action) => {
      if (!action || typeof action !== 'object' || Array.isArray(action)) return false;
      const candidate = action as Partial<ReviewUndoAction>;
      if (
        typeof candidate.id !== 'string' ||
        candidate.id.length === 0 ||
        candidate.id.length > 256 ||
        ids.has(candidate.id) ||
        typeof candidate.createdAt !== 'string' ||
        candidate.createdAt.length === 0 ||
        candidate.createdAt.length > 128
      ) {
        return false;
      }
      ids.add(candidate.id);
      if (candidate.kind === 'hunk') {
        return this.isHunkUndoAction(candidate.action);
      }
      if (candidate.kind === 'disk') {
        return this.isDiskUndoAction(candidate.action);
      }
      if (candidate.kind === 'bulk') {
        return (
          this.isDecisionSnapshot(candidate.decisionSnapshot) &&
          Array.isArray(candidate.diskSnapshots) &&
          candidate.diskSnapshots.every((snapshot) => this.isDiskUndoSnapshot(snapshot))
        );
      }
      return false;
    });
  }

  private isReviewRedoHistory(value: unknown): value is ReviewRedoAction[] {
    if (!Array.isArray(value) || value.length > MAX_STORED_REVIEW_ACTIONS) return false;
    const ids = new Set<string>();
    return value.every((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const candidate = entry as Partial<ReviewRedoAction>;
      if (
        !candidate.action ||
        !this.isReviewActionHistory([candidate.action]) ||
        ids.has(candidate.action.id) ||
        !this.isDecisionSnapshot(candidate.decisionSnapshot) ||
        !this.isContextHashRecord(candidate.hunkContextHashesByFile)
      ) {
        return false;
      }
      ids.add(candidate.action.id);
      return true;
    });
  }

  private hasDisjointReviewActionIds(
    undoHistory: readonly ReviewUndoAction[],
    redoHistory: readonly ReviewRedoAction[]
  ): boolean {
    const undoIds = new Set(undoHistory.map((action) => action.id));
    return redoHistory.every((entry) => !undoIds.has(entry.action.id));
  }

  private isDecisionSnapshot(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as { hunkDecisions?: unknown; fileDecisions?: unknown };
    return (
      this.isDecisionRecord(candidate.hunkDecisions) &&
      this.isDecisionRecord(candidate.fileDecisions)
    );
  }

  private isHunkUndoAction(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as { filePath?: unknown; originalIndex?: unknown };
    return (
      typeof candidate.filePath === 'string' &&
      candidate.filePath.length > 0 &&
      candidate.filePath.length <= MAX_STORED_KEY_LENGTH &&
      Number.isSafeInteger(candidate.originalIndex) &&
      (candidate.originalIndex as number) >= 0
    );
  }

  private isDiskUndoAction(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as {
      snapshot?: unknown;
      originalIndex?: unknown;
      file?: unknown;
      decisionSnapshot?: unknown;
    };
    return (
      this.isDiskUndoSnapshot(candidate.snapshot) &&
      (candidate.originalIndex === undefined ||
        (Number.isSafeInteger(candidate.originalIndex) &&
          (candidate.originalIndex as number) >= 0)) &&
      (candidate.file === undefined || this.isFileSummary(candidate.file)) &&
      (candidate.decisionSnapshot === undefined ||
        this.isDecisionSnapshot(candidate.decisionSnapshot))
    );
  }

  private isDiskUndoSnapshot(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as {
      filePath?: unknown;
      beforeContent?: unknown;
      afterContent?: unknown;
      file?: unknown;
      fileIndex?: unknown;
      restoreConflict?: unknown;
      restoreMode?: unknown;
      renameExpectation?: unknown;
    };
    const restoreModes = new Set([
      'content',
      'create-file',
      'delete-file',
      'restore-rejected-rename',
      'reapply-rejected-rename',
    ]);
    return (
      typeof candidate.filePath === 'string' &&
      candidate.filePath.length > 0 &&
      candidate.filePath.length <= MAX_STORED_KEY_LENGTH &&
      typeof candidate.beforeContent === 'string' &&
      (typeof candidate.afterContent === 'string' || candidate.afterContent === null) &&
      (candidate.file === undefined || this.isFileSummary(candidate.file)) &&
      (candidate.fileIndex === undefined ||
        (Number.isSafeInteger(candidate.fileIndex) && (candidate.fileIndex as number) >= 0)) &&
      (candidate.restoreConflict === undefined ||
        (typeof candidate.restoreConflict === 'string' &&
          candidate.restoreConflict.length <= MAX_STORED_KEY_LENGTH)) &&
      (candidate.restoreMode === undefined || restoreModes.has(candidate.restoreMode as string)) &&
      (candidate.renameExpectation === undefined ||
        (!!candidate.renameExpectation &&
          typeof candidate.renameExpectation === 'object' &&
          !Array.isArray(candidate.renameExpectation)))
    );
  }

  private isFileSummary(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as {
      filePath?: unknown;
      relativePath?: unknown;
      snippets?: unknown;
      linesAdded?: unknown;
      linesRemoved?: unknown;
      isNewFile?: unknown;
    };
    return (
      typeof candidate.filePath === 'string' &&
      candidate.filePath.length > 0 &&
      candidate.filePath.length <= MAX_STORED_KEY_LENGTH &&
      typeof candidate.relativePath === 'string' &&
      Array.isArray(candidate.snippets) &&
      Number.isFinite(candidate.linesAdded) &&
      Number.isFinite(candidate.linesRemoved) &&
      typeof candidate.isNewFile === 'boolean'
    );
  }

  private isDecisionRecord(value: unknown): value is Record<string, HunkDecision> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const entries = Object.entries(value);
    return (
      entries.length <= MAX_STORED_DECISION_ENTRIES &&
      entries.every(
        ([key, decision]) =>
          key.length > 0 &&
          key.length <= MAX_STORED_KEY_LENGTH &&
          (decision === 'accepted' || decision === 'rejected' || decision === 'pending')
      )
    );
  }

  private isContextHashRecord(
    value: unknown
  ): value is Record<string, Record<number, string>> | undefined {
    if (value === undefined) return true;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const files = Object.entries(value as Record<string, unknown>);
    if (files.length > MAX_STORED_CONTEXT_FILES) return false;
    let totalHashes = 0;
    for (const [filePath, hashes] of files) {
      if (
        filePath.length === 0 ||
        filePath.length > MAX_STORED_KEY_LENGTH ||
        !hashes ||
        typeof hashes !== 'object' ||
        Array.isArray(hashes)
      ) {
        return false;
      }
      const entries = Object.entries(hashes);
      totalHashes += entries.length;
      if (totalHashes > MAX_STORED_DECISION_ENTRIES) return false;
      if (
        entries.some(
          ([index, hash]) =>
            !/^(0|[1-9]\d*)$/.test(index) || typeof hash !== 'string' || hash.length > 256
        )
      ) {
        return false;
      }
    }
    return true;
  }

  private extractDecisions(
    data:
      | ReviewDecisionsData
      | ReviewDecisionsDataV2
      | ReviewDecisionsDataV3
      | ReviewDecisionsDataV4
      | ReviewDecisionsDataV5,
    scopeToken?: string
  ): InternalLoadedReviewDecisions | null {
    const hunkDecisions: Record<string, HunkDecision> =
      data.hunkDecisions && typeof data.hunkDecisions === 'object' ? data.hunkDecisions : {};
    const fileDecisions: Record<string, HunkDecision> =
      data.fileDecisions && typeof data.fileDecisions === 'object' ? data.fileDecisions : {};
    const hunkContextHashesByFile: Record<string, Record<number, string>> | undefined =
      data.hunkContextHashesByFile && typeof data.hunkContextHashesByFile === 'object'
        ? data.hunkContextHashesByFile
        : undefined;

    if (scopeToken) {
      if (typeof data.scopeToken !== 'string' || data.scopeToken !== scopeToken) {
        return null;
      }
    }

    const reviewActionHistory =
      'version' in data && (data.version === 3 || data.version === 4 || data.version === 5)
        ? data.reviewActionHistory
        : [];
    const reviewRedoHistory = 'version' in data && data.version === 5 ? data.reviewRedoHistory : [];
    return {
      hunkDecisions,
      fileDecisions,
      hunkContextHashesByFile,
      reviewActionHistory,
      reviewRedoHistory,
      revision: 'version' in data && (data.version === 4 || data.version === 5) ? data.revision : 0,
      ...('version' in data && (data.version === 4 || data.version === 5) && data.lastMutationId
        ? { lastMutationId: data.lastMutationId }
        : {}),
    };
  }

  private async loadFromPath(
    filePath: string,
    scopeToken?: string,
    expectedScopeKey?: string
  ): Promise<InternalLoadedReviewDecisions | null> {
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
      logger.error(`Failed to read review decisions at ${filePath}: ${String(error)}`);
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
      logger.error(`Corrupted review decisions file at ${filePath}`);
      throw new InvalidReviewDecisionDataError(`Corrupted review decisions file at ${filePath}`, {
        cause: error,
      });
    }

    const data = this.parseStoredData(parsed);
    if (!data) {
      throw new InvalidReviewDecisionDataError(`Invalid review decisions payload at ${filePath}`);
    }
    if (
      'version' in data &&
      (data.version === 2 || data.version === 3 || data.version === 4 || data.version === 5) &&
      data.scopeKey !== expectedScopeKey
    ) {
      throw new InvalidReviewDecisionDataError(`Mismatched review decision scope at ${filePath}`);
    }
    return this.extractDecisions(data, scopeToken);
  }

  private async pruneScopeDir(teamName: string, scopeKey: string): Promise<void> {
    const dirPath = this.getV2DirPath(teamName, scopeKey);
    let entries: string[];
    try {
      entries = await fs.promises.readdir(dirPath);
    } catch {
      return;
    }

    if (entries.length <= 16) {
      return;
    }

    const files = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map(async (entry) => {
          const filePath = path.join(dirPath, entry);
          try {
            const stats = await fs.promises.stat(filePath);
            return { filePath, mtimeMs: stats.mtimeMs };
          } catch {
            return null;
          }
        })
    );

    const staleFiles = files
      .filter((entry): entry is { filePath: string; mtimeMs: number } => !!entry)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(16);

    await Promise.all(
      staleFiles.map((entry) => fs.promises.unlink(entry.filePath).catch(() => undefined))
    );
  }

  private async loadInternal(
    teamName: string,
    scopeKey: string,
    scopeToken?: string
  ): Promise<InternalLoadedReviewDecisions | null> {
    this.assertSafeScope(teamName, scopeKey, scopeToken);
    if (scopeToken) {
      const exact = await this.loadFromPath(
        this.getV2FilePath(teamName, scopeKey, scopeToken),
        scopeToken,
        scopeKey
      );
      if (exact) {
        return exact;
      }
    }

    return this.loadFromPath(this.getLegacyFilePath(teamName, scopeKey), scopeToken, scopeKey);
  }

  async load(
    teamName: string,
    scopeKey: string,
    scopeToken?: string
  ): Promise<LoadedReviewDecisions | null> {
    const loaded = await this.loadInternal(teamName, scopeKey, scopeToken);
    if (!loaded) return null;
    const { lastMutationId: _lastMutationId, ...publicSnapshot } = loaded;
    return publicSnapshot;
  }

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
    this.assertSafeScope(teamName, scopeKey, data.scopeToken);
    this.assertValidSnapshot(data);
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
      const current = await this.loadInternal(teamName, scopeKey, data.scopeToken);
      const currentRevision = current?.revision ?? 0;
      const targetSnapshot = {
        hunkDecisions: data.hunkDecisions,
        fileDecisions: data.fileDecisions,
        hunkContextHashesByFile: data.hunkContextHashesByFile,
        reviewActionHistory: data.reviewActionHistory ?? [],
        reviewRedoHistory: data.reviewRedoHistory ?? [],
      };
      if (data.expectedRevision !== undefined && data.expectedRevision !== currentRevision) {
        if (
          data.mutationId &&
          current?.lastMutationId === data.mutationId &&
          isDeepStrictEqual(
            {
              hunkDecisions: current.hunkDecisions,
              fileDecisions: current.fileDecisions,
              hunkContextHashesByFile: current.hunkContextHashesByFile,
              reviewActionHistory: current.reviewActionHistory,
              reviewRedoHistory: current.reviewRedoHistory,
            },
            targetSnapshot
          )
        ) {
          return currentRevision;
        }
        throw new Error('Review decisions changed; refusing stale state overwrite');
      }
      const revision = currentRevision + 1;
      const payload: ReviewDecisionsDataV5 = {
        version: 5,
        scopeKey,
        scopeToken: data.scopeToken,
        ...targetSnapshot,
        revision,
        ...(data.mutationId ? { lastMutationId: data.mutationId } : {}),
        updatedAt: new Date().toISOString(),
      };
      const filePath = this.getV2FilePath(teamName, scopeKey, data.scopeToken);
      const serialized = JSON.stringify(payload, null, 2);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_STORED_DECISIONS_BYTES) {
        throw new Error('Review decisions payload exceeds the durable storage limit');
      }
      await atomicWriteAsync(filePath, serialized, {
        durability: 'strict',
        syncDirectory: true,
      });
      await this.pruneScopeDir(teamName, scopeKey);
      return revision;
    } catch (error) {
      logger.error(`Failed to save review decisions for ${teamName}/${scopeKey}: ${String(error)}`);
      throw error;
    }
  }

  async mergeFileDecisionPatch(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    decision: FileReviewDecision & { reviewKey: string }
  ): Promise<void> {
    this.assertSafeScope(teamName, scopeKey, scopeToken);
    if (
      !decision.reviewKey ||
      decision.reviewKey.length > MAX_STORED_KEY_LENGTH ||
      decision.reviewKey.includes('\0')
    ) {
      throw new Error('Invalid review decision patch key');
    }
    const current: LoadedReviewDecisions = (await this.load(teamName, scopeKey, scopeToken)) ?? {
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

    await this.save(teamName, scopeKey, {
      scopeToken,
      hunkDecisions,
      fileDecisions,
      hunkContextHashesByFile,
      reviewActionHistory: current.reviewActionHistory,
      reviewRedoHistory: current.reviewRedoHistory,
    });
  }

  async clear(teamName: string, scopeKey: string, scopeToken?: string): Promise<void> {
    this.assertSafeScope(teamName, scopeKey, scopeToken);
    try {
      if (scopeToken) {
        await unlinkPathDurably(this.getV2FilePath(teamName, scopeKey, scopeToken)).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          }
        );
        const legacyPath = this.getLegacyFilePath(teamName, scopeKey);
        let legacy;
        try {
          legacy = await this.loadFromPath(legacyPath, scopeToken, scopeKey);
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
      await fs.promises.unlink(this.getLegacyFilePath(teamName, scopeKey)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      await fs.promises.rm(this.getV2DirPath(teamName, scopeKey), {
        recursive: true,
        force: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error(
          `Failed to clear review decisions for ${teamName}/${scopeKey}: ${String(error)}`
        );
        throw error;
      }
    }
  }
}
