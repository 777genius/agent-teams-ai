import {
  parseActorId,
  parseBootId,
  parseDeploymentId,
  parseRevision,
  parseTeamId,
  parseWorkspaceId,
  type QueryContext,
  type Revision,
  type TeamId,
  type WorkspaceId,
} from '@shared/contracts/hosted';

import {
  HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
  HOSTED_LIFECYCLE_CONFLICT_REASONS,
  type HostedLifecycleCommand,
  type HostedLifecycleConflictReason,
  type HostedLifecycleControlStateRequest,
  type HostedLifecycleControlStateResult,
  type HostedLifecyclePrepareRequest,
  type HostedLifecyclePrepareResult,
  type HostedLifecycleProgressRequest,
  type HostedLifecycleProgressResult,
  parseHostedLifecycleCommandPublicResult,
  parseHostedLifecycleControlState,
  parseHostedLifecyclePreparedState,
  parseHostedLifecycleProvisioningStatus,
} from '../../../../contracts/hosted-lifecycle-commands';
import {
  type HostedLifecycleCommandAuthorization,
  type HostedLifecycleCommandAuthorizationResult,
  type HostedLifecycleCommandGatewayExecutionResult,
  type HostedLifecycleCommandRevalidationResult,
  type HostedLifecycleOwnerEffectFence,
} from '../../../../core/application/ports/HostedLifecycleCommandGatewayPort';
import {
  hasExactOrchestratorLifecycleKeys as hasExactKeys,
  isOrchestratorLifecycleRecord as isRecord,
  type OrchestratorLifecycleDurableCommand,
  parseHostedLifecycleAuthorizationGeneration,
  parseHostedLifecycleGrantId,
  parseHostedLifecycleOwnerEffectFence,
  parseOrchestratorMountGeneration,
  parseOrchestratorRestoreGeneration,
  parseOrchestratorRetryAfterMs,
  requireOrchestratorLifecycleAuthorityRevision as requireAuthorityRevision,
  requireOrchestratorLifecycleDurableCommandEcho,
  sameHostedLifecycleAuthorization,
  sameHostedLifecycleOwnerEffectFence,
} from '../../../application/ExecuteHostedLifecycleCommand';

export const ORCHESTRATOR_LIFECYCLE_WIRE_SCHEMA_VERSION = 2;

export type OrchestratorLifecycleOperation =
  | 'control_state'
  | 'prepare_provisioning'
  | 'get_provisioning_status'
  | 'authorize'
  | 'revalidate'
  | 'replay_lookup'
  | 'execute'
  | 'release';

export type OrchestratorLifecycleDurableCommandOutcome =
  | { readonly kind: 'not_started' }
  | { readonly kind: 'started' }
  | { readonly kind: 'operator_required' }
  | { readonly kind: 'idempotency_mismatch' }
  | {
      readonly kind: 'settled';
      readonly execution: Extract<HostedLifecycleCommandGatewayExecutionResult, { kind: 'result' }>;
    };

export type OrchestratorLifecycleReleaseOutcome = Readonly<{
  kind: 'released' | 'already_released' | 'operator_required';
  authorization: HostedLifecycleCommandAuthorization;
}>;

export interface OrchestratorLifecycleResponseAuthority {
  readonly actorId: QueryContext['actorId'];
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly deploymentId: QueryContext['deploymentId'];
  readonly restoreGeneration: number;
  readonly mountGeneration: number;
  readonly bootId: QueryContext['bootId'];
  readonly resourceRevision: Revision | null;
  readonly ownerEffectFence: HostedLifecycleOwnerEffectFence;
}

