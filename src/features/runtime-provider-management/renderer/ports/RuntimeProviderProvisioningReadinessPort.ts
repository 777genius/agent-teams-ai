import type { TeamProvisioningPrepareResult } from '@shared/types';

export interface RuntimeProviderProvisioningReadinessPort {
  checkReadiness(cwd: string, modelRoute: string): Promise<TeamProvisioningPrepareResult>;
}
