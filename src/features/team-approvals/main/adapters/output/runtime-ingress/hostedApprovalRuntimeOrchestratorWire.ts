import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  isRuntimeIngressPermissionOutboxAcknowledgeRequest,
  isRuntimeIngressPermissionOutboxClaimRequest,
  isRuntimeIngressPermissionOutboxRecord,
  RUNTIME_INGRESS_PERMISSION_OUTBOX_MAX_CLAIM_BYTES,
  RUNTIME_INGRESS_PERMISSION_OUTBOX_MAX_RECORD_BYTES,
  type RuntimeIngressPermissionOutboxAcknowledgeRequest,
  type RuntimeIngressPermissionOutboxAcknowledgeResult,
  type RuntimeIngressPermissionOutboxClaimRequest,
  type RuntimeIngressPermissionOutboxRecord,
} from '@features/team-runtime-control';
import {
  parseRuntimePermissionApprovalIngressAuthority,
  type RuntimePermissionApprovalIngressAuthority,
} from '@features/team-runtime-control/contracts';
import {
  type ActorId,
  type BootId,
  type DeploymentId,
  parseActorId,
  parseBootId,
  parseDeploymentId,
  parseRunId,
  parseTeamId,
  parseWorkspaceId,
  type TeamId,
  type WorkspaceId,
} from '@shared/contracts/hosted';

import type {
  HostedApprovalDecisionExternalLifecycleDeliveryPort,
  HostedRuntimePermissionIngressAuthorityPort,
} from '../../../ports/HostedTeamApprovalRuntimeBridgePorts';
import type {
  HostedTeamApprovalAuthorityScope,
  HostedTeamApprovalStorageDecision,
} from '@features/internal-storage/contracts';
import type { OrchestratorLifecycleOwnerProofKey } from '@features/team-lifecycle/main/hosted';

export const HOSTED_APPROVAL_RUNTIME_WIRE_SCHEMA_VERSION = 4 as const;
export const HOSTED_APPROVAL_RUNTIME_OWNER_PROOF_DOMAIN =
  'agent-teams.hosted-runtime-approval.owner-proof/v1' as const;

export const HOSTED_APPROVAL_RUNTIME_OPERATIONS = Object.freeze([
  'approval_ingress_claim',
  'approval_ingress_ack',
  'approval_ingress_authority_resolve',
  'approval_decision_deliver',
  'approval_decision_reconcile',
] as const);

export type HostedApprovalRuntimeOperation = (typeof HOSTED_APPROVAL_RUNTIME_OPERATIONS)[number];

export interface HostedApprovalRuntimeMountBinding {
  readonly mountGeneration: number;
  readonly declaredRootHash: string;
}

/** Server-only authority copied from the admitted lifecycle-owner bootstrap. */
export interface HostedApprovalRuntimeWireAuthority {
  readonly actorId: ActorId;
  readonly deploymentId: DeploymentId;
  readonly bootId: BootId;
  readonly restoreGeneration: number;
  readonly workspaceId: WorkspaceId;
  readonly mountBinding: HostedApprovalRuntimeMountBinding;
}

export type HostedApprovalDecisionDeliveryRequest = Parameters<
  HostedApprovalDecisionExternalLifecycleDeliveryPort['deliverRuntimePermissionDecision']
>[0];
export type HostedApprovalDecisionDeliveryResult = Awaited<
  ReturnType<
    HostedApprovalDecisionExternalLifecycleDeliveryPort['deliverRuntimePermissionDecision']
  >
>;
export type HostedApprovalIngressAuthorityResult = Awaited<
  ReturnType<HostedRuntimePermissionIngressAuthorityPort['resolvePersistedIngressAuthority']>
>;
export interface HostedApprovalDecisionReconciliationRequest {
  readonly reconciliationRef: string;
  readonly providerDeliveryId: string;
  readonly partition: Readonly<{ readonly teamId: TeamId; readonly runId: string }>;
}
export type HostedApprovalDecisionReconciliationResult =
  | Readonly<{ readonly status: 'delivered' | 'not_delivered' }>
  | Readonly<{ readonly status: 'operator_required' | 'unavailable' }>;

