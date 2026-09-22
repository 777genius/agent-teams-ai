import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { ReviewDraftHistoryWriteBuffer } from '@features/change-review-history/renderer';
import { normalizePathForComparison } from '@shared/utils/platformPath';

import type {
  ChangeReviewDraftHistoryPort,
  ChangeReviewDraftHistoryScope,
} from '../ports/changeReviewDraftHistoryPort';
import type { ReviewDraftHistoryHydrationState } from '../utils/changeReviewScope';
import type { ReviewOperationScopeToken } from '../utils/reviewOperationGeneration';
import type { ReviewDraftHistoryConflictCandidateSummary } from '@features/change-review-history/contracts';
import type {
  ReviewDraftHistoryEntry,
  ReviewSerializedEditorState,
} from '@features/change-review-history/contracts';
import type { ReviewChangeSetLike } from '@renderer/utils/reviewDecisionScope';
import type { ReviewConflictResolution, ReviewFileScope } from '@shared/types';

interface PendingDraftHistoryWrite {
  hydrationKey: string;
  scope: ChangeReviewDraftHistoryScope;
  entry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>;
}

interface DraftHistoryVersion {
  revision: number;
  generation: string;
}

interface HydratedDraftState {
  scopeFilePaths: string[];
  recoveredDrafts: Record<string, string>;
  externalChanges: Record<string, { type: 'change' }>;
  errorMessage?: string;
}

interface UseChangeReviewDraftHistoryControllerInput {
  open: boolean;
  changeSetEpoch: number;
  scopeKey: string;
  teamName: string;
  activeChangeSet: ReviewChangeSetLike | null | undefined;
  decisionScopeKey: string;
  decisionScopeToken: string | null;
  decisionHydrationKey: string | null;
  draftHistoryHydrationReady: boolean;
  reviewScope: ReviewFileScope;
  draftHistoryConflictCandidates: readonly ReviewDraftHistoryConflictCandidateSummary[];
  setHydration: (state: ReviewDraftHistoryHydrationState) => void;
  isExpectedHydrationKey: (hydrationKey: string) => boolean;
  refreshConflictCandidates: () => Promise<void>;
  captureOperationScope: () => ReviewOperationScopeToken | null;
  isCurrentOperationScope: (
    operationScope: ReviewOperationScopeToken | null
  ) => operationScope is ReviewOperationScopeToken;
  commitHydratedDrafts: (state: HydratedDraftState) => void;
  reportError: (message: string | null) => void;
  port: ChangeReviewDraftHistoryPort;
}

export interface ChangeReviewDraftHistoryDiagnostics {
  pendingWriteCount: number;
  writeChainCount: number;
  writeErrorCount: number;
}

export interface ChangeReviewDraftHistoryController {
  entries: Record<string, ReviewDraftHistoryEntry>;
  getEntry: (filePath: string) => ReviewDraftHistoryEntry | undefined;
  hasBaseline: (filePath: string) => boolean;
  getBaseline: (filePath: string) => string | null | undefined;
  setBaseline: (filePath: string, baseline: string | null) => void;
  deleteBaseline: (filePath: string) => void;
  unsuppressFile: (filePath: string) => void;
  publishCheckpoint: (
    filePath: string,
    editorState: ReviewSerializedEditorState,
    diskBaseline: string | null
  ) => void;
  handleSerializedStateChanged: (
    filePath: string,
    editorState: ReviewSerializedEditorState
  ) => void;
  handleSerializedStateRestoreError: (filePath: string, error: unknown) => void;
  flushWrites: () => Promise<boolean>;
  clearFile: (filePath: string) => Promise<void>;
  resolveConflictCandidate: (
    candidate: ReviewDraftHistoryConflictCandidateSummary,
    resolution: ReviewConflictResolution,
    operationScope: ReviewOperationScopeToken
  ) => Promise<boolean>;
  retryHydration: () => void;
  discardUnreadableScope: (operationScope: ReviewOperationScopeToken) => Promise<boolean>;
  getDiagnostics: (hydrationKey?: string | null) => ChangeReviewDraftHistoryDiagnostics;
}

