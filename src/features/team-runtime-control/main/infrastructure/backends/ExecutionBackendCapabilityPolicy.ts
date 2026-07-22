import {
  isLaneExecutionOperationRejectionReason,
  type LaneExecutionLaunchOutcome,
  type LaneExecutionObserveOutcome,
  type LaneExecutionOperationRejectionReason,
  type LaneExecutionPlanValidationOutcome,
  type LaneExecutionPreflightOutcome,
  type LaneExecutionProviderCapability,
  type LaneExecutionReadinessReceipt,
  type LaneExecutionRecoverOutcome,
  type LaneExecutionScope,
  type LaneExecutionStopOutcome,
  parseLaneExecutionRef,
} from '../../../core/application/backends';

import type { RuntimeExecutionBackendKind } from '../../../contracts';
import type { TeamProviderId } from '@shared/types';

export const PROVISIONING_CLI_PROVIDER_IDS = Object.freeze([
  'anthropic',
  'codex',
  'gemini',
] as const satisfies readonly TeamProviderId[]);
export const OPENCODE_EXECUTION_PROVIDER_IDS = Object.freeze([
  'opencode',
] as const satisfies readonly TeamProviderId[]);

const PRODUCT_PROVIDER_MATRIX = Object.freeze({
  provisioning_cli: PROVISIONING_CLI_PROVIDER_IDS,
  opencode: OPENCODE_EXECUTION_PROVIDER_IDS,
} satisfies Readonly<Record<RuntimeExecutionBackendKind, readonly TeamProviderId[]>>);

export type ExecutionBackendCapabilityAdmissionOutcome =
  | {
      readonly status: 'admitted';
      readonly capabilities: readonly LaneExecutionProviderCapability[];
    }
  | {
      readonly status: 'rejected';
      readonly reason: LaneExecutionOperationRejectionReason;
    };

/** Runtime validation for provider capability facts and compatibility-adapter outcomes. */
export class ExecutionBackendCapabilityPolicy {
  validatePlan(
    scope: LaneExecutionScope,
    backend: RuntimeExecutionBackendKind
  ): LaneExecutionPlanValidationOutcome {
    const plannedLane = scope.plan.lanes[scope.lane.ordinal];
    const plannedUnit = scope.plan.executionUnits.find((unit) => unit.laneId === scope.lane.laneId);
    if (plannedLane !== scope.lane || plannedUnit !== scope.executionUnit) {
      return { status: 'rejected', reason: 'invalid_plan' };
    }
    if (
      scope.executionUnit.backendBinding.backend !== backend ||
      scope.executionUnit.laneId !== scope.lane.laneId
    ) {
      return { status: 'rejected', reason: 'backend_mismatch' };
    }
    const allowedProviders = PRODUCT_PROVIDER_MATRIX[backend];
    const expectedProviderIds = deriveRequiredProviderIds(scope);
    if (
      scope.requiredProviderIds.length === 0 ||
      new Set(scope.requiredProviderIds).size !== scope.requiredProviderIds.length ||
      !sameStringArray(scope.requiredProviderIds, expectedProviderIds)
    ) {
      return { status: 'rejected', reason: 'invalid_plan' };
    }
    if (
      scope.requiredProviderIds.some(
        (providerId) => !(allowedProviders as readonly TeamProviderId[]).includes(providerId)
      )
    ) {
      return { status: 'rejected', reason: 'unsupported_provider' };
    }
    if (
      scope.plan.orderedLaneIds[scope.lane.ordinal] !== scope.lane.laneId ||
      !sameStringArray(scope.lane.memberIds, scope.executionUnit.memberIds)
    ) {
      return { status: 'rejected', reason: 'invalid_plan' };
    }
    return { status: 'accepted' };
  }