export function parseOrchestratorLifecycleResponseAuthority(
  value: unknown,
  context: QueryContext,
  workspaceId: WorkspaceId,
  teamId: TeamId,
  restoreGeneration: number,
  mountGeneration: number,
  ownerEffectFence: HostedLifecycleOwnerEffectFence
): OrchestratorLifecycleResponseAuthority {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'actorId',
      'workspaceId',
      'teamId',
      'deploymentId',
      'restoreGeneration',
      'mountGeneration',
      'bootId',
      'resourceRevision',
      'ownerEffectFence',
    ])
  ) {
    throw new TypeError('orchestrator-lifecycle-response-authority-invalid');
  }
  const authority = Object.freeze({
    actorId: parseActorId(value.actorId),
    workspaceId: parseWorkspaceId(value.workspaceId),
    teamId: parseTeamId(value.teamId),
    deploymentId: parseDeploymentId(value.deploymentId),
    restoreGeneration: parseOrchestratorRestoreGeneration(value.restoreGeneration),
    mountGeneration: parseOrchestratorMountGeneration(value.mountGeneration),
    bootId: parseBootId(value.bootId),
    resourceRevision:
      value.resourceRevision === null ? null : parseRevision(value.resourceRevision),
    ownerEffectFence: parseHostedLifecycleOwnerEffectFence(value.ownerEffectFence),
  });
  if (
    authority.actorId !== context.actorId ||
    authority.workspaceId !== workspaceId ||
    authority.teamId !== teamId ||
    authority.deploymentId !== context.deploymentId ||
    authority.restoreGeneration !== restoreGeneration ||
    authority.mountGeneration !== mountGeneration ||
    authority.bootId !== context.bootId ||
    !sameHostedLifecycleOwnerEffectFence(authority.ownerEffectFence, ownerEffectFence)
  ) {
    throw new TypeError('orchestrator-lifecycle-response-authority-scope-invalid');
  }
  return authority;
}

function parseAuthorization(
  value: unknown,
  command: HostedLifecycleCommand,
  context: QueryContext,
  restoreGeneration: number,
  mountGeneration: number,
  ownerEffectFence: HostedLifecycleOwnerEffectFence
): HostedLifecycleCommandAuthorization {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'grantId',
      'authorizationGeneration',
      'deploymentId',
      'bootId',
      'resourceRevision',
      'actorId',
      'workspaceId',
      'teamId',
      'restoreGeneration',
      'mountGeneration',
      'ownerEffectFence',
    ])
  ) {
    throw new TypeError('orchestrator-lifecycle-authorization-invalid');
  }
  const authorization = Object.freeze({
    grantId: parseHostedLifecycleGrantId(value.grantId),
    authorizationGeneration: parseHostedLifecycleAuthorizationGeneration(
      value.authorizationGeneration
    ),
    deploymentId: parseDeploymentId(value.deploymentId),
    bootId: parseBootId(value.bootId),
    resourceRevision: parseRevision(value.resourceRevision),
    actorId: parseActorId(value.actorId),
    workspaceId: parseWorkspaceId(value.workspaceId),
    teamId: parseTeamId(value.teamId),
    restoreGeneration: parseOrchestratorRestoreGeneration(value.restoreGeneration),
    mountGeneration: parseOrchestratorMountGeneration(value.mountGeneration),
    ownerEffectFence: parseHostedLifecycleOwnerEffectFence(value.ownerEffectFence),
  });
  if (
    authorization.actorId !== context.actorId ||
    authorization.workspaceId !== command.workspaceId ||
    authorization.teamId !== command.teamId ||
    authorization.deploymentId !== context.deploymentId ||
    authorization.bootId !== context.bootId ||
    authorization.restoreGeneration !== restoreGeneration ||
    authorization.mountGeneration !== mountGeneration ||
    !sameHostedLifecycleOwnerEffectFence(authorization.ownerEffectFence, ownerEffectFence)
  ) {
    throw new TypeError('orchestrator-lifecycle-authorization-scope-invalid');
  }
  return authorization;
}

function parseConflict(value: Record<PropertyKey, unknown>): {
  readonly kind: 'conflict';
  readonly reason: HostedLifecycleConflictReason;
  readonly currentRevision: Revision | null;
} {
  if (
    !hasExactKeys(value, ['schemaVersion', 'kind', 'reason', 'currentRevision']) ||
    value.schemaVersion !== ORCHESTRATOR_LIFECYCLE_WIRE_SCHEMA_VERSION ||
    !HOSTED_LIFECYCLE_CONFLICT_REASONS.includes(value.reason as HostedLifecycleConflictReason)
  ) {
    throw new TypeError('orchestrator-lifecycle-conflict-invalid');
  }
  return Object.freeze({
    kind: 'conflict',
    reason: value.reason as HostedLifecycleConflictReason,
    currentRevision: value.currentRevision === null ? null : parseRevision(value.currentRevision),
  });
}