export interface HostedApprovalRuntimeRequestPayloadByOperation {
  readonly approval_ingress_claim: RuntimeIngressPermissionOutboxClaimRequest;
  readonly approval_ingress_ack: RuntimeIngressPermissionOutboxAcknowledgeRequest;
  readonly approval_ingress_authority_resolve: RuntimePermissionApprovalIngressAuthority;
  readonly approval_decision_deliver: HostedApprovalDecisionDeliveryRequest;
  readonly approval_decision_reconcile: HostedApprovalDecisionReconciliationRequest;
}

export interface HostedApprovalRuntimeResponsePayloadByOperation {
  readonly approval_ingress_claim: readonly RuntimeIngressPermissionOutboxRecord[];
  readonly approval_ingress_ack: RuntimeIngressPermissionOutboxAcknowledgeResult;
  readonly approval_ingress_authority_resolve: HostedApprovalIngressAuthorityResult;
  readonly approval_decision_deliver: HostedApprovalDecisionDeliveryResult;
  readonly approval_decision_reconcile: HostedApprovalDecisionReconciliationResult;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const APPROVAL_ID = /^approval_[0-9a-f]{32}$/;
const APPROVAL_GENERATION = /^generation_runtime-permission-[0-9a-f]{64}$/;
const AUTHORITY_GENERATION = /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/;
const DELIVERY_REF = /^delivery_ref_[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/;
const EXCHANGE_ID = /^approval-request_[0-9a-f]{32}$/;
const RECONCILIATION_REF = /^approval-reconciliation_[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;
const HASH = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<PropertyKey, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function parseIdentifier(value: unknown, diagnostic: string, pattern = IDENTIFIER): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError(diagnostic);
  return value;
}

function parsePositiveInteger(value: unknown, diagnostic: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(diagnostic);
  return value as number;
}

export function parseHostedApprovalRuntimeWireAuthority(
  value: unknown
): HostedApprovalRuntimeWireAuthority {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'actorId',
      'deploymentId',
      'bootId',
      'restoreGeneration',
      'workspaceId',
      'mountBinding',
    ]) ||
    !Number.isSafeInteger(value.restoreGeneration) ||
    (value.restoreGeneration as number) < 0 ||
    !isRecord(value.mountBinding) ||
    !hasExactKeys(value.mountBinding, ['mountGeneration', 'declaredRootHash']) ||
    typeof value.mountBinding.declaredRootHash !== 'string' ||
    !HASH.test(value.mountBinding.declaredRootHash)
  ) {
    throw new TypeError('hosted-approval-runtime-wire-authority-invalid');
  }
  return Object.freeze({
    actorId: parseActorId(value.actorId),
    deploymentId: parseDeploymentId(value.deploymentId),
    bootId: parseBootId(value.bootId),
    restoreGeneration: value.restoreGeneration as number,
    workspaceId: parseWorkspaceId(value.workspaceId),
    mountBinding: Object.freeze({
      mountGeneration: parsePositiveInteger(
        value.mountBinding.mountGeneration,
        'hosted-approval-runtime-wire-mount-generation-invalid'
      ),
      declaredRootHash: value.mountBinding.declaredRootHash,
    }),
  });
}

export function sameHostedApprovalRuntimeWireAuthority(
  left: HostedApprovalRuntimeWireAuthority,
  right: HostedApprovalRuntimeWireAuthority
): boolean {
  return (
    left.actorId === right.actorId &&
    left.deploymentId === right.deploymentId &&
    left.bootId === right.bootId &&
    left.restoreGeneration === right.restoreGeneration &&
    left.workspaceId === right.workspaceId &&
    left.mountBinding.mountGeneration === right.mountBinding.mountGeneration &&
    left.mountBinding.declaredRootHash === right.mountBinding.declaredRootHash
  );
}

function parseScope(value: unknown): HostedTeamApprovalAuthorityScope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'principalId',
      'workspaceId',
      'teamId',
      'authorityGeneration',
      'restoreGeneration',
    ]) ||
    !Number.isSafeInteger(value.restoreGeneration) ||
    (value.restoreGeneration as number) < 0
  ) {
    throw new TypeError('hosted-approval-runtime-scope-invalid');
  }
  return Object.freeze({
    principalId: parseActorId(value.principalId),
    workspaceId: parseWorkspaceId(value.workspaceId),
    teamId: parseTeamId(value.teamId),
    authorityGeneration: parseIdentifier(
      value.authorityGeneration,
      'hosted-approval-runtime-authority-generation-invalid',
      AUTHORITY_GENERATION
    ),
    restoreGeneration: value.restoreGeneration as number,
  });
}

