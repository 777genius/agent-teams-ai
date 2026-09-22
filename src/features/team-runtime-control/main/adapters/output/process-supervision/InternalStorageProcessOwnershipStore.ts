import {
  PROCESS_OWNERSHIP_STORAGE_CODEC_VERSION,
  type ProcessOwnershipStorageCallContext,
  type ProcessOwnershipStorageGateway,
  type ProcessOwnershipStorageScope,
  type StoredProcessOwnershipState,
} from '@features/internal-storage/main';

import {
  isExactProcessOwnershipScope,
  parseOwnedProcessRef,
  type ProcessOwnershipScope,
} from '../../../../contracts/processSupervision';
import {
  isCancellationRequested,
  type ProcessOwnershipCompareAndSwapRequest,
  type ProcessOwnershipCompareAndSwapResult,
  type ProcessOwnershipLoadResult,
  type ProcessOwnershipStoreContext,
  type ProcessOwnershipStorePort,
  type ProcessResidualEvidencePort,
  type ProcessResidualEvidenceReadResult,
  remainingProcessSupervisionTime,
} from '../../../../core/application/process-supervision';
import {
  areOwnershipStatesEquivalent,
  type ProcessOwnershipState,
} from '../../../../core/domain/process-supervision';

import {
  decodeProcessOwnershipState,
  encodeProcessOwnershipState,
  PROCESS_OWNERSHIP_STATE_CODEC_VERSION,
} from './processOwnershipStateCodec';

/**
 * Maps the process-supervision store ports onto the shared SQLite worker. Every storage/protocol or
 * codec fault is fail-closed; only an authoritative empty query maps to missing.
 */
export class InternalStorageProcessOwnershipStore
  implements ProcessOwnershipStorePort, ProcessResidualEvidencePort
{
  constructor(private readonly gateway: ProcessOwnershipStorageGateway) {}

  async load(
    scope: ProcessOwnershipScope,
    context: ProcessOwnershipStoreContext
  ): Promise<ProcessOwnershipLoadResult> {
    try {
      const loaded = await this.gateway.loadProcessOwnershipByScope(
        toStorageScope(scope),
        toStorageCallContext(context)
      );
      if (loaded.status === 'missing') return loaded;
      return this.decodeLoaded(loaded.record, scope);
    } catch {
      return { status: 'unavailable' };
    }
  }

  async loadByProcessRef(
    processRef: ProcessOwnershipState['intent']['processRef'],
    context: ProcessOwnershipStoreContext
  ): Promise<ProcessOwnershipLoadResult> {
    try {
      const loaded = await this.gateway.loadProcessOwnershipByProcessRef(
        processRef,
        toStorageCallContext(context)
      );
      if (loaded.status === 'missing') return loaded;
      const parsedRef = parseOwnedProcessRef(loaded.record.processRef);
      const state = decodeStoredState(loaded.record);
      return parsedRef === processRef && state.intent.processRef === processRef
        ? { status: 'found', state }
        : { status: 'unavailable' };
    } catch {
      return { status: 'unavailable' };
    }
  }

  async compareAndSwap(
    request: ProcessOwnershipCompareAndSwapRequest
  ): Promise<ProcessOwnershipCompareAndSwapResult> {
    try {
      if (!isExactProcessOwnershipScope(request.next.intent.scope, request.scope)) {
        return { status: 'unavailable' };
      }
      const next = toStoredState(request.next);
      const storageContext = toStorageCallContext(request.context);
      const existing = await this.loadExistingForCompareAndSwap(
        request.scope,
        next.processRef,
        storageContext
      );
      if (existing.status === 'conflict') return existing;
      if (
        request.expectedRevision === null
          ? existing.record !== null
          : existing.record === null ||
            existing.record.revision !== request.expectedRevision ||
            existing.record.processRef !== next.processRef ||
            !storageScopesEqual(existing.record.scope, next.scope)
      ) {
        return { status: 'conflict' };
      }
      const result = await this.gateway.compareAndSwapProcessOwnership(
        {
          scope: toStorageScope(request.scope),
          expectedRevision: request.expectedRevision,
          expectedCurrent: existing.record,
          next,
        },
        storageContext
      );
      if (result.status === 'conflict') return result;
      const applied = decodeStoredState(result.record);
      return isExactProcessOwnershipScope(applied.intent.scope, request.scope) &&
        areOwnershipStatesEquivalent(applied, request.next)
        ? { status: 'applied', state: applied }
        : { status: 'unavailable' };
    } catch {
      return { status: 'unavailable' };
    }
  }

  async readResidualEvidence(
    context: ProcessOwnershipStoreContext
  ): Promise<ProcessResidualEvidenceReadResult> {
    try {
      const records = await this.gateway.listProcessOwnershipRecords(toStorageCallContext(context));
      const residuals = records
        .map(decodeStoredState)
        .filter(
          (state): state is Extract<ProcessOwnershipState, { phase: 'unclassified_residual' }> =>
            state.phase === 'unclassified_residual'
        );
      return { status: 'available', residuals: Object.freeze(residuals) };
    } catch {
      return { status: 'unavailable' };
    }
  }

  private async loadExistingForCompareAndSwap(
    scope: ProcessOwnershipScope,
    processRef: string,
    context: ProcessOwnershipStorageCallContext
  ): Promise<
    | { readonly status: 'ready'; readonly record: StoredProcessOwnershipState | null }
    | { readonly status: 'conflict' }
  > {
    const byScope = await this.gateway.loadProcessOwnershipByScope(toStorageScope(scope), context);
    const byProcessRef = await this.gateway.loadProcessOwnershipByProcessRef(processRef, context);
    const records = [
      ...(byScope.status === 'found' ? [byScope.record] : []),
      ...(byProcessRef.status === 'found' ? [byProcessRef.record] : []),
    ];
    for (const record of records) decodeStoredState(record);
    if (records.length === 0) return { status: 'ready', record: null };
    if (records.length === 2 && !storedRecordsEqual(records[0], records[1])) {
      return { status: 'conflict' };
    }
    return { status: 'ready', record: records[0] };
  }

  private decodeLoaded(
    record: StoredProcessOwnershipState,
    expectedScope: ProcessOwnershipScope
  ): ProcessOwnershipLoadResult {
    const state = decodeStoredState(record);
    return isExactProcessOwnershipScope(state.intent.scope, expectedScope)
      ? { status: 'found', state }
      : { status: 'unavailable' };
  }
}

