import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { loadHostedTeamRuntimeEvidence } from '../utils/loadHostedTeamRuntimeEvidence';
import { loadTeamLifecycleList } from '../utils/loadTeamLifecycleList';

import type {
  CanonicalListTeamLifecycleResult,
  CanonicalTeamLifecycleListItem,
  TeamLifecycleReadTransportApi,
} from '../../contracts';
import type {
  HostedControlStateRead,
  HostedRuntimeEvidence,
} from '../utils/loadHostedTeamRuntimeEvidence';
import type { Revision, TeamId, WorkspaceId } from '@shared/contracts/hosted';

type ReadFailure = Exclude<CanonicalListTeamLifecycleResult, { readonly kind: 'success' }>;
type DirectorySnapshot = Readonly<{
  revision: Revision;
  items: readonly CanonicalTeamLifecycleListItem[];
  readEpoch: number;
  readStartedAtWatermark: number;
}>;

export interface HostedTeamDirectoryReadState {
  readonly scopeKey: WorkspaceId;
  readonly freshness: 'loading' | 'refreshing' | 'fresh' | 'stale' | 'failed';
  readonly snapshot: DirectorySnapshot | null;
  readonly failure: ReadFailure | null;
  readonly watermark: number;
  readonly runtime: Readonly<{
    phase: 'idle' | 'reading' | 'complete' | 'incomplete';
    byTeamId: ReadonlyMap<TeamId, HostedRuntimeEvidence>;
  }>;
}

export interface HostedTeamDirectoryReadTransport {
  listTeamLifecycle(
    request: Parameters<TeamLifecycleReadTransportApi['listTeamLifecycle']>[0],
    signal?: AbortSignal
  ): ReturnType<TeamLifecycleReadTransportApi['listTeamLifecycle']>;
  getControlState: HostedControlStateRead;
}

export interface HostedTeamDirectoryReadSession {
  getState(): HostedTeamDirectoryReadState;
  subscribe(listener: () => void): () => void;
  reload(): Promise<void>;
  /** Call after a confirmed create/promotion/deletion receipt, before changing selection. */
  advanceWatermark(): void;
  /** Cancels this mount's requests; a subsequent reload may restart the session. */
  cancel(): void;
}

const EMPTY_EVIDENCE: ReadonlyMap<TeamId, HostedRuntimeEvidence> = new Map();
const IDLE_RUNTIME = Object.freeze({ phase: 'idle' as const, byTeamId: EMPTY_EVIDENCE });

