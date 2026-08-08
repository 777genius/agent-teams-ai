import type { HostedDiagnosticsPanelProps } from '@features/hosted-operations/renderer';
import type { HostedReadinessProjection } from '@features/hosted-readiness/contracts';
import type {
  HostedReadinessRendererTransport,
  HostedReadinessTransportErrorCode,
} from '@features/hosted-readiness/renderer';
import type { HostedMemberLogSelectionId } from '@features/member-log-stream/contracts';
// eslint-disable-next-line no-restricted-imports -- Hosted browser composition requires the bounded browser-safe facet.
import type { HostedMemberLogTransport } from '@features/member-log-stream/renderer/hosted';
import type { HostedTeamApprovalRendererSlice } from '@features/team-approvals/renderer';

export type HostedOperatorSurfaceLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface HostedOperatorMemberLogBinding {
  readonly selectionId: HostedMemberLogSelectionId;
  readonly transport: HostedMemberLogTransport;
  readonly heading?: string;
}

export interface HostedOperatorSurfaceBindings {
  readonly approvalSlice?: HostedTeamApprovalRendererSlice;
  readonly diagnostics?: HostedDiagnosticsPanelProps;
  readonly memberLog?: HostedOperatorMemberLogBinding;
}

export interface HostedOperatorSurfaceSnapshot {
  readonly status: HostedOperatorSurfaceLoadStatus;
  readonly readiness: HostedReadinessProjection | null;
  readonly error: string | null;
  readonly bindings: HostedOperatorSurfaceBindings;
}

export interface HostedOperatorSurfaceController {
  getSnapshot(): HostedOperatorSurfaceSnapshot;
  subscribe(listener: () => void): () => void;
  mount(): () => void;
  reload(): Promise<void>;
}

export interface CreateHostedOperatorSurfaceControllerDependencies extends HostedOperatorSurfaceBindings {
  readonly readinessTransport: HostedReadinessRendererTransport;
}

const READINESS_ERROR = 'Hosted operator readiness is temporarily unavailable.';

function isCancellation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  try {
    return (
      (error as { readonly code?: HostedReadinessTransportErrorCode }).code === 'request_cancelled'
    );
  } catch {
    return false;
  }
}

/**
 * Owns only renderer lifecycle and readiness loading. Feature transports retain all business,
 * authority, pagination, diagnostic and approval decision semantics.
 */
export function createHostedOperatorSurfaceController(
  dependencies: CreateHostedOperatorSurfaceControllerDependencies
): HostedOperatorSurfaceController {
  if (!dependencies || typeof dependencies.readinessTransport?.load !== 'function') {
    throw new TypeError('hosted-operator-surface-controller-dependencies-invalid');
  }

  const diagnostics =
    dependencies.diagnostics === undefined
      ? undefined
      : Object.freeze({
          ...dependencies.diagnostics,
          referenceIds: Object.freeze([...dependencies.diagnostics.referenceIds]),
        });
  const memberLog =
    dependencies.memberLog === undefined ? undefined : Object.freeze({ ...dependencies.memberLog });
  const bindings: HostedOperatorSurfaceBindings = Object.freeze({
    ...(dependencies.approvalSlice === undefined
      ? {}
      : { approvalSlice: dependencies.approvalSlice }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(memberLog === undefined ? {} : { memberLog }),
  });
  let snapshot: HostedOperatorSurfaceSnapshot = Object.freeze({
    status: 'idle',
    readiness: null,
    error: null,
    bindings,
  });
  let mountCount = 0;
  let generation = 0;
  let activeController: AbortController | null = null;
  let activeReload: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  const publish = (next: Omit<HostedOperatorSurfaceSnapshot, 'bindings'>): void => {
    snapshot = Object.freeze({ ...next, bindings });
    for (const listener of listeners) listener();
  };

  const reload = (): Promise<void> => {
    if (mountCount === 0) return Promise.resolve();

    const requestGeneration = ++generation;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    publish({ status: 'loading', readiness: null, error: null });

    const request = dependencies.readinessTransport
      .load(controller.signal)
      .then((readiness) => {
        if (mountCount === 0 || controller.signal.aborted || generation !== requestGeneration) {
          return;
        }
        publish({ status: 'ready', readiness, error: null });
      })
      .catch((error: unknown) => {
        if (
          mountCount === 0 ||
          controller.signal.aborted ||
          generation !== requestGeneration ||
          isCancellation(error)
        ) {
          return;
        }
        publish({ status: 'error', readiness: null, error: READINESS_ERROR });
      })
      .finally(() => {
        if (activeController === controller) activeController = null;
        if (activeReload === request) activeReload = null;
      });
    activeReload = request;
    return request;
  };

  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    mount(): () => void {
      mountCount += 1;
      if (mountCount === 1) void reload();
      let mounted = true;
      return () => {
        if (!mounted) return;
        mounted = false;
        mountCount -= 1;
        if (mountCount !== 0) return;
        generation += 1;
        activeController?.abort();
        activeController = null;
        activeReload = null;
        publish({ status: 'idle', readiness: null, error: null });
      };
    },
    reload,
  });
}
