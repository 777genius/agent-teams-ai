import type { OrganizationAgentSummaryDto, OrganizationAgentTaskDto } from '../../contracts';
import type { TeamTask, TeamTaskWithKanban } from '@shared/types';

/** A task as the store lists it: global tasks know the native team that owns them. */
export type InspectorScopedTask = TeamTaskWithKanban & { teamName?: string };

/**
 * The tasks an organization node's inspector works with. A per-project team keeps
 * its tasks in its project copies, so they are looked up by those copies'
 * names; any other team keeps using its own loaded board when there is one.
 */
export function scopeInspectorTasks(input: {
  teamName: string;
  executionTeamNames: readonly string[];
  teamDataTasks: TeamTaskWithKanban[] | undefined;
  globalTasks: readonly InspectorScopedTask[];
}): InspectorScopedTask[] {
  const { teamName, executionTeamNames, teamDataTasks, globalTasks } = input;
  if (!teamName) return [];
  if (executionTeamNames.length === 0) {
    return teamDataTasks ?? globalTasks.filter((task) => task.teamName === teamName);
  }
  const names = new Set([teamName, ...executionTeamNames]);
  return globalTasks.filter((task) => task.teamName !== undefined && names.has(task.teamName));
}

/** The team that owns a task: the copy for a per-project team, else the node's team. */
export function taskOwnerTeam(task: InspectorScopedTask, nodeTeamName: string): string {
  return task.teamName ?? nodeTeamName;
}

/**
 * Whether a task is the one a summary names. Ids are only unique inside a team
 * (legacy numeric ids repeat across copies), so a summary that names its owning
 * copy only matches that copy's task.
 */
export function matchesTaskSummary(
  task: InspectorScopedTask,
  summary: OrganizationAgentTaskDto
): boolean {
  if (
    summary.executionTeamName !== undefined &&
    task.teamName !== undefined &&
    task.teamName !== summary.executionTeamName
  ) {
    return false;
  }
  return task.id === summary.id || task.displayId === summary.id;
}

/** Tasks of each owning team by id, so a lookup never crosses from one copy into another. */
export function groupTasksByOwner(
  tasks: readonly InspectorScopedTask[],
  nodeTeamName: string
): Map<string, Map<string, TeamTask>> {
  const byOwner = new Map<string, Map<string, TeamTask>>();
  for (const task of tasks) {
    const owner = taskOwnerTeam(task, nodeTeamName);
    const map = byOwner.get(owner) ?? new Map<string, TeamTask>();
    map.set(task.id, task);
    byOwner.set(owner, map);
  }
  return byOwner;
}

/** The project copies that own the visible tasks of a node (none for an ordinary team). */
export function collectExecutionTeamNames(
  agents: readonly OrganizationAgentSummaryDto[]
): string[] {
  const names = new Set<string>();
  for (const agent of agents) {
    for (const task of agent.currentTasks) {
      if (task.executionTeamName) names.add(task.executionTeamName);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}
