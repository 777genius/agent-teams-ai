import type { TeamDataService } from '@main/services/team/TeamDataService';

import { projectAttentionMessage, projectAttentionTasks } from '../../core/domain/projectAttention';

import type {
  AttentionSnapshot,
  AttentionTeamSnapshot,
  UserAttentionApi,
} from '../../contracts';

export type UserAttentionFeatureFacade = UserAttentionApi;

const MAX_PARALLEL_READS = 3;

/**
 * Read-only aggregation; task and chat sources remain owned by TeamDataService.
 * No separate persisted inbox, watcher or notification history.
 */
export function createUserAttentionFeature(deps: {
  getContextId(): string;
  getTeamDataService(): Pick<TeamDataService,
    'listTeams' | 'getUserAttentionTasks' | 'getMessageFeed'>;
}): UserAttentionFeatureFacade {
  async function readTeam(
    team: { teamName: string; displayName: string; projectPath?: string }
  ): Promise<AttentionTeamSnapshot> {
    try {
      const data = deps.getTeamDataService();
      const [tasks, feed] = await Promise.all([
        data.getUserAttentionTasks(team.teamName),
        data.getMessageFeed(team.teamName),
      ]);
      const unique = new Map<string, NonNullable<ReturnType<typeof projectAttentionMessage>>>();
      for (const message of feed.messages) {
        const candidate = projectAttentionMessage(message);
        if (!candidate) continue;
        const key = candidate.messageId ?? `${candidate.timestamp}:${candidate.from}`;
        if (!unique.has(key)) unique.set(key, candidate);
      }
      return {
        teamName: team.teamName,
        teamDisplayName: team.displayName,
        projectPath: team.projectPath,
        tasks: projectAttentionTasks(tasks, team),
        messages: [...unique.values()],
      };
    } catch {
      // Fail visibly rather than misreporting zero attention for this team.
      return {
        teamName: team.teamName,
        teamDisplayName: team.displayName,
        projectPath: team.projectPath,
        tasks: [],
        messages: [],
        error: 'Unable to read this team',
      };
    }
  }

  return {
    getUserAttentionSnapshot: async (teamName?: string): Promise<AttentionSnapshot> => {
      const contextId = deps.getContextId();
      const allTeams = await deps.getTeamDataService().listTeams();
      const eligible = allTeams.filter((team) =>
        !team.deletedAt && (!teamName || team.teamName === teamName)
      );
      const teams = new Array<AttentionTeamSnapshot>(eligible.length);
      let next = 0;
      const workers = Array.from(
        { length: Math.min(MAX_PARALLEL_READS, eligible.length) },
        async () => {
          while (next < eligible.length) {
            const index = next++;
            const team = eligible[index];
            teams[index] = await readTeam(team);
          }
        }
      );
      await Promise.all(workers);
      if (contextId !== deps.getContextId()) {
        throw new Error('Attention snapshot context changed');
      }
      return { contextId, teams, complete: teams.every((team) => !team.error) };
    },
  };
}