export function parseOrchestratorLifecycleControlStateResponse(
  value: unknown,
  authority: OrchestratorLifecycleResponseAuthority,
  request: HostedLifecycleControlStateRequest,
  context: QueryContext
): HostedLifecycleControlStateResult {
  if (isRecord(value) && value.kind === 'control_state') {
    const parsed = parseHostedLifecycleControlState(value, {
      ...request,
      deploymentId: context.deploymentId,
      bootId: context.bootId,
    });
    if (parsed.ok) {
      requireAuthorityRevision(authority, parsed.value.resourceRevision);
      return parsed.value;
    }
  }
  if (
    isRecord(value) &&
    value.schemaVersion === HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION &&
    value.kind === 'not_found' &&
    hasExactKeys(value, ['schemaVersion', 'kind'])
  ) {
    requireAuthorityRevision(authority, null);
    return Object.freeze({
      schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
      kind: 'not_found' as const,
    });
  }
  if (
    isRecord(value) &&
    value.schemaVersion === HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION &&
    value.kind === 'unavailable' &&
    hasExactKeys(value, ['schemaVersion', 'kind', 'retryAfterMs'])
  ) {
    requireAuthorityRevision(authority, null);
    return Object.freeze({
      schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
      kind: 'unavailable' as const,
      retryAfterMs: parseOrchestratorRetryAfterMs(value.retryAfterMs),
    });
  }
  throw new TypeError('orchestrator-lifecycle-control-state-response-invalid');
}

function parseProjectionFallback(
  value: unknown,
  authority: OrchestratorLifecycleResponseAuthority
): Exclude<HostedLifecycleControlStateResult, { readonly kind: 'control_state' }> {
  if (
    isRecord(value) &&
    value.schemaVersion === HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION &&
    value.kind === 'not_found' &&
    hasExactKeys(value, ['schemaVersion', 'kind'])
  ) {
    requireAuthorityRevision(authority, null);
    return Object.freeze({
      schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
      kind: 'not_found',
    });
  }
  if (
    isRecord(value) &&
    value.schemaVersion === HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION &&
    value.kind === 'unavailable' &&
    hasExactKeys(value, ['schemaVersion', 'kind', 'retryAfterMs'])
  ) {
    requireAuthorityRevision(authority, null);
    return Object.freeze({
      schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
      kind: 'unavailable',
      retryAfterMs: parseOrchestratorRetryAfterMs(value.retryAfterMs),
    });
  }
  throw new TypeError('orchestrator-lifecycle-projection-response-invalid');
}

export function parseOrchestratorLifecyclePrepareResponse(
  value: unknown,
  authority: OrchestratorLifecycleResponseAuthority,
  request: HostedLifecyclePrepareRequest,
  context: QueryContext
): HostedLifecyclePrepareResult {
  if (isRecord(value) && value.kind === 'prepared') {
    const parsed = parseHostedLifecyclePreparedState(value);
    if (
      parsed.ok &&
      parsed.value.workspaceId === request.workspaceId &&
      parsed.value.teamId === request.teamId &&
      parsed.value.deploymentId === context.deploymentId &&
      parsed.value.bootId === context.bootId
    ) {
      requireAuthorityRevision(authority, parsed.value.resourceRevision);
      return parsed.value;
    }
  }
  return parseProjectionFallback(value, authority);
}

export function parseOrchestratorLifecycleProgressResponse(
  value: unknown,
  authority: OrchestratorLifecycleResponseAuthority,
  request: HostedLifecycleProgressRequest,
  context: QueryContext
): HostedLifecycleProgressResult {
  if (isRecord(value) && value.kind === 'provisioning_status') {
    const parsed = parseHostedLifecycleProvisioningStatus(value);
    if (
      parsed.ok &&
      parsed.value.workspaceId === request.workspaceId &&
      parsed.value.teamId === request.teamId &&
      parsed.value.deploymentId === context.deploymentId &&
      parsed.value.bootId === context.bootId
    ) {
      requireAuthorityRevision(authority, parsed.value.resourceRevision);
      return parsed.value;
    }
  }
  return parseProjectionFallback(value, authority);
}

