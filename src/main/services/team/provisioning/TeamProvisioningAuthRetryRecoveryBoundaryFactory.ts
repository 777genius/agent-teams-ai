import { spawnCli } from '@main/utils/childProcess';
import * as fs from 'fs';

import { readBootstrapRealTaskSubmissionState } from '../TeamBootstrapStateReader';

import { sleep } from './TeamProvisioningAsyncUtils';
import {
  respawnCliAfterAuthFailure,
  type TeamProvisioningAuthRetryPorts,
  type TeamProvisioningAuthRetryRun,
} from './TeamProvisioningAuthRetryRecovery';
import {
  getProvisioningRunTimeoutMs,
  writeDeterministicBootstrapUserPromptFile,
} from './TeamProvisioningBootstrapSpec';
import { PREFLIGHT_AUTH_RETRY_DELAY_MS } from './TeamProvisioningProviderDiagnostics';
import { type TeamProvisioningProviderRuntimeFacade } from './TeamProvisioningProviderRuntimeFacade';
import { extractCliLogsFromRun } from './TeamProvisioningRetainedLogs';

export interface TeamProvisioningAuthRetryRecoveryBoundary<
  TRun extends TeamProvisioningAuthRetryRun,
> {
  respawnAfterAuthFailure(run: TRun): Promise<void>;
}

export type TeamProvisioningAuthRetryRecoveryServiceAdapter<
  TRun extends TeamProvisioningAuthRetryRun,
> = Pick<
  TeamProvisioningAuthRetryPorts<TRun>,
  | 'getStopAllTeamsGeneration'
  | 'stopFilesystemMonitor'
  | 'stopStallWatchdog'
  | 'cleanupRun'
  | 'attachStdoutHandler'
  | 'attachStderrHandler'
  | 'startStallWatchdog'
  | 'startFilesystemMonitor'
  | 'tryCompleteAfterTimeout'
  | 'handleProcessExit'
>;

export interface TeamProvisioningAuthRetryRecoveryBoundaryDeps<
  TRun extends TeamProvisioningAuthRetryRun,
> {
  service: TeamProvisioningAuthRetryRecoveryServiceAdapter<TRun>;
  logger: TeamProvisioningAuthRetryPorts<TRun>['logger'];
  mcpConfigBuilder: TeamProvisioningAuthRetryPorts<TRun>['mcpConfigBuilder'];
  providerRuntime: Pick<TeamProvisioningProviderRuntimeFacade, 'validateAgentTeamsMcpRuntime'>;
  killTeamProcessAndWait: TeamProvisioningAuthRetryPorts<TRun>['killTeamProcessAndWait'];
  cleanupRunOwnedAnthropicApiKeyHelper: TeamProvisioningAuthRetryPorts<TRun>['cleanupRunOwnedAnthropicApiKeyHelper'];
  retainAnthropicApiKeyHelperCleanupRetryOwner: TeamProvisioningAuthRetryPorts<TRun>['retainAnthropicApiKeyHelperCleanupRetryOwner'];
  updateProgress: TeamProvisioningAuthRetryPorts<TRun>['updateProgress'];
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function createTeamProvisioningAuthRetryRecoveryBoundary<
  TRun extends TeamProvisioningAuthRetryRun,
>(
  deps: TeamProvisioningAuthRetryRecoveryBoundaryDeps<TRun>
): TeamProvisioningAuthRetryRecoveryBoundary<TRun> {
  return {
    respawnAfterAuthFailure: (run) =>
      respawnCliAfterAuthFailure<TRun>(
        run,
        {
          logger: deps.logger,
          clearTimeout: (handle) => clearTimeout(handle),
          setTimeout: (callback, ms) => setTimeout(callback, ms),
          nowMs: () => Date.now(),
          sleep,
          pathExists,
          mcpConfigBuilder: deps.mcpConfigBuilder,
          readBootstrapRealTaskSubmissionState,
          writeDeterministicBootstrapUserPromptFile,
          validateAgentTeamsMcpRuntime: (claudePath, cwd, env, mcpConfigPath, options) =>
            deps.providerRuntime.validateAgentTeamsMcpRuntime(
              claudePath,
              cwd,
              env,
              mcpConfigPath,
              options
            ),
          spawnCli,
          getStopAllTeamsGeneration: () => deps.service.getStopAllTeamsGeneration(),
          isStopAllTeamsGenerationChanged: (stopAllGenerationAtStart) =>
            deps.service.getStopAllTeamsGeneration() !== stopAllGenerationAtStart,
          stopFilesystemMonitor: (provisioningRun) =>
            deps.service.stopFilesystemMonitor(provisioningRun),
          stopStallWatchdog: (provisioningRun) => deps.service.stopStallWatchdog(provisioningRun),
          killTeamProcessAndWait: deps.killTeamProcessAndWait,
          cleanupRunOwnedAnthropicApiKeyHelper: deps.cleanupRunOwnedAnthropicApiKeyHelper,
          retainAnthropicApiKeyHelperCleanupRetryOwner:
            deps.retainAnthropicApiKeyHelperCleanupRetryOwner,
          updateProgress: deps.updateProgress,
          extractCliLogsFromRun,
          cleanupRun: (provisioningRun) => deps.service.cleanupRun(provisioningRun),
          attachStdoutHandler: (provisioningRun) =>
            deps.service.attachStdoutHandler(provisioningRun),
          attachStderrHandler: (provisioningRun) =>
            deps.service.attachStderrHandler(provisioningRun),
          startStallWatchdog: (provisioningRun) => deps.service.startStallWatchdog(provisioningRun),
          startFilesystemMonitor: (provisioningRun, request) =>
            deps.service.startFilesystemMonitor(provisioningRun, request),
          tryCompleteAfterTimeout: (provisioningRun) =>
            deps.service.tryCompleteAfterTimeout(provisioningRun),
          getProvisioningRunTimeoutMs,
          handleProcessExit: (provisioningRun, code) =>
            deps.service.handleProcessExit(provisioningRun, code),
        },
        { preflightAuthRetryDelayMs: PREFLIGHT_AUTH_RETRY_DELAY_MS }
      ),
  };
}
