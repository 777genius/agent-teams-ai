import { useMemo } from 'react';

import { useStore } from '@renderer/store';
import {
  selectResolvedMembersForTeamName,
  selectTeamDataForName,
} from '@renderer/store/slices/teamSlice';
import { createEncodedTaskReference } from '@renderer/utils/taskReferenceUtils';
import { getTaskDisplayId } from '@shared/utils/taskIdentity';
import { useShallow } from 'zustand/react/shallow';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { GlobalTask, TeamSummary, TeamTaskWithKanban } from '@shared/types';

const EMPTY_GLOBAL_TASKS: GlobalTask[] = [];
const EMPTY_TEAM_MEMBERS: NonNullable<TeamSummary['members']> = [];
const EMPTY_TEAM_BY_NAME: Record<string, TeamSummary> = {};
const EMPTY_TASK_SUGGESTIONS: MentionSuggestion[] = [];

export interface UseTaskSuggestionsResult {
  suggestions: MentionSuggestion[];
}

interface UseTaskSuggestionsOptions {
  enabled?: boolean;
}

interface TaskWithTeamContext {
  task: TeamTaskWithKanban | GlobalTask;
  teamName: string;
  teamDisplayName: string;
  teamColor?: string;
  isCurrentTeamTask: boolean;
  ownerColor?: string;
}

function getTaskTimestamp(task: TeamTaskWithKanban | GlobalTask): number {
  const value = task.updatedAt ?? task.createdAt;
  return value ? Date.parse(value) || 0 : 0;
}

function buildTaskSuggestion({
  task,
  teamName,
  teamDisplayName,
  teamColor,
  isCurrentTeamTask,
  ownerColor,
}: TaskWithTeamContext): MentionSuggestion {
  const displayId = getTaskDisplayId(task);
  return {
    id: `task:${teamName}:${task.id}`,
    name: displayId,
    insertText: createEncodedTaskReference(displayId, task.id, teamName),
    subtitle: task.subject,
    color: teamColor,
    type: 'task',
    taskId: task.id,
    teamName,
    teamDisplayName,
    isCurrentTeamTask,
    ownerName: task.owner,
    ownerColor,
    searchText: [task.subject, teamDisplayName, teamName, task.owner].filter(Boolean).join(' '),
  };
}

function isVisibleTask(task: TeamTaskWithKanban | GlobalTask): boolean {
  return task.status !== 'deleted' && !task.deletedAt;
}

function buildTaskSuggestions(
  currentTeamName: string | null,
  globalTasks: GlobalTask[],
  currentTeamData: ReturnType<typeof selectTeamDataForName>,
  currentTeamMembers: NonNullable<TeamSummary['members']>,
  teamByName: Record<string, TeamSummary>
): MentionSuggestion[] {
  const tasks: TaskWithTeamContext[] = [];
  const seenTaskIds = new Set<string>();
  if (currentTeamName) {
    const currentTeamSummary = teamByName[currentTeamName];
    const currentTeamDisplayName = currentTeamSummary?.displayName || currentTeamName;
    const currentTeamTasks =
      currentTeamData?.tasks ?? globalTasks.filter((task) => task.teamName === currentTeamName);
    const currentTeamMemberColors =
      currentTeamMembers.length > 0 ? currentTeamMembers : (currentTeamSummary?.members ?? []);
    for (const task of currentTeamTasks) {
      if (!isVisibleTask(task)) continue;
      seenTaskIds.add(task.id);
      tasks.push({
        task,
        teamName: currentTeamName,
        teamDisplayName: currentTeamDisplayName,
        teamColor: currentTeamSummary?.color,
        isCurrentTeamTask: true,
        ownerColor: currentTeamMemberColors.find((member) => member.name === task.owner)?.color,
      });
    }
  }
  for (const task of globalTasks) {
    if (!isVisibleTask(task) || seenTaskIds.has(task.id)) continue;
    const teamSummary = teamByName[task.teamName];
    tasks.push({
      task,
      teamName: task.teamName,
      teamDisplayName: task.teamDisplayName,
      teamColor: teamSummary?.color,
      isCurrentTeamTask: task.teamName === currentTeamName,
      ownerColor: teamSummary?.members?.find((member) => member.name === task.owner)?.color,
    });
  }
  tasks.sort((a, b) => {
    if (a.isCurrentTeamTask !== b.isCurrentTeamTask) return a.isCurrentTeamTask ? -1 : 1;
    const timeDelta = getTaskTimestamp(b.task) - getTaskTimestamp(a.task);
    if (timeDelta !== 0) return timeDelta;
    if (a.teamName !== b.teamName) return a.teamName.localeCompare(b.teamName);
    return getTaskDisplayId(a.task).localeCompare(getTaskDisplayId(b.task));
  });
  return tasks.map(buildTaskSuggestion);
}

export function getTaskSuggestionsForTeamNow(currentTeamName: string | null): MentionSuggestion[] {
  const state = useStore.getState();
  return buildTaskSuggestions(
    currentTeamName,
    state.globalTasks,
    currentTeamName ? selectTeamDataForName(state, currentTeamName) : null,
    currentTeamName ? selectResolvedMembersForTeamName(state, currentTeamName) : EMPTY_TEAM_MEMBERS,
    state.teamByName
  );
}

export function useTaskSuggestions(
  currentTeamName: string | null,
  options: UseTaskSuggestionsOptions = {}
): UseTaskSuggestionsResult {
  const enabled = options.enabled ?? true;
  const { globalTasks, currentTeamData, currentTeamMembers, teamByName } = useStore(
    useShallow((s) => ({
      globalTasks: enabled ? s.globalTasks : EMPTY_GLOBAL_TASKS,
      currentTeamData:
        enabled && currentTeamName ? selectTeamDataForName(s, currentTeamName) : null,
      currentTeamMembers:
        enabled && currentTeamName
          ? selectResolvedMembersForTeamName(s, currentTeamName)
          : EMPTY_TEAM_MEMBERS,
      teamByName: enabled ? s.teamByName : EMPTY_TEAM_BY_NAME,
    }))
  );

  const suggestions = useMemo<MentionSuggestion[]>(() => {
    if (!enabled) return EMPTY_TASK_SUGGESTIONS;
    return buildTaskSuggestions(
      currentTeamName,
      globalTasks,
      currentTeamData,
      currentTeamMembers,
      teamByName
    );
  }, [currentTeamData, currentTeamMembers, currentTeamName, enabled, globalTasks, teamByName]);

  return { suggestions };
}
