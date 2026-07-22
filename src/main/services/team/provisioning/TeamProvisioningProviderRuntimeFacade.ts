import {
  createTeamProvisioningEnvRuntimePorts,
  type TeamProvisioningEnvRuntimePorts,
  type TeamProvisioningEnvRuntimePortsDeps,
} from './TeamProvisioningEnvRuntimePorts';
import { createTeamProvisioningProviderDiagnosticsRuntime } from './TeamProvisioningProviderDiagnosticsPorts';

import type {
  BuildProvisioningEnvOptions,
  CrossProviderMemberArgsResult,
  ProvisioningEnvResolution,
  TeamRuntimeAuthContext,
} from './TeamProvisioningEnvBuilder';
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

export interface TeamProvisioningProviderRuntimeFacadeServiceHost {
  providerConnectionService: TeamProvisioningProviderDiagnosticsRuntimeInput['providerConnectionService'] &
    TeamProvisioningEnvRuntimePortsDeps['providerConnectionService'];
  appShellBoundary: {
    getControlApiBaseUrlResolver(): ReturnType<
      TeamProvisioningEnvRuntimePortsDeps['getControlApiBaseUrlResolver']
    >;
    getRuntimeTurnSettledEnvironmentProvider(): ReturnType<
      TeamProvisioningEnvRuntimePortsDeps['getRuntimeTurnSettledEnvironmentProvider']
    >;
    getRuntimeTurnSettledHookSettingsProvider(): ReturnType<
      TeamProvisioningEnvRuntimePortsDeps['getRuntimeTurnSettledHookSettingsProvider']
    >;
  };
}

export interface TeamProvisioningProviderRuntimeFacadeServiceHostOptions {
  transientProbeProcesses: TeamProvisioningProviderDiagnosticsRuntimeInput['transientProbeProcesses'];
  logger: TeamProvisioningProviderDiagnosticsRuntimeInput['logger'] &
    TeamProvisioningEnvRuntimePortsDeps['logger'];
  isAuthFailureWarning: TeamProvisioningProviderDiagnosticsRuntimeInput['isAuthFailureWarning'];
  normalizeApiRetryErrorMessage: TeamProvisioningProviderDiagnosticsRuntimeInput['normalizeApiRetryErrorMessage'];
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

  async probeClaudeRuntime(
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

  async runProviderOneShotDiagnostic(
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

  async spawnProbe(
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

  async buildProvisioningEnv(
    providerId: TeamProviderId | undefined = 'anthropic',
    providerBackendId?: string | null,
    options?: BuildProvisioningEnvOptions
  ): Promise<ProvisioningEnvResolution> {
    return this.deps.envRuntimePorts.buildProvisioningEnv(providerId, providerBackendId, options);
  }

  async buildCrossProviderMemberArgs(
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

  async resolveControlApiBaseUrl(): Promise<string | null> {
    return this.deps.envRuntimePorts.resolveControlApiBaseUrl();
  }
}

export type TeamProvisioningProviderRuntimeCompatibility = Pick<
  TeamProvisioningProviderRuntimeFacade,
  'buildProvisioningEnv' | 'buildCrossProviderMemberArgs' | 'validateAgentTeamsMcpRuntime'
>;

export function createTeamProvisioningProviderRuntimeCompatibility(
  facade: TeamProvisioningProviderRuntimeFacade
): TeamProvisioningProviderRuntimeCompatibility {
  return {
    buildProvisioningEnv: (...args) => facade.buildProvisioningEnv(...args),
    buildCrossProviderMemberArgs: (...args) => facade.buildCrossProviderMemberArgs(...args),
    validateAgentTeamsMcpRuntime: (...args) => facade.validateAgentTeamsMcpRuntime(...args),
  };
}

export function createTeamProvisioningProviderRuntimeFacade(
  deps: TeamProvisioningProviderRuntimeFacadeDeps
): TeamProvisioningProviderRuntimeFacade {
  return new TeamProvisioningProviderRuntimeFacade(deps);
}

export function createTeamProvisioningProviderRuntimeFacadeDepsFromService(
  service: TeamProvisioningProviderRuntimeFacadeServiceHost,
  options: TeamProvisioningProviderRuntimeFacadeServiceHostOptions
): TeamProvisioningProviderRuntimeFacadeDeps {
  return {
    diagnosticsRuntimeInput: {
      transientProbeProcesses: options.transientProbeProcesses,
      providerConnectionService: service.providerConnectionService,
      logger: options.logger,
      isAuthFailureWarning: options.isAuthFailureWarning,
      normalizeApiRetryErrorMessage: options.normalizeApiRetryErrorMessage,
    },
    envRuntimePorts: createTeamProvisioningEnvRuntimePorts({
      providerConnectionService: service.providerConnectionService,
      getControlApiBaseUrlResolver: () => service.appShellBoundary.getControlApiBaseUrlResolver(),
      getRuntimeTurnSettledEnvironmentProvider: () =>
        service.appShellBoundary.getRuntimeTurnSettledEnvironmentProvider(),
      getRuntimeTurnSettledHookSettingsProvider: () =>
        service.appShellBoundary.getRuntimeTurnSettledHookSettingsProvider(),
      logger: options.logger,
    }),
  };
}

export function createTeamProvisioningProviderRuntimeFacadeFromService(
  service: TeamProvisioningProviderRuntimeFacadeServiceHost,
  options: TeamProvisioningProviderRuntimeFacadeServiceHostOptions
): TeamProvisioningProviderRuntimeFacade {
  return createTeamProvisioningProviderRuntimeFacade(
    createTeamProvisioningProviderRuntimeFacadeDepsFromService(service, options)
  );
}