/** One source-owned list read and one bounded runtime wave for a selected workspace. */
export function createHostedTeamDirectoryReadSession(
  scopeKey: WorkspaceId,
  transport: HostedTeamDirectoryReadTransport
): HostedTeamDirectoryReadSession {
  let state: HostedTeamDirectoryReadState = Object.freeze({
    scopeKey,
    freshness: 'loading',
    snapshot: null,
    failure: null,
    watermark: 0,
    runtime: IDLE_RUNTIME,
  });
  const listeners = new Set<() => void>();
  let requestGeneration = 0;
  let readEpoch = 0;
  let currentRead: Promise<void> | null = null;
  let dirty = false;
  let listAbort: AbortController | null = null;
  let runtimeAbort: AbortController | null = null;

  const publish = (next: HostedTeamDirectoryReadState): void => {
    state = Object.freeze(next);
    listeners.forEach((listener) => listener());
  };

  const runRead = async (generation: number): Promise<void> => {
    runtimeAbort?.abort();
    runtimeAbort = null;
    const controller = new AbortController();
    listAbort = controller;
    const startedAtWatermark = state.watermark;
    publish({
      ...state,
      freshness: state.snapshot === null ? 'loading' : 'refreshing',
      failure: null,
      runtime: state.snapshot === null ? IDLE_RUNTIME : state.runtime,
    });

    const result = await loadTeamLifecycleList(transport, controller.signal);
    if (controller.signal.aborted || generation !== requestGeneration) return;
    listAbort = null;
    if (startedAtWatermark !== state.watermark) {
      dirty = true;
      publish({
        ...state,
        freshness: state.snapshot === null ? 'loading' : 'stale',
      });
      return;
    }
    if (result.kind !== 'success') {
      publish({
        ...state,
        freshness: state.snapshot === null ? 'failed' : 'stale',
        failure: result,
        runtime: state.snapshot === null ? IDLE_RUNTIME : state.runtime,
      });
      return;
    }

    const items = Object.freeze(result.items.filter((item) => item.workspaceId === scopeKey));
    const acceptedEpoch = ++readEpoch;
    const snapshot: DirectorySnapshot = Object.freeze({
      revision: result.snapshotRevision,
      items,
      readEpoch: acceptedEpoch,
      readStartedAtWatermark: startedAtWatermark,
    });
    publish({
      ...state,
      freshness: 'fresh',
      snapshot,
      failure: null,
      runtime: {
        phase: items.length === 0 ? 'complete' : 'reading',
        byTeamId: EMPTY_EVIDENCE,
      },
    });
    if (items.length === 0) return;

    const waveController = new AbortController();
    runtimeAbort = waveController;
    void loadHostedTeamRuntimeEvidence(
      items,
      (request, signal) => transport.getControlState(request, signal),
      waveController.signal
    )
      .then((wave) => {
        if (
          waveController.signal.aborted ||
          generation !== requestGeneration ||
          state.snapshot?.readEpoch !== acceptedEpoch ||
          state.freshness !== 'fresh'
        ) {
          return;
        }
        publish({
          ...state,
          runtime: {
            phase: wave.complete ? 'complete' : 'incomplete',
            byTeamId: wave.byTeamId,
          },
        });
      })
      .catch(() => {
        if (
          !waveController.signal.aborted &&
          generation === requestGeneration &&
          state.snapshot?.readEpoch === acceptedEpoch &&
          state.freshness === 'fresh'
        ) {
          publish({ ...state, runtime: { phase: 'incomplete', byTeamId: EMPTY_EVIDENCE } });
        }
      });
  };

  const reload = (): Promise<void> => {
    if (currentRead !== null) {
      dirty = true;
      return currentRead;
    }
    const generation = ++requestGeneration;
    const read = runRead(generation).finally(() => {
      if (currentRead !== read || generation !== requestGeneration) return;
      currentRead = null;
      if (dirty) {
        dirty = false;
        void reload();
      }
    });
    currentRead = read;
    return read;
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reload,
    advanceWatermark() {
      publish({
        ...state,
        watermark: state.watermark + 1,
        freshness: state.snapshot === null ? 'loading' : 'stale',
      });
      void reload();
    },
    cancel() {
      requestGeneration += 1;
      listAbort?.abort();
      runtimeAbort?.abort();
      listAbort = null;
      runtimeAbort = null;
      currentRead = null;
      dirty = false;
    },
  };
}

/** Instantiate once above chooser and dashboard; both receive this same state/reload owner. */
export function useHostedTeamDirectorySource(
  scopeKey: WorkspaceId | undefined,
  transport: HostedTeamDirectoryReadTransport,
  enabled = true
): Readonly<{
  state: HostedTeamDirectoryReadState;
  reload: () => Promise<void>;
  advanceWatermark: () => void;
}> {
  const session = useMemo(
    // An unscoped standalone workspace has no directory authority. Its legacy list stays separate.
    () => createHostedTeamDirectoryReadSession(scopeKey ?? ('' as WorkspaceId), transport),
    [scopeKey, transport]
  );
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  useEffect(() => {
    if (scopeKey !== undefined && enabled) void session.reload();
    return () => session.cancel();
  }, [scopeKey, session, enabled]);
  return { state, reload: session.reload, advanceWatermark: session.advanceWatermark };
}
