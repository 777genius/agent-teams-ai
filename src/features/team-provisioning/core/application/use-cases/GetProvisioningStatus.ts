import type { TeamProvisioningProgress } from '../models/TeamProvisioningModels';
import type { TeamProvisioningStatusPort } from '../ports/TeamProvisioningPorts';

export class GetProvisioningStatus {
  constructor(private readonly status: TeamProvisioningStatusPort) {}

  execute(runId: string): Promise<TeamProvisioningProgress> {
    return this.status.getStatus(runId);
  }
}
