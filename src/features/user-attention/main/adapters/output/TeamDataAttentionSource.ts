import { projectTeamSummaries } from '@features/team-project-context/main';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

import type { AttentionSourcePort, AttentionTeamSource } from '../../../core/application/ports';
import type { TeamDataService } from '@main/services/team/TeamDataService';
import type { InboxMessage, TeamTask } from '@shared/types/team';

/** Thin main-owned adapter to existing canonical task and normalized chat readers. */
export class TeamDataAttentionSource implements AttentionSourcePort {
  private readonly meta = new TeamMetaStore();

  constructor(private readonly deps: {
    getContextId(): string;
    listGroupNames?: (teamName: string) => Promise<Record<string, string>>;
    getTeamDataService(): Pick<TeamDataService,
      'listTeams' | 'getUserAttentionTasks' | 'getMessageFeed'>;
  }) {}

  currentContextId(): string {
    return this.deps.getContextId();
  }

  async listTeams(): Promise<readonly AttentionTeamSource[]> {
    return projectTeamSummaries(await this.deps.getTeamDataService().listTeams(), this.meta);
  }

  async listHumanTasks(teamName: string): Promise<readonly TeamTask[]> {
    return this.deps.getTeamDataService().getUserAttentionTasks(teamName);
  }

  async listNormalizedMessages(teamName: string): Promise<readonly InboxMessage[]> {
    return (await this.deps.getTeamDataService().getMessageFeed(teamName)).messages;
  }

  async listGroupNames(teamName: string): Promise<Record<string, string>> {
    return this.deps.listGroupNames ? this.deps.listGroupNames(teamName) : {};
  }
}