  admitCapabilities(
    scope: LaneExecutionScope,
    backend: RuntimeExecutionBackendKind,
    value: unknown,
    options: { readonly requireReady: boolean }
  ): ExecutionBackendCapabilityAdmissionOutcome {
    const validation = this.validatePlan(scope, backend);
    if (validation.status === 'rejected') {
      return {
        status: 'rejected',
        reason:
          validation.reason === 'unsupported_provider' ? 'unsupported' : 'capability_mismatch',
      };
    }
    if (!isDenseArray(value) || value.length !== scope.requiredProviderIds.length) {
      return { status: 'rejected', reason: 'capability_mismatch' };
    }

    const capabilities: LaneExecutionProviderCapability[] = [];
    for (const [index, candidate] of value.entries()) {
      if (
        !isExactRecord(candidate, [
          'backend',
          'bindingId',
          'bindingRevision',
          'capabilityRevision',
          'providerId',
          'readiness',
          'supported',
        ])
      ) {
        return { status: 'rejected', reason: 'capability_mismatch' };
      }
      const expectedProviderId = scope.requiredProviderIds[index];
      if (
        candidate.backend !== backend ||
        candidate.bindingId !== scope.executionUnit.backendBinding.bindingId ||
        candidate.bindingRevision !== scope.executionUnit.backendBinding.bindingRevision ||
        candidate.providerId !== expectedProviderId ||
        !Number.isSafeInteger(candidate.capabilityRevision) ||
        (candidate.capabilityRevision as number) < 1 ||
        typeof candidate.supported !== 'boolean' ||
        (candidate.readiness !== 'ready' && candidate.readiness !== 'not_ready') ||
        (candidate.supported === false && candidate.readiness === 'ready')
      ) {
        return { status: 'rejected', reason: 'capability_mismatch' };
      }
      capabilities.push(
        Object.freeze({
          backend,
          bindingId: scope.executionUnit.backendBinding.bindingId,
          bindingRevision: scope.executionUnit.backendBinding.bindingRevision,
          providerId: expectedProviderId,
          capabilityRevision: candidate.capabilityRevision as number,
          supported: candidate.supported,
          readiness: candidate.readiness,
        })
      );
    }

    if (capabilities.some((capability) => !capability.supported)) {
      return { status: 'rejected', reason: 'unsupported' };
    }
    if (
      options.requireReady &&
      capabilities.some((capability) => capability.readiness !== 'ready')
    ) {
      return { status: 'rejected', reason: 'unavailable' };
    }
    return { status: 'admitted', capabilities: Object.freeze(capabilities) };
  }

  createReadinessReceipt(
    scope: LaneExecutionScope,
    backend: RuntimeExecutionBackendKind,
    capabilities: readonly LaneExecutionProviderCapability[]
  ): LaneExecutionReadinessReceipt {
    return Object.freeze({
      backend,
      bindingId: scope.executionUnit.backendBinding.bindingId,
      laneId: scope.lane.laneId,
      planHash: scope.plan.planHash,
      bindingRevision: scope.executionUnit.backendBinding.bindingRevision,
      providerRevisions: Object.freeze(
        capabilities.map((capability) =>
          Object.freeze({
            providerId: capability.providerId,
            capabilityRevision: capability.capabilityRevision,
          })
        )
      ),
    });
  }

  validateReadinessReceipt(
    scope: LaneExecutionScope,
    backend: RuntimeExecutionBackendKind,
    capabilities: readonly LaneExecutionProviderCapability[],
    value: unknown
  ):
    | { readonly status: 'valid' }
    | { readonly status: 'rejected'; readonly reason: 'readiness_mismatch' } {
    if (
      !isExactRecord(value, [
        'backend',
        'bindingId',
        'bindingRevision',
        'laneId',
        'planHash',
        'providerRevisions',
      ]) ||
      value.backend !== backend ||
      value.bindingId !== scope.executionUnit.backendBinding.bindingId ||
      value.laneId !== scope.lane.laneId ||
      value.planHash !== scope.plan.planHash ||
      value.bindingRevision !== scope.executionUnit.backendBinding.bindingRevision ||
      !isDenseArray(value.providerRevisions) ||
      value.providerRevisions.length !== capabilities.length
    ) {
      return { status: 'rejected', reason: 'readiness_mismatch' };
    }
    for (const [index, candidate] of value.providerRevisions.entries()) {
      const capability = capabilities[index];
      if (
        !capability ||
        !isExactRecord(candidate, ['capabilityRevision', 'providerId']) ||
        candidate.providerId !== capability.providerId ||
        candidate.capabilityRevision !== capability.capabilityRevision
      ) {
        return { status: 'rejected', reason: 'readiness_mismatch' };
      }
    }
    return { status: 'valid' };
  }

  containPreflightOutcome(
    scope: LaneExecutionScope,
    backend: RuntimeExecutionBackendKind,
    capabilities: readonly LaneExecutionProviderCapability[],
    value: unknown
  ): LaneExecutionPreflightOutcome {
    if (isExactRecord(value, ['status']) && value.status === 'ready') {
      return {
        status: 'ready',
        readiness: this.createReadinessReceipt(scope, backend, capabilities),
      };
    }
    return containRejectedOutcome(value, capabilities);
  }

  containLaunchOutcome(
    value: unknown,
    capabilities: readonly LaneExecutionProviderCapability[]
  ): LaneExecutionLaunchOutcome {
    if (
      isExactRecord(value, ['executionRef', 'status']) &&
      (value.status === 'launched' || value.status === 'already_launched')
    ) {
      try {
        return { status: value.status, executionRef: parseLaneExecutionRef(value.executionRef) };
      } catch {
        return { status: 'operator_required' };
      }
    }
    if (isExactRecord(value, ['status']) && value.status === 'operator_required') {
      return { status: 'operator_required' };
    }
    return containRejectedOutcomeOr(value, capabilities, { status: 'operator_required' });
  }