export function useChangeReviewDraftHistoryController({
  open,
  changeSetEpoch,
  scopeKey,
  teamName,
  activeChangeSet,
  decisionScopeKey,
  decisionScopeToken,
  decisionHydrationKey,
  draftHistoryHydrationReady,
  reviewScope,
  draftHistoryConflictCandidates,
  setHydration,
  isExpectedHydrationKey,
  refreshConflictCandidates,
  captureOperationScope,
  isCurrentOperationScope,
  commitHydratedDrafts,
  reportError,
  port,
}: UseChangeReviewDraftHistoryControllerInput): ChangeReviewDraftHistoryController {
  const [entries, setEntries] = useState<Record<string, ReviewDraftHistoryEntry>>({});
  const [retryNonce, setRetryNonce] = useState(0);
  const [promotionNonce, setPromotionNonce] = useState(0);
  const entriesRef = useRef<Record<string, ReviewDraftHistoryEntry>>({});
  const baselinesRef = useRef(new Map<string, string | null>());
  const writeChainsRef = useRef(new Map<string, Promise<void>>());
  const promotionChainsRef = useRef(new Map<string, Promise<void>>());
  const writeBufferRef = useRef(new ReviewDraftHistoryWriteBuffer<PendingDraftHistoryWrite>());
  const writeErrorsRef = useRef(new Map<string, unknown>());
  const persistedVersionsRef = useRef(new Map<string, DraftHistoryVersion>());
  const suppressedFilesRef = useRef(new Set<string>());
  const stableReviewScope = useMemo(
    () => ({
      teamName: reviewScope.teamName,
      taskId: reviewScope.taskId,
      memberName: reviewScope.memberName,
    }),
    [reviewScope.memberName, reviewScope.taskId, reviewScope.teamName]
  );
  const persistenceScope = useMemo(
    () =>
      decisionScopeToken
        ? { teamName, scopeKey: decisionScopeKey, scopeToken: decisionScopeToken }
        : null,
    [decisionScopeKey, decisionScopeToken, teamName]
  );

  const replaceEntries = useCallback((next: Record<string, ReviewDraftHistoryEntry>): void => {
    entriesRef.current = next;
    setEntries(next);
  }, []);

  const startDrain = useCallback(
    (writeKey: string): Promise<void> => {
      const active = writeChainsRef.current.get(writeKey);
      if (active) return active;

      const drain = (async () => {
        while (true) {
          const pending = writeBufferRef.current.takeNext(writeKey);
          if (!pending) return;
          try {
            const expectedVersion = persistedVersionsRef.current.get(writeKey);
            const saved = await port.saveEntry({
              scope: pending.scope,
              entry: pending.entry,
              expectedVersion: {
                revision: expectedVersion?.revision ?? 0,
                generation: expectedVersion?.generation ?? null,
              },
            });
            persistedVersionsRef.current.set(writeKey, {
              revision: saved.revision,
              generation: saved.generation,
            });
            writeErrorsRef.current.delete(writeKey);
            const current = entriesRef.current[pending.entry.filePath];
            if (
              isExpectedHydrationKey(pending.hydrationKey) &&
              current?.revision === saved.revision
            ) {
              replaceEntries({ ...entriesRef.current, [pending.entry.filePath]: saved });
            }
          } catch (error) {
            writeBufferRef.current.markFailed(writeKey, pending);
            writeErrorsRef.current.set(writeKey, error);
            setPromotionNonce((nonce) => nonce + 1);
            if (isExpectedHydrationKey(pending.hydrationKey)) {
              reportError('Unable to save manual edit history. Retry Save or keep Changes open.');
              void refreshConflictCandidates();
            }
            throw error;
          }
        }
      })();
      writeChainsRef.current.set(writeKey, drain);
      void drain
        .catch(() => undefined)
        .finally(() => {
          if (writeChainsRef.current.get(writeKey) === drain) {
            writeChainsRef.current.delete(writeKey);
          }
        });
      return drain;
    },
    [isExpectedHydrationKey, port, refreshConflictCandidates, replaceEntries, reportError]
  );

  const enqueueWrite = useCallback(
    (entry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>): void => {
      if (!decisionHydrationKey || !persistenceScope) return;
      const writeKey = `${decisionHydrationKey}\0${entry.filePath}`;
      writeBufferRef.current.enqueue(writeKey, {
        hydrationKey: decisionHydrationKey,
        scope: persistenceScope,
        entry,
      });
      if (writeBufferRef.current.peekFailed(writeKey)) {
        setPromotionNonce((nonce) => nonce + 1);
      }
      void startDrain(writeKey);
    },
    [decisionHydrationKey, persistenceScope, startDrain]
  );

  useLayoutEffect(() => {
    suppressedFilesRef.current.clear();
  }, [changeSetEpoch, decisionHydrationKey, open, scopeKey, teamName]);

  useEffect(() => {
    baselinesRef.current.clear();
    replaceEntries({});
    setHydration({ key: null, status: 'idle' });
  }, [changeSetEpoch, replaceEntries, scopeKey, setHydration, teamName]);

  useEffect(() => {
    if (!open || !decisionHydrationKey || !persistenceScope || !activeChangeSet) {
      if (!decisionHydrationKey) setHydration({ key: null, status: 'idle' });
      return;
    }
    let cancelled = false;
    const hydrationKey = decisionHydrationKey;
    setHydration({ key: hydrationKey, status: 'loading' });

    void (async () => {
      try {
        const snapshot = await port.load(persistenceScope);
        if (cancelled || !isExpectedHydrationKey(hydrationKey)) return;
        const writeKeyPrefix = `${hydrationKey}\0`;
        for (const writeKey of persistedVersionsRef.current.keys()) {
          if (writeKey.startsWith(writeKeyPrefix)) persistedVersionsRef.current.delete(writeKey);
        }

        const allowedFiles = new Map(
          activeChangeSet.files.map((file) => [normalizePathForComparison(file.filePath), file])
        );
        const recoveredEntries: Record<string, ReviewDraftHistoryEntry> = {};
        const recoveredDrafts: Record<string, string> = {};
        const externalChanges: Record<string, { type: 'change' }> = {};

        for (const entry of Object.values(snapshot?.entries ?? {})) {
          const file = allowedFiles.get(normalizePathForComparison(entry.filePath));
          if (file?.filePath !== entry.filePath) continue;
          const baselineKey = normalizePathForComparison(file.filePath);
          const conflict = await port.checkConflict({
            reviewScope: stableReviewScope,
            filePath: file.filePath,
            expectedModified: entry.diskBaseline ?? '',
          });
          if (cancelled || !isExpectedHydrationKey(hydrationKey)) return;
          const diskMatchesBaseline =
            entry.diskBaseline === null
              ? conflict.hasConflict && conflict.conflictContent === null
              : !conflict.hasConflict;

          recoveredEntries[file.filePath] = entry;
          persistedVersionsRef.current.set(`${hydrationKey}\0${file.filePath}`, {
            revision: entry.revision,
            generation: entry.generation,
          });
          baselinesRef.current.set(baselineKey, entry.diskBaseline);
          if (!diskMatchesBaseline || entry.editorState.doc !== entry.diskBaseline) {
            recoveredDrafts[file.filePath] = entry.editorState.doc;
          }
          if (!diskMatchesBaseline) externalChanges[file.filePath] = { type: 'change' };
        }

        replaceEntries(recoveredEntries);
        commitHydratedDrafts({
          scopeFilePaths: [...allowedFiles.keys()],
          recoveredDrafts,
          externalChanges,
          ...(Object.keys(externalChanges).length > 0
            ? {
                errorMessage:
                  'Recovered manual edits are based on files that changed on disk. Review each conflict before saving.',
              }
            : {}),
        });
        setHydration({ key: hydrationKey, status: 'loaded' });
      } catch (error) {
        if (cancelled || !isExpectedHydrationKey(hydrationKey)) return;
        setHydration({ key: hydrationKey, status: 'error' });
        reportError(`Unable to load saved manual edit history: ${String(error)}`);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeChangeSet,
    changeSetEpoch,
    commitHydratedDrafts,
    decisionHydrationKey,
    isExpectedHydrationKey,
    open,
    persistenceScope,
    port,
    replaceEntries,
    reportError,
    retryNonce,
    stableReviewScope,
    setHydration,
  ]);

  useEffect(() => {
    if (!decisionHydrationKey || !persistenceScope) return;
    const hydrationKey = decisionHydrationKey;
    for (const candidate of draftHistoryConflictCandidates) {
      const writeKey = `${hydrationKey}\0${candidate.filePath}`;
      if (promotionChainsRef.current.has(writeKey)) continue;
      const failed = writeBufferRef.current.peekFailed(writeKey);
      const pending = writeBufferRef.current.peekPending(writeKey);
      if (!failed || !pending || failed.hydrationKey !== hydrationKey) continue;
      const promotion = (async () => {
        try {
          await port.replaceConflictCandidate({
            scope: persistenceScope,
            expectedEntry: failed.entry,
            replacementEntry: pending.entry,
            observedVersion: {
              revision: candidate.observedCurrentRevision,
              generation: candidate.observedCurrentGeneration,
            },
          });
          if (!isExpectedHydrationKey(hydrationKey)) return;
          writeBufferRef.current.promotePendingToFailed(writeKey, failed, pending);
          await refreshConflictCandidates();
        } catch (error) {
          if (!isExpectedHydrationKey(hydrationKey)) return;
          reportError(`Unable to preserve the latest manual edit recovery copy: ${String(error)}`);
          await refreshConflictCandidates();
        }
      })();
      promotionChainsRef.current.set(writeKey, promotion);
      void promotion.finally(() => {
        if (promotionChainsRef.current.get(writeKey) === promotion) {
          promotionChainsRef.current.delete(writeKey);
        }
        if (
          isExpectedHydrationKey(hydrationKey) &&
          writeBufferRef.current.peekFailed(writeKey) &&
          writeBufferRef.current.peekPending(writeKey)
        ) {
          setPromotionNonce((nonce) => nonce + 1);
        }
      });
    }
  }, [
    decisionHydrationKey,
    draftHistoryConflictCandidates,
    isExpectedHydrationKey,
    persistenceScope,
    port,
    promotionNonce,
    refreshConflictCandidates,
    reportError,
  ]);

  const flushWrites = useCallback(async (): Promise<boolean> => {
    if (!decisionHydrationKey) return true;
    const prefix = `${decisionHydrationKey}\0`;
    for (const key of writeBufferRef.current.keys(prefix)) void startDrain(key);
    while (true) {
      const writes = [...writeChainsRef.current.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, write]) => write);
      if (writes.length === 0) break;
      await Promise.allSettled(writes);
    }
    return (
      !writeBufferRef.current.hasPendingWithPrefix(prefix) &&
      !writeBufferRef.current.hasFailedWithPrefix(prefix) &&
      ![...writeErrorsRef.current.keys()].some((key) => key.startsWith(prefix))
    );
  }, [decisionHydrationKey, startDrain]);

  const clearFile = useCallback(
    (filePath: string): Promise<void> => {
      const operationScope = captureOperationScope();
      if (!operationScope) {
        return Promise.reject(new Error('Review scope changed before Undo history could clear.'));
      }
      const normalizedPath = normalizePathForComparison(filePath);
      suppressedFilesRef.current.add(normalizedPath);
      if (!decisionHydrationKey || !persistenceScope) {
        if (isCurrentOperationScope(operationScope))
          suppressedFilesRef.current.delete(normalizedPath);
        return Promise.reject(
          new Error('Durable review scope is unavailable; refusing to discard Undo history.')
        );
      }

      const writeKey = `${decisionHydrationKey}\0${filePath}`;
      const previous = startDrain(writeKey);
      let clearedVersion: DraftHistoryVersion | undefined;
      const clear = previous
        .then(() => {
          if (!isCurrentOperationScope(operationScope)) {
            throw new Error('Review scope changed before Undo history could clear.');
          }
          clearedVersion = persistedVersionsRef.current.get(writeKey);
          return port.clear({
            scope: persistenceScope,
            filePath,
            expectedVersion: {
              revision: clearedVersion?.revision ?? 0,
              generation: clearedVersion?.generation ?? null,
            },
          });
        })
        .then(() => {
          if (!isCurrentOperationScope(operationScope)) return;
          const next = { ...entriesRef.current };
          const current = next[filePath];
          if (!current || current.revision <= (clearedVersion?.revision ?? 0))
            delete next[filePath];
          replaceEntries(next);
          persistedVersionsRef.current.delete(writeKey);
          writeErrorsRef.current.delete(writeKey);
        });
      writeChainsRef.current.set(writeKey, clear);
      void clear
        .catch((error) => {
          if (!isCurrentOperationScope(operationScope)) return;
          suppressedFilesRef.current.delete(normalizedPath);
          writeErrorsRef.current.set(writeKey, error);
          if (isExpectedHydrationKey(decisionHydrationKey)) {
            reportError(`Unable to discard saved manual edit history: ${String(error)}`);
          }
        })
        .finally(() => {
          if (writeChainsRef.current.get(writeKey) === clear)
            writeChainsRef.current.delete(writeKey);
          if (
            isCurrentOperationScope(operationScope) &&
            writeBufferRef.current.hasPending(writeKey)
          ) {
            void startDrain(writeKey);
          }
        });
      return clear;
    },
    [
      captureOperationScope,
      decisionHydrationKey,
      isCurrentOperationScope,
      isExpectedHydrationKey,
      persistenceScope,
      port,
      replaceEntries,
      reportError,
      startDrain,
    ]
  );

  const publishCheckpoint = useCallback(
    (
      filePath: string,
      editorState: ReviewSerializedEditorState,
      diskBaseline: string | null
    ): void => {
      if (!decisionHydrationKey || !draftHistoryHydrationReady) return;
      const current = entriesRef.current[filePath];
      if (
        current?.diskBaseline === diskBaseline &&
        JSON.stringify(current.editorState) === JSON.stringify(editorState)
      ) {
        return;
      }
      const entry: ReviewDraftHistoryEntry = {
        filePath,
        codec: 'codemirror-history-v1',
        revision: (current?.revision ?? 0) + 1,
        generation: current?.generation ?? 'pending',
        diskBaseline,
        editorState,
        updatedAt: new Date().toISOString(),
      };
      replaceEntries({ ...entriesRef.current, [filePath]: entry });
      enqueueWrite({
        filePath,
        codec: entry.codec,
        revision: entry.revision,
        diskBaseline,
        editorState,
      });
    },
    [decisionHydrationKey, draftHistoryHydrationReady, enqueueWrite, replaceEntries]
  );

  const handleSerializedStateChanged = useCallback(
    (filePath: string, editorState: ReviewSerializedEditorState): void => {
      const baselineKey = normalizePathForComparison(filePath);
      if (suppressedFilesRef.current.has(baselineKey)) return;
      const existing = entriesRef.current[filePath];
      if (!baselinesRef.current.has(baselineKey)) {
        if (!existing) return;
        baselinesRef.current.set(baselineKey, existing.diskBaseline);
      }
      publishCheckpoint(filePath, editorState, baselinesRef.current.get(baselineKey) ?? null);
    },
    [publishCheckpoint]
  );

  const handleSerializedStateRestoreError = useCallback(
    (filePath: string, error: unknown): void => {
      reportError(
        `Saved manual edit history for ${filePath} is incompatible and was not applied: ${String(error)}`
      );
    },
    [reportError]
  );

  const resolveConflictCandidate = useCallback(
    async (
      candidate: ReviewDraftHistoryConflictCandidateSummary,
      resolution: ReviewConflictResolution,
      operationScope: ReviewOperationScopeToken
    ): Promise<boolean> => {
      if (!decisionHydrationKey || !persistenceScope) return false;
      const hydrationKey = decisionHydrationKey;
      const writeKey = `${hydrationKey}\0${candidate.filePath}`;
      await writeChainsRef.current.get(writeKey)?.catch(() => undefined);
      if (!isCurrentOperationScope(operationScope) || !isExpectedHydrationKey(hydrationKey)) {
        return false;
      }
      const resolved = await port.resolveConflictCandidate({
        scope: persistenceScope,
        candidateId: candidate.id,
        resolution,
        observedVersion: {
          revision: candidate.observedCurrentRevision,
          generation: candidate.observedCurrentGeneration,
        },
      });
      if (!isCurrentOperationScope(operationScope) || !isExpectedHydrationKey(hydrationKey)) {
        return false;
      }
      const pendingDescendant = writeBufferRef.current.resolveConflict(
        writeKey,
        resolution === 'recover-candidate'
      );
      writeErrorsRef.current.delete(writeKey);
      if (resolved) {
        persistedVersionsRef.current.set(writeKey, {
          revision: resolved.revision,
          generation: resolved.generation,
        });
      } else {
        persistedVersionsRef.current.delete(writeKey);
      }
      if (pendingDescendant && resolved) {
        const rebasedEntry = {
          ...pendingDescendant,
          entry: { ...pendingDescendant.entry, revision: resolved.revision + 1 },
        };
        replaceEntries({
          ...entriesRef.current,
          [candidate.filePath]: {
            ...rebasedEntry.entry,
            generation: resolved.generation,
            updatedAt: new Date().toISOString(),
          },
        });
        writeBufferRef.current.enqueue(writeKey, rebasedEntry);
        void startDrain(writeKey);
      } else {
        setRetryNonce((nonce) => nonce + 1);
      }
      return true;
    },
    [
      decisionHydrationKey,
      isCurrentOperationScope,
      isExpectedHydrationKey,
      persistenceScope,
      port,
      replaceEntries,
      startDrain,
    ]
  );

  const retryHydration = useCallback((): void => setRetryNonce((nonce) => nonce + 1), []);

  const discardUnreadableScope = useCallback(
    async (operationScope: ReviewOperationScopeToken): Promise<boolean> => {
      if (!decisionHydrationKey || !persistenceScope) return false;
      await port.clear({ scope: persistenceScope });
      if (!isCurrentOperationScope(operationScope)) return false;
      baselinesRef.current.clear();
      replaceEntries({});
      setHydration({ key: decisionHydrationKey, status: 'loaded' });
      return true;
    },
    [
      decisionHydrationKey,
      isCurrentOperationScope,
      persistenceScope,
      port,
      replaceEntries,
      setHydration,
    ]
  );

  const getEntry = useCallback((filePath: string) => entriesRef.current[filePath], []);
  const hasBaseline = useCallback(
    (filePath: string): boolean => baselinesRef.current.has(normalizePathForComparison(filePath)),
    []
  );
  const getBaseline = useCallback(
    (filePath: string): string | null | undefined =>
      baselinesRef.current.get(normalizePathForComparison(filePath)),
    []
  );
  const setBaseline = useCallback((filePath: string, baseline: string | null): void => {
    baselinesRef.current.set(normalizePathForComparison(filePath), baseline);
  }, []);
  const deleteBaseline = useCallback((filePath: string): void => {
    baselinesRef.current.delete(normalizePathForComparison(filePath));
  }, []);
  const unsuppressFile = useCallback((filePath: string): void => {
    suppressedFilesRef.current.delete(normalizePathForComparison(filePath));
  }, []);
  const getDiagnostics = useCallback(
    (hydrationKey?: string | null): ChangeReviewDraftHistoryDiagnostics => {
      const prefix = hydrationKey ? `${hydrationKey}\0` : '';
      return {
        pendingWriteCount: writeBufferRef.current.keys(prefix).length,
        writeChainCount: [...writeChainsRef.current.keys()].filter((key) => key.startsWith(prefix))
          .length,
        writeErrorCount: [...writeErrorsRef.current.keys()].filter((key) => key.startsWith(prefix))
          .length,
      };
    },
    []
  );

  return {
    entries,
    getEntry,
    hasBaseline,
    getBaseline,
    setBaseline,
    deleteBaseline,
    unsuppressFile,
    publishCheckpoint,
    handleSerializedStateChanged,
    handleSerializedStateRestoreError,
    flushWrites,
    clearFile,
    resolveConflictCandidate,
    retryHydration,
    discardUnreadableScope,
    getDiagnostics,
  };
}
