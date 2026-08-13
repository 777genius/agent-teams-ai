import {
  type HostedTeamConfigurationStorageCreateRequest,
  type HostedTeamConfigurationStorageCreateResult,
  type HostedTeamConfigurationStorageDeleteRequest,
  type HostedTeamConfigurationStorageDeleteResult,
  type HostedTeamConfigurationStorageMutationOptions,
  type HostedTeamConfigurationStorageReadResult,
  type HostedTeamConfigurationStorageUpdateRequest,
  type HostedTeamConfigurationStorageUpdateResult,
  parseHostedTeamConfigurationStorageCreateRequest,
  parseHostedTeamConfigurationStorageDeleteRequest,
  parseHostedTeamConfigurationStorageUpdateRequest,
} from '../../contracts/hostedTeamConfigurationStorageContracts';
import {
  parseHostedTeamApprovalDecisionStorageRequest,
  parseHostedTeamApprovalDecisionStorageResult,
  parseHostedTeamApprovalDeliveryAcknowledgeRequest,
  parseHostedTeamApprovalDeliveryClaimRequest,
  parseHostedTeamApprovalDeliveryOperatorRequiredRequest,
  parseHostedTeamApprovalDeliveryReconciliationReadResult,
  parseHostedTeamApprovalDeliveryReconciliationRequest,
  parseHostedTeamApprovalDeliveryReconciliationSettleRequest,
  parseHostedTeamApprovalDeliveryRecord,
  parseHostedTeamApprovalPendingReadRecord,
  parseHostedTeamApprovalPendingReadRequest,
  parseHostedTeamApprovalPendingReadResult,
  parseHostedTeamApprovalPendingStorageRecord,
  parseHostedTeamApprovalPreviewReadRequest,
  parseHostedTeamApprovalPreviewReadResult,
  parseHostedTeamApprovalTimeoutAuditRequest,
  parseHostedTeamApprovalTimeoutAuditResult,
  parseHostedTeamApprovalVoidResult,
} from '../application/hostedTeamApprovalAuthorityStorage';

import type {
  HostedTeamApprovalDecisionStorageRequest,
  HostedTeamApprovalDecisionStorageResult,
  HostedTeamApprovalDeliveryAcknowledgeRequest,
  HostedTeamApprovalDeliveryClaimRequest,
  HostedTeamApprovalDeliveryOperatorRequiredRequest,
  HostedTeamApprovalDeliveryReconciliationReadResult,
  HostedTeamApprovalDeliveryReconciliationRequest,
  HostedTeamApprovalDeliveryReconciliationSettleRequest,
  HostedTeamApprovalDeliveryRecord,
  HostedTeamApprovalPendingReadRecord,
  HostedTeamApprovalPendingReadRequest,
  HostedTeamApprovalPendingReadResult,
  HostedTeamApprovalPendingStorageRecord,
  HostedTeamApprovalPreviewReadRequest,
  HostedTeamApprovalPreviewReadResult,
  HostedTeamApprovalTimeoutAuditRequest,
  HostedTeamApprovalTimeoutAuditResult,
} from '../../contracts/hostedTeamApprovalAuthorityStorageContracts';
import type {
  InternalStorageWorkerCallOptions,
  InternalStorageWorkerPayloadFor,
  InternalStorageWorkerTransport,
} from './InternalStorageWorkerTransport';
import type {
  HostedTeamConfigurationWorkerPayloadByOp,
  InternalStorageWorkerRequest,
} from './worker/internalStorageWorkerProtocol';
import type { TeamId, WorkspaceId } from '@shared/contracts/hosted';

type HostedTeamConfigurationCall = <TOp extends keyof HostedTeamConfigurationWorkerPayloadByOp>(
  op: TOp,
  payload: HostedTeamConfigurationWorkerPayloadByOp[TOp],
  options?: InternalStorageWorkerCallOptions
) => Promise<unknown>;

export class HostedTeamStorageWorkerClient {
  constructor(
    private readonly callWorker: InternalStorageWorkerTransport['call'],
    private readonly callHostedTeamConfigurationWorker: HostedTeamConfigurationCall
  ) {}

