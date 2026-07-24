import {
  ExecutionBackendCapabilityPolicy,
  OPENCODE_EXECUTION_PROVIDER_IDS,
} from '../../../infrastructure/backends';

import type {
  CancellableLaneExecutionRequest,
  LaneExecutionBackend,
  LaneExecutionLaunchOutcome,
  LaneExecutionObserveOutcome,
  LaneExecutionOperationRejectionReason,
  LaneExecutionPlanValidationOutcome,
  LaneExecutionPreflightDecision,
  LaneExecutionPreflightOutcome,
  LaneExecutionProviderCapability,
  LaneExecutionRecoverOutcome,
  LaneExecutionRequest,
  LaneExecutionScope,
  LaneExecutionStopOutcome,
  LaunchLaneExecutionRequest,
  ObserveLaneExecutionRequest,
  StopLaneExecutionRequest,
} from '../../../../core/application/backends';
import type { TeamProviderId } from '@shared/types';

/** Structural subset implemented by the target-base TeamRuntimeAdapterRegistry. */
export interface TeamRuntimeAdapterRegistryCompatiblePort<TAdapter> {
  has(providerId: TeamProviderId): boolean;
  get(providerId: TeamProviderId): TAdapter;
}

export interface OpenCodeExecutionCompatibilityPorts<
  TAdapter extends { readonly providerId: TeamProviderId },
> {
  readonly registry: TeamRuntimeAdapterRegistryCompatiblePort<TAdapter>;
  readCapabilities(
    adapter: TAdapter,
    request: LaneExecutionRequest
  ): Promise<readonly LaneExecutionProviderCapability[]>;
  preflight(
    adapter: TAdapter,
    request: CancellableLaneExecutionRequest
  ): Promise<LaneExecutionPreflightDecision>;
  launch(
    adapter: TAdapter,
    request: LaunchLaneExecutionRequest
  ): Promise<LaneExecutionLaunchOutcome>;
  observe(
    adapter: TAdapter,
    request: ObserveLaneExecutionRequest
  ): Promise<LaneExecutionObserveOutcome>;
  stop(adapter: TAdapter, request: StopLaneExecutionRequest): Promise<LaneExecutionStopOutcome>;
  recover(
    adapter: TAdapter,
    request: CancellableLaneExecutionRequest
  ): Promise<LaneExecutionRecoverOutcome>;
}

export class OpenCodeExecutionBackend<
  TAdapter extends { readonly providerId: TeamProviderId },
