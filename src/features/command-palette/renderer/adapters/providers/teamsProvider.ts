import type { CommandProvider } from '../../../core/domain/models/CommandProvider';
import type { TeamSummary } from '@shared/types';

function memberKeywords(team: TeamSummary): string[] {
  return (team.members ?? []).map((member) => member.name);
}

export function createTeamsProvider(teams: readonly TeamSummary[]): CommandProvider {
  return {
    id: 'teams',
    match: (_query, context) =>
      teams
        .filter((team) => !team.deletedAt)
        .map((team, index) => ({
          id: `team:${team.teamName}`,
          providerId: 'teams',
          category: 'team',
          icon: 'team',
          title: team.displayName || team.teamName,
          subtitle: team.description || team.teamName,
          detail: team.projectPath,
          badge: `${team.memberCount} member${team.memberCount === 1 ? '' : 's'}`,
          keywords: [
            team.teamName,
            team.description,
            team.projectPath ?? '',
            team.leadName ?? '',
            ...memberKeywords(team),
          ],
          priority: context.activeTeamName === team.teamName ? 70 : 35 - index / 100,
          dedupeKey: `team:${team.teamName}`,
          intent: {
            type: 'team.open',
            teamName: team.teamName,
            projectPath: team.projectPath,
          },
        })),
  };
}
