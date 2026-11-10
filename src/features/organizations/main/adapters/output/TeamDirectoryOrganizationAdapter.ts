import type { OrganizationsTeamDirectoryPort } from '../../../core/application';
import type { OrgTaskCandidate, OrgTeamCandidate } from '../../../core/domain';
import type { TeamDataService } from '@main/services/team/TeamDataService';
import type { GlobalTask, TeamSummary, TeamSummaryMember } from '@shared/types';

function toTaskCandidate(task: GlobalTask): OrgTaskCandidate {
  return {
    id: task.id,
    subject: task.subject,
    owner: task.owner,
    status: task.status,
    updatedAt: task.updatedAt,
    kanbanColumn: task.kanbanColumn,
  };
}

function ensureLeadMember(team: TeamSummary, members: TeamSummaryMember[]): TeamSummaryMember[] {
  if (!team.leadName) {
    return members;
  }
  const leadKey = team.leadName.trim().toLowerCase();
  if (!leadKey || members.some((member) => member.name.trim().toLowerCase() === leadKey)) {
    return members;
  }
  return [
    {
      name: team.leadName,
      color: team.leadColor,
      role: 'Lead',
    },
    ...members,
  ];
}

export class TeamDirectoryOrganizationAdapter implements OrganizationsTeamDirectoryPort {
  constructor(private readonly teamDataService: TeamDataService) {}

  async listTeams(input: { includeDeletedTeams: boolean }): Promise<OrgTeamCandidate[]> {
    const [teams, globalTasks, aliveTeams] = await Promise.all([
      this.teamDataService.listTeams(),
      this.teamDataService.getAllTasks(),
      this.teamDataService.listAliveProcessTeams(),
    ]);
    const aliveSet = new Set(aliveTeams);
    const tasksByTeam = new Map<string, OrgTaskCandidate[]>();

    for (const task of globalTasks) {
      const list = tasksByTeam.get(task.teamName) ?? [];
      list.push(toTaskCandidate(task));
      tasksByTeam.set(task.teamName, list);
    }

    return teams
      .filter((team) => input.includeDeletedTeams || !team.deletedAt)
      .map((team) => {
        const members = ensureLeadMember(team, team.members ?? []).map((member) => ({
          name: member.name,
          role: member.role,
          color: member.color,
        }));

        return {
          teamName: team.teamName,
          displayName: team.displayName || team.teamName,
          description: team.description,
          color: team.color,
          projectPath: team.projectPath,
          isOnline: aliveSet.has(team.teamName),
          deletedAt: team.deletedAt,
          pendingCreate: team.pendingCreate,
          members,
          tasks: tasksByTeam.get(team.teamName) ?? [],
        };
      });
  }
}