function parseDecision(value: unknown): HostedTeamApprovalStorageDecision {
  if (value !== 'allow' && value !== 'deny' && value !== 'timeout') {
    throw new TypeError('hosted-approval-runtime-decision-invalid');
  }
  return value;
}

export function parseHostedApprovalDecisionDeliveryRequest(
  value: unknown
): HostedApprovalDecisionDeliveryRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'providerDeliveryId',
      'reconciliationRef',
      'principal',
      'deliveryRef',
      'approvalId',
      'approvalGeneration',
      'decision',
      'partition',
      'requestId',
    ]) ||
    !isRecord(value.partition) ||
    !hasExactKeys(value.partition, ['teamId', 'runId'])
  ) {
    throw new TypeError('hosted-approval-runtime-delivery-request-invalid');
  }
  return Object.freeze({
    providerDeliveryId: parseIdentifier(
      value.providerDeliveryId,
      'hosted-approval-runtime-provider-delivery-id-invalid',
      IDENTIFIER
    ),
    reconciliationRef: parseIdentifier(
      value.reconciliationRef,
      'hosted-approval-runtime-reconciliation-ref-invalid',
      RECONCILIATION_REF
    ),
    principal: parseDeliveryPrincipal(value.principal, value.decision),
    deliveryRef: parseIdentifier(
      value.deliveryRef,
      'hosted-approval-runtime-delivery-ref-invalid',
      DELIVERY_REF
    ),
    approvalId: parseIdentifier(
      value.approvalId,
      'hosted-approval-runtime-approval-id-invalid',
      APPROVAL_ID
    ),
    approvalGeneration: parseIdentifier(
      value.approvalGeneration,
      'hosted-approval-runtime-approval-generation-invalid',
      APPROVAL_GENERATION
    ),
    decision: parseDecision(value.decision),
    partition: Object.freeze({
      teamId: parseTeamId(value.partition.teamId),
      runId: parseRunId(value.partition.runId),
    }),
    requestId: parseIdentifier(value.requestId, 'hosted-approval-runtime-request-id-invalid'),
  });
}

function parseReconciliationRequest(value: unknown): HostedApprovalDecisionReconciliationRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['reconciliationRef', 'providerDeliveryId', 'partition']) ||
    !isRecord(value.partition) ||
    !hasExactKeys(value.partition, ['teamId', 'runId'])
  ) {
    throw new TypeError('hosted-approval-runtime-reconciliation-request-invalid');
  }
  return Object.freeze({
    reconciliationRef: parseIdentifier(
      value.reconciliationRef,
      'hosted-approval-runtime-reconciliation-ref-invalid',
      RECONCILIATION_REF
    ),
    providerDeliveryId: parseIdentifier(
      value.providerDeliveryId,
      'hosted-approval-runtime-provider-delivery-id-invalid'
    ),
    partition: Object.freeze({
      teamId: parseTeamId(value.partition.teamId),
      runId: parseRunId(value.partition.runId),
    }),
  });
}

function parseDeliveryPrincipal(
  value: unknown,
  decision: unknown
): HostedApprovalDecisionDeliveryRequest['principal'] {
  if (!isRecord(value)) throw new TypeError('hosted-approval-runtime-principal-invalid');
  if (
    value.kind === 'operator' &&
    hasExactKeys(value, ['kind', 'actorId']) &&
    decision !== 'timeout'
  ) {
    return Object.freeze({ kind: 'operator', actorId: parseActorId(value.actorId) });
  }
  if (value.kind === 'system_timeout' && hasExactKeys(value, ['kind']) && decision === 'timeout') {
    return Object.freeze({ kind: 'system_timeout' });
  }
  throw new TypeError('hosted-approval-runtime-principal-invalid');
}

export function parseHostedApprovalRuntimeRequestPayload<
  Operation extends HostedApprovalRuntimeOperation,
