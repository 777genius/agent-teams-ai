import type { TeamProvisioningProgress } from '@shared/types/team';

export interface ProvisioningStatusReaderPort {
  findByRunId(runId: string): Promise<TeamProvisioningProgress | undefined>;
}

export interface GetProvisioningStatusQuery {
  runId: string;
}

export class GetProvisioningStatusUseCase {
  constructor(private readonly statusReader: ProvisioningStatusReaderPort) {}

  async execute(query: GetProvisioningStatusQuery): Promise<TeamProvisioningProgress> {
    const progress = await this.statusReader.findByRunId(query.runId);
    if (!progress) {
      throw new Error('Unknown runId');
    }
    return progress;
  }
}
