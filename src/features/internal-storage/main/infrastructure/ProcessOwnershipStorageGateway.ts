import {
  type ProcessOwnershipStorageCallContext,
  type ProcessOwnershipStorageCompareAndSwapRequest,
  type ProcessOwnershipStorageCompareAndSwapResult,
  type ProcessOwnershipStorageGateway,
  type ProcessOwnershipStorageLoadResult,
  type ProcessOwnershipStorageScope,
  type StoredProcessOwnershipState,
} from '../application/processOwnershipStorage';

import {
  parseProcessOwnershipWorkerResult,
  type ProcessOwnershipWorkerPayloadByOp,
} from './worker/internalStorageWorkerProtocol';

export {
  isProcessOwnershipStorageCallAdmitted,
  PROCESS_OWNERSHIP_STORAGE_CODEC_VERSION,
  type ProcessOwnershipStorageCallContext,
  type ProcessOwnershipStorageCompareAndSwapRequest,
  type ProcessOwnershipStorageCompareAndSwapResult,
  type ProcessOwnershipStorageGateway,
  type ProcessOwnershipStorageLoadResult,
  type ProcessOwnershipStorageScope,
  type StoredProcessOwnershipPhase,
  type StoredProcessOwnershipState,
} from '../application/processOwnershipStorage';

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
