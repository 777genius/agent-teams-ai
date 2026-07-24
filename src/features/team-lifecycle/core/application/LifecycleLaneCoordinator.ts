import type { LifecycleRun } from '../domain';
import type {
  LifecycleCancellation,
  LifecycleExecutionBackendRegistryPort,
  LifecycleLaneProviderMutation,
  LifecycleLaneProviderMutationProposal,
  LifecycleLaneReadinessReceipt,
  LifecycleResolvedLaneBackend,
  ResolveLifecycleLaneBackendResult,
} from './ports/TeamLifecycleCommandPorts';
import type { LaneId } from '@features/team-runtime-control';
import type { TeamProviderId } from '@shared/types';

export type LifecycleLanePreflightResult =
  | {
      readonly status: 'ready';
      readonly backend: LifecycleResolvedLaneBackend;
      readonly readiness: LifecycleLaneReadinessReceipt;
      readonly scope: Extract<
        ResolveLifecycleLaneBackendResult,
        { readonly status: 'resolved' }
      >['scope'];
    }
  | { readonly status: 'rejected'; readonly reason: string };

export class LifecycleLaneCoordinator {
  constructor(private readonly registry: LifecycleExecutionBackendRegistryPort) {}

  async preflight(
    run: LifecycleRun,
    laneId: LaneId,
    cancellation: LifecycleCancellation
  ): Promise<LifecycleLanePreflightResult> {
    const resolved = this.resolve(run, laneId);
    if (resolved.status === 'rejected') return resolved;
    if (isCancelled(cancellation)) return { status: 'rejected', reason: 'cancelled' };
    try {
      const outcome = await resolved.backend.preflight({
        scope: resolved.scope,
        cancellation,
      });
      if (outcome.status === 'rejected') return outcome;
      if (
        outcome.readiness.backend !== resolved.backend.backend ||
        outcome.readiness.bindingId !== resolved.scope.executionUnit.backendBinding.bindingId ||
        outcome.readiness.bindingRevision !==
          resolved.scope.executionUnit.backendBinding.bindingRevision ||
        outcome.readiness.laneId !== laneId ||
        outcome.readiness.planHash !== run.plan.planHash
      ) {
        return { status: 'rejected', reason: 'backend_readiness_mismatch' };
      }
      return {
        status: 'ready',
        backend: resolved.backend,
        readiness: canonicalReadiness(outcome.readiness),
        scope: resolved.scope,
      };
    } catch {
      return { status: 'rejected', reason: 'unavailable' };
    }
  }

  prepareLaunchMutation(
    run: LifecycleRun,
    laneId: LaneId,
    preflight: Extract<LifecycleLanePreflightResult, { readonly status: 'ready' }>,
    operationId: string
  ): LifecycleLaneProviderMutationProposal {
    const scope = canonicalScope(run, laneId);
    if (
      !scope ||
      !isBoundedIdentifier(operationId, 512) ||
      preflight.backend.backend !== scope.executionUnit.backendBinding.backend ||
      !sameSemanticIdentity(preflight.scope, scope) ||
      !readinessMatchesScope(preflight.readiness, scope)
    ) {
      throw new TypeError('lifecycle-lane-launch-mutation-invalid');
    }
    return Object.freeze({
      effectKind: 'launch',
      operationId,
      backend: preflight.backend.backend,
      scope,
      readiness: canonicalReadiness(preflight.readiness),
      executionRef: null,
      mode: null,
    });
  }

  prepareStopMutation(
    run: LifecycleRun,
    laneId: LaneId,
    operationId: string,
    executionRef: string,
    mode: 'graceful' | 'immediate'
  ): LifecycleLaneProviderMutationProposal {
    const scope = canonicalScope(run, laneId);
    if (
      !scope ||
      !isBoundedIdentifier(operationId, 512) ||
      !isBoundedIdentifier(executionRef, 256)
    ) {
      throw new TypeError('lifecycle-lane-stop-mutation-invalid');
    }
    return Object.freeze({
      effectKind: 'stop',
      operationId,
      backend: scope.executionUnit.backendBinding.backend,
      scope,
      readiness: null,
      executionRef,
      mode,
    });
  }

  prepareRecoverMutation(
    run: LifecycleRun,
    laneId: LaneId,
    operationId: string
  ): LifecycleLaneProviderMutationProposal {
    const scope = canonicalScope(run, laneId);
    if (!scope || !isBoundedIdentifier(operationId, 512)) {
      throw new TypeError('lifecycle-lane-recover-mutation-invalid');
    }
    return Object.freeze({
      effectKind: 'recover',
      operationId,
      backend: scope.executionUnit.backendBinding.backend,
      scope,
      readiness: null,
      executionRef: null,
      mode: null,
    });
  }

