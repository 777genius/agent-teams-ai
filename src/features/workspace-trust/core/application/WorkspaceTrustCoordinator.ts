import {
  buildCodexTrustedProjectConfigOverrides,
  buildCodexWorkspaceTrustSettingsArgs,
  type WorkspaceTrustFeatureFlags,
  type WorkspaceTrustLaunchArgPatch,
  type WorkspaceTrustLaunchArgTargetSurface,
  type WorkspaceTrustProvider,
  type WorkspaceTrustWorkspace,
} from '../domain';

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

const DEFAULT_CODEX_TARGET_SURFACES: WorkspaceTrustLaunchArgTargetSurface[] = [
  'primary_provider_args',
  'cross_provider_member_args',
  'provider_facts_probe',
  'default_model_probe',
];

function providerSet(providers: WorkspaceTrustProvider[]): Set<WorkspaceTrustProvider> {
  return new Set(providers.map((provider) => (provider === 'anthropic' ? 'claude' : provider)));
}

function requiresClaudeWorkspaceTrustPreflight(providers: WorkspaceTrustProvider[]): boolean {
  return providerSet(providers).has('claude');
}

function buildCodexPatches(input: {
  providers: WorkspaceTrustProvider[];
  workspaces: WorkspaceTrustWorkspace[];
  targetSurfaces?: WorkspaceTrustLaunchArgTargetSurface[];
  featureFlags: WorkspaceTrustFeatureFlags;
}): WorkspaceTrustLaunchArgPatch[] {
  if (!input.featureFlags.enabled || !input.featureFlags.codexArgs) {
    return [];
  }
  if (!providerSet(input.providers).has('codex')) {
    return [];
  }

  const configKeys = input.workspaces.flatMap((workspace) => [
    workspace.configKeyCwd,
    workspace.realCwd,
    ...(workspace.gitRootConfigKey ? [workspace.gitRootConfigKey] : []),
  ]);
  const overrides = buildCodexTrustedProjectConfigOverrides(configKeys);
  const args = buildCodexWorkspaceTrustSettingsArgs(overrides);
  if (args.length === 0) {
    return [];
  }

  const workspaceIds = input.workspaces.map((workspace) => workspace.id);
  const surfaces = input.targetSurfaces ?? DEFAULT_CODEX_TARGET_SURFACES;
  return surfaces.map((surface) => ({
    id: `workspace-trust:codex:${surface}`,
    owner: 'workspace-trust' as const,
    targetProvider: 'codex' as const,
    targetSurface: surface,
    dialect: 'claude-codex-runtime-settings' as const,
    args,
    dedupeKey: `workspace-trust:codex:${surface}:${overrides.join('|')}`,
    sourceWorkspaceIds: workspaceIds,
    reason: 'Carry app-owned Codex workspace trust overrides through sibling runtime settings.',
  }));
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
      launchArgPatches: buildCodexPatches(request),
    };
  }

  async planFull(request: WorkspaceTrustFullPlanRequest): Promise<WorkspaceTrustFullPlanResult> {
    return {
      providers: [...providerSet(request.providers)],
      workspaces: request.workspaces,
      launchArgPatches: buildCodexPatches(request),
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
