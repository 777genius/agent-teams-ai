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
    // Group names come from the existing group catalog, only when needed.
    const needsGroups = [...unique.values()].some((message) => Boolean(message.groupChatId));
    const groupNames = needsGroups && this.source.listGroupNames
      ? await this.source.listGroupNames(team.teamName).catch(() => ({}))
      : {};
    return {
      teamName: team.teamName,
      ...(team.logicalTeamName ? { logicalTeamName: team.logicalTeamName } : {}),
      teamDisplayName: team.displayName,
      projectPath: team.projectPath,
      tasks: tasksResult.status === 'fulfilled' ? projectAttentionTasks(tasksResult.value, team) : [],
      messages: [...unique.values()],
      groupNames,
      ...(tasksResult.status === 'rejected' || messagesResult.status === 'rejected'
        ? { error: 'Some attention sources are unavailable' }
        : {}),
    };
  }

  async getUserAttentionSnapshot(teamName?: string): Promise<AttentionSnapshot> {
    const contextId = this.source.currentContextId();
    const allTeams = await this.source.listTeams();
    // Reuse verified project-history ownership: a visible logical team may
    // contain several physical execution aliases, each with its own task/chat files.
    const expanded: AttentionTeamSource[] = [];
    const seen = new Set<string>();
    const include = (team: AttentionTeamSource): void => {
      if (seen.has(team.teamName)) return;
      seen.add(team.teamName);
      expanded.push(team);
    };
    for (const team of allTeams) {
      if (team.deletedAt) continue;
      include(team);
      for (const history of team.projectHistoryContexts ?? []) {
        include({
          teamName: history.executionTeamName,
          logicalTeamName: team.teamName,
          displayName: team.displayName,
          projectPath: history.projectPath,
        });
      }
    }
    const eligible = expanded.filter(
      (team) => !teamName || team.teamName === teamName || team.logicalTeamName === teamName
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
