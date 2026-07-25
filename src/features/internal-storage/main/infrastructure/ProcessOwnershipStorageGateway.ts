import {
  parseProcessOwnershipWorkerResult,
  type ProcessOwnershipWorkerPayloadByOp,
} from './worker/internalStorageWorkerProtocol';

export const PROCESS_OWNERSHIP_STORAGE_CODEC_VERSION = 1 as const;

export type StoredProcessOwnershipPhase =
  | 'spawn_intent'
  | 'owned'
  | 'stopping'
  | 'drained'
  | 'unclassified_residual';

/**
 * Immutable lookup scope copied from the process-supervision contract. Keeping this storage seam
 * primitive-only prevents internal-storage from depending on another feature's domain objects.
 */
export interface ProcessOwnershipStorageScope {
  readonly teamId: string;
  readonly runId: string;
  readonly planGeneration: number;
  readonly planHash: string;
  readonly executionUnitId: string;
}

/**
 * The JSON value is a strict versioned process-supervision codec envelope. It contains typed state,
 * digests, and opaque references only; raw launch or native-process data has no storage field.
 */
export interface StoredProcessOwnershipState {
  readonly scope: ProcessOwnershipStorageScope;
  readonly processRef: string;
  readonly codecVersion: typeof PROCESS_OWNERSHIP_STORAGE_CODEC_VERSION;
  readonly stateVersion: number;
  readonly revision: number;
  readonly phase: StoredProcessOwnershipPhase;
  readonly stateJson: string;
}

export type ProcessOwnershipStorageLoadResult =
  | { readonly status: 'found'; readonly record: StoredProcessOwnershipState }
  | { readonly status: 'missing' };

export type ProcessOwnershipStorageCompareAndSwapResult =
  | { readonly status: 'applied'; readonly record: StoredProcessOwnershipState }
  | { readonly status: 'conflict' };

/**
 * In-process admission context. The cancellation probe deliberately stays out of the worker
 * payload; the client uses it to remove work that has not yet crossed the worker boundary.
 */
export interface ProcessOwnershipStorageCallContext {
  readonly deadlineAtMs: number;
  readonly isCancellationRequested: () => boolean;
}

export function isProcessOwnershipStorageCallAdmitted(
  context: ProcessOwnershipStorageCallContext | undefined
): boolean {
  if (!context) return true;
  try {
    return Date.now() < context.deadlineAtMs && context.isCancellationRequested() === false;
  } catch {
    return false;
  }
}

export interface ProcessOwnershipStorageCompareAndSwapRequest {
  readonly scope: ProcessOwnershipStorageScope;
  readonly expectedRevision: number | null;
  /**
   * Canonically decoded by process supervision before CAS. SQLite requires byte-for-byte equality
   * with this snapshot, so same-revision durable bytes cannot be replaced after validation.
   */
  readonly expectedCurrent: StoredProcessOwnershipState | null;
  readonly next: StoredProcessOwnershipState;
}

/** SQLite worker boundary used by the process-supervision output adapter. */
export interface ProcessOwnershipStorageGateway {
  loadProcessOwnershipByScope(
    scope: ProcessOwnershipStorageScope,
    context: ProcessOwnershipStorageCallContext
  ): Promise<ProcessOwnershipStorageLoadResult>;
  loadProcessOwnershipByProcessRef(
    processRef: string,
    context: ProcessOwnershipStorageCallContext
  ): Promise<ProcessOwnershipStorageLoadResult>;
  listProcessOwnershipRecords(
    context: ProcessOwnershipStorageCallContext
  ): Promise<readonly StoredProcessOwnershipState[]>;
  compareAndSwapProcessOwnership(
    request: ProcessOwnershipStorageCompareAndSwapRequest,
    context: ProcessOwnershipStorageCallContext
  ): Promise<ProcessOwnershipStorageCompareAndSwapResult>;
}

/** Shared typed ownership facade; concrete clients retain ownership of queue admission. */
export abstract class ProcessOwnershipStorageGatewayClient implements ProcessOwnershipStorageGateway {
  protected abstract callProcessOwnershipWorker<
    TOp extends keyof ProcessOwnershipWorkerPayloadByOp,
  >(
    op: TOp,
    payload: ProcessOwnershipWorkerPayloadByOp[TOp],
    context: ProcessOwnershipStorageCallContext
  ): Promise<unknown>;

  async loadProcessOwnershipByScope(
    scope: ProcessOwnershipStorageScope,
    context: ProcessOwnershipStorageCallContext
  ): Promise<ProcessOwnershipStorageLoadResult> {
    return parseProcessOwnershipWorkerResult(
      'processOwnership.loadByScope',
      await this.callProcessOwnershipWorker('processOwnership.loadByScope', { scope }, context)
    );
  }

  async loadProcessOwnershipByProcessRef(
    processRef: string,
    context: ProcessOwnershipStorageCallContext
  ): Promise<ProcessOwnershipStorageLoadResult> {
    return parseProcessOwnershipWorkerResult(
      'processOwnership.loadByProcessRef',
      await this.callProcessOwnershipWorker(
        'processOwnership.loadByProcessRef',
        { processRef },
        context
      )
    );
  }

  async listProcessOwnershipRecords(
    context: ProcessOwnershipStorageCallContext
  ): Promise<readonly StoredProcessOwnershipState[]> {
    return parseProcessOwnershipWorkerResult(
      'processOwnership.list',
      await this.callProcessOwnershipWorker('processOwnership.list', {}, context)
    );
  }

  async compareAndSwapProcessOwnership(
    request: ProcessOwnershipStorageCompareAndSwapRequest,
    context: ProcessOwnershipStorageCallContext
  ): Promise<ProcessOwnershipStorageCompareAndSwapResult> {
    return parseProcessOwnershipWorkerResult(
      'processOwnership.compareAndSwap',
      await this.callProcessOwnershipWorker(
        'processOwnership.compareAndSwap',
        { request, admission: { deadlineAtMs: context.deadlineAtMs } },
        context
      )
    );
  }
}