export function parseOrchestratorLifecycleAuthorizationResponse(
  value: unknown,
  command: HostedLifecycleCommand,
  context: QueryContext,
  restoreGeneration: number,
  mountGeneration: number,
  ownerEffectFence: HostedLifecycleOwnerEffectFence
): HostedLifecycleCommandAuthorizationResult {
  if (!isRecord(value) || value.schemaVersion !== ORCHESTRATOR_LIFECYCLE_WIRE_SCHEMA_VERSION) {
    throw new TypeError('orchestrator-lifecycle-authorization-response-invalid');
  }
  if (value.kind === 'authorized') {
    if (!hasExactKeys(value, ['schemaVersion', 'kind', 'authorization'])) throw new TypeError();
    return Object.freeze({
      kind: 'authorized',
      authorization: parseAuthorization(
        value.authorization,
        command,
        context,
        restoreGeneration,
        mountGeneration,
        ownerEffectFence
      ),
    });
  }
  if (value.kind === 'conflict') return parseConflict(value);
  if (value.kind === 'not_found') {
    if (!hasExactKeys(value, ['schemaVersion', 'kind'])) throw new TypeError();
    return Object.freeze({ kind: 'not_found' });
  }
  if (value.kind === 'operator_required') {
    if (!hasExactKeys(value, ['schemaVersion', 'kind'])) throw new TypeError();
    return Object.freeze({ kind: 'operator_required' });
  }
  if (value.kind === 'unavailable') {
    if (!hasExactKeys(value, ['schemaVersion', 'kind', 'retryAfterMs'])) throw new TypeError();
    return Object.freeze({
      kind: 'unavailable',
      retryAfterMs: parseOrchestratorRetryAfterMs(value.retryAfterMs),
    });
  }
  throw new TypeError('orchestrator-lifecycle-authorization-response-invalid');
}

export function parseOrchestratorLifecycleRevalidationResponse(
  value: unknown,
  command: HostedLifecycleCommand,
  context: QueryContext,
  restoreGeneration: number,
  mountGeneration: number,
  ownerEffectFence: HostedLifecycleOwnerEffectFence
): HostedLifecycleCommandRevalidationResult {
  if (!isRecord(value) || value.schemaVersion !== ORCHESTRATOR_LIFECYCLE_WIRE_SCHEMA_VERSION) {
    throw new TypeError('orchestrator-lifecycle-revalidation-response-invalid');
  }
  if (value.kind === 'valid') {
    if (!hasExactKeys(value, ['schemaVersion', 'kind', 'authorization'])) throw new TypeError();
    return Object.freeze({
      kind: 'valid',
      authorization: parseAuthorization(
        value.authorization,
        command,
        context,
        restoreGeneration,
        mountGeneration,
        ownerEffectFence
      ),
    });
  }
  if (value.kind === 'conflict') return parseConflict(value);
  if (value.kind === 'not_found') {
    if (!hasExactKeys(value, ['schemaVersion', 'kind'])) throw new TypeError();
    return Object.freeze({ kind: 'not_found' });
  }
  if (value.kind === 'operator_required') {
    if (!hasExactKeys(value, ['schemaVersion', 'kind'])) throw new TypeError();
    return Object.freeze({ kind: 'operator_required' });
  }
  if (value.kind === 'unavailable') {
    if (!hasExactKeys(value, ['schemaVersion', 'kind', 'retryAfterMs'])) throw new TypeError();
    return Object.freeze({
      kind: 'unavailable',
      retryAfterMs: parseOrchestratorRetryAfterMs(value.retryAfterMs),
    });
  }
  throw new TypeError('orchestrator-lifecycle-revalidation-response-invalid');
}

