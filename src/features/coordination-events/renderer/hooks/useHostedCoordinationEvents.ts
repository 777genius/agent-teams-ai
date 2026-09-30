import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { HostedCoordinationEventReconciler } from '../reconciliation/HostedCoordinationEventReconciler';

import type {
  CoordinationEventScope,
  CoordinationJsonValue,
  HostedCoordinationEventEnvelope,
  ReplayCursor,
} from '../../contracts';
import type {
  HostedCoordinationEventConnection,
  HostedCoordinationEventTransport,
  HostedCoordinationSnapshotResyncCause,
  HostedCoordinationSnapshotResyncPort,
} from '../ports/HostedCoordinationEventRendererPorts';
import type { HostedCoordinationEventReconciliationState } from '../reconciliation/HostedCoordinationEventReconciler';

export type HostedCoordinationEventsStatus =
  | 'idle'
  | 'resyncing'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'error';

export interface UseHostedCoordinationEventsInput<
  TSnapshot,
  TPayload extends CoordinationJsonValue = CoordinationJsonValue,
> {
  readonly authenticated: boolean;
  readonly scope: CoordinationEventScope | null;
  readonly transport: HostedCoordinationEventTransport;
  readonly snapshotResync: HostedCoordinationSnapshotResyncPort<TSnapshot>;
  readonly applyEvent?: (
    snapshot: TSnapshot,
    event: HostedCoordinationEventEnvelope<TPayload>
  ) => TSnapshot;
  /** Defaults to exact scope identity while still advancing over other authorized events. */
  readonly shouldApplyEvent?: (
    event: HostedCoordinationEventEnvelope<TPayload>,
    scope: CoordinationEventScope
  ) => boolean;
  readonly reconciler?: HostedCoordinationEventReconciler;
}

export interface UseHostedCoordinationEventsResult<
  TSnapshot,
  TPayload extends CoordinationJsonValue = CoordinationJsonValue,
> {
  readonly status: HostedCoordinationEventsStatus;
  readonly snapshot: TSnapshot | null;
  readonly lastEvent: HostedCoordinationEventEnvelope<TPayload> | null;
  readonly cursor: ReplayCursor | null;
  readonly generation: number;
  readonly error: Error | null;
  readonly retryScheduledInMs: number | null;
  /** Starts a fresh scoped bootstrap after a terminal error, without remounting. */
  readonly retry: () => void;
}

interface HookState<TSnapshot, TPayload extends CoordinationJsonValue> {
  readonly selectionKey: string | null;
  readonly status: HostedCoordinationEventsStatus;
  readonly snapshot: TSnapshot | null;
  readonly lastEvent: HostedCoordinationEventEnvelope<TPayload> | null;
  readonly cursor: ReplayCursor | null;
  readonly generation: number;
  readonly error: Error | null;
  readonly retryScheduledInMs: number | null;
}

const DEFAULT_RECONCILER = new HostedCoordinationEventReconciler();
const MAX_SNAPSHOT_ATTEMPTS = 3;
const MAX_STREAM_RECONNECT_ATTEMPTS = 5;

