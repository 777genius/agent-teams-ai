import { getTeamDataWorkerClient } from '@main/services/team/TeamDataWorkerClient';

import type { TeamConfigurationCachePort } from '../../../core/application/ports/TeamConfigurationPorts';

export class TeamDataWorkerConfigCache implements TeamConfigurationCachePort {
  invalidateTeamConfig(teamName: string): void {
    getTeamDataWorkerClient().invalidateTeamConfig(teamName);
  }
}
