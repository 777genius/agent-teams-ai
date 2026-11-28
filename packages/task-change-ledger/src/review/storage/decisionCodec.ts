import { createHash } from 'crypto';
import type {
  FileChangeSummary,
  HunkDecision,
  ReviewDiskUndoSnapshot,
  ReviewRedoAction,
  ReviewUndoAction,
} from '../../contracts.js';
import {
  MAX_STORED_DECISION_ENTRIES,
  MAX_STORED_REVIEW_ACTIONS,
  type ReviewDecisionsData,
  type ReviewDecisionsDataV2,
  type ReviewDecisionsDataV3,
  type ReviewDecisionsDataV4,
  type ReviewDecisionsDataV5,
  type StoredReviewDiskUndoSnapshotV6,
  type StoredReviewDiskUndoActionV6,
  type StoredReviewUndoActionV6,
  type StoredReviewRedoActionV6,
  type StoredReviewDecisionsDataV6,
  type ParsedReviewDecisionsDataV6,
  type InternalLoadedReviewDecisions,
  type DecisionContext,
} from './DecisionTypes.js';

export function createDecisionCodec(getContext: () => DecisionContext) {
  return {
    hashHistoryBlob(kind: 'text' | 'file-summary', value: string): string {
      return createHash('sha256').update(kind).update('\0').update(value).digest('hex');
    },
    encodeHistoryV6(
      undoHistory: readonly ReviewUndoAction[],
      redoHistory: readonly ReviewRedoAction[]
    ): Pick<
      StoredReviewDecisionsDataV6,
      'reviewActionHistory' | 'reviewRedoHistory' | 'textBlobs' | 'fileSummaryBlobs'
    > {
      const ctx = getContext();
      const textBlobs: Record<string, string> = {};
      const fileSummaryBlobs: Record<string, FileChangeSummary> = {};
      const addText = (content: string): string => {
        const ref = ctx.hashHistoryBlob('text', content);
        const existing = textBlobs[ref];
        if (existing !== undefined && existing !== content) {
          throw new Error('Review history content hash collision');
        }
        textBlobs[ref] = content;
        return ref;
      };
      const addFileSummary = (file: FileChangeSummary): string => {
        const serialized = JSON.stringify(file);
        const ref = ctx.hashHistoryBlob('file-summary', serialized);
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
    },
    decodeHistoryV6(data: {
      reviewActionHistory?: unknown;
      reviewRedoHistory?: unknown;
      textBlobs?: unknown;
      fileSummaryBlobs?: unknown;
    }): { undo: ReviewUndoAction[]; redo: ReviewRedoAction[] } | null {
      const ctx = getContext();
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
            ctx.hashHistoryBlob('text', content) !== ref
        ) ||
        fileEntries.some(([ref, file]) => {
          if (!/^[a-f0-9]{64}$/.test(ref) || !ctx.isFileSummary(file)) return true;
          try {
            return ctx.hashHistoryBlob('file-summary', JSON.stringify(file)) !== ref;
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
        if (
          candidate.kind !== 'disk' ||
          !candidate.action ||
          typeof candidate.action !== 'object'
        ) {
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
    },
    parseStoredData(
      parsed: unknown
    ):
      | ReviewDecisionsData
      | ReviewDecisionsDataV2
      | ReviewDecisionsDataV3
      | ReviewDecisionsDataV4
      | ReviewDecisionsDataV5
      | ParsedReviewDecisionsDataV6
      | null {
      const ctx = getContext();
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
        const decoded = ctx.decodeHistoryV6(data);
        if (
          !decoded ||
          !ctx.isDecisionRecord(data.hunkDecisions) ||
          !ctx.isDecisionRecord(data.fileDecisions) ||
          !ctx.isContextHashRecord(data.hunkContextHashesByFile) ||
          !ctx.isReviewActionHistory(decoded.undo) ||
          !ctx.isReviewRedoHistory(decoded.redo) ||
          !ctx.hasDisjointReviewActionIds(decoded.undo, decoded.redo) ||
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
          ...(typeof data.lastMutationId === 'string'
            ? { lastMutationId: data.lastMutationId }
            : {}),
        };
      }

      if (
        !ctx.isDecisionRecord(data.hunkDecisions) ||
        !ctx.isDecisionRecord(data.fileDecisions) ||
        !ctx.isContextHashRecord(data.hunkContextHashesByFile) ||
        ((data.version === 3 || data.version === 4 || data.version === 5) &&
          !ctx.isReviewActionHistory(data.reviewActionHistory)) ||
        (data.version === 5 && !ctx.isReviewRedoHistory(data.reviewRedoHistory)) ||
        (data.version === 5 &&
          !ctx.hasDisjointReviewActionIds(data.reviewActionHistory!, data.reviewRedoHistory!)) ||
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
    },
    extractDecisions(
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
        'version' in data && (data.version === 5 || data.version === 6)
          ? data.reviewRedoHistory
          : [];
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
    },
  };
}
