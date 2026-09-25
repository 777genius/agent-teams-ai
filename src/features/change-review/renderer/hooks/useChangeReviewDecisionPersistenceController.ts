import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  ChangeReviewDecisionPersistencePort,
  ChangeReviewDecisionPersistenceScope,
  ChangeReviewDecisionPersistenceSnapshot,
} from '../ports/changeReviewActionHistoryPorts';
import type { ReviewActionPersistenceStatus } from '../utils/changeReviewActionHistory';

export const CHANGE_REVIEW_PERSISTENCE_ERROR =
  'Latest review action is not saved. Retry from History before continuing.';
const REVIEW_AUTO_CLEAR_ERROR =
  'Unable to clear saved review decisions. Retry from History or keep Changes open.';

interface ReviewPersistenceSnapshotIdentity {
  scopeToken: string;
  hunkDecisions: object;
  fileDecisions: object;
  reviewActionHistory: object;
  reviewRedoHistory: object;
  fileContents: object;
  fileChunkCounts: object;
}

interface PendingAutoClear {
  hydrationKey: string;
  generation: number;
  operation: object;
  promise: Promise<ChangeReviewAutoClearResult>;
}

export type ChangeReviewAutoClearResult = 'cleared' | 'failed' | 'stale' | 'pending';

interface UseChangeReviewDecisionPersistenceControllerInput {
  hydrationKey: string | null;
  scope: ChangeReviewDecisionPersistenceScope | null;
  hydrationReady: boolean;
  isExpectedHydrationKey: (hydrationKey: string) => boolean;
  refreshConflictCandidates: () => Promise<void>;
  port: ChangeReviewDecisionPersistencePort;
}

export interface ChangeReviewDecisionPersistenceDiagnostics {
  pendingDecisionClear: boolean;
  persistenceStatus: ReviewActionPersistenceStatus;
}

export interface ChangeReviewDecisionPersistenceController {
  status: ReviewActionPersistenceStatus;
  getStatus: () => ReviewActionPersistenceStatus;
  publishSaved: () => void;
  hydrate: (scope: ChangeReviewDecisionPersistenceScope, hydrationKey: string) => Promise<void>;
  persistLatest: () => Promise<boolean>;
  scheduleAutoPersistence: (scope: ChangeReviewDecisionPersistenceScope) => void;
  clearAfterDurableStateEmptied: (
    scope: ChangeReviewDecisionPersistenceScope,
    hydrationKey: string
  ) => Promise<ChangeReviewAutoClearResult>;
  flushForClose: () => Promise<boolean>;
  getDiagnostics: () => ChangeReviewDecisionPersistenceDiagnostics;
}

function captureSnapshotIdentity(
  scopeToken: string,
  snapshot: ChangeReviewDecisionPersistenceSnapshot
): ReviewPersistenceSnapshotIdentity {
  return {
    scopeToken,
    hunkDecisions: snapshot.hunkDecisions,
    fileDecisions: snapshot.fileDecisions,
    reviewActionHistory: snapshot.reviewActionHistory,
    reviewRedoHistory: snapshot.reviewRedoHistory,
    fileContents: snapshot.fileContents,
    fileChunkCounts: snapshot.fileChunkCounts,
  };
}

function isSameSnapshot(
  left: ReviewPersistenceSnapshotIdentity | null,
  right: ReviewPersistenceSnapshotIdentity
): boolean {
  return (
    left?.scopeToken === right.scopeToken &&
    left.hunkDecisions === right.hunkDecisions &&
    left.fileDecisions === right.fileDecisions &&
    left.reviewActionHistory === right.reviewActionHistory &&
    left.reviewRedoHistory === right.reviewRedoHistory &&
    left.fileContents === right.fileContents &&
    left.fileChunkCounts === right.fileChunkCounts
  );
}

function hasDurableReviewState(snapshot: ChangeReviewDecisionPersistenceSnapshot): boolean {
  return (
    Object.keys(snapshot.hunkDecisions).length > 0 ||
    Object.keys(snapshot.fileDecisions).length > 0 ||
    Object.keys(snapshot.reviewActionHistory).length > 0 ||
    Object.keys(snapshot.reviewRedoHistory).length > 0
  );
}