>(operation: Operation, value: unknown): HostedApprovalRuntimeRequestPayloadByOperation[Operation] {
  switch (operation) {
    case 'approval_ingress_claim':
      if (!isRuntimeIngressPermissionOutboxClaimRequest(value)) throw new TypeError();
      return Object.freeze({
        ...value,
      }) as HostedApprovalRuntimeRequestPayloadByOperation[Operation];
    case 'approval_ingress_ack':
      if (!isRuntimeIngressPermissionOutboxAcknowledgeRequest(value)) throw new TypeError();
      return Object.freeze({
        ...value,
      }) as HostedApprovalRuntimeRequestPayloadByOperation[Operation];
    case 'approval_ingress_authority_resolve':
      return parseRuntimePermissionApprovalIngressAuthority(
        value
      ) as HostedApprovalRuntimeRequestPayloadByOperation[Operation];
    case 'approval_decision_deliver':
      return parseHostedApprovalDecisionDeliveryRequest(
        value
      ) as HostedApprovalRuntimeRequestPayloadByOperation[Operation];
    case 'approval_decision_reconcile':
      return parseReconciliationRequest(
        value
      ) as HostedApprovalRuntimeRequestPayloadByOperation[Operation];
  }
}

export function parseHostedApprovalRuntimeResponsePayload<
  Operation extends HostedApprovalRuntimeOperation,
>(
  operation: Operation,
  value: unknown,
  request: HostedApprovalRuntimeRequestPayloadByOperation[Operation],
  authority: HostedApprovalRuntimeWireAuthority
): HostedApprovalRuntimeResponsePayloadByOperation[Operation] {
  if (operation === 'approval_ingress_claim') {
    const claim = request as RuntimeIngressPermissionOutboxClaimRequest;
    if (!Array.isArray(value) || value.length > claim.limit || value.length > 100) {
      throw new TypeError();
    }
    const outboxIds = new Set<string>();
    const records = value.map((record) => {
      if (
        !isRuntimeIngressPermissionOutboxRecord(record) ||
        new TextEncoder().encode(JSON.stringify(record)).byteLength >
          RUNTIME_INGRESS_PERMISSION_OUTBOX_MAX_RECORD_BYTES ||
        record.lease === null ||
        record.lease.generation < 1 ||
        record.lease.ownerId !== claim.ownerId ||
        record.lease.leaseToken !== claim.leaseToken ||
        record.acknowledgedAtIso !== null ||
        outboxIds.has(record.outboxId) ||
        record.authority.deploymentId !== authority.deploymentId
      ) {
        throw new TypeError();
      }
      outboxIds.add(record.outboxId);
      return Object.freeze(record);
    });
    if (
      new TextEncoder().encode(JSON.stringify(records)).byteLength >
      RUNTIME_INGRESS_PERMISSION_OUTBOX_MAX_CLAIM_BYTES
    ) {
      throw new TypeError();
    }
    return Object.freeze(records) as HostedApprovalRuntimeResponsePayloadByOperation[Operation];
  }
  if (operation === 'approval_ingress_ack') {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['status']) ||
      !['acknowledged', 'already_acknowledged', 'conflict', 'unavailable'].includes(
        value.status as string
      )
    ) {
      throw new TypeError();
    }
    return Object.freeze({
      status: value.status,
    }) as HostedApprovalRuntimeResponsePayloadByOperation[Operation];
  }
  if (operation === 'approval_ingress_authority_resolve') {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, value.status === 'resolved' ? ['status', 'scope'] : ['status'])
    ) {
      throw new TypeError();
    }
    if (value.status === 'resolved') {
      const scope = parseScope(value.scope);
      const ingress = request as RuntimePermissionApprovalIngressAuthority;
      if (
        scope.teamId !== ingress.teamId ||
        scope.workspaceId !== authority.workspaceId ||
        scope.restoreGeneration !== authority.restoreGeneration
      ) {
        throw new TypeError();
      }
      return Object.freeze({
        status: 'resolved',
        scope,
      }) as HostedApprovalRuntimeResponsePayloadByOperation[Operation];
    }
    if (!['stale_generation', 'wrong_lane', 'unavailable'].includes(value.status as string)) {
      throw new TypeError();
    }
    return Object.freeze({
      status: value.status,
    }) as HostedApprovalRuntimeResponsePayloadByOperation[Operation];
  }
  if (operation === 'approval_decision_reconcile') {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['status']) ||
      !['delivered', 'not_delivered', 'operator_required', 'unavailable'].includes(
        value.status as string
      )
    ) {
      throw new TypeError();
    }
    return Object.freeze({
      status: value.status,
    }) as HostedApprovalRuntimeResponsePayloadByOperation[Operation];
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      value.status === 'operator_required' ? ['status', 'reconciliationRef'] : ['status']
    ) ||
    ![
      'delivered',
      'idempotent_replay',
      'stale_generation',
      'expired',
      'wrong_lane',
      'self_approval',
      'unavailable',
      'operator_required',
    ].includes(value.status as string)
  ) {
    throw new TypeError();
  }
  if (value.status === 'operator_required') {
    const requestRef = (request as HostedApprovalDecisionDeliveryRequest).reconciliationRef;
    if (value.reconciliationRef !== requestRef) throw new TypeError();
    return Object.freeze({
      status: 'operator_required',
      reconciliationRef: parseIdentifier(
        value.reconciliationRef,
        'hosted-approval-runtime-reconciliation-ref-invalid',
        RECONCILIATION_REF
      ),
    }) as HostedApprovalRuntimeResponsePayloadByOperation[Operation];
  }
  return Object.freeze({
    status: value.status,
  }) as HostedApprovalRuntimeResponsePayloadByOperation[Operation];
}

