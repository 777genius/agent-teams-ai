import type { TeamCreateConfigRequest } from '@shared/types';

/** Draft-configuration capability needed after an import review is accepted. */
export interface TeamImportTeamDataPort {
  createTeamConfig(request: TeamCreateConfigRequest): Promise<void>;
}
