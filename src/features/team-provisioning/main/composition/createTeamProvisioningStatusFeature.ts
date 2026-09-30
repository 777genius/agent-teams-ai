import { GetProvisioningStatusUseCase } from '../../core/application/use-cases/GetProvisioningStatusUseCase';
import { LegacyProvisioningStatusReaderAdapter } from '../adapters/output/LegacyProvisioningStatusReaderAdapter';

import type { TeamProvisioningStatusApi } from '../../contracts';
import type { TeamProvisioningProgress } from '@shared/types/team';

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
  const statusReader = new LegacyProvisioningStatusReaderAdapter(deps);
  const getProvisioningStatus = new GetProvisioningStatusUseCase(statusReader);

  return {
    getProvisioningStatus: (runId) => getProvisioningStatus.execute({ runId }),
  };
}
