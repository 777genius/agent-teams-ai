import {
  ProcessSupervisionCancellationError,
  ProcessSupervisionTimeoutError,
} from '../../../contracts/processSupervision';

import type {
  OwnedProcessRef,
  ProcessControllerInstanceId,
  ProcessOwnershipScope,
  ProcessStopFence,
  SpawnNonce,
} from '../../../contracts/processSupervision';
import type {
  ProcessDrainProof,
  ProcessOwnershipRecord,
  ProcessOwnershipState,
  UnclassifiedProcessOwnershipState,
} from '../../domain/process-supervision';
import type { RuntimeCancellation } from '../ports';

export const PROCESS_OWNERSHIP_CAS_RECONCILE_LIMIT = 3;
export const PROCESS_SUPERVISION_FAIL_CLOSED_PERSISTENCE_TIMEOUT_MS = 100;

export interface MonotonicClockPort {
  now(): number;
}

export interface ProcessSupervisionDeadline {
  readonly startedAt: number;
  readonly expiresAt: number;
}

export function createProcessSupervisionDeadline(
  clock: MonotonicClockPort,
  timeoutMs: number
): ProcessSupervisionDeadline {
  const startedAt = clock.now();
  const expiresAt = startedAt + timeoutMs;
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isFinite(expiresAt)
  ) {
    throw new TypeError('process-supervision-deadline-invalid');
  }
  return Object.freeze({ startedAt, expiresAt });
}

export function remainingProcessSupervisionTime(
  deadline: ProcessSupervisionDeadline,
  clock: MonotonicClockPort
): number {
  const now = clock.now();
  if (!Number.isFinite(now) || now < deadline.startedAt) return 0;
  const remaining = deadline.expiresAt - now;
  const originalBudget = deadline.expiresAt - deadline.startedAt;
  return Number.isFinite(remaining) && Number.isFinite(originalBudget)
    ? Math.max(0, Math.min(remaining, originalBudget))
    : 0;
}

export interface ProcessOwnershipStoreContext {
  readonly deadline: ProcessSupervisionDeadline;
  readonly clock: MonotonicClockPort;
  readonly cancellation: RuntimeCancellation;
  readonly failClosedPersistence?: true;
}

export type ProcessOwnershipLoadResult =
  | { readonly status: 'found'; readonly state: ProcessOwnershipState }
  | { readonly status: 'missing' }
  | { readonly status: 'unavailable' };

export type ProcessOwnershipCompareAndSwapResult =
  | { readonly status: 'applied'; readonly state: ProcessOwnershipState }
  | { readonly status: 'conflict' }
  | { readonly status: 'unavailable' };

export interface ProcessOwnershipCompareAndSwapRequest {
  readonly scope: ProcessOwnershipScope;
  readonly expectedRevision: number | null;
  readonly next: ProcessOwnershipState;
  readonly context: ProcessOwnershipStoreContext;
}

export interface ProcessOwnershipStorePort {
  load(
    scope: ProcessOwnershipScope,
    context: ProcessOwnershipStoreContext
  ): Promise<ProcessOwnershipLoadResult>;
  loadByProcessRef(
    processRef: OwnedProcessRef,
    context: ProcessOwnershipStoreContext
  ): Promise<ProcessOwnershipLoadResult>;
  compareAndSwap(
    request: ProcessOwnershipCompareAndSwapRequest
  ): Promise<ProcessOwnershipCompareAndSwapResult>;
}

export type ProcessResidualEvidenceReadResult =
  | {
      readonly status: 'available';
      readonly residuals: readonly UnclassifiedProcessOwnershipState[];
    }
  | { readonly status: 'unavailable' };

/**
 * Read-only projection for security/readiness consumers. It exposes typed fail-closed evidence but
 * deliberately has no clear, acknowledge, delete, or mutation operation.
 */
export interface ProcessResidualEvidencePort {
  readResidualEvidence(
    context: ProcessOwnershipStoreContext
  ): Promise<ProcessResidualEvidenceReadResult>;
}

export interface ProcessIdentityFactoryPort {
  createProcessRef(): OwnedProcessRef;
  createSpawnNonce(): SpawnNonce;
}

export type LiveProcessChannelInspection =
  | { readonly status: 'live' }
  | { readonly status: 'eof' | 'lost' | 'mismatch' | 'unavailable' };

export type StopOwnedProcessEffectResult =
  | { readonly status: 'drained' | 'unclassified'; readonly proof: ProcessDrainProof }
  | { readonly status: 'cancelled' | 'timed_out' | 'unavailable' };