  containObserveOutcome(
    value: unknown,
    capabilities: readonly LaneExecutionProviderCapability[]
  ): LaneExecutionObserveOutcome {
    if (
      isExactRecord(value, ['status']) &&
      (value.status === 'starting' ||
        value.status === 'degraded' ||
        value.status === 'stopping' ||
        value.status === 'operator_required')
    ) {
      return { status: value.status };
    }
    if (isExactRecord(value, ['status']) && value.status === 'ready') {
      return capabilities.every((capability) => capability.readiness === 'ready')
        ? { status: 'ready' }
        : { status: 'rejected', reason: 'readiness_mismatch' };
    }
    if (
      isExactRecord(value, ['outcome', 'status']) &&
      value.status === 'exited' &&
      (value.outcome === 'success' || value.outcome === 'failure' || value.outcome === 'unknown')
    ) {
      return { status: 'exited', outcome: value.outcome };
    }
    return containRejectedOutcome(value, capabilities);
  }

  containStopOutcome(
    value: unknown,
    capabilities: readonly LaneExecutionProviderCapability[]
  ): LaneExecutionStopOutcome {
    if (
      isExactRecord(value, ['status']) &&
      (value.status === 'stopped' ||
        value.status === 'already_stopped' ||
        value.status === 'cancelled' ||
        value.status === 'operator_required')
    ) {
      return { status: value.status };
    }
    return containRejectedOutcomeOr(value, capabilities, { status: 'operator_required' });
  }

  containRecoverOutcome(
    value: unknown,
    capabilities: readonly LaneExecutionProviderCapability[]
  ): LaneExecutionRecoverOutcome {
    if (
      isExactRecord(value, ['status']) &&
      (value.status === 'not_started' ||
        value.status === 'cancelled' ||
        value.status === 'operator_required')
    ) {
      return { status: value.status };
    }
    if (isExactRecord(value, ['executionRef', 'status']) && value.status === 'recovered') {
      try {
        return { status: 'recovered', executionRef: parseLaneExecutionRef(value.executionRef) };
      } catch {
        return { status: 'operator_required' };
      }
    }
    return containRejectedOutcomeOr(value, capabilities, { status: 'operator_required' });
  }
}

function containRejectedOutcome(
  value: unknown,
  capabilities: readonly LaneExecutionProviderCapability[]
): { readonly status: 'rejected'; readonly reason: LaneExecutionOperationRejectionReason } {
  return (
    parseRejectedOutcome(value, capabilities) ?? {
      status: 'rejected',
      reason: 'capability_mismatch',
    }
  );
}

function containRejectedOutcomeOr<TFallback>(
  value: unknown,
  capabilities: readonly LaneExecutionProviderCapability[],
  fallback: TFallback
):
  | { readonly status: 'rejected'; readonly reason: LaneExecutionOperationRejectionReason }
  | TFallback {
  return parseRejectedOutcome(value, capabilities) ?? fallback;
}

function parseRejectedOutcome(
  value: unknown,
  capabilities: readonly LaneExecutionProviderCapability[]
): { readonly status: 'rejected'; readonly reason: LaneExecutionOperationRejectionReason } | null {
  if (
    !isExactRecord(value, ['reason', 'status']) ||
    value.status !== 'rejected' ||
    !isLaneExecutionOperationRejectionReason(value.reason)
  ) {
    return null;
  }
  if (value.reason === 'unsupported' && capabilities.every((capability) => capability.supported)) {
    return { status: 'rejected', reason: 'capability_mismatch' };
  }
  if (
    value.reason === 'unavailable' &&
    capabilities.every((capability) => capability.readiness === 'ready')
  ) {
    return { status: 'rejected', reason: 'readiness_mismatch' };
  }
  return { status: 'rejected', reason: value.reason };
}

function isDenseArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value) && Object.keys(value).length === value.length;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && actualKeys.every((key) => keys.includes(key));
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function deriveRequiredProviderIds(scope: LaneExecutionScope): TeamProviderId[] {
  const providers: TeamProviderId[] = [];
  const add = (providerId: TeamProviderId): void => {
    if (!providers.includes(providerId)) providers.push(providerId);
  };
  if (scope.lane.laneKind === 'primary') add(scope.plan.leadProviderId);
  for (const memberId of scope.lane.memberIds) {
    const member = scope.plan.memberBindings.find((binding) => binding.memberId === memberId);
    if (!member) return [];
    add(member.providerId);
  }
  return providers;
}
