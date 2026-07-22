import {
  type CliHelpOutputCache,
  type CliHelpOutputPorts,
  getCliHelpOutputForProvisioning,
} from './TeamProvisioningProviderPreflight';

import type { TeamProviderId } from '@shared/types';

export interface TeamProvisioningCliHelpOutputProviderRuntime {
  buildProvisioningEnv(): Promise<{ env: NodeJS.ProcessEnv }>;
  spawnProbe(
    claudePath: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
}

export interface TeamProvisioningCliHelpOutputPortsFactoryDeps {
  getCachedOrProbeResult(
    cwd: string,
    providerId: TeamProviderId | undefined
  ): Promise<{ claudePath?: string } | null>;
  providerRuntime: TeamProvisioningCliHelpOutputProviderRuntime;
}

export interface TeamProvisioningCliHelpOutputRequest extends TeamProvisioningCliHelpOutputPortsFactoryDeps {
  cwd?: string;
  cache: CliHelpOutputCache;
  now?: () => number;
}

export function createTeamProvisioningCliHelpOutputPorts({
  getCachedOrProbeResult,
  providerRuntime,
}: TeamProvisioningCliHelpOutputPortsFactoryDeps): CliHelpOutputPorts {
  return {
    getCachedOrProbeResult,
    buildProvisioningEnv: () => providerRuntime.buildProvisioningEnv(),
    spawnProbe: (claudePath, args, cwd, env, timeoutMs) =>
      providerRuntime.spawnProbe(claudePath, args, cwd, env, timeoutMs),
  };
}

export async function getCliHelpOutputWithProvisioningPorts({
  cwd,
  cache,
  now,
  ...portsDeps
}: TeamProvisioningCliHelpOutputRequest): Promise<string> {
  const ports = createTeamProvisioningCliHelpOutputPorts(portsDeps);
  const cacheSnapshot = { ...cache };
  const output = await getCliHelpOutputForProvisioning({
    cwd,
    cache: cacheSnapshot,
    ports,
    now,
  });
  cache.output = cacheSnapshot.output;
  cache.cachedAtMs = cacheSnapshot.cachedAtMs;
  return output;
}