  async launch(
    run: LifecycleRun,
    laneId: LaneId,
    mutation: LifecycleLaneProviderMutation,
    cancellation: LifecycleCancellation
  ): Promise<
    | { readonly status: 'launched' | 'already_launched'; readonly executionRef: string }
    | { readonly status: 'operator_required'; readonly diagnostic: string }
    | { readonly status: 'rejected'; readonly diagnostic: string }
  > {
    const resolved = this.resolveProviderMutation(run, laneId, mutation, 'launch');
    if (resolved.status === 'rejected') {
      return { status: 'rejected', diagnostic: `runtime-launch-${resolved.reason}` };
    }
    if (!mutation.readiness) {
      return { status: 'rejected', diagnostic: 'runtime-launch-provider_mutation_mismatch' };
    }
    try {
      const outcome = await resolved.backend.launch({
        scope: mutation.scope,
        cancellation,
        readiness: mutation.readiness,
        operationId: mutation.operationId,
        effectLease: mutation.lease,
      });
      if (outcome.status === 'operator_required') {
        return { status: 'operator_required', diagnostic: 'runtime-launch-ambiguous' };
      }
      if (outcome.status === 'rejected') {
        return { status: 'rejected', diagnostic: `runtime-launch-${outcome.reason}` };
      }
      return outcome;
    } catch {
      return { status: 'operator_required', diagnostic: 'runtime-launch-ambiguous' };
    }
  }

  async observe(
    run: LifecycleRun,
    laneId: LaneId,
    executionRef: string
  ): Promise<
    | { readonly status: 'starting' | 'ready' | 'degraded' | 'stopping' }
    | { readonly status: 'exited'; readonly outcome: 'success' | 'failure' | 'unknown' }
    | { readonly status: 'operator_required'; readonly diagnostic: string }
    | { readonly status: 'rejected'; readonly diagnostic: string }
  > {
    const resolved = this.resolve(run, laneId);
    if (resolved.status === 'rejected') {
      return { status: 'rejected', diagnostic: `runtime-observe-${resolved.reason}` };
    }
    try {
      const outcome = await resolved.backend.observe({
        scope: resolved.scope,
        executionRef,
      });
      if (outcome.status === 'operator_required') {
        return { status: 'operator_required', diagnostic: 'runtime-observation-ambiguous' };
      }
      if (outcome.status === 'rejected') {
        return { status: 'rejected', diagnostic: `runtime-observe-${outcome.reason}` };
      }
      return outcome;
    } catch {
      return { status: 'rejected', diagnostic: 'runtime-observe-unavailable' };
    }
  }

  async stop(
    run: LifecycleRun,
    laneId: LaneId,
    mutation: LifecycleLaneProviderMutation,
    cancellation: LifecycleCancellation
  ): Promise<
    | { readonly status: 'stopped' | 'already_stopped' | 'cancelled' }
    | { readonly status: 'operator_required'; readonly diagnostic: string }
    | { readonly status: 'rejected'; readonly diagnostic: string }
  > {
    const resolved = this.resolveProviderMutation(run, laneId, mutation, 'stop');
    if (resolved.status === 'rejected') {
      return { status: 'rejected', diagnostic: `runtime-stop-${resolved.reason}` };
    }
    if (!mutation.executionRef || !mutation.mode) {
      return {
        status: 'rejected',
        diagnostic: 'runtime-stop-provider_mutation_mismatch',
      };
    }
    try {
      const outcome = await resolved.backend.stop({
        scope: mutation.scope,
        executionRef: mutation.executionRef,
        mode: mutation.mode,
        cancellation,
        operationId: mutation.operationId,
        effectLease: mutation.lease,
      });
      if (outcome.status === 'cancelled' && isCancelled(cancellation)) {
        return {
          status: 'rejected',
          diagnostic: 'runtime-stop-cancelled-before-drain-proof',
        };
      }
      if (outcome.status === 'operator_required') {
        return { status: 'operator_required', diagnostic: 'runtime-stop-ambiguous' };
      }
      if (outcome.status === 'rejected') {
        return { status: 'rejected', diagnostic: `runtime-stop-${outcome.reason}` };
      }
      return outcome;
    } catch {
      return { status: 'operator_required', diagnostic: 'runtime-stop-ambiguous' };
    }
  }

