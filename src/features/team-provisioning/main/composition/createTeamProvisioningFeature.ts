import { CancelProvisioning } from '../../core/application/use-cases/CancelProvisioning';
import { CheckProvisioningPreflight } from '../../core/application/use-cases/CheckProvisioningPreflight';
import { GetProvisioningStatus } from '../../core/application/use-cases/GetProvisioningStatus';
import { ProvisionTeam } from '../../core/application/use-cases/ProvisionTeam';
import { ReadLaunchDiagnostics } from '../../core/application/use-cases/ReadLaunchDiagnostics';
import { ResolveTeamLaunchMode } from '../../core/application/use-cases/ResolveTeamLaunchMode';
import { MainTeamLaunchDiagnostics } from '../adapters/output/MainTeamLaunchDiagnostics';
import { MainTeamProvisioningEffects } from '../adapters/output/MainTeamProvisioningEffects';
import { MainTeamProvisioningWorkspace } from '../infrastructure/MainTeamProvisioningWorkspace';

import type {
  TeamLaunchDiagnosticsPort,
  TeamProvisioningCancellationPort,
  TeamProvisioningEffectsPort,
  TeamProvisioningLoggerPort,
  TeamProvisioningPreflightPort,
  TeamProvisioningRepositoryPort,
  TeamProvisioningStartPort,
  TeamProvisioningStatusPort,
  TeamProvisioningWorkspacePort,
} from '../../core/application/ports/TeamProvisioningPorts';
import type { LaunchIoGovernor } from '@main/services/team/LaunchIoGovernor';

export interface TeamProvisioningFeature {
  provisionTeam: ProvisionTeam;
  resolveLaunchMode: ResolveTeamLaunchMode;
  preflight: CheckProvisioningPreflight;
  getStatus: GetProvisioningStatus;
  cancel: CancelProvisioning;
  readLaunchDiagnostics: ReadLaunchDiagnostics;
  workspace: TeamProvisioningWorkspacePort;
  logger: TeamProvisioningLoggerPort;
}

export function createTeamProvisioningFeature(dependencies: {
  start: TeamProvisioningStartPort;
  status: {
    getProvisioningStatus(runId: string): ReturnType<TeamProvisioningStatusPort['getStatus']>;
  };
  preflight: TeamProvisioningPreflightPort;
  provisioningRun: { cancelProvisioning(runId: string): Promise<void> };
  repository: TeamProvisioningRepositoryPort & {
    invalidateMessageFeed(teamName: string): void;
    invalidateTeamRuntimeAdvisories(teamName: string): void;
  };
  launchIoGovernor?: LaunchIoGovernor;
  logger: TeamProvisioningLoggerPort;
  workspace?: TeamProvisioningWorkspacePort;
  effects?: TeamProvisioningEffectsPort;
  diagnostics?: TeamLaunchDiagnosticsPort;
}): TeamProvisioningFeature {
  const start: TeamProvisioningStartPort = {
    createTeam: (request, onProgress) => dependencies.start.createTeam(request, onProgress),
    launchTeam: (request, onProgress) => dependencies.start.launchTeam(request, onProgress),
  };
  const repository: TeamProvisioningRepositoryPort = {
    getSavedRequest: (teamName) => dependencies.repository.getSavedRequest(teamName),
  };
  const preflight: TeamProvisioningPreflightPort = {
    getCliHelpOutput: () => dependencies.preflight.getCliHelpOutput(),
    prepareForProvisioning: (cwd, options) =>
      dependencies.preflight.prepareForProvisioning(cwd, options),
  };
  const status: TeamProvisioningStatusPort = {
    getStatus: (runId) => dependencies.status.getProvisioningStatus(runId),
  };
  const cancellation: TeamProvisioningCancellationPort = {
    cancel: (runId) => dependencies.provisioningRun.cancelProvisioning(runId),
  };
  const workspace = dependencies.workspace ?? new MainTeamProvisioningWorkspace();
  const effects =
    dependencies.effects ??
    new MainTeamProvisioningEffects(dependencies.repository, dependencies.launchIoGovernor);
  const diagnostics = dependencies.diagnostics ?? new MainTeamLaunchDiagnostics();

  return {
    provisionTeam: new ProvisionTeam({ start, repository, workspace, effects }),
    resolveLaunchMode: new ResolveTeamLaunchMode(workspace),
    preflight: new CheckProvisioningPreflight(preflight),
    getStatus: new GetProvisioningStatus(status),
    cancel: new CancelProvisioning(cancellation),
    readLaunchDiagnostics: new ReadLaunchDiagnostics(diagnostics),
    workspace,
    logger: dependencies.logger,
  };
}
