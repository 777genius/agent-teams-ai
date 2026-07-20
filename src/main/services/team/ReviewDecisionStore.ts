import { atomicWriteAsync, unlinkPathDurably } from '@main/utils/atomicWrite';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import {
  assertConstrainedPersistenceDirectory,
  ensureConstrainedPersistenceDirectory,
  quarantineConstrainedPersistenceFile,
} from '@main/utils/safePersistenceDirectory';
import { createLogger } from '@shared/utils/logger';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';

import type {
  FileChangeSummary,
  FileReviewDecision,
  HunkDecision,
  ReviewConflictResolution,
  ReviewDecisionConflictCandidate,
  ReviewDecisionConflictCandidateSummary,
  ReviewDiskUndoAction,
  ReviewDiskUndoSnapshot,
  ReviewPersistedStateSnapshot,
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
const MAX_RETAINED_DECISION_SCOPES = 16;
const MAX_RETAINED_CONFLICT_CANDIDATES = 8;
const MAX_RETAINED_LOGICAL_SCOPE_CONFLICT_CANDIDATES = 32;
const EXACT_SCOPE_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;
const EXACT_SCOPE_HASH_PATTERN = /^[a-f0-9]{64}$/;

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

type StoredReviewDiskUndoSnapshotV6 = Omit<
  ReviewDiskUndoSnapshot,
  'beforeContent' | 'afterContent' | 'file'
> & {
  beforeBlob: string;
  afterBlob: string | null;
  fileRef?: string;
};

type StoredReviewDiskUndoActionV6 = Omit<ReviewDiskUndoAction, 'snapshot' | 'file'> & {
  snapshot: StoredReviewDiskUndoSnapshotV6;
  fileRef?: string;
};

type StoredReviewUndoActionV6 =
  | (Omit<Extract<ReviewUndoAction, { kind: 'bulk' }>, 'diskSnapshots'> & {
      diskSnapshots: StoredReviewDiskUndoSnapshotV6[];
    })
  | (Omit<Extract<ReviewUndoAction, { kind: 'disk' }>, 'action'> & {
      action: StoredReviewDiskUndoActionV6;
    })
  | Extract<ReviewUndoAction, { kind: 'hunk' }>;

type StoredReviewRedoActionV6 = Omit<ReviewRedoAction, 'action'> & {
  action: StoredReviewUndoActionV6;
};

interface StoredReviewDecisionsDataV6 extends Omit<
  ReviewDecisionsData,
  'reviewActionHistory' | 'reviewRedoHistory'
> {
  version: 6;
  scopeKey: string;
  scopeToken: string;
  reviewActionHistory: StoredReviewUndoActionV6[];
  reviewRedoHistory: StoredReviewRedoActionV6[];
  textBlobs: Record<string, string>;
  fileSummaryBlobs: Record<string, FileChangeSummary>;
  revision: number;
  lastMutationId?: string;
}

interface ParsedReviewDecisionsDataV6 extends ReviewDecisionsData {
  version: 6;
  scopeKey: string;
  scopeToken: string;
  reviewActionHistory: ReviewUndoAction[];
  reviewRedoHistory: ReviewRedoAction[];
  revision: number;
  lastMutationId?: string;
}

interface StoredReviewDecisionConflictCandidateV1 {
  version: 1;
  id: string;
  scopeKey: string;
  scopeTokenHash: string;
  capturedAt: string;
  expectedRevision: number;
  observedCurrentRevision: number;
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
  hunkContextHashesByFile?: Record<string, Record<number, string>>;
  reviewActionHistory: StoredReviewUndoActionV6[];
  reviewRedoHistory: StoredReviewRedoActionV6[];
  textBlobs: Record<string, string>;
  fileSummaryBlobs: Record<string, FileChangeSummary>;
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
  storageVersion: number;
}

class InvalidReviewDecisionDataError extends Error {}

function shouldQuarantineDecisionConflictCandidate(error: unknown): boolean {
  if (error instanceof InvalidReviewDecisionDataError) return true;
  if (!(error instanceof Error)) return false;
  return (
    error.message.startsWith('Unsafe review decision conflict candidate') ||
    error.message === 'Unsafe or oversized review decision conflict candidate' ||
    error.message === 'Review decision conflict candidate changed while being read'
  );
}

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

  private getConflictCandidateDir(teamName: string, scopeKey: string, scopeToken: string): string {
    const scopeHash = createHash('sha256').update(scopeToken).digest('hex');
    return this.getConflictCandidateDirByScopeHash(teamName, scopeKey, scopeHash);
  }

  private getConflictScopeDir(teamName: string, scopeKey: string): string {
    return path.join(
      this.getLegacyDirPath(teamName),
      'conflicts',
      'v1',
      encodeURIComponent(scopeKey)
    );
  }

  private getConflictCandidateDirByScopeHash(
    teamName: string,
    scopeKey: string,
    scopeHash: string
  ): string {
    if (!EXACT_SCOPE_HASH_PATTERN.test(scopeHash)) {
      throw new Error('Invalid review decision conflict scope hash');
    }
    return path.join(this.getConflictScopeDir(teamName, scopeKey), scopeHash);
  }

  private async inspectConflictScopes(
    teamName: string,
    scopeKey: string
  ): Promise<{ scopeHashes: Set<string>; candidatePaths: Set<string> }> {
    const rootPath = this.getConflictScopeDir(teamName, scopeKey);
    if (!(await assertConstrainedPersistenceDirectory(getTeamsBasePath(), rootPath))) {
      return { scopeHashes: new Set(), candidatePaths: new Set() };
    }
    const scopeEntries = await fs.promises.readdir(rootPath);
    const scopeHashes = new Set<string>();
    const candidatePaths = new Set<string>();
    for (const scopeHash of scopeEntries.filter((entry) => EXACT_SCOPE_HASH_PATTERN.test(entry))) {
      const scopeDir = this.getConflictCandidateDirByScopeHash(teamName, scopeKey, scopeHash);
      if (!(await assertConstrainedPersistenceDirectory(getTeamsBasePath(), scopeDir))) continue;
      const entries = await fs.promises.readdir(scopeDir);
      for (const entry of entries.filter((name) => EXACT_SCOPE_FILE_PATTERN.test(name))) {
        scopeHashes.add(scopeHash);
        candidatePaths.add(path.join(scopeDir, entry));
      }
    }
    return { scopeHashes, candidatePaths };
  }

  private getConflictCandidatePath(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string
  ): string {
    if (!EXACT_SCOPE_HASH_PATTERN.test(candidateId)) {
      throw new Error('Invalid review decision conflict candidate id');
    }
    return path.join(
      this.getConflictCandidateDir(teamName, scopeKey, scopeToken),
      `${candidateId}.json`
    );
  }

  private async ensureConflictCandidateDir(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<string> {
    const dirPath = this.getConflictCandidateDir(teamName, scopeKey, scopeToken);
    await ensureConstrainedPersistenceDirectory(getTeamsBasePath(), dirPath);
    return dirPath;
  }

  private hashHistoryBlob(kind: 'text' | 'file-summary', value: string): string {
    return createHash('sha256').update(kind).update('\0').update(value).digest('hex');
  }

  private encodeHistoryV6(
    undoHistory: readonly ReviewUndoAction[],
    redoHistory: readonly ReviewRedoAction[]
  ): Pick<
    StoredReviewDecisionsDataV6,
    'reviewActionHistory' | 'reviewRedoHistory' | 'textBlobs' | 'fileSummaryBlobs'
  > {
    const textBlobs: Record<string, string> = {};
    const fileSummaryBlobs: Record<string, FileChangeSummary> = {};
    const addText = (content: string): string => {
      const ref = this.hashHistoryBlob('text', content);
      const existing = textBlobs[ref];
      if (existing !== undefined && existing !== content) {
        throw new Error('Review history content hash collision');
      }
      textBlobs[ref] = content;
      return ref;
    };
    const addFileSummary = (file: FileChangeSummary): string => {
      const serialized = JSON.stringify(file);
      const ref = this.hashHistoryBlob('file-summary', serialized);
      const existing = fileSummaryBlobs[ref];
      if (existing !== undefined && JSON.stringify(existing) !== serialized) {
        throw new Error('Review history file-summary hash collision');
      }
      fileSummaryBlobs[ref] = file;
      return ref;
    };
    const encodeSnapshot = (snapshot: ReviewDiskUndoSnapshot): StoredReviewDiskUndoSnapshotV6 => {
      const { beforeContent, afterContent, file, ...metadata } = snapshot;
      return {
        ...metadata,
        beforeBlob: addText(beforeContent),
        afterBlob: afterContent === null ? null : addText(afterContent),
        ...(file ? { fileRef: addFileSummary(file) } : {}),
      };
    };
    const encodeAction = (action: ReviewUndoAction): StoredReviewUndoActionV6 => {
      if (action.kind === 'hunk') return action;
      if (action.kind === 'bulk') {
        return {
          ...action,
          diskSnapshots: action.diskSnapshots.map(encodeSnapshot),
        };
      }
      const { snapshot, file, ...actionMetadata } = action.action;
      return {
        ...action,
        action: {
          ...actionMetadata,
          snapshot: encodeSnapshot(snapshot),
          ...(file ? { fileRef: addFileSummary(file) } : {}),
        },
      };
    };

    return {
      reviewActionHistory: undoHistory.map(encodeAction),
      reviewRedoHistory: redoHistory.map((entry) => ({
        ...entry,
        action: encodeAction(entry.action),
      })),
      textBlobs,
      fileSummaryBlobs,
    };
  }

  private decodeHistoryV6(data: {
    reviewActionHistory?: unknown;
    reviewRedoHistory?: unknown;
    textBlobs?: unknown;
    fileSummaryBlobs?: unknown;
  }): { undo: ReviewUndoAction[]; redo: ReviewRedoAction[] } | null {
    if (
      !Array.isArray(data.reviewActionHistory) ||
      data.reviewActionHistory.length > MAX_STORED_REVIEW_ACTIONS ||
      !Array.isArray(data.reviewRedoHistory) ||
      data.reviewRedoHistory.length > MAX_STORED_REVIEW_ACTIONS ||
      !data.textBlobs ||
      typeof data.textBlobs !== 'object' ||
      Array.isArray(data.textBlobs) ||
      !data.fileSummaryBlobs ||
      typeof data.fileSummaryBlobs !== 'object' ||
      Array.isArray(data.fileSummaryBlobs)
    ) {
      return null;
    }
    const textEntries = Object.entries(data.textBlobs as Record<string, unknown>);
    const fileEntries = Object.entries(data.fileSummaryBlobs as Record<string, unknown>);
    if (
      textEntries.length + fileEntries.length > MAX_STORED_DECISION_ENTRIES ||
      textEntries.some(
        ([ref, content]) =>
          !/^[a-f0-9]{64}$/.test(ref) ||
          typeof content !== 'string' ||
          this.hashHistoryBlob('text', content) !== ref
      ) ||
      fileEntries.some(([ref, file]) => {
        if (!/^[a-f0-9]{64}$/.test(ref) || !this.isFileSummary(file)) return true;
        try {
          return this.hashHistoryBlob('file-summary', JSON.stringify(file)) !== ref;
        } catch {
          return true;
        }
      })
    ) {
      return null;
    }
    const textBlobs = data.textBlobs as Record<string, string>;
    const fileSummaryBlobs = data.fileSummaryBlobs as Record<string, FileChangeSummary>;
    const hasOwn = (record: object, key: string): boolean =>
      Object.prototype.hasOwnProperty.call(record, key);
    const usedTextRefs = new Set<string>();
    const usedFileRefs = new Set<string>();
    let decodedSnapshotCount = 0;
    const decodeSnapshot = (value: unknown): ReviewDiskUndoSnapshot | null => {
      decodedSnapshotCount++;
      if (decodedSnapshotCount > MAX_STORED_DECISION_ENTRIES) return null;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const candidate = value as Partial<StoredReviewDiskUndoSnapshotV6>;
      if (
        typeof candidate.beforeBlob !== 'string' ||
        !hasOwn(textBlobs, candidate.beforeBlob) ||
        (candidate.afterBlob !== null &&
          (typeof candidate.afterBlob !== 'string' || !hasOwn(textBlobs, candidate.afterBlob))) ||
        (candidate.fileRef !== undefined &&
          (typeof candidate.fileRef !== 'string' || !hasOwn(fileSummaryBlobs, candidate.fileRef)))
      ) {
        return null;
      }
      usedTextRefs.add(candidate.beforeBlob);
      if (candidate.afterBlob !== null) usedTextRefs.add(candidate.afterBlob);
      if (candidate.fileRef) usedFileRefs.add(candidate.fileRef);
      const { beforeBlob, afterBlob, fileRef, ...metadata } = candidate;
      return {
        ...metadata,
        beforeContent: textBlobs[beforeBlob],
        afterContent: afterBlob === null ? null : textBlobs[afterBlob],
        ...(fileRef ? { file: fileSummaryBlobs[fileRef] } : {}),
      } as ReviewDiskUndoSnapshot;
    };
    const decodeAction = (value: unknown): ReviewUndoAction | null => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const candidate = value as Partial<StoredReviewUndoActionV6>;
      if (candidate.kind === 'hunk') return candidate as ReviewUndoAction;
      if (candidate.kind === 'bulk') {
        if (!Array.isArray(candidate.diskSnapshots)) return null;
        const diskSnapshots = candidate.diskSnapshots.map(decodeSnapshot);
        if (diskSnapshots.some((snapshot) => !snapshot)) return null;
        return { ...candidate, diskSnapshots } as ReviewUndoAction;
      }
      if (candidate.kind !== 'disk' || !candidate.action || typeof candidate.action !== 'object') {
        return null;
      }
      const storedAction = candidate.action as Partial<StoredReviewDiskUndoActionV6>;
      const snapshot = decodeSnapshot(storedAction.snapshot);
      if (
        !snapshot ||
        (storedAction.fileRef !== undefined &&
          (typeof storedAction.fileRef !== 'string' ||
            !hasOwn(fileSummaryBlobs, storedAction.fileRef)))
      ) {
        return null;
      }
      if (storedAction.fileRef) usedFileRefs.add(storedAction.fileRef);
      const { fileRef, ...actionMetadata } = storedAction;
      return {
        ...candidate,
        action: {
          ...actionMetadata,
          snapshot,
          ...(fileRef ? { file: fileSummaryBlobs[fileRef] } : {}),
        },
      } as ReviewUndoAction;
    };
    const undo = data.reviewActionHistory.map(decodeAction);
    const redo = data.reviewRedoHistory.map((value): ReviewRedoAction | null => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const candidate = value as Partial<StoredReviewRedoActionV6>;
      const action = decodeAction(candidate.action);
      return action ? ({ ...candidate, action } as ReviewRedoAction) : null;
    });
    if (
      undo.some((action) => !action) ||
      redo.some((entry) => !entry) ||
      usedTextRefs.size !== textEntries.length ||
      usedFileRefs.size !== fileEntries.length
    ) {
      return null;
    }
    return { undo: undo as ReviewUndoAction[], redo: redo as ReviewRedoAction[] };
  }

  private getConflictCandidateIdentityPayload(
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
  }

  private parseConflictCandidate(
    value: unknown,
    scopeKey: string,
    sourceScopeHash: string,
    currentScopeHash: string
  ): ReviewDecisionConflictCandidate {
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
      !this.isDecisionRecord(candidate.hunkDecisions) ||
      !this.isDecisionRecord(candidate.fileDecisions) ||
      !this.isContextHashRecord(candidate.hunkContextHashesByFile)
    ) {
      throw new InvalidReviewDecisionDataError('Invalid review decision conflict candidate');
    }
    const decoded = this.decodeHistoryV6(candidate);
    if (
      !decoded ||
      !this.isReviewActionHistory(decoded.undo) ||
      !this.isReviewRedoHistory(decoded.redo) ||
      !this.hasDisjointReviewActionIds(decoded.undo, decoded.redo)
    ) {
      throw new InvalidReviewDecisionDataError(
        'Invalid review decision conflict candidate history'
      );
    }
    const identityPayload = this.getConflictCandidateIdentityPayload({
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
    this.assertValidSnapshot(state);
    return {
      id: candidate.id,
      capturedAt: candidate.capturedAt,
      origin: sourceScopeHash === currentScopeHash ? 'current-snapshot' : 'prior-snapshot',
      expectedRevision: candidate.expectedRevision!,
      observedCurrentRevision: candidate.observedCurrentRevision!,
      state,
    };
  }

  private async loadConflictCandidateFromPath(
    filePath: string,
    scopeKey: string,
    sourceScopeHash: string,
    currentScopeHash: string
  ): Promise<ReviewDecisionConflictCandidate> {
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
      const candidate = this.parseConflictCandidate(
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
  }

  private async assertConflictCandidateCapacity(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    protectedPath: string,
    replacementPath?: string
  ): Promise<void> {
    const dirPath = this.getConflictCandidateDir(teamName, scopeKey, scopeToken);
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
    if (!existing.includes(protectedPath) && existing.length >= MAX_RETAINED_CONFLICT_CANDIDATES) {
      throw new Error(
        `Too many unresolved review recovery copies (${MAX_RETAINED_CONFLICT_CANDIDATES}). Resolve one before saving another branch.`
      );
    }
    const logicalScopeCandidates = (await this.inspectConflictScopes(teamName, scopeKey))
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
  }

  private async writeConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    expectedRevision: number,
    observedCurrentRevision: number,
    state: ReviewPersistedStateSnapshot,
    replacementPath?: string
  ): Promise<void> {
    const encodedHistory = this.encodeHistoryV6(state.reviewActionHistory, state.reviewRedoHistory);
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
      .update(JSON.stringify(this.getConflictCandidateIdentityPayload(identityFields)))
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
    const filePath = this.getConflictCandidatePath(teamName, scopeKey, scopeToken, id);
    await this.ensureConflictCandidateDir(teamName, scopeKey, scopeToken);
    await this.assertConflictCandidateCapacity(
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
  }

  private parseStoredData(
    parsed: unknown
  ):
    | ReviewDecisionsData
    | ReviewDecisionsDataV2
    | ReviewDecisionsDataV3
    | ReviewDecisionsDataV4
    | ReviewDecisionsDataV5
    | ParsedReviewDecisionsDataV6
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
      textBlobs?: unknown;
      fileSummaryBlobs?: unknown;
    };
    const isExactScope =
      (data.version === 2 ||
        data.version === 3 ||
        data.version === 4 ||
        data.version === 5 ||
        data.version === 6) &&
      typeof data.scopeKey === 'string' &&
      typeof data.scopeToken === 'string';

    if (data.version !== undefined && !isExactScope) {
      return null;
    }

    if (data.version === 6) {
      const decoded = this.decodeHistoryV6(data);
      if (
        !decoded ||
        !this.isDecisionRecord(data.hunkDecisions) ||
        !this.isDecisionRecord(data.fileDecisions) ||
        !this.isContextHashRecord(data.hunkContextHashesByFile) ||
        !this.isReviewActionHistory(decoded.undo) ||
        !this.isReviewRedoHistory(decoded.redo) ||
        !this.hasDisjointReviewActionIds(decoded.undo, decoded.redo) ||
        !Number.isSafeInteger(data.revision) ||
        (data.revision as number) < 1 ||
        (data.lastMutationId !== undefined &&
          (typeof data.lastMutationId !== 'string' ||
            data.lastMutationId.length === 0 ||
            data.lastMutationId.length > 256))
      ) {
        return null;
      }
      return {
        ...(data as ReviewDecisionsData),
        version: 6,
        scopeKey: data.scopeKey as string,
        scopeToken: data.scopeToken!,
        reviewActionHistory: decoded.undo,
        reviewRedoHistory: decoded.redo,
        revision: data.revision as number,
        ...(typeof data.lastMutationId === 'string' ? { lastMutationId: data.lastMutationId } : {}),
      };
    }

    if (
      !this.isDecisionRecord(data.hunkDecisions) ||
      !this.isDecisionRecord(data.fileDecisions) ||
      !this.isContextHashRecord(data.hunkContextHashesByFile) ||
      ((data.version === 3 || data.version === 4 || data.version === 5) &&
        !this.isReviewActionHistory(data.reviewActionHistory)) ||
      (data.version === 5 && !this.isReviewRedoHistory(data.reviewRedoHistory)) ||
      (data.version === 5 &&
        !this.hasDisjointReviewActionIds(data.reviewActionHistory!, data.reviewRedoHistory!)) ||
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
      | ReviewDecisionsDataV5
      | ParsedReviewDecisionsDataV6;
  }

  private isReviewActionHistory(value: unknown): value is ReviewUndoAction[] {
    if (!Array.isArray(value) || value.length > MAX_STORED_REVIEW_ACTIONS) return false;
    const ids = new Set<string>();
    let diskSnapshotCount = 0;
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
        candidate.createdAt.length > 128 ||
        (candidate.descriptor !== undefined && !this.isReviewActionDescriptor(candidate.descriptor))
      ) {
        return false;
      }
      ids.add(candidate.id);
      if (candidate.kind === 'hunk') {
        return (
          this.isHunkUndoAction(candidate.action) &&
          this.isReviewActionDescriptorConsistent(candidate as ReviewUndoAction)
        );
      }
      if (candidate.kind === 'disk') {
        diskSnapshotCount++;
        return (
          diskSnapshotCount <= MAX_STORED_DECISION_ENTRIES &&
          this.isDiskUndoAction(candidate.action) &&
          this.isReviewActionDescriptorConsistent(candidate as ReviewUndoAction)
        );
      }
      if (candidate.kind === 'bulk') {
        if (!Array.isArray(candidate.diskSnapshots)) return false;
        diskSnapshotCount += candidate.diskSnapshots.length;
        return (
          diskSnapshotCount <= MAX_STORED_DECISION_ENTRIES &&
          this.isDecisionSnapshot(candidate.decisionSnapshot) &&
          candidate.diskSnapshots.every((snapshot) => this.isDiskUndoSnapshot(snapshot)) &&
          this.isReviewActionDescriptorConsistent(candidate as ReviewUndoAction)
        );
      }
      return false;
    });
  }

  private isReviewActionDescriptor(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as {
      intent?: unknown;
      filePath?: unknown;
      hunkIndex?: unknown;
      fileCount?: unknown;
    };
    const hasSafeFilePath =
      typeof candidate.filePath === 'string' &&
      candidate.filePath.length > 0 &&
      candidate.filePath.length <= MAX_STORED_KEY_LENGTH &&
      !candidate.filePath.includes('\0');
    const hasSafeHunkIndex =
      Number.isSafeInteger(candidate.hunkIndex) && Number(candidate.hunkIndex) >= 0;
    const hasSafeFileCount =
      Number.isSafeInteger(candidate.fileCount) &&
      Number(candidate.fileCount) > 0 &&
      Number(candidate.fileCount) <= MAX_STORED_DECISION_ENTRIES;

    switch (candidate.intent) {
      case 'accept-hunk':
      case 'reject-hunk':
        return hasSafeFilePath && hasSafeHunkIndex && candidate.fileCount === undefined;
      case 'accept-file':
      case 'reject-file':
      case 'restore-file':
      case 'restore-rename':
        return (
          hasSafeFilePath && candidate.hunkIndex === undefined && candidate.fileCount === undefined
        );
      case 'accept-all':
      case 'reject-all':
        return (
          candidate.filePath === undefined && candidate.hunkIndex === undefined && hasSafeFileCount
        );
      default:
        return false;
    }
  }

  private isReviewActionDescriptorConsistent(action: ReviewUndoAction): boolean {
    const descriptor = action.descriptor;
    if (!descriptor) return true;
    if (action.kind === 'hunk') {
      return (
        (descriptor.intent === 'accept-hunk' || descriptor.intent === 'reject-hunk') &&
        descriptor.filePath === action.action.filePath &&
        descriptor.hunkIndex === action.action.originalIndex
      );
    }
    if (action.kind === 'disk') {
      const { snapshot, originalIndex } = action.action;
      if (originalIndex !== undefined) {
        return (
          descriptor.intent === 'reject-hunk' &&
          descriptor.filePath === snapshot.filePath &&
          descriptor.hunkIndex === originalIndex
        );
      }
      return (
        (descriptor.intent === 'reject-file' ||
          descriptor.intent === 'restore-file' ||
          descriptor.intent === 'restore-rename') &&
        descriptor.filePath === snapshot.filePath
      );
    }
    if (action.diskSnapshots.length > 0) {
      return (
        descriptor.intent === 'reject-all' && descriptor.fileCount === action.diskSnapshots.length
      );
    }
    return descriptor.intent === 'accept-all' || descriptor.intent === 'accept-file';
  }

  private isReviewRedoHistory(value: unknown): value is ReviewRedoAction[] {
    if (!Array.isArray(value) || value.length > MAX_STORED_REVIEW_ACTIONS) return false;
    const ids = new Set<string>();
    let diskSnapshotCount = 0;
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
      diskSnapshotCount +=
        candidate.action.kind === 'bulk'
          ? candidate.action.diskSnapshots.length
          : candidate.action.kind === 'disk'
            ? 1
            : 0;
      if (diskSnapshotCount > MAX_STORED_DECISION_ENTRIES) return false;
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

  private getDiskBackedHistory(snapshot: {
    reviewActionHistory: readonly ReviewUndoAction[];
    reviewRedoHistory: readonly ReviewRedoAction[];
  }): object[] {
    const hasDiskEffect = (action: ReviewUndoAction): boolean =>
      action.kind === 'disk' || (action.kind === 'bulk' && action.diskSnapshots.length > 0);
    return [
      ...snapshot.reviewActionHistory
        .filter(hasDiskEffect)
        .map((action) => ({ stack: 'undo', action })),
      ...snapshot.reviewRedoHistory
        .filter((entry) => hasDiskEffect(entry.action))
        .map((entry) => ({ stack: 'redo', entry })),
    ];
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
      authoritativeBeforeSha256?: unknown;
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
      (candidate.authoritativeBeforeSha256 === undefined ||
        candidate.authoritativeBeforeSha256 === null ||
        (typeof candidate.authoritativeBeforeSha256 === 'string' &&
          /^[a-f0-9]{64}$/.test(candidate.authoritativeBeforeSha256))) &&
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
      | ReviewDecisionsDataV5
      | ParsedReviewDecisionsDataV6,
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
      'version' in data &&
      (data.version === 3 || data.version === 4 || data.version === 5 || data.version === 6)
        ? data.reviewActionHistory
        : [];
    const reviewRedoHistory =
      'version' in data && (data.version === 5 || data.version === 6) ? data.reviewRedoHistory : [];
    return {
      hunkDecisions,
      fileDecisions,
      hunkContextHashesByFile,
      reviewActionHistory,
      reviewRedoHistory,
      storageVersion: 'version' in data ? data.version : 1,
      revision:
        'version' in data && (data.version === 4 || data.version === 5 || data.version === 6)
          ? data.revision
          : 0,
      ...('version' in data &&
      (data.version === 4 || data.version === 5 || data.version === 6) &&
      data.lastMutationId
        ? { lastMutationId: data.lastMutationId }
        : {}),
    };
  }

  private async loadFromPath(
    filePath: string,
    scopeToken?: string,
    expectedScopeKey?: string
  ): Promise<InternalLoadedReviewDecisions | null> {
    if (
      !(await assertConstrainedPersistenceDirectory(getTeamsBasePath(), path.dirname(filePath)))
    ) {
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
      (data.version === 2 ||
        data.version === 3 ||
        data.version === 4 ||
        data.version === 5 ||
        data.version === 6) &&
      data.scopeKey !== expectedScopeKey
    ) {
      throw new InvalidReviewDecisionDataError(`Mismatched review decision scope at ${filePath}`);
    }
    return this.extractDecisions(data, scopeToken);
  }

  private async getPendingMutationScopeHashes(
    teamName: string,
    scopeKey: string
  ): Promise<Set<string>> {
    const journalScopeDir = path.join(
      getTeamsBasePath(),
      teamName,
      'review-decisions',
      'mutation-journal',
      scopeKey
    );
    if (!(await assertConstrainedPersistenceDirectory(getTeamsBasePath(), journalScopeDir))) {
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
  }

  private async pruneScopeDir(
    teamName: string,
    scopeKey: string,
    protectedPath: string
  ): Promise<void> {
    const dirPath = this.getV2DirPath(teamName, scopeKey);
    await ensureConstrainedPersistenceDirectory(getTeamsBasePath(), dirPath);
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
      this.getPendingMutationScopeHashes(teamName, scopeKey),
      this.inspectConflictScopes(teamName, scopeKey),
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
    const unprotectedRetention = Math.max(0, MAX_RETAINED_DECISION_SCOPES - protectedExistingCount);
    const staleFiles = existingFiles
      .filter((entry) => !protectedPaths.has(entry.filePath))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath))
      .slice(unprotectedRetention);

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
    const {
      lastMutationId: _lastMutationId,
      storageVersion: _storageVersion,
      ...publicSnapshot
    } = loaded;
    return publicSnapshot;
  }

  private async mapConflictCandidates<T extends { id: string; capturedAt: string }>(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    mapCandidate: (candidate: ReviewDecisionConflictCandidate) => T
  ): Promise<T[]> {
    this.assertSafeScope(teamName, scopeKey, scopeToken);
    const currentScopeHash = createHash('sha256').update(scopeToken).digest('hex');
    const conflictScopes = await this.inspectConflictScopes(teamName, scopeKey);
    const currentRevision =
      (await this.loadInternal(teamName, scopeKey, scopeToken))?.revision ?? 0;
    const candidates: T[] = [];
    let quarantinedCount = 0;
    for (const sourceScopeHash of [...conflictScopes.scopeHashes].sort()) {
      const dirPath = this.getConflictCandidateDirByScopeHash(teamName, scopeKey, sourceScopeHash);
      const entries = await fs.promises.readdir(dirPath);
      for (const entry of entries.filter((name) => EXACT_SCOPE_FILE_PATTERN.test(name))) {
        const candidatePath = path.join(dirPath, entry);
        try {
          const candidate = await this.loadConflictCandidateFromPath(
            candidatePath,
            scopeKey,
            sourceScopeHash,
            currentScopeHash
          );
          candidates.push(mapCandidate({ ...candidate, observedCurrentRevision: currentRevision }));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          if (!shouldQuarantineDecisionConflictCandidate(error)) throw error;
          try {
            await quarantineConstrainedPersistenceFile(
              getTeamsBasePath(),
              candidatePath,
              path.join(dirPath, 'quarantine')
            );
          } catch (quarantineError) {
            if ((quarantineError as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw quarantineError;
          }
          quarantinedCount += 1;
          logger.warn(`Quarantined unreadable review recovery copy: ${String(error)}`);
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
  }

  async loadConflictCandidates(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<ReviewDecisionConflictCandidate[]> {
    return this.mapConflictCandidates(teamName, scopeKey, scopeToken, (candidate) => candidate);
  }

  async loadConflictCandidateSummaries(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<ReviewDecisionConflictCandidateSummary[]> {
    return this.mapConflictCandidates(teamName, scopeKey, scopeToken, (candidate) => ({
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
  }

  private async locateConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string
  ): Promise<{ candidatePath: string; candidate: ReviewDecisionConflictCandidate }> {
    if (!EXACT_SCOPE_HASH_PATTERN.test(candidateId)) {
      throw new Error('Invalid review decision conflict candidate id');
    }
    const currentScopeHash = createHash('sha256').update(scopeToken).digest('hex');
    const conflictScopes = await this.inspectConflictScopes(teamName, scopeKey);
    let located: { candidatePath: string; candidate: ReviewDecisionConflictCandidate } | null =
      null;
    for (const sourceScopeHash of conflictScopes.scopeHashes) {
      const candidatePath = path.join(
        this.getConflictCandidateDirByScopeHash(teamName, scopeKey, sourceScopeHash),
        `${candidateId}.json`
      );
      try {
        const candidate = await this.loadConflictCandidateFromPath(
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
  }

  async loadConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string
  ): Promise<ReviewDecisionConflictCandidate> {
    this.assertSafeScope(teamName, scopeKey, scopeToken);
    const { candidate } = await this.locateConflictCandidate(
      teamName,
      scopeKey,
      scopeToken,
      candidateId
    );
    const observedCurrentRevision =
      (await this.loadInternal(teamName, scopeKey, scopeToken))?.revision ?? 0;
    return { ...candidate, observedCurrentRevision };
  }

  async resolveConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string,
    resolution: ReviewConflictResolution,
    expectedCurrentRevision: number
  ): Promise<number> {
    this.assertSafeScope(teamName, scopeKey, scopeToken);
    if (
      (resolution !== 'recover-candidate' && resolution !== 'keep-current') ||
      !Number.isSafeInteger(expectedCurrentRevision) ||
      expectedCurrentRevision < 0
    ) {
      throw new Error('Invalid review decision conflict resolution');
    }
    const { candidatePath, candidate } = await this.locateConflictCandidate(
      teamName,
      scopeKey,
      scopeToken,
      candidateId
    );
    const current = await this.loadInternal(teamName, scopeKey, scopeToken);
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
        this.getDiskBackedHistory(candidate.state),
        this.getDiskBackedHistory(currentSnapshot)
      )
    ) {
      throw new Error(
        'Recovery branches contain different disk-backed history; refusing unsafe replacement'
      );
    }
    // Recover is an explicit branch swap, not a destructive overwrite. Publish the
    // current canonical branch first so a crash or a mistaken choice remains reversible.
    await this.writeConflictCandidate(
      teamName,
      scopeKey,
      scopeToken,
      currentRevision,
      currentRevision + 1,
      currentSnapshot,
      candidatePath
    );
    const revision = await this.save(teamName, scopeKey, {
      scopeToken,
      ...candidate.state,
      expectedRevision: currentRevision,
    });
    await unlinkPathDurably(candidatePath);
    return revision;
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
          await this.writeConflictCandidate(
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
      const compactedHistory = this.encodeHistoryV6(
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
      const filePath = this.getV2FilePath(teamName, scopeKey, data.scopeToken);
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
      await this.pruneScopeDir(teamName, scopeKey, filePath);
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
        const exactPath = this.getV2FilePath(teamName, scopeKey, scopeToken);
        if (
          await assertConstrainedPersistenceDirectory(getTeamsBasePath(), path.dirname(exactPath))
        ) {
          await unlinkPathDurably(exactPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
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
      if (
        await assertConstrainedPersistenceDirectory(
          getTeamsBasePath(),
          this.getLegacyDirPath(teamName)
        )
      ) {
        await fs.promises.unlink(this.getLegacyFilePath(teamName, scopeKey)).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      }
      if (
        await assertConstrainedPersistenceDirectory(
          getTeamsBasePath(),
          this.getV2DirPath(teamName, scopeKey)
        )
      ) {
        await fs.promises.rm(this.getV2DirPath(teamName, scopeKey), {
          recursive: true,
          force: true,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error(
          `Failed to clear review decisions for ${teamName}/${scopeKey}: ${String(error)}`
        );
        throw error;
      }
    }
  }

  async clearUnreadableExactScope(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<void> {
    this.assertSafeScope(teamName, scopeKey, scopeToken);
    const exactPath = this.getV2FilePath(teamName, scopeKey, scopeToken);
    const legacyPath = this.getLegacyFilePath(teamName, scopeKey);
    let exactUnreadable = false;
    let legacyUnreadable = false;
    let exact: InternalLoadedReviewDecisions | null = null;
    let legacy: InternalLoadedReviewDecisions | null = null;

    try {
      exact = await this.loadFromPath(exactPath, scopeToken, scopeKey);
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
      legacy = await this.loadFromPath(legacyPath, scopeToken, scopeKey);
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
  }
}
