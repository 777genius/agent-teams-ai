import {
  getTeamDataWorkerClient,
  isTeamDataWorkerFatalError,
} from '@main/services/team/TeamDataWorkerClient';

import type { TeamDataWorkerReadPort } from '../../../core/application/ports/TeamViewReadModelPorts';
import type {
  MessagesPage,
  TeamGetDataOptions,
  TeamMemberActivityMeta,
  TeamViewSnapshot,
} from '@shared/types';

export class TeamDataWorkerReadAdapter implements TeamDataWorkerReadPort {
  isAvailable(): boolean {
    return getTeamDataWorkerClient().isAvailable();
  }

  isFatalError(error: unknown): boolean {
    return isTeamDataWorkerFatalError(error);
  }

  getTeamData(teamName: string, options?: TeamGetDataOptions): Promise<TeamViewSnapshot> {
    const worker = getTeamDataWorkerClient();
    return options === undefined
      ? worker.getTeamData(teamName)
      : worker.getTeamData(teamName, options);
  }

  getMessagesPage(
    teamName: string,
    options: { cursor?: string | null; limit: number }
  ): Promise<MessagesPage> {
    return getTeamDataWorkerClient().getMessagesPage(teamName, options);
  }

  getMemberActivityMeta(teamName: string): Promise<TeamMemberActivityMeta> {
    return getTeamDataWorkerClient().getMemberActivityMeta(teamName);
  }
}
