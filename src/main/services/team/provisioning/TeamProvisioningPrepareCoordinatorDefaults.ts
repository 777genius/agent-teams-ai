import { execCli as defaultExecCli } from '@main/utils/childProcess';
import * as path from 'path';

import { ClaudeBinaryResolver } from '../ClaudeBinaryResolver';

import { createInMemoryProviderProbeCachePort } from './TeamProvisioningProviderProbeCache';

import type { TeamProvisioningPrepareCoordinatorPorts } from './TeamProvisioningPrepareCoordinator';

export function createDefaultTeamProvisioningPrepareCoordinatorPorts(
  overrides: Partial<TeamProvisioningPrepareCoordinatorPorts>
): TeamProvisioningPrepareCoordinatorPorts {
  return {
    providerProbeCache: createInMemoryProviderProbeCachePort(),
    getOpenCodeRuntimeAdapter: () => null,
    buildProvisioningEnv: async () => ({
      env: process.env,
      authSource: 'none',
      geminiRuntimeAuth: null,
      providerArgs: [],
    }),
    runProviderOneShotDiagnostic: async () => ({}),
    readRuntimeProviderLaunchFacts: async () => ({
      defaultModel: null,
      modelIds: new Set(),
      runtimeCapabilities: null,
      modelCatalog: null,
    }),
    resolveClaudeBinaryPath: () => ClaudeBinaryResolver.resolve(),
    probeClaudeRuntime: async () => ({}),
    ensureMemberWorktree: async ({ baseCwd, memberName }) => ({
      worktreePath: path.join(baseCwd, memberName),
    }),
    execCli: defaultExecCli,
    info: () => undefined,
    warn: () => undefined,
    ...overrides,
  };
}