> implements LaneExecutionBackend {
  readonly backend = 'opencode' as const;
  readonly supportedProviderIds = OPENCODE_EXECUTION_PROVIDER_IDS;

  constructor(
    private readonly ports: OpenCodeExecutionCompatibilityPorts<TAdapter>,
    private readonly capabilityPolicy = new ExecutionBackendCapabilityPolicy()
  ) {}

  validatePlan(scope: LaneExecutionScope): LaneExecutionPlanValidationOutcome {
    return this.capabilityPolicy.validatePlan(scope, this.backend);
  }

  async preflight(
    request: CancellableLaneExecutionRequest
  ): Promise<LaneExecutionPreflightOutcome> {
    const rejected = this.rejectInvalidRequest(request.scope);
    if (rejected) return rejected;
    if (isCancelled(request)) return { status: 'rejected', reason: 'cancelled' };
    const resolved = this.resolveAdapter();
    if (resolved.status === 'rejected') return resolved;
    const capabilities = await this.readCapabilities(resolved.adapter, request.scope, true);
    if (capabilities.status === 'rejected') return capabilities;
    if (isCancelled(request)) return { status: 'rejected', reason: 'cancelled' };
    try {
      return this.capabilityPolicy.containPreflightOutcome(
        request.scope,
        this.backend,
        capabilities.capabilities,
        await this.ports.preflight(resolved.adapter, request)
      );
    } catch {
      return { status: 'rejected', reason: 'unavailable' };
    }
  }

  async launch(request: LaunchLaneExecutionRequest): Promise<LaneExecutionLaunchOutcome> {
    const rejected = this.rejectInvalidRequest(request.scope);
    if (rejected) return rejected;
    if (isCancelled(request)) return { status: 'rejected', reason: 'cancelled' };
    const resolved = this.resolveAdapter();
    if (resolved.status === 'rejected') return resolved;
    const capabilities = await this.readCapabilities(resolved.adapter, request.scope, true);
    if (capabilities.status === 'rejected') return capabilities;
    const receipt = this.capabilityPolicy.validateReadinessReceipt(
      request.scope,
      this.backend,
      capabilities.capabilities,
      request.readiness
    );
    if (receipt.status === 'rejected') return receipt;
    if (isCancelled(request)) return { status: 'rejected', reason: 'cancelled' };
    try {
      return this.capabilityPolicy.containLaunchOutcome(
        await this.ports.launch(resolved.adapter, request),
        capabilities.capabilities
      );
    } catch {
      return { status: 'operator_required' };
    }
  }

  async observe(request: ObserveLaneExecutionRequest): Promise<LaneExecutionObserveOutcome> {
    const rejected = this.rejectInvalidRequest(request.scope);
    if (rejected) return rejected;
    const resolved = this.resolveAdapter();
    if (resolved.status === 'rejected') return resolved;
    const capabilities = await this.readCapabilities(resolved.adapter, request.scope, false);
    if (capabilities.status === 'rejected') return capabilities;
    try {
      return this.capabilityPolicy.containObserveOutcome(
        await this.ports.observe(resolved.adapter, request),
        capabilities.capabilities
      );
    } catch {
      return { status: 'rejected', reason: 'unavailable' };
    }
  }

  async stop(request: StopLaneExecutionRequest): Promise<LaneExecutionStopOutcome> {
    const rejected = this.rejectInvalidRequest(request.scope);
    if (rejected) return rejected;
    if (isCancelled(request)) return { status: 'cancelled' };
    const resolved = this.resolveAdapter();
    if (resolved.status === 'rejected') return resolved;
    const capabilities = await this.readCapabilities(resolved.adapter, request.scope, false);
    if (capabilities.status === 'rejected') return capabilities;
    try {
      return this.capabilityPolicy.containStopOutcome(
        await this.ports.stop(resolved.adapter, request),
        capabilities.capabilities
      );
    } catch {
      return { status: 'operator_required' };
    }
  }

  async recover(request: CancellableLaneExecutionRequest): Promise<LaneExecutionRecoverOutcome> {
    const rejected = this.rejectInvalidRequest(request.scope);
    if (rejected) return rejected;
    if (isCancelled(request)) return { status: 'cancelled' };
    const resolved = this.resolveAdapter();
    if (resolved.status === 'rejected') return resolved;
    const capabilities = await this.readCapabilities(resolved.adapter, request.scope, true);
    if (capabilities.status === 'rejected') return capabilities;
    if (isCancelled(request)) return { status: 'cancelled' };
    try {
      return this.capabilityPolicy.containRecoverOutcome(
        await this.ports.recover(resolved.adapter, request),
        capabilities.capabilities
      );
    } catch {
      return { status: 'operator_required' };
    }
  }

  private rejectInvalidRequest(
    scope: LaneExecutionScope
  ): { readonly status: 'rejected'; readonly reason: 'invalid_plan' | 'unsupported' } | null {
    const validation = this.validatePlan(scope);
    if (validation.status === 'accepted') return null;
    return {
      status: 'rejected',
      reason: validation.reason === 'unsupported_provider' ? 'unsupported' : 'invalid_plan',
    };
  }

  private resolveAdapter():
    | { readonly status: 'resolved'; readonly adapter: TAdapter }
    | { readonly status: 'rejected'; readonly reason: LaneExecutionOperationRejectionReason } {
    try {
      if (!this.ports.registry.has('opencode')) {
        return { status: 'rejected', reason: 'unsupported' };
      }
      const adapter = this.ports.registry.get('opencode');
      if (adapter.providerId !== 'opencode') {
        return { status: 'rejected', reason: 'capability_mismatch' };
      }
      return { status: 'resolved', adapter };
    } catch {
      return { status: 'rejected', reason: 'unavailable' };
    }
  }

  private async readCapabilities(
    adapter: TAdapter,
    scope: LaneExecutionScope,
    requireReady: boolean
  ): Promise<
    | {
        readonly status: 'admitted';
        readonly capabilities: readonly LaneExecutionProviderCapability[];
      }
    | { readonly status: 'rejected'; readonly reason: LaneExecutionOperationRejectionReason }
  > {
    try {
      return this.capabilityPolicy.admitCapabilities(
        scope,
        this.backend,
        await this.ports.readCapabilities(adapter, { scope }),
        { requireReady }
      );
    } catch {
      return { status: 'rejected', reason: 'unavailable' };
    }
  }
}

function isCancelled(request: CancellableLaneExecutionRequest): boolean {
  try {
    return request.cancellation.isCancellationRequested();
  } catch {
    return true;
  }
}
