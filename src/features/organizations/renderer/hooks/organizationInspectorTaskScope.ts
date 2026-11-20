import type { OrganizationAgentSummaryDto } from '../../contracts';
import type { TeamTaskWithKanban } from '@shared/types';

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

/** The native team a task action has to run against. */
export function executionTeamOfTask(
  tasks: readonly InspectorScopedTask[],
  taskId: string,
  fallbackTeamName: string
): string {
  return tasks.find((task) => task.id === taskId)?.teamName ?? fallbackTeamName;
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