  callHostedTeamConfiguration<TOp extends keyof HostedTeamConfigurationWorkerPayloadByOp>(
    op: TOp,
    payload: HostedTeamConfigurationWorkerPayloadByOp[TOp],
    options: InternalStorageWorkerCallOptions = {}
  ): Promise<unknown> {
    return this.call(op, payload as InternalStorageWorkerPayloadFor<TOp>, options);
  }

  async createHostedTeamConfiguration(
    request: HostedTeamConfigurationStorageCreateRequest,
    options: HostedTeamConfigurationStorageMutationOptions
  ): Promise<HostedTeamConfigurationStorageCreateResult> {
    const input = parseHostedTeamConfigurationStorageCreateRequest(request);
    return (await this.callHostedTeamConfigurationWorker('hostedTeamConfiguration.create', input, {
      signal: options.signal,
      timeoutAtMs: input.deadlineAtMs,
    })) as HostedTeamConfigurationStorageCreateResult;
  }

  async readHostedTeamConfiguration(input: {
    readonly workspaceId: WorkspaceId;
    readonly teamId: TeamId;
  }): Promise<HostedTeamConfigurationStorageReadResult> {
    return (await this.callHostedTeamConfigurationWorker(
      'hostedTeamConfiguration.read',
      input
    )) as HostedTeamConfigurationStorageReadResult;
  }

  async updateHostedTeamConfiguration(
    request: HostedTeamConfigurationStorageUpdateRequest,
    options: HostedTeamConfigurationStorageMutationOptions
  ): Promise<HostedTeamConfigurationStorageUpdateResult> {
    const input = parseHostedTeamConfigurationStorageUpdateRequest(request);
    return (await this.callHostedTeamConfigurationWorker('hostedTeamConfiguration.update', input, {
      signal: options.signal,
      timeoutAtMs: input.deadlineAtMs,
    })) as HostedTeamConfigurationStorageUpdateResult;
  }

  async deleteHostedTeamConfiguration(
    request: HostedTeamConfigurationStorageDeleteRequest,
    options: HostedTeamConfigurationStorageMutationOptions
  ): Promise<HostedTeamConfigurationStorageDeleteResult> {
    const input = parseHostedTeamConfigurationStorageDeleteRequest(request);
    return (await this.callHostedTeamConfigurationWorker('hostedTeamConfiguration.delete', input, {
      signal: options.signal,
      timeoutAtMs: input.deadlineAtMs,
    })) as HostedTeamConfigurationStorageDeleteResult;
  }

  async hostedTeamApprovalObserve(
    record: HostedTeamApprovalPendingStorageRecord
  ): Promise<HostedTeamApprovalPendingReadRecord> {
    const input = parseHostedTeamApprovalPendingStorageRecord(record);
    return parseHostedTeamApprovalPendingReadRecord(
      await this.call('hostedTeamApprovalAuthority.observe', input, {
        timeoutAtMs: input.deadlineAtMs,
      })
    );
  }

  async hostedTeamApprovalReadPending(
    request: HostedTeamApprovalPendingReadRequest
  ): Promise<HostedTeamApprovalPendingReadResult> {
    const input = parseHostedTeamApprovalPendingReadRequest(request);
    return parseHostedTeamApprovalPendingReadResult(
      await this.call('hostedTeamApprovalAuthority.readPending', input, {
        timeoutAtMs: input.deadlineAtMs,
      })
    );
  }

  async hostedTeamApprovalReadPreview(
    request: HostedTeamApprovalPreviewReadRequest
  ): Promise<HostedTeamApprovalPreviewReadResult> {
    const input = parseHostedTeamApprovalPreviewReadRequest(request);
    return parseHostedTeamApprovalPreviewReadResult(
      await this.call('hostedTeamApprovalAuthority.readPreview', input, {
        timeoutAtMs: input.deadlineAtMs,
      })
    );
  }

