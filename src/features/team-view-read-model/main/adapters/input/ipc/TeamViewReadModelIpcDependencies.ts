import type { TeamViewReadResult } from '../../../../core/application/ports/TeamViewReadModelPorts';
import type { MessagesPage, TeamGetDataOptions, TeamMemberActivityMeta } from '@shared/types';

export interface TeamViewReadModelIpcDependencies {
  getTeamView: {
    execute(teamName: string, options?: TeamGetDataOptions): Promise<TeamViewReadResult>;
  };
  getMessagesPage: {
    execute(input: {
      teamName: string;
      cursor?: string | null;
      limit: number;
    }): Promise<MessagesPage>;
  };
  getMemberActivityMeta: {
    execute(teamName: string): Promise<TeamMemberActivityMeta>;
  };
  logger: {
    error(message: string): void;
  };
}
