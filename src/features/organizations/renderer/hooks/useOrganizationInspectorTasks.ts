import { useCallback, useMemo } from 'react';

import { useStore } from '@renderer/store';
import {
  selectResolvedMembersForTeamName,
  selectTeamDataForName,
} from '@renderer/store/slices/teamSlice';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { useShallow } from 'zustand/react/shallow';

import { executionTeamOfTask, scopeInspectorTasks } from './organizationInspectorTaskScope';

import type { OrganizationAgentTaskDto } from '../../contracts';
import type { TeamTask, TeamTaskWithKanban } from '@shared/types';

export interface OrganizationInspectorTaskBindings {
  contextId: string;
  tasks: TeamTaskWithKanban[];
  taskMap: Map<string, TeamTask>;
  memberColorMap: Map<string, string>;
  kanbanTaskStateById:
    | NonNullable<ReturnType<typeof selectTeamDataForName>>['kanbanState']['tasks']
    | undefined;
  openTaskDetail: (task: TeamTask) => void;
  openTaskSummaryDetail: (task: OrganizationAgentTaskDto) => void;
  onStartTask: (taskId: string) => void;
  onCompleteTask: (taskId: string) => void;
  onCancelTask: (taskId: string) => void;
  onApproveTask: (taskId: string) => void;
  onRequestReview: (taskId: string) => void;
  onRequestChanges: (taskId: string) => void;
  onMoveBackToDone: (taskId: string) => void;
}

/**
 * `executionTeamNames` are the project copies a per-project team keeps its tasks in.
 * Task actions run against the copy that owns the task, not the team the node shows.
 */
export function useOrganizationInspectorTasks(
  teamName: string,
  executionTeamNames: readonly string[] = []
): OrganizationInspectorTaskBindings {
  const {
    contextId,
    globalTasks,
    members,
    openGlobalTaskDetail,
    requestReview,
    startTaskByUser,
    teamData,
    updateKanban,
    updateTaskStatus,
  } = useStore(
    useShallow((state) => ({
      contextId: state.activeContextId,
      globalTasks: state.globalTasks,
      members: selectResolvedMembersForTeamName(state, teamName),
      openGlobalTaskDetail: state.openGlobalTaskDetail,
      requestReview: state.requestReview,
      startTaskByUser: state.startTaskByUser,
      teamData: selectTeamDataForName(state, teamName),
      updateKanban: state.updateKanban,
      updateTaskStatus: state.updateTaskStatus,
    }))
  );

  // A stable key: the caller builds the list on every render.
  const executionKey = executionTeamNames.join('\n');
  const tasks = useMemo<TeamTaskWithKanban[]>(
    () =>
      scopeInspectorTasks({
        teamName,
        executionTeamNames: executionKey ? executionKey.split('\n') : [],
        teamDataTasks: teamData?.tasks,
        globalTasks,
      }),
    [executionKey, globalTasks, teamData?.tasks, teamName]
  );

  const executionTeamFor = useCallback(
    (taskId: string): string => executionTeamOfTask(tasks, taskId, teamName),
    [tasks, teamName]
  );

  const taskMap = useMemo<Map<string, TeamTask>>(() => {
    const map = new Map<string, TeamTask>();
    for (const task of tasks) {
      map.set(task.id, task);
    }
    return map;
  }, [tasks]);

  const memberColorMap = useMemo(() => buildMemberColorMap(members), [members]);

  const openTaskIn = useCallback(
    (executionTeam: string, taskId: string): void => {
      if (!executionTeam) return;
      openGlobalTaskDetail(executionTeam, taskId);
    },
    [openGlobalTaskDetail]
  );

  const openTaskById = useCallback(
    (taskId: string): void => openTaskIn(executionTeamFor(taskId), taskId),
    [executionTeamFor, openTaskIn]
  );

  const openTaskDetail = useCallback(
    (task: TeamTask): void => {
      openTaskById(task.id);
    },
    [openTaskById]
  );

  const openTaskSummaryDetail = useCallback(
    (task: OrganizationAgentTaskDto): void => {
      openTaskIn(task.executionTeamName ?? teamName, task.id);
    },
    [openTaskIn, teamName]
  );

  const onStartTask = useCallback(
    (taskId: string): void => {
      const executionTeam = executionTeamFor(taskId);
      if (!executionTeam) return;
      void startTaskByUser(executionTeam, taskId).catch(() => undefined);
    },
    [executionTeamFor, startTaskByUser]
  );

  const onCompleteTask = useCallback(
    (taskId: string): void => {
      const executionTeam = executionTeamFor(taskId);
      if (!executionTeam) return;
      void updateTaskStatus(executionTeam, taskId, 'completed').catch(() => undefined);
    },
    [executionTeamFor, updateTaskStatus]
  );

  const onCancelTask = useCallback(
    (taskId: string): void => {
      const executionTeam = executionTeamFor(taskId);
      if (!executionTeam) return;
      void updateTaskStatus(executionTeam, taskId, 'pending').catch(() => undefined);
    },
    [executionTeamFor, updateTaskStatus]
  );

  const onApproveTask = useCallback(
    (taskId: string): void => {
      const executionTeam = executionTeamFor(taskId);
      if (!executionTeam) return;
      void updateKanban(executionTeam, taskId, { op: 'set_column', column: 'approved' }).catch(
        () => undefined
      );
    },
    [executionTeamFor, updateKanban]
  );

  const onRequestReview = useCallback(
    (taskId: string): void => {
      const executionTeam = executionTeamFor(taskId);
      if (!executionTeam) return;
      void requestReview(executionTeam, taskId).catch(() => undefined);
    },
    [executionTeamFor, requestReview]
  );

  const onMoveBackToDone = useCallback(
    (taskId: string): void => {
      const executionTeam = executionTeamFor(taskId);
      if (!executionTeam) return;
      void (async () => {
        try {
          await updateKanban(executionTeam, taskId, { op: 'remove' });
          await updateTaskStatus(executionTeam, taskId, 'completed');
        } catch {
          // Store state surfaces the error.
        }
      })();
    },
    [executionTeamFor, updateKanban, updateTaskStatus]
  );

  return {
    contextId,
    tasks,
    taskMap,
    memberColorMap,
    kanbanTaskStateById: teamData?.kanbanState.tasks,
    openTaskDetail,
    openTaskSummaryDetail,
    onStartTask,
    onCompleteTask,
    onCancelTask,
    onApproveTask,
    onRequestReview,
    onRequestChanges: openTaskById,
    onMoveBackToDone,
  };
}