  async recover(
    run: LifecycleRun,
    laneId: LaneId,
    mutation: LifecycleLaneProviderMutation,
    cancellation: LifecycleCancellation
  ): Promise<
    | { readonly status: 'not_started' | 'cancelled' }
    | { readonly status: 'recovered'; readonly executionRef: string }
    | { readonly status: 'operator_required'; readonly diagnostic: string }
    | { readonly status: 'rejected'; readonly diagnostic: string }
  > {
    const resolved = this.resolveProviderMutation(run, laneId, mutation, 'recover');
    if (resolved.status === 'rejected') {
      return { status: 'rejected', diagnostic: `runtime-recover-${resolved.reason}` };
    }
    try {
      const outcome = await resolved.backend.recover({
        scope: mutation.scope,
        cancellation,
        operationId: mutation.operationId,
        effectLease: mutation.lease,
      });
      if (outcome.status === 'cancelled') {
        return {
          status: 'rejected',
          diagnostic: 'runtime-recovery-cancelled-before-proof',
        };
      }
      if (outcome.status === 'operator_required') {
        return { status: 'operator_required', diagnostic: 'runtime-recovery-ambiguous' };
      }
      if (outcome.status === 'rejected') {
        return { status: 'rejected', diagnostic: `runtime-recover-${outcome.reason}` };
      }
      return outcome;
    } catch {
      return { status: 'operator_required', diagnostic: 'runtime-recovery-ambiguous' };
    }
  }

  private resolveProviderMutation(
    run: LifecycleRun,
    laneId: LaneId,
    mutation: LifecycleLaneProviderMutation,
    effectKind: LifecycleLaneProviderMutation['effectKind']
  ): ResolveLifecycleLaneBackendResult {
    const canonical = canonicalScope(run, laneId);
    if (
      !canonical ||
      mutation.effectKind !== effectKind ||
      mutation.backend !== canonical.executionUnit.backendBinding.backend ||
      !sameSemanticIdentity(mutation.scope, canonical) ||
      !validMutationShape(mutation)
    ) {
      return { status: 'rejected', reason: 'provider_mutation_mismatch' };
    }
    const resolved = this.resolve(run, laneId);
    if (resolved.status === 'rejected') return resolved;
    if (
      resolved.backend.backend !== mutation.backend ||
      !sameSemanticIdentity(resolved.scope, mutation.scope)
    ) {
      return { status: 'rejected', reason: 'provider_mutation_mismatch' };
    }
    return resolved;
  }

  private resolve(run: LifecycleRun, laneId: LaneId): ResolveLifecycleLaneBackendResult {
    let resolved: ResolveLifecycleLaneBackendResult;
    try {
      resolved = this.registry.resolve(run.plan, laneId);
    } catch {
      return { status: 'rejected', reason: 'backend_registry_unavailable' };
    }
    if (resolved.status === 'rejected') return resolved;
    const storedLanes = run.plan.lanes.filter((lane) => lane.laneId === laneId);
    const storedUnits = run.plan.executionUnits.filter((unit) => unit.laneId === laneId);
    const storedLane = storedLanes[0];
    const storedUnit = storedUnits[0];
    if (storedLanes.length !== 1 || storedUnits.length !== 1 || !storedLane || !storedUnit) {
      return { status: 'rejected', reason: 'stored_backend_scope_ambiguous' };
    }
    const requiredProviderIds = exactRequiredProviderIds(run, laneId);
    if (
      !sameSemanticIdentity(resolved.scope.plan, run.plan) ||
      !sameSemanticIdentity(resolved.scope.lane, storedLane) ||
      !sameSemanticIdentity(resolved.scope.executionUnit, storedUnit) ||
      resolved.scope.plan.runId !== run.runId ||
      resolved.scope.plan.generation !== run.generation ||
      resolved.scope.lane.laneId !== laneId ||
      resolved.scope.executionUnit.laneId !== laneId ||
      resolved.backend.backend !== storedUnit.backendBinding.backend ||
      !sameProviderIds(resolved.scope.requiredProviderIds, requiredProviderIds)
    ) {
      return { status: 'rejected', reason: 'backend_scope_mismatch' };
    }
    return {
      status: 'resolved',
      backend: resolved.backend,
      scope: Object.freeze({
        plan: run.plan,
        lane: storedLane,
        executionUnit: storedUnit,
        requiredProviderIds,
      }),
    };
  }
}

function canonicalScope(
  run: LifecycleRun,
  laneId: LaneId
): Extract<ResolveLifecycleLaneBackendResult, { readonly status: 'resolved' }>['scope'] | null {
  const lanes = run.plan.lanes.filter((candidate) => candidate.laneId === laneId);
  const units = run.plan.executionUnits.filter((candidate) => candidate.laneId === laneId);
  const lane = lanes[0];
  const executionUnit = units[0];
  if (
    lanes.length !== 1 ||
    units.length !== 1 ||
    !lane ||
    !executionUnit ||
    run.runId !== run.plan.runId ||
    run.generation !== run.plan.generation
  ) {
    return null;
  }
  const requiredProviderIds = exactRequiredProviderIds(run, laneId);
  if (requiredProviderIds.length === 0) return null;
  return Object.freeze({
    plan: run.plan,
    lane,
    executionUnit,
    requiredProviderIds,
  });
}

