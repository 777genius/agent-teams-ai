import {
  ExecutionBackendCapabilityPolicy,
  PROVISIONING_CLI_PROVIDER_IDS,
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

/** The compatibility seam around the target-base deterministic provisioning lifecycle. */
export interface ProvisioningCliDeterministicExecutionPorts {
  readCapabilities(
    request: LaneExecutionRequest
  ): Promise<readonly LaneExecutionProviderCapability[]>;
  preflight(request: CancellableLaneExecutionRequest): Promise<LaneExecutionPreflightDecision>;
  launch(request: LaunchLaneExecutionRequest): Promise<LaneExecutionLaunchOutcome>;
  observe(request: ObserveLaneExecutionRequest): Promise<LaneExecutionObserveOutcome>;
  stop(request: StopLaneExecutionRequest): Promise<LaneExecutionStopOutcome>;
  recover(request: CancellableLaneExecutionRequest): Promise<LaneExecutionRecoverOutcome>;
}

export class ProvisioningCliExecutionBackend implements LaneExecutionBackend {
  readonly backend = 'provisioning_cli' as const;
  readonly supportedProviderIds = PROVISIONING_CLI_PROVIDER_IDS;

  constructor(
    private readonly ports: ProvisioningCliDeterministicExecutionPorts,
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

    const capabilities = await this.readCapabilities(request.scope, true);
    if (capabilities.status === 'rejected') return capabilities;
    if (isCancelled(request)) return { status: 'rejected', reason: 'cancelled' };
    try {
      const outcome = await this.ports.preflight(request);
      return this.capabilityPolicy.containPreflightOutcome(
        request.scope,
        this.backend,
        capabilities.capabilities,
        outcome
      );
    } catch {
      return { status: 'rejected', reason: 'unavailable' };
    }
  }

  async launch(request: LaunchLaneExecutionRequest): Promise<LaneExecutionLaunchOutcome> {
    const rejected = this.rejectInvalidRequest(request.scope);
    if (rejected) return rejected;
    if (isCancelled(request)) return { status: 'rejected', reason: 'cancelled' };

    const capabilities = await this.readCapabilities(request.scope, true);
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
        await this.ports.launch(request),
        capabilities.capabilities
      );
    } catch {
      return { status: 'operator_required' };
    }
  }

  async observe(request: ObserveLaneExecutionRequest): Promise<LaneExecutionObserveOutcome> {
    const rejected = this.rejectInvalidRequest(request.scope);
    if (rejected) return rejected;
    const capabilities = await this.readCapabilities(request.scope, false);
    if (capabilities.status === 'rejected') return capabilities;
    try {
      return this.capabilityPolicy.containObserveOutcome(
        await this.ports.observe(request),
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
    const capabilities = await this.readCapabilities(request.scope, false);
    if (capabilities.status === 'rejected') return capabilities;
    try {
      return this.capabilityPolicy.containStopOutcome(
        await this.ports.stop(request),
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
    const capabilities = await this.readCapabilities(request.scope, true);
    if (capabilities.status === 'rejected') return capabilities;
    if (isCancelled(request)) return { status: 'cancelled' };
    try {
      return this.capabilityPolicy.containRecoverOutcome(
        await this.ports.recover(request),
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

  private async readCapabilities(
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
        await this.ports.readCapabilities({ scope }),
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