function toStoredState(state: ProcessOwnershipState): StoredProcessOwnershipState {
  return {
    scope: toStorageScope(state.intent.scope),
    processRef: state.intent.processRef,
    codecVersion: PROCESS_OWNERSHIP_STORAGE_CODEC_VERSION,
    stateVersion: state.stateVersion,
    revision: state.revision,
    phase: state.phase,
    stateJson: encodeProcessOwnershipState(state),
  };
}

function decodeStoredState(record: StoredProcessOwnershipState): ProcessOwnershipState {
  if (
    record.codecVersion !== PROCESS_OWNERSHIP_STORAGE_CODEC_VERSION ||
    record.codecVersion !== PROCESS_OWNERSHIP_STATE_CODEC_VERSION
  ) {
    throw new TypeError('process-ownership-storage-codec-version-invalid');
  }
  const state = decodeProcessOwnershipState(record.stateJson);
  if (
    state.stateVersion !== record.stateVersion ||
    state.revision !== record.revision ||
    state.phase !== record.phase ||
    state.intent.processRef !== parseOwnedProcessRef(record.processRef) ||
    !isExactProcessOwnershipScope(state.intent.scope, fromStorageScope(record.scope))
  ) {
    throw new TypeError('process-ownership-storage-metadata-mismatch');
  }
  return state;
}

function toStorageScope(scope: ProcessOwnershipScope): ProcessOwnershipStorageScope {
  return {
    teamId: scope.planRef.teamId,
    runId: scope.planRef.runId,
    planGeneration: scope.planRef.generation,
    planHash: scope.planRef.planHash,
    executionUnitId: scope.executionUnitId,
  };
}

function fromStorageScope(scope: ProcessOwnershipStorageScope): ProcessOwnershipScope {
  return {
    planRef: {
      teamId: scope.teamId as ProcessOwnershipScope['planRef']['teamId'],
      runId: scope.runId as ProcessOwnershipScope['planRef']['runId'],
      generation: scope.planGeneration,
      planHash: scope.planHash as ProcessOwnershipScope['planRef']['planHash'],
    },
    executionUnitId: scope.executionUnitId as ProcessOwnershipScope['executionUnitId'],
  };
}

function toStorageCallContext(
  context: ProcessOwnershipStoreContext
): ProcessOwnershipStorageCallContext {
  if (isCancellationRequested(context.cancellation)) {
    throw new Error('process-ownership-storage-call-cancelled');
  }
  const remainingTimeMs = remainingProcessSupervisionTime(context.deadline, context.clock);
  const deadlineAtMs = Date.now() + Math.ceil(remainingTimeMs);
  if (remainingTimeMs <= 0 || !Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= Date.now()) {
    throw new Error('process-ownership-storage-call-deadline-expired');
  }
  return Object.freeze({
    deadlineAtMs,
    isCancellationRequested: () => isCancellationRequested(context.cancellation),
  });
}

function storedRecordsEqual(
  left: StoredProcessOwnershipState,
  right: StoredProcessOwnershipState
): boolean {
  return (
    storageScopesEqual(left.scope, right.scope) &&
    left.processRef === right.processRef &&
    left.codecVersion === right.codecVersion &&
    left.stateVersion === right.stateVersion &&
    left.revision === right.revision &&
    left.phase === right.phase &&
    left.stateJson === right.stateJson
  );
}

function storageScopesEqual(
  left: ProcessOwnershipStorageScope,
  right: ProcessOwnershipStorageScope
): boolean {
  return (
    left.teamId === right.teamId &&
    left.runId === right.runId &&
    left.planGeneration === right.planGeneration &&
    left.planHash === right.planHash &&
    left.executionUnitId === right.executionUnitId
  );
}