export function createHostedApprovalRuntimeOwnerProof(
  key: OrchestratorLifecycleOwnerProofKey,
  direction: 'request' | 'response',
  serializedUnsignedEnvelope: string
): string {
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(
      `${HOSTED_APPROVAL_RUNTIME_OWNER_PROOF_DOMAIN}\u0000${direction}\u0000${serializedUnsignedEnvelope}`
    )
    .digest('hex');
}

export function hostedApprovalRuntimeOwnerProofMatches(expected: string, actual: unknown): boolean {
  return (
    typeof actual === 'string' &&
    HASH.test(actual) &&
    timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))
  );
}

export function parseHostedApprovalRuntimeExchangeId(value: unknown): string {
  return parseIdentifier(value, 'hosted-approval-runtime-exchange-id-invalid', EXCHANGE_ID);
}

/** Product-only candidate fixture; it is not an owner-compatible cross-repository vector. */
export function hostedApprovalRuntimeProductCandidateRequest(): Readonly<{
  schemaVersion: 4;
  exchangeId: string;
  operation: 'approval_ingress_ack';
  ownerBinding: Readonly<{
    ownerAuthority: string;
    ownerGeneration: number;
    ownerSessionId: string;
    socketIdentity: Readonly<{
      device: string;
      inode: string;
      uid: number;
      gid: number;
      mode: number;
    }>;
  }>;
  authority: HostedApprovalRuntimeWireAuthority;
  payload: RuntimeIngressPermissionOutboxAcknowledgeRequest;
}> {
  return Object.freeze({
    schemaVersion: HOSTED_APPROVAL_RUNTIME_WIRE_SCHEMA_VERSION,
    exchangeId: `approval-request_${'6'.repeat(32)}`,
    operation: 'approval_ingress_ack',
    ownerBinding: Object.freeze({
      ownerAuthority: 'owner-authority_approval-wire',
      ownerGeneration: 7,
      ownerSessionId: 'owner-session_approval-wire',
      socketIdentity: Object.freeze({
        device: '11',
        inode: '12',
        uid: 501,
        gid: 20,
        mode: 0o600,
      }),
    }),
    authority: Object.freeze({
      actorId: parseActorId('actor_approval-wire'),
      deploymentId: parseDeploymentId('deployment_approval-wire'),
      bootId: parseBootId('boot_approval-wire'),
      restoreGeneration: 4,
      workspaceId: parseWorkspaceId(`workspace_${'3'.repeat(32)}`),
      mountBinding: Object.freeze({
        mountGeneration: 9,
        declaredRootHash: 'a'.repeat(64),
      }),
    }),
    payload: Object.freeze({
      outboxId: `runtime_permission:effect:${'5'.repeat(64)}`,
      generation: 3,
      ownerId: 'owner_approval-wire',
      leaseToken: 'lease_approval-wire',
    }),
  });
}
