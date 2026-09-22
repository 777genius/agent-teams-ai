import { useCallback, useMemo } from 'react';

import { useStore } from '@renderer/store';
import {
  selectResolvedMembersForTeamName,
  selectTeamDataForName,
} from '@renderer/store/slices/teamSlice';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { useShallow } from 'zustand/react/shallow';

import type { OrganizationAgentTaskDto } from '../../contracts';
import type { TeamTask, TeamTaskWithKanban } from '@shared/types';

export interface OrganizationInspectorTaskBindings {
  tasks: TeamTaskWithKanban[];
  taskMap: Map<string, TeamTask>;
  memberColorMap: Map<string, string>;
  kanbanTaskStateById: NonNullable<ReturnType<typeof selectTeamDataForName>>['kanbanState']['tasks'] | undefined;
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

export function useOrganizationInspectorTasks(teamName: string): OrganizationInspectorTaskBindings {
  const {
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

  const tasks = useMemo<TeamTaskWithKanban[]>(() => {
    if (!teamName) return [];
    if (teamData?.tasks) return teamData.tasks;
    return globalTasks.filter((task) => task.teamName === teamName);
  }, [globalTasks, teamData?.tasks, teamName]);

  const taskMap = useMemo<Map<string, TeamTask>>(() => {
    const map = new Map<string, TeamTask>();
    for (const task of tasks) {
      map.set(task.id, task);
    }
    return map;
  }, [tasks]);

  const memberColorMap = useMemo(() => buildMemberColorMap(members), [members]);

  const openTaskById = useCallback(
    (taskId: string): void => {
      if (!teamName) return;
      openGlobalTaskDetail(teamName, taskId);
    },
    [openGlobalTaskDetail, teamName]
  );

  const openTaskDetail = useCallback(
    (task: TeamTask): void => {
      openTaskById(task.id);
    },
    [openTaskById]
  );

  const openTaskSummaryDetail = useCallback(
    (task: OrganizationAgentTaskDto): void => {
      openTaskById(task.id);
    },
    [openTaskById]
  );

  const onStartTask = useCallback(
    (taskId: string): void => {
      if (!teamName) return;
      void startTaskByUser(teamName, taskId).catch(() => undefined);
    },
    [startTaskByUser, teamName]
  );

  const onCompleteTask = useCallback(
    (taskId: string): void => {
      if (!teamName) return;
      void updateTaskStatus(teamName, taskId, 'completed').catch(() => undefined);
    },
    [teamName, updateTaskStatus]
  );

  const onCancelTask = useCallback(
    (taskId: string): void => {
      if (!teamName) return;
      void updateTaskStatus(teamName, taskId, 'pending').catch(() => undefined);
    },
    [teamName, updateTaskStatus]
  );

  const onApproveTask = useCallback(
    (taskId: string): void => {
      if (!teamName) return;
      void updateKanban(teamName, taskId, { op: 'set_column', column: 'approved' }).catch(
        () => undefined
      );
    },
    [teamName, updateKanban]
  );

  const onRequestReview = useCallback(
    (taskId: string): void => {
      if (!teamName) return;
      void requestReview(teamName, taskId).catch(() => undefined);
    },
    [requestReview, teamName]
  );

  const onMoveBackToDone = useCallback(
    (taskId: string): void => {
      if (!teamName) return;
      void (async () => {
        try {
          await updateKanban(teamName, taskId, { op: 'remove' });
          await updateTaskStatus(teamName, taskId, 'completed');
        } catch {
          // Store state surfaces the error.
        }
      })();
    },
    [teamName, updateKanban, updateTaskStatus]
  );

  return {
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
