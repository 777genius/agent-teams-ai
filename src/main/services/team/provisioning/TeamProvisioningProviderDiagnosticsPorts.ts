import {
  createDefaultTeamProvisioningProviderDiagnosticsPorts,
  probeClaudeRuntime as probeClaudeRuntimeHelper,
  probeProviderRuntimeControlPlane as probeProviderRuntimeControlPlaneHelper,
  runProviderOneShotDiagnostic as runProviderOneShotDiagnosticHelper,
  spawnProbe as spawnProbeHelper,
  type SpawnProbeOptions,
  type SpawnProbeResult,
  type TeamProvisioningProbeChild,
  type TeamProvisioningProviderDiagnosticsPorts,
  validateAgentTeamsMcpRuntime as validateAgentTeamsMcpRuntimeHelper,
} from './TeamProvisioningProviderDiagnostics';

import type { ProviderConnectionService } from '../../runtime/ProviderConnectionService';
import type { AuthWarningSource } from './TeamProvisioningOutputErrorPolicy';
import type { TeamProviderId } from '@shared/types';

interface TeamProvisioningProviderDiagnosticsLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface TeamProvisioningProviderDiagnosticsRuntimeInput {
  transientProbeProcesses: Set<TeamProvisioningProbeChild>;
  providerConnectionService?: Pick<
    ProviderConnectionService,
    'getConfiguredCodexCustomProviderModel'
  >;
  logger: TeamProvisioningProviderDiagnosticsLogger;
  isAuthFailureWarning(text: string, source: AuthWarningSource): boolean;
  normalizeApiRetryErrorMessage(text: string): string;
}

export interface TeamProvisioningProviderDiagnosticsRuntime {
  getBasePorts(): TeamProvisioningProviderDiagnosticsPorts;
  getPorts(): TeamProvisioningProviderDiagnosticsPorts;
  probeClaudeRuntime(
    claudePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    providerId?: TeamProviderId,
    providerArgs?: string[]
  ): Promise<{ warning?: string }>;
  probeProviderRuntimeControlPlane(input: {
    claudePath: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    providerId: TeamProviderId;
    providerArgs: string[];
  }): Promise<{ warning?: string }>;
  runProviderOneShotDiagnostic(
    claudePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    providerId?: TeamProviderId,
    providerArgs?: string[]
  ): Promise<{ warning?: string }>;
  validateAgentTeamsMcpRuntime(
    claudePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    mcpConfigPath: string,
    options?: { isCancelled?: () => boolean }
  ): Promise<void>;
  spawnProbe(
    claudePath: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    options?: SpawnProbeOptions
  ): Promise<SpawnProbeResult>;
}

export function buildTeamProvisioningProviderDiagnosticsPorts(input: {
  basePorts: TeamProvisioningProviderDiagnosticsPorts;
  spawnProbe: TeamProvisioningProviderDiagnosticsPorts['spawnProbe'];
}): TeamProvisioningProviderDiagnosticsPorts {
  return {
    ...input.basePorts,
    spawnProbe: input.spawnProbe,
  };
}

export function createTeamProvisioningProviderDiagnosticsBasePorts(
  input: TeamProvisioningProviderDiagnosticsRuntimeInput
): TeamProvisioningProviderDiagnosticsPorts {
  return createDefaultTeamProvisioningProviderDiagnosticsPorts({
    transientProbeProcesses: input.transientProbeProcesses,
    providerConnectionService: input.providerConnectionService,
    logger: input.logger,
    isAuthFailureWarning: input.isAuthFailureWarning,
    normalizeApiRetryErrorMessage: input.normalizeApiRetryErrorMessage,
  });
}

export function createTeamProvisioningProviderDiagnosticsRuntime(
  input: TeamProvisioningProviderDiagnosticsRuntimeInput
): TeamProvisioningProviderDiagnosticsRuntime {
  const getBasePorts = () => createTeamProvisioningProviderDiagnosticsBasePorts(input);
  const spawnProbe = (
    claudePath: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    options?: SpawnProbeOptions
  ): Promise<SpawnProbeResult> =>
    spawnProbeHelper({
      claudePath,
      args,
      cwd,
      env,
      timeoutMs,
      options,
      ports: getBasePorts(),
    });
  const getPorts = () =>
    buildTeamProvisioningProviderDiagnosticsPorts({
      basePorts: getBasePorts(),
      spawnProbe,
    });

  return {
    getBasePorts,
    getPorts,
    probeClaudeRuntime: (claudePath, cwd, env, providerId = 'anthropic', providerArgs = []) =>
      probeClaudeRuntimeHelper({
        claudePath,
        cwd,
        env,
        providerId,
        providerArgs,
        ports: getPorts(),
      }),
    probeProviderRuntimeControlPlane: (controlPlaneInput) =>
      probeProviderRuntimeControlPlaneHelper({
        ...controlPlaneInput,
        ports: getPorts(),
      }),
    runProviderOneShotDiagnostic: (
      claudePath,
      cwd,
      env,
      providerId = 'anthropic',
      providerArgs = []
    ) =>
      runProviderOneShotDiagnosticHelper({
        claudePath,
        cwd,
        env,
        providerId,
        providerArgs,
        ports: getPorts(),
      }),
    validateAgentTeamsMcpRuntime: (
      claudePath,
      cwd,
      env,
      mcpConfigPath,
      options: { isCancelled?: () => boolean } = {}
    ) =>
      validateAgentTeamsMcpRuntimeHelper({
        claudePath,
        cwd,
        env,
        mcpConfigPath,
        options,
        ports: getPorts(),
      }),
    spawnProbe,
  };
}