  async hostedTeamApprovalDecide(
    request: HostedTeamApprovalDecisionStorageRequest
  ): Promise<HostedTeamApprovalDecisionStorageResult> {
    const input = parseHostedTeamApprovalDecisionStorageRequest(request);
    return parseHostedTeamApprovalDecisionStorageResult(
      await this.call('hostedTeamApprovalAuthority.decide', input, {
        timeoutAtMs: input.deadlineAtMs,
      })
    );
  }

  async hostedTeamApprovalClaimDeliveries(
    request: HostedTeamApprovalDeliveryClaimRequest
  ): Promise<readonly HostedTeamApprovalDeliveryRecord[]> {
    const input = parseHostedTeamApprovalDeliveryClaimRequest(request);
    const value = await this.call('hostedTeamApprovalAuthority.claimDeliveries', input, {
      timeoutAtMs: input.deadlineAtMs,
    });
    if (
      !Array.isArray(value) ||
      value.length > input.limit ||
      Reflect.ownKeys(value).length !== value.length + 1
    ) {
      throw new TypeError('hosted-team-approval-storage-delivery-claim-result-invalid');
    }
    return Object.freeze(value.map(parseHostedTeamApprovalDeliveryRecord));
  }

  async hostedTeamApprovalAcknowledgeDelivery(
    request: HostedTeamApprovalDeliveryAcknowledgeRequest
  ): Promise<void> {
    const input = parseHostedTeamApprovalDeliveryAcknowledgeRequest(request);
    parseHostedTeamApprovalVoidResult(
      await this.call('hostedTeamApprovalAuthority.acknowledgeDelivery', input, {
        timeoutAtMs: input.deadlineAtMs,
      })
    );
  }

  async hostedTeamApprovalMarkDeliveryOperatorRequired(
    request: HostedTeamApprovalDeliveryOperatorRequiredRequest
  ): Promise<void> {
    const input = parseHostedTeamApprovalDeliveryOperatorRequiredRequest(request);
    parseHostedTeamApprovalVoidResult(
      await this.call('hostedTeamApprovalAuthority.markDeliveryOperatorRequired', input, {
        timeoutAtMs: input.deadlineAtMs,
      })
    );
  }

  async hostedTeamApprovalReadDeliveryReconciliation(
    request: HostedTeamApprovalDeliveryReconciliationRequest
  ): Promise<HostedTeamApprovalDeliveryReconciliationReadResult> {
    const input = parseHostedTeamApprovalDeliveryReconciliationRequest(request);
    return parseHostedTeamApprovalDeliveryReconciliationReadResult(
      await this.call('hostedTeamApprovalAuthority.readDeliveryReconciliation', input, {
        timeoutAtMs: input.deadlineAtMs,
      })
    );
  }

  async hostedTeamApprovalSettleDeliveryReconciliation(
    request: HostedTeamApprovalDeliveryReconciliationSettleRequest
  ): Promise<void> {
    const input = parseHostedTeamApprovalDeliveryReconciliationSettleRequest(request);
    parseHostedTeamApprovalVoidResult(
      await this.call('hostedTeamApprovalAuthority.settleDeliveryReconciliation', input, {
        timeoutAtMs: input.deadlineAtMs,
      })
    );
  }

  async hostedTeamApprovalAuditTimeouts(
    request: HostedTeamApprovalTimeoutAuditRequest
  ): Promise<HostedTeamApprovalTimeoutAuditResult> {
    const input = parseHostedTeamApprovalTimeoutAuditRequest(request);
    return parseHostedTeamApprovalTimeoutAuditResult(
      await this.call('hostedTeamApprovalAuthority.auditTimeouts', input, {
        timeoutAtMs: input.deadlineAtMs,
      })
    );
  }

  private call<TOp extends InternalStorageWorkerRequest['op']>(
    op: TOp,
    payload: InternalStorageWorkerPayloadFor<TOp>,
    options: InternalStorageWorkerCallOptions = {}
  ): Promise<unknown> {
    return this.callWorker(op, payload, options);
  }
}