function parseDurableCommandOutcome(
  value: unknown,
  command: HostedLifecycleCommand,
  context: QueryContext,
  restoreGeneration: number,
  mountGeneration: number,
  durableCommand: OrchestratorLifecycleDurableCommand,
  allowAccepted: boolean
): OrchestratorLifecycleDurableCommandOutcome {
  if (!isRecord(value) || value.schemaVersion !== ORCHESTRATOR_LIFECYCLE_WIRE_SCHEMA_VERSION) {
    throw new TypeError('orchestrator-lifecycle-durable-command-response-invalid');
  }
  if (
    value.kind === 'not_started' ||
    value.kind === 'started' ||
    value.kind === 'operator_required' ||
    value.kind === 'idempotency_mismatch'
  ) {
    if (!hasExactKeys(value, ['schemaVersion', 'kind', 'durableCommand'])) {
      throw new TypeError();
    }
    requireOrchestratorLifecycleDurableCommandEcho(value.durableCommand, durableCommand);
    return Object.freeze({ kind: value.kind });
  }
  if (value.kind === 'settled') {
    if (
      !hasExactKeys(value, ['schemaVersion', 'kind', 'durableCommand', 'result', 'authorization'])
    ) {
      throw new TypeError();
    }
    requireOrchestratorLifecycleDurableCommandEcho(value.durableCommand, durableCommand);
    const result = parseHostedLifecycleCommandPublicResult(value.result);
    if (
      !result.ok ||
      result.value.kind === 'unavailable' ||
      (!allowAccepted && result.value.kind === 'accepted')
    ) {
      throw new TypeError();
    }
    return Object.freeze({
      kind: 'settled' as const,
      execution: Object.freeze({
        kind: 'result' as const,
        result: result.value,
        authorization: parseAuthorization(
          value.authorization,
          command,
          context,
          restoreGeneration,
          mountGeneration,
          durableCommand.resource.ownerEffectFence
        ),
      }),
    });
  }
  throw new TypeError('orchestrator-lifecycle-durable-command-response-invalid');
}

export function parseOrchestratorLifecycleReplayLookupResponse(
  value: unknown,
  command: HostedLifecycleCommand,
  context: QueryContext,
  restoreGeneration: number,
  mountGeneration: number,
  durableCommand: OrchestratorLifecycleDurableCommand
): OrchestratorLifecycleDurableCommandOutcome {
  return parseDurableCommandOutcome(
    value,
    command,
    context,
    restoreGeneration,
    mountGeneration,
    durableCommand,
    false
  );
}

export function parseOrchestratorLifecycleExecutionResponse(
  value: unknown,
  command: HostedLifecycleCommand,
  context: QueryContext,
  restoreGeneration: number,
  mountGeneration: number,
  durableCommand: OrchestratorLifecycleDurableCommand
): OrchestratorLifecycleDurableCommandOutcome {
  return parseDurableCommandOutcome(
    value,
    command,
    context,
    restoreGeneration,
    mountGeneration,
    durableCommand,
    true
  );
}

export function parseOrchestratorLifecycleReleaseResponse(
  value: unknown,
  authority: OrchestratorLifecycleResponseAuthority,
  command: HostedLifecycleCommand,
  context: QueryContext,
  restoreGeneration: number,
  mountGeneration: number,
  expectedAuthorization: HostedLifecycleCommandAuthorization
): OrchestratorLifecycleReleaseOutcome {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'kind', 'authorization']) ||
    value.schemaVersion !== ORCHESTRATOR_LIFECYCLE_WIRE_SCHEMA_VERSION ||
    (value.kind !== 'released' &&
      value.kind !== 'already_released' &&
      value.kind !== 'operator_required')
  ) {
    throw new TypeError('orchestrator-lifecycle-release-response-invalid');
  }
  const authorization = parseAuthorization(
    value.authorization,
    command,
    context,
    restoreGeneration,
    mountGeneration,
    expectedAuthorization.ownerEffectFence
  );
  if (!sameHostedLifecycleAuthorization(authorization, expectedAuthorization)) {
    throw new TypeError('orchestrator-lifecycle-release-authorization-invalid');
  }
  requireAuthorityRevision(authority, expectedAuthorization.resourceRevision);
  return Object.freeze({ kind: value.kind, authorization });
}