function canonicalReadiness(
  readiness: LifecycleLaneReadinessReceipt
): LifecycleLaneReadinessReceipt {
  return Object.freeze({
    ...readiness,
    providerRevisions: Object.freeze(
      readiness.providerRevisions.map((revision) => Object.freeze({ ...revision }))
    ),
  });
}

function readinessMatchesScope(
  readiness: LifecycleLaneReadinessReceipt,
  scope: Extract<ResolveLifecycleLaneBackendResult, { readonly status: 'resolved' }>['scope']
): boolean {
  return (
    readiness.backend === scope.executionUnit.backendBinding.backend &&
    readiness.bindingId === scope.executionUnit.backendBinding.bindingId &&
    readiness.bindingRevision === scope.executionUnit.backendBinding.bindingRevision &&
    readiness.laneId === scope.lane.laneId &&
    readiness.planHash === scope.plan.planHash &&
    readiness.providerRevisions.length === scope.requiredProviderIds.length &&
    readiness.providerRevisions.every(
      (revision, index) =>
        revision.providerId === scope.requiredProviderIds[index] &&
        Number.isSafeInteger(revision.capabilityRevision) &&
        revision.capabilityRevision >= 1
    )
  );
}

function validMutationShape(mutation: LifecycleLaneProviderMutation): boolean {
  if (
    !isBoundedIdentifier(mutation.operationId, 512) ||
    !isBoundedIdentifier(mutation.lease.token, 512) ||
    !isBoundedIdentifier(mutation.lease.ownerId, 512) ||
    !Number.isSafeInteger(mutation.lease.fence) ||
    mutation.lease.fence < 1 ||
    !isCanonicalTimestamp(mutation.lease.claimedAtIso) ||
    !isCanonicalTimestamp(mutation.lease.expiresAtIso) ||
    Date.parse(mutation.lease.expiresAtIso) <= Date.parse(mutation.lease.claimedAtIso)
  ) {
    return false;
  }
  if (mutation.effectKind === 'launch') {
    return (
      mutation.readiness !== null &&
      readinessMatchesScope(mutation.readiness, mutation.scope) &&
      mutation.executionRef === null &&
      mutation.mode === null
    );
  }
  if (mutation.effectKind === 'stop') {
    return (
      mutation.readiness === null &&
      isBoundedIdentifier(mutation.executionRef, 256) &&
      (mutation.mode === 'graceful' || mutation.mode === 'immediate')
    );
  }
  return mutation.readiness === null && mutation.executionRef === null && mutation.mode === null;
}

function exactRequiredProviderIds(run: LifecycleRun, laneId: LaneId): readonly TeamProviderId[] {
  const lane = run.plan.lanes.find((candidate) => candidate.laneId === laneId);
  if (!lane) return Object.freeze([]);
  const providers: TeamProviderId[] = [];
  const append = (providerId: TeamProviderId): void => {
    if (!providers.includes(providerId)) providers.push(providerId);
  };
  if (lane.laneKind === 'primary') append(run.plan.leadProviderId);
  for (const memberId of lane.memberIds) {
    const member = run.plan.memberBindings.find((candidate) => candidate.memberId === memberId);
    if (!member) return Object.freeze([]);
    append(member.providerId);
  }
  return Object.freeze(providers);
}

function sameProviderIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((providerId, index) => providerId === right[index])
  );
}

function sameSemanticIdentity(
  left: unknown,
  right: unknown,
  seen = new WeakMap<object, object>()
): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== 'object' ||
    left === null ||
    typeof right !== 'object' ||
    right === null ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    return false;
  }
  const paired = seen.get(left);
  if (paired) return paired === right;
  seen.set(left, right);
  try {
    if (Array.isArray(left) && Array.isArray(right)) {
      return (
        left.length === right.length &&
        left.every((value, index) => sameSemanticIdentity(value, right.at(index), seen))
      );
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort((first, second) => first.localeCompare(second));
    const rightKeys = Object.keys(rightRecord).sort((first, second) => first.localeCompare(second));
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys.at(index) &&
          Object.hasOwn(rightRecord, key) &&
          sameSemanticIdentity(
            Object.getOwnPropertyDescriptor(leftRecord, key)?.value,
            Object.getOwnPropertyDescriptor(rightRecord, key)?.value,
            seen
          )
      )
    );
  } catch {
    return false;
  }
}

function isCancelled(cancellation: LifecycleCancellation): boolean {
  try {
    return cancellation.isCancellationRequested() !== false;
  } catch {
    return true;
  }
}

function isBoundedIdentifier(value: unknown, maximumLength: number): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximumLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 31 || codePoint === 127) return false;
  }
  return true;
}

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
