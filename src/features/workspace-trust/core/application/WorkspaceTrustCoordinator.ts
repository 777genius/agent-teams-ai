import {
  type WorkspaceTrustFeatureFlags,
  type WorkspaceTrustLaunchArgPatch,
  type WorkspaceTrustLaunchArgTargetSurface,
  type WorkspaceTrustProvider,
  type WorkspaceTrustWorkspace,
} from '../domain';
import { buildCodexTrustPatches } from '../domain/buildCodexTrustPatches';

import {
  WorkspaceTrustLockCancelledError,
  WorkspaceTrustLockRegistry,
  WorkspaceTrustLockTimeoutError,
} from './WorkspaceTrustLocks';

import type { ClaudePtyWorkspaceTrustStrategy } from './ClaudePtyWorkspaceTrustStrategy';

export interface WorkspaceTrustArgsOnlyPlanRequest {
  providers: WorkspaceTrustProvider[];
  workspaces: WorkspaceTrustWorkspace[];
  targetSurfaces?: WorkspaceTrustLaunchArgTargetSurface[];
  featureFlags: WorkspaceTrustFeatureFlags;
}

export interface WorkspaceTrustArgsOnlyPlanResult {
  launchArgPatches: WorkspaceTrustLaunchArgPatch[];
}

export type WorkspaceTrustFullPlanRequest = WorkspaceTrustArgsOnlyPlanRequest;

export type WorkspaceTrustFullPlanResult = WorkspaceTrustArgsOnlyPlanResult & {
  providers: WorkspaceTrustProvider[];
  workspaces: WorkspaceTrustWorkspace[];
};

export interface WorkspaceTrustExecutionPlan {
  providers: WorkspaceTrustProvider[];
  claudePath: string;
  workspaces: WorkspaceTrustWorkspace[];
  env: Record<string, string | undefined>;
  featureFlags: WorkspaceTrustFeatureFlags;
  isCancelled(): boolean;
}

export type WorkspaceTrustExecutionResult = Awaited<
  ReturnType<ClaudePtyWorkspaceTrustStrategy['execute']>
>;

export interface WorkspaceTrustCoordinator {
  planArgsOnly(
    request: WorkspaceTrustArgsOnlyPlanRequest
  ): Promise<WorkspaceTrustArgsOnlyPlanResult>;
  planFull(request: WorkspaceTrustFullPlanRequest): Promise<WorkspaceTrustFullPlanResult>;
  execute(plan: WorkspaceTrustExecutionPlan): Promise<WorkspaceTrustExecutionResult>;
}

function providerSet(providers: WorkspaceTrustProvider[]): Set<WorkspaceTrustProvider> {
  return new Set(providers.map((provider) => (provider === 'anthropic' ? 'claude' : provider)));
}

function requiresClaudeWorkspaceTrustPreflight(providers: WorkspaceTrustProvider[]): boolean {
  return providerSet(providers).has('claude');
}

export class DefaultWorkspaceTrustCoordinator implements WorkspaceTrustCoordinator {
  constructor(
    private readonly claudeStrategy: ClaudePtyWorkspaceTrustStrategy,
    private readonly lockRegistry: WorkspaceTrustLockRegistry = new WorkspaceTrustLockRegistry()
  ) {}

  async planArgsOnly(
    request: WorkspaceTrustArgsOnlyPlanRequest
  ): Promise<WorkspaceTrustArgsOnlyPlanResult> {
    return {
      launchArgPatches: buildCodexTrustPatches(request),
    };
  }

  async planFull(request: WorkspaceTrustFullPlanRequest): Promise<WorkspaceTrustFullPlanResult> {
    return {
      providers: [...providerSet(request.providers)],
      workspaces: request.workspaces,
      launchArgPatches: buildCodexTrustPatches(request),
    };
  }

  async execute(plan: WorkspaceTrustExecutionPlan): Promise<WorkspaceTrustExecutionResult> {
    if (
      !plan.featureFlags.enabled ||
      !plan.featureFlags.claudePty ||
      plan.workspaces.length === 0
    ) {
      return {
        id: 'claude-pty-workspace-trust',
        provider: 'claude',
        status: 'skipped',
        workspaceIds: plan.workspaces.map((workspace) => workspace.id),
        evidence: ['workspace trust Claude PTY preflight disabled'],
      };
    }
    if (!requiresClaudeWorkspaceTrustPreflight(plan.providers)) {
      return {
        id: 'claude-pty-workspace-trust',
        provider: 'claude',
        status: 'skipped',
        workspaceIds: plan.workspaces.map((workspace) => workspace.id),
        evidence: ['Claude workspace trust preflight not required for selected providers'],
      };
    }

    const lockKeys = plan.workspaces.map((workspace) => `claude:${workspace.comparisonKey}`);
    try {
      return await this.lockRegistry.withWorkspaceLocks(
        lockKeys,
        {
          timeoutMs: 20_000,
          isCancelled: plan.isCancelled,
        },
        () =>
          this.claudeStrategy.execute({
            claudePath: plan.claudePath,
            workspaces: plan.workspaces,
            env: plan.env,
            isCancelled: plan.isCancelled,
          })
      );
    } catch (error) {
      if (error instanceof WorkspaceTrustLockCancelledError) {
        return {
          id: 'claude-pty-workspace-trust',
          provider: 'claude',
          status: 'cancelled',
          workspaceIds: plan.workspaces.map((workspace) => workspace.id),
          errorCode: 'workspace_trust_lock_cancelled',
          errorMessage: error.message,
        };
      }
      if (error instanceof WorkspaceTrustLockTimeoutError) {
        return {
          id: 'claude-pty-workspace-trust',
          provider: 'claude',
          status: 'soft_failed',
          workspaceIds: plan.workspaces.map((workspace) => workspace.id),
          errorCode: 'workspace_trust_lock_timeout',
          errorMessage: error.message,
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        id: 'claude-pty-workspace-trust',
        provider: 'claude',
        status: 'soft_failed',
        workspaceIds: plan.workspaces.map((workspace) => workspace.id),
        errorCode: 'workspace_trust_preflight_error',
        errorMessage: message,
        evidence: [message],
      };
    }
  }
}
