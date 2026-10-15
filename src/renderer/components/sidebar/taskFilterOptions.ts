import type { ComboboxOption } from '@renderer/components/ui/combobox';

interface ProjectSessionEligibility {
  totalSessions?: number;
  sessions: readonly unknown[];
}
interface RepositoryEligibility {
  id: string;
  name: string;
  totalSessions: number;
  worktrees: readonly { path: string }[];
}

export interface TaskProjectOptionSources {
  viewMode: 'flat' | 'grouped';
  repositoryGroups: readonly RepositoryEligibility[];
  projects: readonly (ProjectSessionEligibility & { path: string; name: string })[];
}

export function buildTaskProjectFilterOptions({
  viewMode,
  repositoryGroups,
  projects,
}: TaskProjectOptionSources): ComboboxOption[] {
  const items =
    viewMode === 'grouped'
      ? repositoryGroups
          .filter((repository) => repository.totalSessions > 0)
          .map((repository) => ({
            value: repository.worktrees[0]?.path ?? repository.id,
            label: repository.name,
            path: repository.worktrees[0]?.path,
          }))
      : projects
          .filter((project) => (project.totalSessions ?? project.sessions.length) > 0)
          .map((project) => ({
            value: project.path,
            label: project.name,
            path: project.path,
          }));
  return items.map((item) => ({
    value: item.value,
    label: item.label,
    description: item.path,
  }));
}

export function buildTaskFilterTeamOptions(
  teams: readonly { teamName: string; displayName: string }[]
): { teamName: string; displayName: string }[] {
  return teams.map((team) => ({
    teamName: team.teamName,
    displayName: team.displayName,
  }));
}
