import { projectAttentionMessage, projectAttentionTasks } from '../domain/projectAttention';

import type { AttentionSourcePort, AttentionTeamSource } from './ports';
import type {
  AttentionSnapshot,
  AttentionTeamSnapshot,
  UserAttentionApi,
} from '../../contracts';

const MAX_PARALLEL_READS = 3;

/** Single feature use case, transport-independent and read-only. */
export class GetAttentionSnapshot implements UserAttentionApi {
  constructor(private readonly source: AttentionSourcePort) {}

  private async readTeam(team: AttentionTeamSource): Promise<AttentionTeamSnapshot> {
    const [tasksResult, messagesResult] = await Promise.allSettled([
      this.source.listHumanTasks(team.teamName),
      this.source.listNormalizedMessages(team.teamName),
    ]);
    const unique = new Map<string, NonNullable<ReturnType<typeof projectAttentionMessage>>>();
    if (messagesResult.status === 'fulfilled') {
      for (const message of messagesResult.value) {
        const candidate = projectAttentionMessage(message);
        if (!candidate) continue;
        const key = candidate.messageId ?? `${candidate.timestamp}:${candidate.from}`;
        if (!unique.has(key)) unique.set(key, candidate);
      }
    }
    return {
      teamName: team.teamName,
      teamDisplayName: team.displayName,
      projectPath: team.projectPath,
      tasks: tasksResult.status === 'fulfilled' ? projectAttentionTasks(tasksResult.value, team) : [],
      messages: [...unique.values()],
      ...(tasksResult.status === 'rejected' || messagesResult.status === 'rejected'
        ? { error: 'Some attention sources are unavailable' }
        : {}),
    };
  }

  async getUserAttentionSnapshot(teamName?: string): Promise<AttentionSnapshot> {
    const contextId = this.source.currentContextId();
    const allTeams = await this.source.listTeams();
    const eligible = allTeams.filter(
      (team) => !team.deletedAt && (!teamName || team.teamName === teamName)
    );
    const teams = new Array<AttentionTeamSnapshot>(eligible.length);
    let next = 0;
    const workers = Array.from(
      { length: Math.min(MAX_PARALLEL_READS, eligible.length) },
      async () => {
        while (next < eligible.length) {
          const index = next++;
          teams[index] = await this.readTeam(eligible[index]);
        }
      }
    );
    await Promise.all(workers);
    if (contextId !== this.source.currentContextId()) {
      throw new Error('Attention snapshot context changed');
    }
    return { contextId, teams, complete: teams.every((team) => !team.error) };
  }
}
