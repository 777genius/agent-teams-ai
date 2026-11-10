import { GetProvisioningStatusUseCase } from '../../core/application/use-cases/GetProvisioningStatusUseCase';
import { LegacyProvisioningStatusReaderAdapter } from '../adapters/output/LegacyProvisioningStatusReaderAdapter';

import type { TeamProvisioningStatusApi } from '../../contracts';
import type {
  LegacyProvisioningProgressSource,
  LegacyProvisioningStatusRun,
} from '../adapters/output/LegacyProvisioningStatusReaderAdapter';

export interface TeamProvisioningStatusFeatureDeps<
  TRun extends LegacyProvisioningStatusRun = LegacyProvisioningStatusRun,
> {
  progressSource: LegacyProvisioningProgressSource<TRun>;
  runs: ReadonlyMap<string, TRun>;
}

export function createTeamProvisioningStatusFeature<
  TRun extends LegacyProvisioningStatusRun = LegacyProvisioningStatusRun,
>(deps: TeamProvisioningStatusFeatureDeps<TRun>): TeamProvisioningStatusApi {
  const statusReader = new LegacyProvisioningStatusReaderAdapter(deps);
  const getProvisioningStatus = new GetProvisioningStatusUseCase(statusReader);

  return {
    getProvisioningStatus: (runId) => getProvisioningStatus.execute({ runId }),
  };
}
