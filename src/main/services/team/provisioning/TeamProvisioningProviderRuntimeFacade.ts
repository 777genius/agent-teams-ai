import { createTeamProvisioningProviderDiagnosticsRuntime } from './TeamProvisioningProviderDiagnosticsPorts';

import type {
  BuildProvisioningEnvOptions,
  CrossProviderMemberArgsResult,
  ProvisioningEnvResolution,
  TeamRuntimeAuthContext,
} from './TeamProvisioningEnvBuilder';
import type { TeamProvisioningEnvRuntimePorts } from './TeamProvisioningEnvRuntimePorts';
import type { SpawnProbeOptions, SpawnProbeResult } from './TeamProvisioningProviderDiagnostics';
import type {
  TeamProvisioningProviderDiagnosticsRuntime,
  TeamProvisioningProviderDiagnosticsRuntimeInput,
} from './TeamProvisioningProviderDiagnosticsPorts';
import type { TeamCreateRequest, TeamProviderId } from '@shared/types';

export interface TeamProvisioningProviderRuntimeFacadeDeps {
  diagnosticsRuntimeInput: TeamProvisioningProviderDiagnosticsRuntimeInput;
  envRuntimePorts: TeamProvisioningEnvRuntimePorts;
  createDiagnosticsRuntime?: (
    input: TeamProvisioningProviderDiagnosticsRuntimeInput
  ) => TeamProvisioningProviderDiagnosticsRuntime;
}

export class TeamProvisioningProviderRuntimeFacade {
  private readonly createDiagnosticsRuntime: (
    input: TeamProvisioningProviderDiagnosticsRuntimeInput
  ) => TeamProvisioningProviderDiagnosticsRuntime;

  constructor(private readonly deps: TeamProvisioningProviderRuntimeFacadeDeps) {
    this.createDiagnosticsRuntime =
      deps.createDiagnosticsRuntime ?? createTeamProvisioningProviderDiagnosticsRuntime;
  }

  getProviderDiagnosticsRuntime(): TeamProvisioningProviderDiagnosticsRuntime {
    return this.createDiagnosticsRuntime(this.deps.diagnosticsRuntimeInput);
  }

  probeClaudeRuntime(
    claudePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    providerId: TeamProviderId | undefined = 'anthropic',
    providerArgs: string[] = []
  ): Promise<{ warning?: string }> {
    return this.getProviderDiagnosticsRuntime().probeClaudeRuntime(
      claudePath,
      cwd,
      env,
      providerId,
      providerArgs
    );
  }

  runProviderOneShotDiagnostic(
    claudePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    providerId: TeamProviderId | undefined = 'anthropic',
    providerArgs: string[] = []
  ): Promise<{ warning?: string }> {
    return this.getProviderDiagnosticsRuntime().runProviderOneShotDiagnostic(
      claudePath,
      cwd,
      env,
      providerId,
      providerArgs
    );
  }

  async validateAgentTeamsMcpRuntime(
    claudePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    mcpConfigPath: string,
    options: { isCancelled?: () => boolean } = {}
  ): Promise<void> {
    await this.getProviderDiagnosticsRuntime().validateAgentTeamsMcpRuntime(
      claudePath,
      cwd,
      env,
      mcpConfigPath,
      options
    );
  }

  spawnProbe(
    claudePath: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    options?: SpawnProbeOptions
  ): Promise<SpawnProbeResult> {
    return this.getProviderDiagnosticsRuntime().spawnProbe(
      claudePath,
      args,
      cwd,
      env,
      timeoutMs,
      options
    );
  }

  buildProvisioningEnv(
    providerId: TeamProviderId | undefined = 'anthropic',
    providerBackendId?: string | null,
    options?: BuildProvisioningEnvOptions
  ): Promise<ProvisioningEnvResolution> {
    return this.deps.envRuntimePorts.buildProvisioningEnv(providerId, providerBackendId, options);
  }

  buildCrossProviderMemberArgs(
    primaryProviderId: TeamProviderId,
    memberSpecs: TeamCreateRequest['members'],
    options?: { teamRuntimeAuth?: TeamRuntimeAuthContext }
  ): Promise<CrossProviderMemberArgsResult> {
    return this.deps.envRuntimePorts.buildCrossProviderMemberArgs(
      primaryProviderId,
      memberSpecs,
      options
    );
  }

  resolveControlApiBaseUrl(): Promise<string | null> {
    return this.deps.envRuntimePorts.resolveControlApiBaseUrl();
  }
}

export function createTeamProvisioningProviderRuntimeFacade(
  deps: TeamProvisioningProviderRuntimeFacadeDeps
): TeamProvisioningProviderRuntimeFacade {
  return new TeamProvisioningProviderRuntimeFacade(deps);
}
