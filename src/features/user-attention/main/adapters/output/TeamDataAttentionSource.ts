import { projectTeamSummaries } from '@features/team-project-context/main';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

import type { AttentionSourcePort, AttentionTeamSource } from '../../../core/application/ports';
import type { TeamDataService } from '@main/services/team/TeamDataService';
import type { InboxMessage, TeamSummary, TeamTask } from '@shared/types/team';

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
    const raw = await this.deps.getTeamDataService().listTeams();
    const visible = await projectTeamSummaries(raw, this.meta);
    const byName = new Map(raw.map((team) => [team.teamName, team]));
    // The logical summary deliberately folds away native aliases. Their own
    // active rosters are still needed to resolve available Messenger threads.
    const roster = (team: TeamSummary | undefined) => ({
      directParticipants: (team?.members ?? []).map((member) => member.name),
      leadName: team?.leadName,
    });
    return visible.map((team) => ({
      ...team,
      ...roster(byName.get(team.teamName)),
      projectHistoryContexts: team.projectHistoryContexts?.map((history) => ({
        ...history,
        ...roster(byName.get(history.executionTeamName)),
      })),
    }));
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