export function useChangeReviewDecisionPersistenceController({
  hydrationKey,
  scope,
  hydrationReady,
  isExpectedHydrationKey,
  refreshConflictCandidates,
  port,
}: UseChangeReviewDecisionPersistenceControllerInput): ChangeReviewDecisionPersistenceController {
  const [status, setStatus] = useState<ReviewActionPersistenceStatus>('saved');
  const statusRef = useRef<ReviewActionPersistenceStatus>('saved');
  const generationRef = useRef(0);
  const immediateSnapshotRef = useRef<ReviewPersistenceSnapshotIdentity | null>(null);
  const pendingAutoClearRef = useRef<PendingAutoClear | null>(null);

  const publishStatus = useCallback((next: ReviewActionPersistenceStatus): void => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    immediateSnapshotRef.current = null;
    if (pendingAutoClearRef.current?.hydrationKey !== hydrationKey) {
      pendingAutoClearRef.current = null;
    }
    publishStatus('saved');
  }, [hydrationKey, publishStatus]);

  const getStatus = useCallback((): ReviewActionPersistenceStatus => statusRef.current, []);
  const publishSaved = useCallback((): void => publishStatus('saved'), [publishStatus]);

  const hydrate = useCallback(
    async (
      hydrationScope: ChangeReviewDecisionPersistenceScope,
      targetHydrationKey: string
    ): Promise<void> => {
      const generation = generationRef.current;
      await port.load(hydrationScope);
      if (generationRef.current !== generation || !isExpectedHydrationKey(targetHydrationKey)) {
        return;
      }
      const hydrated = port.getSnapshot();
      if (
        hydrated.decisionHydrationScopeKey === targetHydrationKey &&
        hydrated.decisionHydrationStatus === 'loaded'
      ) {
        // Loading is already durable. Suppress only the exact reference snapshot
        // produced by this hydration, never a structurally-equal later edit.
        immediateSnapshotRef.current = captureSnapshotIdentity(hydrationScope.scopeToken, hydrated);
      }
    },
    [isExpectedHydrationKey, port]
  );

  const persistLatest = useCallback(async (): Promise<boolean> => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    pendingAutoClearRef.current = null;
    publishStatus('saving');

    if (!scope || !hydrationReady) {
      if (generationRef.current === generation) {
        publishStatus('error');
        port.reportError(CHANGE_REVIEW_PERSISTENCE_ERROR);
      }
      return false;
    }

    // The marker must precede both scheduling and flushing. Otherwise the
    // post-ack render can enqueue a redundant revision before the marker exists.
    immediateSnapshotRef.current = captureSnapshotIdentity(scope.scopeToken, port.getSnapshot());

    let saved = false;
    try {
      port.schedule(scope);
      saved = await port.flush(scope);
    } catch {
      saved = false;
    }

    if (generationRef.current !== generation || !isExpectedHydrationKey(hydrationKey ?? '')) {
      return saved;
    }
    if (saved) {
      publishStatus('saved');
      port.clearError(CHANGE_REVIEW_PERSISTENCE_ERROR);
      return true;
    }

    publishStatus('error');
    port.reportError(CHANGE_REVIEW_PERSISTENCE_ERROR);
    void refreshConflictCandidates();
    return false;
  }, [
    hydrationKey,
    hydrationReady,
    isExpectedHydrationKey,
    port,
    publishStatus,
    refreshConflictCandidates,
    scope,
  ]);

  const scheduleAutoPersistence = useCallback(
    (autoScope: ChangeReviewDecisionPersistenceScope): void => {
      const currentSnapshot = captureSnapshotIdentity(autoScope.scopeToken, port.getSnapshot());
      if (isSameSnapshot(immediateSnapshotRef.current, currentSnapshot)) {
        immediateSnapshotRef.current = null;
        return;
      }
      immediateSnapshotRef.current = null;
      port.schedule(autoScope);
    },
    [port]
  );

  const clearAfterDurableStateEmptied = useCallback(
    (
      clearScope: ChangeReviewDecisionPersistenceScope,
      targetHydrationKey: string
    ): Promise<ChangeReviewAutoClearResult> => {
      const existing = pendingAutoClearRef.current;
      if (
        existing?.hydrationKey === targetHydrationKey &&
        existing.generation === generationRef.current
      ) {
        return existing.promise;
      }

      const generation = generationRef.current + 1;
      generationRef.current = generation;
      const operation = {};
      const pending: PendingAutoClear = {
        hydrationKey: targetHydrationKey,
        generation,
        operation,
        promise: Promise.resolve('pending'),
      };
      const isCurrent = (): boolean =>
        generationRef.current === generation &&
        pendingAutoClearRef.current?.operation === operation &&
        isExpectedHydrationKey(targetHydrationKey);

      pending.promise = (async (): Promise<ChangeReviewAutoClearResult> => {
        let cleared = false;
        try {
          cleared = await port.clear(clearScope);
        } catch {
          cleared = false;
        }
        if (!isCurrent()) return 'stale';
        if (cleared) return 'cleared';

        publishStatus('error');
        port.reportError(REVIEW_AUTO_CLEAR_ERROR);
        void refreshConflictCandidates();
        return 'failed';
      })().finally(() => {
        if (pendingAutoClearRef.current?.operation === operation) {
          pendingAutoClearRef.current = null;
        }
      });
      pendingAutoClearRef.current = pending;
      return pending.promise;
    },
    [isExpectedHydrationKey, port, publishStatus, refreshConflictCandidates]
  );

  const flushForClose = useCallback(async (): Promise<boolean> => {
    if (!scope) return true;
    if (hasDurableReviewState(port.getSnapshot())) return persistLatest();
    const pending = pendingAutoClearRef.current;
    if (pending?.hydrationKey === hydrationKey) {
      return (await pending.promise) === 'cleared';
    }
    try {
      return await port.clear(scope);
    } catch {
      return false;
    }
  }, [hydrationKey, persistLatest, port, scope]);

  const getDiagnostics = useCallback(
    (): ChangeReviewDecisionPersistenceDiagnostics => ({
      pendingDecisionClear: pendingAutoClearRef.current !== null,
      persistenceStatus: statusRef.current,
    }),
    []
  );

  return {
    status,
    getStatus,
    publishSaved,
    hydrate,
    persistLatest,
    scheduleAutoPersistence,
    clearAfterDurableStateEmptied,
    flushForClose,
    getDiagnostics,
  };
}