/** Boot-local channel access only. There is intentionally no reconnect/adopt operation. */
export interface OwnedProcessControlPort {
  inspectLiveChannel(
    ownership: ProcessOwnershipRecord,
    context: ProcessOwnershipStoreContext
  ): Promise<LiveProcessChannelInspection>;
  stopAndDrain(request: {
    readonly fence: ProcessStopFence;
    readonly ownership: ProcessOwnershipRecord;
    readonly mode: 'graceful' | 'immediate';
    readonly deadline: ProcessSupervisionDeadline;
    readonly cancellation: RuntimeCancellation;
  }): Promise<StopOwnedProcessEffectResult>;
}

export function isCancellationRequested(cancellation: RuntimeCancellation): boolean {
  try {
    return cancellation.isCancellationRequested() !== false;
  } catch {
    return true;
  }
}

/** Cleanup classification must finish after caller cancellation; it cannot create a new effect. */
export function createFailClosedCleanupCancellation(
  cancellation: RuntimeCancellation
): RuntimeCancellation {
  return Object.freeze({
    cancellationId: cancellation.cancellationId,
    isCancellationRequested: () => false,
  });
}

/**
 * Fail-closed persistence uses the still-live operation deadline when possible. If the one
 * end-to-end operation deadline has expired, it receives exactly one small, bounded store-only
 * budget; process and channel effects never receive this extension.
 */
export function createFailClosedPersistenceContext(
  context: ProcessOwnershipStoreContext,
  forceNewBudget = false
): ProcessOwnershipStoreContext {
  if (context.failClosedPersistence) return context;
  const cancellation = createFailClosedCleanupCancellation(context.cancellation);
  if (!forceNewBudget && remainingProcessSupervisionTime(context.deadline, context.clock) > 0) {
    return Object.freeze({ ...context, cancellation });
  }
  return Object.freeze({
    deadline: createProcessSupervisionDeadline(
      context.clock,
      PROCESS_SUPERVISION_FAIL_CLOSED_PERSISTENCE_TIMEOUT_MS
    ),
    clock: context.clock,
    cancellation,
    failClosedPersistence: true,
  });
}

export function isControllerInstanceExact(
  ownership: ProcessOwnershipRecord,
  controllerInstanceId: ProcessControllerInstanceId
): boolean {
  return ownership.controllerInstanceId === controllerInstanceId;
}

/** Every nested process/store wait consumes the original absolute deadline; none may reset it. */
export async function runBoundedProcessSupervisionEffect<T>(
  operation: string,
  deadline: ProcessSupervisionDeadline,
  clock: MonotonicClockPort,
  cancellation: RuntimeCancellation,
  effect: (remainingTimeMs: number) => Promise<T>
): Promise<T> {
  if (isCancellationRequested(cancellation)) {
    throw new ProcessSupervisionCancellationError(operation);
  }
  const remainingTimeMs = remainingProcessSupervisionTime(deadline, clock);
  if (remainingTimeMs <= 0) throw new ProcessSupervisionTimeoutError(operation);

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(cancellationPoll);
      callback();
    };
    const timeout = setTimeout(
      () => settle(() => reject(new ProcessSupervisionTimeoutError(operation))),
      Math.min(Math.ceil(remainingTimeMs), 2_147_483_647)
    );
    const cancellationPoll = setInterval(
      () => {
        if (isCancellationRequested(cancellation)) {
          settle(() => reject(new ProcessSupervisionCancellationError(operation)));
        }
      },
      Math.min(5, Math.max(1, Math.ceil(remainingTimeMs)))
    );

    const promise = Promise.resolve().then(async () => await effect(remainingTimeMs));
    void promise.then(
      (value) => {
        if (isCancellationRequested(cancellation)) {
          settle(() => reject(new ProcessSupervisionCancellationError(operation)));
        } else if (remainingProcessSupervisionTime(deadline, clock) <= 0) {
          settle(() => reject(new ProcessSupervisionTimeoutError(operation)));
        } else {
          settle(() => resolve(value));
        }
      },
      (error: unknown) =>
        settle(() => reject(error instanceof Error ? error : new Error(String(error))))
    );
  });
}

export function classifyBoundedProcessSupervisionFailure(
  error: unknown
): 'cancelled' | 'timed_out' | 'unavailable' {
  if (error instanceof ProcessSupervisionCancellationError) return 'cancelled';
  if (error instanceof ProcessSupervisionTimeoutError) return 'timed_out';
  return 'unavailable';
}
