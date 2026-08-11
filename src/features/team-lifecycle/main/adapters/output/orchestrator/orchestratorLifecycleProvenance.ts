import {
  hasExactOrchestratorLifecycleKeys as hasExactKeys,
  isOrchestratorLifecycleRecord as isRecord,
  type OrchestratorLifecycleOwnerBinding,
} from '../../../application/ExecuteHostedLifecycleCommand';

import type { QueryContext, TeamId, WorkspaceId } from '@shared/contracts/hosted';

export interface OrchestratorLifecycleControllerProvenance {
  readonly kind: 'controller';
  readonly deploymentId: QueryContext['deploymentId'];
  readonly bootId: QueryContext['bootId'];
  readonly actorId: QueryContext['actorId'];
  readonly sessionId: QueryContext['sessionId'];
}

export interface OrchestratorLifecycleOwnerProvenance {
  readonly kind: 'owner';
  readonly ownerAuthority: string;
  readonly ownerGeneration: number;
  readonly ownerSessionId: string;
}

export interface OrchestratorLifecycleProvenanceTarget {
  readonly capability: 'hosted-lifecycle-command';
  readonly exchangeId: string;
  readonly operation: string;
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
}

/** Explicit endpoints and target authenticated by the exact request/response wire HMAC. */
export interface OrchestratorLifecycleWireProvenance {
  readonly from: OrchestratorLifecycleControllerProvenance | OrchestratorLifecycleOwnerProvenance;
  readonly to: OrchestratorLifecycleControllerProvenance | OrchestratorLifecycleOwnerProvenance;
  readonly target: OrchestratorLifecycleProvenanceTarget;
}

function controllerProvenance(context: QueryContext): OrchestratorLifecycleControllerProvenance {
  return Object.freeze({
    kind: 'controller',
    deploymentId: context.deploymentId,
    bootId: context.bootId,
    actorId: context.actorId,
    sessionId: context.sessionId,
  });
}

function ownerProvenance(
  binding: OrchestratorLifecycleOwnerBinding
): OrchestratorLifecycleOwnerProvenance {
  return Object.freeze({
    kind: 'owner',
    ownerAuthority: binding.ownerAuthority,
    ownerGeneration: binding.ownerGeneration,
    ownerSessionId: binding.ownerSessionId,
  });
}

export function createOrchestratorLifecycleRequestProvenance(input: {
  readonly context: QueryContext;
  readonly ownerBinding: OrchestratorLifecycleOwnerBinding;
  readonly exchangeId: string;
  readonly operation: string;
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
}): OrchestratorLifecycleWireProvenance {
  return Object.freeze({
    from: controllerProvenance(input.context),
    to: ownerProvenance(input.ownerBinding),
    target: Object.freeze({
      capability: 'hosted-lifecycle-command',
      exchangeId: input.exchangeId,
      operation: input.operation,
      workspaceId: input.workspaceId,
      teamId: input.teamId,
    }),
  });
}

export function createOrchestratorLifecycleResponseProvenance(
  request: OrchestratorLifecycleWireProvenance
): OrchestratorLifecycleWireProvenance {
  return Object.freeze({
    from: request.to,
    to: request.from,
    target: request.target,
  });
}

function sameEndpoint(
  first: OrchestratorLifecycleWireProvenance['from'],
  second: OrchestratorLifecycleWireProvenance['from']
): boolean {
  if (first.kind !== second.kind) return false;
  if (first.kind === 'controller' && second.kind === 'controller') {
    return (
      first.deploymentId === second.deploymentId &&
      first.bootId === second.bootId &&
      first.actorId === second.actorId &&
      first.sessionId === second.sessionId
    );
  }
  return (
    first.kind === 'owner' &&
    second.kind === 'owner' &&
    first.ownerAuthority === second.ownerAuthority &&
    first.ownerGeneration === second.ownerGeneration &&
    first.ownerSessionId === second.ownerSessionId
  );
}

export function sameOrchestratorLifecycleWireProvenance(
  left: OrchestratorLifecycleWireProvenance,
  right: OrchestratorLifecycleWireProvenance
): boolean {
  return (
    sameEndpoint(left.from, right.from) &&
    sameEndpoint(left.to, right.to) &&
    left.target.capability === right.target.capability &&
    left.target.exchangeId === right.target.exchangeId &&
    left.target.operation === right.target.operation &&
    left.target.workspaceId === right.target.workspaceId &&
    left.target.teamId === right.target.teamId
  );
}

function parseEndpoint(
  value: unknown,
  expected: OrchestratorLifecycleWireProvenance['from']
): OrchestratorLifecycleWireProvenance['from'] {
  if (!isRecord(value)) throw new TypeError();
  const keys =
    expected.kind === 'controller'
      ? ['kind', 'deploymentId', 'bootId', 'actorId', 'sessionId']
      : ['kind', 'ownerAuthority', 'ownerGeneration', 'ownerSessionId'];
  if (!hasExactKeys(value, keys) || value.kind !== expected.kind) throw new TypeError();
  return value as unknown as OrchestratorLifecycleWireProvenance['from'];
}

export function requireOrchestratorLifecycleWireProvenance(
  value: unknown,
  expected: OrchestratorLifecycleWireProvenance
): OrchestratorLifecycleWireProvenance {
  try {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['from', 'to', 'target']) ||
      !isRecord(value.target) ||
      !hasExactKeys(value.target, [
        'capability',
        'exchangeId',
        'operation',
        'workspaceId',
        'teamId',
      ])
    ) {
      throw new TypeError();
    }
    const parsed = Object.freeze({
      from: parseEndpoint(value.from, expected.from),
      to: parseEndpoint(value.to, expected.to),
      target: value.target as unknown as OrchestratorLifecycleProvenanceTarget,
    });
    if (!sameOrchestratorLifecycleWireProvenance(parsed, expected)) throw new TypeError();
    return expected;
  } catch {
    throw new TypeError('orchestrator-lifecycle-provenance-invalid');
  }
}