function exactScopeMatch(
  event: HostedCoordinationEventEnvelope,
  scope: CoordinationEventScope
): boolean {
  return event.scope.kind === scope.kind && event.scope.scopeId === scope.scopeId;
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function selectionKey(scope: CoordinationEventScope): string {
  return JSON.stringify([scope.kind, scope.scopeId]);
}

function emptyState<TSnapshot, TPayload extends CoordinationJsonValue>(
  key: string | null,
  generation: number,
  status: HostedCoordinationEventsStatus = 'idle'
): HookState<TSnapshot, TPayload> {
  return {
    selectionKey: key,
    status,
    snapshot: null,
    lastEvent: null,
    cursor: null,
    generation,
    error: null,
    retryScheduledInMs: null,
  };
}

export function useHostedCoordinationEvents<
  TSnapshot,
  TPayload extends CoordinationJsonValue = CoordinationJsonValue,
>(
  input: UseHostedCoordinationEventsInput<TSnapshot, TPayload>
): UseHostedCoordinationEventsResult<TSnapshot, TPayload> {
  const reconciler = input.reconciler ?? DEFAULT_RECONCILER;
  const applyEventRef = useRef(input.applyEvent);
  const shouldApplyEventRef = useRef(input.shouldApplyEvent);
  applyEventRef.current = input.applyEvent;
  shouldApplyEventRef.current = input.shouldApplyEvent;

  const scopeKind = input.scope?.kind ?? null;
  const scopeId = input.scope?.scopeId ?? null;
  const requestedSelectionKey = useMemo(
    () =>
      input.authenticated && scopeKind !== null && scopeId !== null
        ? selectionKey({ kind: scopeKind, scopeId })
        : null,
    [input.authenticated, scopeId, scopeKind]
  );
  const generationRef = useRef(0);
  const [retrySequence, setRetrySequence] = useState(0);
  const retry = useCallback(() => setRetrySequence((sequence) => sequence + 1), []);
  const [state, setState] = useState<HookState<TSnapshot, TPayload>>(() => emptyState(null, 0));

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    if (
      !input.authenticated ||
      scopeKind === null ||
      scopeId === null ||
      requestedSelectionKey === null
    ) {
      setState(emptyState(null, generation));
      return () => {
        if (generationRef.current === generation) generationRef.current += 1;
      };
    }

    const scope: CoordinationEventScope = Object.freeze({ kind: scopeKind, scopeId });
    const ownerController = new AbortController();
    let snapshotController: AbortController | null = null;
    let snapshotOwnerAbortListener: (() => void) | null = null;
    let connection: HostedCoordinationEventConnection | null = null;
    let reconciliation: HostedCoordinationEventReconciliationState | null = null;
    let currentSnapshot: TSnapshot | null = null;
    let hasSnapshot = false;
    let snapshotRequest = 0;
    let snapshotFailureCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const clearRetryTimer = (): void => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
    };

    const isCurrent = (): boolean =>
      generationRef.current === generation && !ownerController.signal.aborted;
    const update = (
      updater: (current: HookState<TSnapshot, TPayload>) => HookState<TSnapshot, TPayload>
    ): void => {
      if (!isCurrent()) return;
      setState((current) =>
        current.generation === generation && current.selectionKey === requestedSelectionKey
          ? updater(current)
          : current
      );
    };

    setState(emptyState(requestedSelectionKey, generation, 'resyncing'));

    const startSnapshotResync = async (
      cause: HostedCoordinationSnapshotResyncCause,
      scheduledRetry = false
    ): Promise<void> => {
      if (!isCurrent()) return;
      clearRetryTimer();
      if (!scheduledRetry) snapshotFailureCount = 0;
      const request = ++snapshotRequest;
      connection?.close();
      connection = null;
      if (snapshotOwnerAbortListener) {
        ownerController.signal.removeEventListener('abort', snapshotOwnerAbortListener);
        snapshotOwnerAbortListener = null;
      }
      snapshotController?.abort();
      reconciliation = null;
      currentSnapshot = null;
      hasSnapshot = false;
      snapshotController = new AbortController();
      const requestController = snapshotController;
      const abortRequest = (): void => requestController.abort();
      snapshotOwnerAbortListener = abortRequest;
      ownerController.signal.addEventListener('abort', abortRequest, { once: true });
      update((current) => ({
        ...current,
        status: 'resyncing',
        snapshot: null,
        lastEvent: null,
        cursor: null,
        error: null,
        retryScheduledInMs: null,
      }));

      try {
        const snapshot = await input.snapshotResync.loadSnapshot({
          scope,
          cause,
          signal: requestController.signal,
        });
        if (!isCurrent() || requestController.signal.aborted || request !== snapshotRequest) {
          return;
        }
        const nextReconciliation = reconciler.fromSnapshot({ snapshot, generation });
        reconciliation = nextReconciliation;
        currentSnapshot = snapshot.snapshot;
        hasSnapshot = true;
        update((current) => ({
          ...current,
          status: 'connecting',
          snapshot: snapshot.snapshot,
          lastEvent: null,
          cursor: nextReconciliation.cursor,
          error: null,
          retryScheduledInMs: null,
        }));

        let streamStopped = false;
        const isActiveRequest = (): boolean =>
          isCurrent() && request === snapshotRequest && !streamStopped;

        const openedConnection = input.transport.connect<TPayload>({
          resumeCursor: nextReconciliation.cursor,
          signal: ownerController.signal,
          handlers: {
            onOpen: () => {
              if (!isActiveRequest()) return;
              update((current) => ({ ...current, status: 'live', error: null }));
            },
            onReconnectScheduled: ({ attempt }) => {
              if (!isActiveRequest()) return;
              if (attempt >= MAX_STREAM_RECONNECT_ATTEMPTS) {
                streamStopped = true;
                // The transport schedules after this callback; close on the next microtask.
                queueMicrotask(() => {
                  if (!isCurrent() || request !== snapshotRequest) return;
                  connection?.close();
                  connection = null;
                  update((current) => ({
                    ...current,
                    status: 'error',
                    error: new Error('Hosted coordination stream reconnect limit reached'),
                  }));
                });
                return;
              }
              update((current) => ({ ...current, status: 'reconnecting' }));
            },
            onError: (error) => {
              if (!isActiveRequest()) return;
              update((current) => ({ ...current, status: 'error', error }));
            },
            onResyncRequired: (reason) => {
              if (isActiveRequest()) void startSnapshotResync(reason);
            },
            onEvent: (event) => {
              if (!isActiveRequest() || reconciliation === null || !hasSnapshot) {
                return Object.freeze({ kind: 'stop' });
              }
              const result = reconciler.reconcile({
                state: reconciliation,
                event,
                generation,
              });
              if (result.kind === 'stale_generation') return Object.freeze({ kind: 'stop' });
              if (result.kind === 'resync_required') {
                void startSnapshotResync(result.reason);
                return Object.freeze({ kind: 'stop' });
              }
              reconciliation = result.state;
              if (result.kind === 'duplicate') {
                update((current) => ({ ...current, cursor: result.state.cursor }));
                return Object.freeze({ kind: 'advance', resumeCursor: result.state.cursor });
              }

              const shouldApply = (shouldApplyEventRef.current ?? exactScopeMatch)(event, scope);
              if (!shouldApply) {
                update((current) => ({ ...current, cursor: result.state.cursor }));
                return Object.freeze({ kind: 'advance', resumeCursor: result.state.cursor });
              }
              try {
                currentSnapshot = applyEventRef.current
                  ? applyEventRef.current(currentSnapshot as TSnapshot, event)
                  : currentSnapshot;
              } catch {
                void startSnapshotResync('projection_invalid');
                return Object.freeze({ kind: 'stop' });
              }
              const nextSnapshot = currentSnapshot;
              update((current) => ({
                ...current,
                snapshot: nextSnapshot,
                lastEvent: event,
                cursor: result.state.cursor,
                error: null,
              }));
              return Object.freeze({ kind: 'advance', resumeCursor: result.state.cursor });
            },
          },
        });
        if (!isCurrent() || request !== snapshotRequest) openedConnection.close();
        else {
          connection = openedConnection;
          snapshotFailureCount = 0;
        }
      } catch (error) {
        if (!isCurrent() || requestController.signal.aborted || request !== snapshotRequest) {
          return;
        }
        reconciliation = null;
        currentSnapshot = null;
        hasSnapshot = false;
        snapshotFailureCount += 1;
        const delayMs =
          snapshotFailureCount < MAX_SNAPSHOT_ATTEMPTS
            ? 1_000 * 2 ** (snapshotFailureCount - 1)
            : null;
        update((current) => ({
          ...current,
          status: 'error',
          snapshot: null,
          lastEvent: null,
          cursor: null,
          error: asError(error, 'Hosted coordination snapshot resync failed'),
          retryScheduledInMs: delayMs,
        }));
        if (delayMs !== null) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (isCurrent() && request === snapshotRequest) {
              void startSnapshotResync(cause, true);
            }
          }, delayMs);
        }
      } finally {
        ownerController.signal.removeEventListener('abort', abortRequest);
        if (snapshotOwnerAbortListener === abortRequest) snapshotOwnerAbortListener = null;
      }
    };

    void startSnapshotResync('initial');
    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
      ownerController.abort();
      clearRetryTimer();
      if (snapshotOwnerAbortListener) {
        ownerController.signal.removeEventListener('abort', snapshotOwnerAbortListener);
        snapshotOwnerAbortListener = null;
      }
      snapshotController?.abort();
      connection?.close();
      connection = null;
      reconciliation = null;
      currentSnapshot = null;
      hasSnapshot = false;
    };
  }, [
    input.authenticated,
    input.snapshotResync,
    input.transport,
    reconciler,
    requestedSelectionKey,
    retrySequence,
    scopeId,
    scopeKind,
  ]);

  if (state.selectionKey !== requestedSelectionKey) {
    return {
      ...emptyState<TSnapshot, TPayload>(
        requestedSelectionKey,
        state.generation,
        requestedSelectionKey === null ? 'idle' : 'resyncing'
      ),
      retry,
    };
  }
  return { ...state, retry };
}
