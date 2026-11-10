import { projectHostProvisioningProgress } from './projectHostProvisioningProgress';
import { readHostLaunchConfiguration } from './readHostLaunchConfiguration';

import type { AgentBackendApi } from '../contracts/operations';
import type { TeamProductReadOrder } from './TeamProductReadOrder';
import type { TeamChangeEvent, TeamProvisioningProgress } from '@shared/types/team';

type Listener = (event: unknown, change: TeamChangeEvent) => void;
type ProgressListener = (event: unknown, progress: TeamProvisioningProgress) => void;

/** One bounded, non-overlapping read loop shared by all ordinary Team subscribers. */
export function createHostTeamChanges(options: {
  backend: AgentBackendApi;
  captureScope(): () => boolean;
  selectionKey(handleId: string): string;
  readOrder: TeamProductReadOrder;
}) {
  const listeners = new Map<symbol, Listener>();
  const progressListeners = new Map<symbol, ProgressListener>();
  const progressSignatures = new Map<string, string>();
  const hasListeners = () => listeners.size > 0 || progressListeners.size > 0;
  const cursors = new Map<string, string>();
  const resync = new Set<string>();
  const delivered = new Map<string, { streamId: string; sequence: number }>();
  let resyncAll = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  let epoch = 0;
  let priorScope: (() => boolean) | undefined;
  const poll = async (): Promise<void> => {
    if (polling || !hasListeners()) return;
    polling = true;
    const capturedEpoch = epoch;
    if (priorScope && !priorScope()) {
      cursors.clear();
      resync.clear();
      delivered.clear();
      progressSignatures.clear();
      resyncAll = true;
    }
    const current = options.captureScope();
    priorScope = current;
    const active = () => current() && capturedEpoch === epoch && hasListeners();
    try {
      const snapshot = await options.backend.getConnections();
      if (!active() || snapshot.state !== 'ready') return;
      options.readOrder.capture(current);
      if (resyncAll) {
        for (const binding of snapshot.bindings) resync.add(binding.handle.handleId);
        resyncAll = false;
      }
      const retained = new Set(snapshot.bindings.map((binding) => binding.handle.handleId));
      for (const key of cursors.keys()) if (!retained.has(key)) cursors.delete(key);
      for (const key of progressSignatures.keys())
        if (!retained.has(key)) progressSignatures.delete(key);
      for (const binding of snapshot.bindings) {
        if (!active()) return;
        const handleId = binding.handle.handleId;
        if (progressListeners.size) {
          const readFence = options.readOrder.launchReadFence(handleId);
          try {
            const configuration = await readHostLaunchConfiguration(options.backend, { handleId });
            if (!active()) return;
            readFence();
            if (configuration && configuration.launch.startedAtMs !== null) {
              const progress = projectHostProvisioningProgress(handleId, configuration);
              // Observation time alone is not a product change. New subscribers
              // clear this signature and receive their own current projection.
              const signature = JSON.stringify({
                ...progress,
                updatedAt: undefined,
                launchDiagnostics: progress.launchDiagnostics?.map(
                  ({ observedAt: _time, ...item }) => item
                ),
              });
              if (progressSignatures.get(handleId) !== signature) {
                progressSignatures.set(handleId, signature);
                for (const [token, listener] of [...progressListeners]) {
                  if (!active()) return;
                  if (!progressListeners.has(token)) continue;
                  try {
                    listener(undefined, structuredClone(progress));
                  } catch {
                    /* Isolate observers. */
                  }
                }
              }
            }
          } catch {
            /* An unavailable owner has no fabricated progress outcome. */
          }
        }
        if (!listeners.size) continue;
        const cursor = cursors.get(handleId) ?? options.readOrder.position(handleId)?.cursor;
        try {
          const result = await options.backend.invoke({
            handle: { handleId },
            commandId: crypto.randomUUID(),
            operation: 'team.changes.read',
            payload: cursor === undefined ? {} : { cursor },
          });
          if (!active()) return;
          if (
            !result.ok ||
            !result.value ||
            !('events' in result.value) ||
            !('cursor' in result.value) ||
            !('streamId' in result.value) ||
            typeof result.value.cursor !== 'string'
          )
            continue;
          const feed = result.value;
          if (!options.readOrder.observeFeed(handleId, feed)) continue;
          cursors.set(handleId, feed.cursor);
          const force = resync.delete(handleId);
          const acknowledged = delivered.get(handleId);
          const fresh = feed.events.some(
            (event) =>
              acknowledged?.streamId !== feed.streamId || event.sequence > acknowledged.sequence
          );
          delivered.set(handleId, { streamId: feed.streamId, sequence: feed.sequence });
          if (!fresh && !feed.gap && !force) continue;
          // These are full-read invalidations, not synthesized business events.
          // Existing consumers refresh roster/board/global tasks and message head.
          for (const type of ['config', 'inbox'] as const) {
            for (const [token, listener] of [...listeners]) {
              if (!listeners.has(token)) continue;
              if (!active()) return;
              try {
                listener(undefined, {
                  type,
                  teamName: options.selectionKey(handleId),
                  detail: feed.gap
                    ? 'host-product-gap'
                    : force
                      ? 'host-subscription-resync'
                      : 'host-product-invalidated',
                });
              } catch {
                /* One observer cannot prevent other observers from rehydrating. */
              }
            }
          }
        } catch {
          /* Preserve that owner's cursor and continue independent captured teams. */
        }
      }
    } catch {
      /* A failed discovery is unknown, never an empty authoritative Team list. */
    } finally {
      polling = false;
      if (hasListeners())
        timer = setTimeout(() => {
          timer = undefined;
          void poll();
        }, 2000);
    }
  };
  function stopIfIdle(): void {
    if (hasListeners()) return;
    epoch++;
    if (timer) clearTimeout(timer);
    timer = undefined;
    cursors.clear();
    resync.clear();
    delivered.clear();
    progressSignatures.clear();
  }
  function startIfNeeded(): void {
    if (listeners.size + progressListeners.size === 1 && !polling)
      timer = setTimeout(() => {
        timer = undefined;
        void poll();
      }, 0);
  }
  return {
    subscribeProgress(listener: ProgressListener): () => void {
      const token = Symbol();
      progressListeners.set(token, listener);
      epoch++;
      resyncAll = true;
      progressSignatures.clear();
      startIfNeeded();
      return () => {
        progressListeners.delete(token);
        stopIfIdle();
      };
    },
    subscribe(listener: Listener): () => void {
      const token = Symbol();
      listeners.set(token, listener);
      // A new legacy UI subscriber needs its own initial full read even if an
      // existing observer already consumed the shared feed cursor.
      epoch++;
      resyncAll = true;
      startIfNeeded();
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        listeners.delete(token);
        stopIfIdle();
      };
    },
  };
}
