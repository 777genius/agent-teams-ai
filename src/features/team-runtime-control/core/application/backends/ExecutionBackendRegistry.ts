import {
  type CompositeRuntimePlan,
  type LaneId,
  RUNTIME_EXECUTION_BACKENDS,
  type RuntimeExecutionBackendKind,
} from '../../../contracts';
import { decodeCompositeRuntimePlan } from '../planning';

import type {
  LaneExecutionBackend,
  LaneExecutionPlanValidationOutcome,
  LaneExecutionScope,
} from './LaneExecutionBackend';
import type { TeamProviderId } from '@shared/types';

const TEAM_PROVIDER_IDS = Object.freeze([
  'anthropic',
  'codex',
  'gemini',
  'opencode',
] as const satisfies readonly TeamProviderId[]);

export type ExecutionBackendRegistryConfigurationErrorCode =
  | 'duplicate_backend'
  | 'duplicate_provider'
  | 'invalid_backend'
  | 'invalid_provider_set';

export class ExecutionBackendRegistryConfigurationError extends TypeError {
  readonly code: ExecutionBackendRegistryConfigurationErrorCode;

  constructor(code: ExecutionBackendRegistryConfigurationErrorCode) {
    super(`execution-backend-registry-${code.replaceAll('_', '-')}`);
    this.name = 'ExecutionBackendRegistryConfigurationError';
    this.code = code;
  }
}

export type ResolveLaneExecutionBackendRejectionReason =
  | 'invalid_plan'
  | 'lane_not_found'
  | 'backend_not_registered'
  | 'provider_not_owned'
  | 'backend_rejected';

export type ResolveLaneExecutionBackendOutcome =
  | {
      readonly status: 'resolved';
      readonly backend: LaneExecutionBackend;
      readonly scope: LaneExecutionScope;
    }
  | {
      readonly status: 'rejected';
      readonly reason: ResolveLaneExecutionBackendRejectionReason;
      readonly validation?: LaneExecutionPlanValidationOutcome;
    };

/** A registration-order-independent map from an accepted lane binding to one backend. */
export class ExecutionBackendRegistry {
  private readonly backendByKind: ReadonlyMap<RuntimeExecutionBackendKind, LaneExecutionBackend>;
  private readonly providerOwners: ReadonlyMap<TeamProviderId, RuntimeExecutionBackendKind>;
  private readonly orderedBackends: readonly LaneExecutionBackend[];

  constructor(backends: readonly LaneExecutionBackend[]) {
    const byKind = new Map<RuntimeExecutionBackendKind, LaneExecutionBackend>();
    const providerOwners = new Map<TeamProviderId, RuntimeExecutionBackendKind>();

    for (const backend of backends) {
      if (!(RUNTIME_EXECUTION_BACKENDS as readonly unknown[]).includes(backend.backend)) {
        throw new ExecutionBackendRegistryConfigurationError('invalid_backend');
      }
      if (byKind.has(backend.backend)) {
        throw new ExecutionBackendRegistryConfigurationError('duplicate_backend');
      }
      if (
        backend.supportedProviderIds.length === 0 ||
        new Set(backend.supportedProviderIds).size !== backend.supportedProviderIds.length ||
        backend.supportedProviderIds.some(
          (providerId) => !(TEAM_PROVIDER_IDS as readonly unknown[]).includes(providerId)
        )
      ) {
        throw new ExecutionBackendRegistryConfigurationError('invalid_provider_set');
      }
      for (const providerId of backend.supportedProviderIds) {
        if (providerOwners.has(providerId)) {
          throw new ExecutionBackendRegistryConfigurationError('duplicate_provider');
        }
        providerOwners.set(providerId, backend.backend);
      }
      byKind.set(backend.backend, backend);
    }

    this.backendByKind = byKind;
    this.providerOwners = providerOwners;
    this.orderedBackends = Object.freeze(
      RUNTIME_EXECUTION_BACKENDS.flatMap((kind) => {
        const backend = byKind.get(kind);
        return backend ? [backend] : [];
      })
    );
  }

  backends(): readonly LaneExecutionBackend[] {
    return this.orderedBackends;
  }

  resolve(planValue: CompositeRuntimePlan, laneId: LaneId): ResolveLaneExecutionBackendOutcome {
    let plan: CompositeRuntimePlan;
    try {
      plan = decodeCompositeRuntimePlan(planValue);
    } catch {
      return { status: 'rejected', reason: 'invalid_plan' };
    }

    const lanes = plan.lanes.filter((lane) => lane.laneId === laneId);
    const executionUnits = plan.executionUnits.filter((unit) => unit.laneId === laneId);
    if (lanes.length !== 1 || executionUnits.length !== 1) {
      return { status: 'rejected', reason: 'lane_not_found' };
    }

    const lane = lanes[0];
    const executionUnit = executionUnits[0];
    if (!lane || !executionUnit) {
      return { status: 'rejected', reason: 'lane_not_found' };
    }
    const backend = this.backendByKind.get(executionUnit.backendBinding.backend);
    if (!backend) {
      return { status: 'rejected', reason: 'backend_not_registered' };
    }

    const requiredProviderIds = deriveRequiredProviderIds(plan, laneId);
    if (
      requiredProviderIds.length === 0 ||
      requiredProviderIds.some(
        (providerId) => this.providerOwners.get(providerId) !== executionUnit.backendBinding.backend
      )
    ) {
      return { status: 'rejected', reason: 'provider_not_owned' };
    }

    const scope: LaneExecutionScope = Object.freeze({
      plan,
      lane,
      executionUnit,
      requiredProviderIds: Object.freeze(requiredProviderIds),
    });
    let validation: LaneExecutionPlanValidationOutcome;
    try {
      validation = backend.validatePlan(scope);
    } catch {
      return { status: 'rejected', reason: 'backend_rejected' };
    }
    if (!isAcceptedValidation(validation)) {
      return { status: 'rejected', reason: 'backend_rejected', validation };
    }
    return { status: 'resolved', backend, scope };
  }
}

function isAcceptedValidation(value: unknown): value is { readonly status: 'accepted' } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === 1 &&
    (value as { readonly status?: unknown }).status === 'accepted'
  );
}

function deriveRequiredProviderIds(plan: CompositeRuntimePlan, laneId: LaneId): TeamProviderId[] {
  const lane = plan.lanes.find((candidate) => candidate.laneId === laneId);
  if (!lane) return [];

  const providers: TeamProviderId[] = [];
  const add = (providerId: TeamProviderId): void => {
    if (!providers.includes(providerId)) providers.push(providerId);
  };
  if (lane.laneKind === 'primary') add(plan.leadProviderId);
  for (const memberId of lane.memberIds) {
    const member = plan.memberBindings.find((candidate) => candidate.memberId === memberId);
    if (!member) return [];
    add(member.providerId);
  }
  return providers;
}
