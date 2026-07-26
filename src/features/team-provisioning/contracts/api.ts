import type { TeamProvisioningProgress } from '@shared/types/team';

export interface TeamProvisioningStatusApi {
  getProvisioningStatus(runId: string): Promise<TeamProvisioningProgress>;
}
