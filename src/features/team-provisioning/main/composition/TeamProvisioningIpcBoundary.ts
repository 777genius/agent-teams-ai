import {
  registerTeamProvisioningIpc as registerProvisioningIpc,
  removeTeamProvisioningIpc as removeProvisioningIpc,
} from '../adapters/input/ipc/registerTeamProvisioningIpc';

import type {
  TeamProvisioningLoggerPort,
  TeamProvisioningWorkspacePort,
} from '../../core/application/ports/TeamProvisioningPorts';
import type { CancelProvisioning } from '../../core/application/use-cases/CancelProvisioning';
import type { CheckProvisioningPreflight } from '../../core/application/use-cases/CheckProvisioningPreflight';
import type { GetProvisioningStatus } from '../../core/application/use-cases/GetProvisioningStatus';
import type { ProvisionTeam } from '../../core/application/use-cases/ProvisionTeam';
import type { ReadLaunchDiagnostics } from '../../core/application/use-cases/ReadLaunchDiagnostics';
import type { ResolveTeamLaunchMode } from '../../core/application/use-cases/ResolveTeamLaunchMode';

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

export interface TeamProvisioningIpcRegistrar {
  readonly handle: CallableFunction;
  readonly removeHandler: CallableFunction;
}

export function registerTeamProvisioningIpc(
  ipcMain: TeamProvisioningIpcRegistrar,
  feature: TeamProvisioningFeature
): void {
  registerProvisioningIpc(ipcMain, feature);
}

export function removeTeamProvisioningIpc(ipcMain: TeamProvisioningIpcRegistrar): void {
  removeProvisioningIpc(ipcMain);
}
