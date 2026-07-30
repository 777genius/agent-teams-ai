import {
  registerTeamProvisioningIpc as registerProvisioningIpc,
  removeTeamProvisioningIpc as removeProvisioningIpc,
} from './adapters/input/ipc/registerTeamProvisioningIpc';
import { createTeamProvisioningStatusFeature as createProvisioningStatusFeature } from './composition/createTeamProvisioningStatusFeature';

import type { TeamProvisioningStatusApi } from '../contracts';
import type { TeamProvisioningFeature } from './composition/createTeamProvisioningFeature';
import type { TeamProvisioningProgress } from '@shared/types/team';

export interface TeamProvisioningIpcRegistrar {
  readonly handle: CallableFunction;
  readonly removeHandler: CallableFunction;
}

export function registerTeamProvisioningIpc(
  ipcMain: TeamProvisioningIpcRegistrar,
  feature: TeamProvisioningFeature
): void {
  registerProvisioningIpc(
    ipcMain as unknown as Parameters<typeof registerProvisioningIpc>[0],
    feature
  );
}

export function removeTeamProvisioningIpc(ipcMain: TeamProvisioningIpcRegistrar): void {
  removeProvisioningIpc(ipcMain as unknown as Parameters<typeof removeProvisioningIpc>[0]);
}

export {
  createTeamProvisioningApplicationFeature,
  type TeamProvisioningApplicationFeature,
  type TeamProvisioningApplicationFeatureDependencies,
} from './composition/createTeamProvisioningApplicationFeature';
export {
  createTeamProvisioningFeature,
  type TeamProvisioningFeature,
} from './composition/createTeamProvisioningFeature';

export interface TeamProvisioningStatusRun {
  progress: TeamProvisioningProgress;
}

export interface TeamProvisioningProgressSource<
  TRun extends TeamProvisioningStatusRun = TeamProvisioningStatusRun,
> {
  findProvisioningStatus(
    runId: string,
    runs: ReadonlyMap<string, TRun>
  ): TeamProvisioningProgress | undefined;
}

export interface TeamProvisioningStatusFeatureDeps<
  TRun extends TeamProvisioningStatusRun = TeamProvisioningStatusRun,
> {
  progressSource: TeamProvisioningProgressSource<TRun>;
  runs: ReadonlyMap<string, TRun>;
}

export function createTeamProvisioningStatusFeature<
  TRun extends TeamProvisioningStatusRun = TeamProvisioningStatusRun,
>(deps: TeamProvisioningStatusFeatureDeps<TRun>): TeamProvisioningStatusApi {
  return createProvisioningStatusFeature(deps);
}
