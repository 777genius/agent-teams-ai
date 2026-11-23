import { useCallback, useMemo } from 'react';

import { useStore } from '@renderer/store';
import {
  selectResolvedMembersForTeamName,
  selectTeamDataForName,
} from '@renderer/store/slices/teamSlice';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { useShallow } from 'zustand/react/shallow';

import { groupTasksByOwner, scopeInspectorTasks } from './organizationInspectorTaskScope';

import type { OrganizationAgentTaskDto } from '../../contracts';
import type { InspectorScopedTask } from './organizationInspectorTaskScope';
import type { TeamTask } from '@shared/types';

/** What one task card needs; every action runs against the team that owns the task. */
export interface OrganizationInspectorTaskCardBindings {
  taskMap: Map<string, TeamTask>;
  onTaskClick: (task: TeamTask) => void;
  onStartTask: (taskId: string) => void;
  onCompleteTask: (taskId: string) => void;
  onCancelTask: (taskId: string) => void;
  onApprove: (taskId: string) => void;
  onRequestReview: (taskId: string) => void;
  onRequestChanges: (taskId: string) => void;
  onMoveBackToDone: (taskId: string) => void;
}

export interface OrganizationInspectorTaskBindings {
  contextId: string;
  tasks: InspectorScopedTask[];
  memberColorMap: Map<string, string>;
  kanbanTaskStateById:
    | NonNullable<ReturnType<typeof selectTeamDataForName>>['kanbanState']['tasks']
    | undefined;
  openTaskSummaryDetail: (task: OrganizationAgentTaskDto) => void;
  /**
   * Bindings of the cards of one owning team. The owner is passed explicitly: task
   * ids are only unique inside a team, so an id alone can name a task in two copies.
   */
  cardBindingsFor: (ownerTeamName: string) => OrganizationInspectorTaskCardBindings;
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
  const tasks = useMemo<InspectorScopedTask[]>(
    () =>
      scopeInspectorTasks({
        teamName,
        executionTeamNames: executionKey ? executionKey.split('\n') : [],
        teamDataTasks: teamData?.tasks,
        globalTasks,
      }),
    [executionKey, globalTasks, teamData?.tasks, teamName]
  );

  const taskMapsByOwner = useMemo(() => groupTasksByOwner(tasks, teamName), [tasks, teamName]);
  const memberColorMap = useMemo(() => buildMemberColorMap(members), [members]);

  const openTaskSummaryDetail = useCallback(
    (task: OrganizationAgentTaskDto): void => {
      const owner = task.executionTeamName ?? teamName;
      if (owner) openGlobalTaskDetail(owner, task.id);
    },
    [openGlobalTaskDetail, teamName]
  );

  const cardBindingsFor = useCallback(
    (owner: string): OrganizationInspectorTaskCardBindings => {
      const swallow = (): undefined => undefined;
      return {
        taskMap: taskMapsByOwner.get(owner) ?? new Map<string, TeamTask>(),
        onTaskClick: (task) => {
          if (owner) openGlobalTaskDetail(owner, task.id);
        },
        onStartTask: (taskId) => {
          if (owner) void startTaskByUser(owner, taskId).catch(swallow);
        },
        onCompleteTask: (taskId) => {
          if (owner) void updateTaskStatus(owner, taskId, 'completed').catch(swallow);
        },
        onCancelTask: (taskId) => {
          if (owner) void updateTaskStatus(owner, taskId, 'pending').catch(swallow);
        },
        onApprove: (taskId) => {
          if (owner) {
            void updateKanban(owner, taskId, { op: 'set_column', column: 'approved' }).catch(swallow);
          }
        },
        onRequestReview: (taskId) => {
          if (owner) void requestReview(owner, taskId).catch(swallow);
        },
        onRequestChanges: (taskId) => {
          if (owner) openGlobalTaskDetail(owner, taskId);
        },
        onMoveBackToDone: (taskId) => {
          if (!owner) return;
          void (async () => {
            try {
              await updateKanban(owner, taskId, { op: 'remove' });
              await updateTaskStatus(owner, taskId, 'completed');
            } catch {
              // Store state surfaces the error.
            }
          })();
        },
      };
    },
    [
      openGlobalTaskDetail,
      requestReview,
      startTaskByUser,
      taskMapsByOwner,
      updateKanban,
      updateTaskStatus,
    ]
  );

  return {
    contextId,
    tasks,
    memberColorMap,
    kanbanTaskStateById: teamData?.kanbanState.tasks,
    openTaskSummaryDetail,
    cardBindingsFor,
  };
}
