import type { TeamProvisioningStatusPort } from '../ports/TeamProvisioningPorts';
import type { TeamProvisioningProgress } from '@shared/types';

export class GetProvisioningStatus {
  constructor(private readonly status: TeamProvisioningStatusPort) {}

  execute(runId: string): Promise<TeamProvisioningProgress> {
    return this.status.getStatus(runId);
  }
}
