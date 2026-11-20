import type { OrganizationsTeamDirectoryPort } from '../../../core/application';
import type { OrgTaskCandidate, OrgTeamCandidate } from '../../../core/domain';
import type { TeamDataService } from '@main/services/team/TeamDataService';
import type { GlobalTask, TeamSummary, TeamSummaryMember } from '@shared/types';

function toTaskCandidate(task: GlobalTask, logicalTeamName: string): OrgTaskCandidate {
  return {
    id: task.id,
    subject: task.subject,
    owner: task.owner,
    status: task.status,
    updatedAt: task.updatedAt,
    kanbanColumn: task.kanbanColumn,
    ...(task.teamName === logicalTeamName ? {} : { executionTeamName: task.teamName }),
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
  /**
   * `projectTeams` folds the native project copies of a per-project team into its
   * logical team, so one team is one candidate. It defaults to "no folding".
   */
  constructor(
    private readonly teamDataService: TeamDataService,
    private readonly projectTeams: (teams: TeamSummary[]) => Promise<TeamSummary[]> = (teams) =>
      Promise.resolve(teams)
  ) {}

  async listTeams(input: { includeDeletedTeams: boolean }): Promise<OrgTeamCandidate[]> {
    const [allTeams, globalTasks, aliveTeams] = await Promise.all([
      this.teamDataService.listTeams(),
      this.teamDataService.getAllTasks(),
      this.teamDataService.listAliveProcessTeams(),
    ]);
    const teams = await this.projectTeams(allTeams);
    const aliveSet = new Set(aliveTeams);
    const tasksByTeam = new Map<string, GlobalTask[]>();

    for (const task of globalTasks) {
      const list = tasksByTeam.get(task.teamName) ?? [];
      list.push(task);
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

        // A logical team has no process or board of its own: it is online while any
        // of its project contexts is, and its tasks are the tasks of those contexts.
        const names = [
          team.teamName,
          ...(team.projectHistoryContexts ?? []).map((context) => context.executionTeamName),
        ];

        return {
          teamName: team.teamName,
          displayName: team.displayName || team.teamName,
          description: team.description,
          color: team.color,
          projectPath: team.projectPath,
          isOnline: names.some((name) => aliveSet.has(name)),
          deletedAt: team.deletedAt,
          pendingCreate: team.pendingCreate,
          members,
          tasks: names
            .flatMap((name) => tasksByTeam.get(name) ?? [])
            .map((task) => toTaskCandidate(task, team.teamName)),
        };
      });
  }
}
