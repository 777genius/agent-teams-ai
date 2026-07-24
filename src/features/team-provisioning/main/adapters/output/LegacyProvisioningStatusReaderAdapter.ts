import type { ProvisioningStatusReaderPort } from '../../../core/application/use-cases/GetProvisioningStatusUseCase';
import type { TeamProvisioningProgress } from '@shared/types/team';

export interface LegacyProvisioningStatusRun {
  progress: TeamProvisioningProgress;
}

export interface LegacyProvisioningProgressSource<
  TRun extends LegacyProvisioningStatusRun = LegacyProvisioningStatusRun,
> {
  findProvisioningStatus(
    runId: string,
    runs: ReadonlyMap<string, TRun>
  ): TeamProvisioningProgress | undefined;
}

export interface LegacyProvisioningStatusReaderDeps<
  TRun extends LegacyProvisioningStatusRun = LegacyProvisioningStatusRun,
> {
  progressSource: LegacyProvisioningProgressSource<TRun>;
  runs: ReadonlyMap<string, TRun>;
}

export class LegacyProvisioningStatusReaderAdapter<
  TRun extends LegacyProvisioningStatusRun = LegacyProvisioningStatusRun,
> implements ProvisioningStatusReaderPort {
  constructor(private readonly deps: LegacyProvisioningStatusReaderDeps<TRun>) {}

  findByRunId(runId: string): Promise<TeamProvisioningProgress | undefined> {
    return Promise.resolve(this.deps.progressSource.findProvisioningStatus(runId, this.deps.runs));
  }
}
