import { api } from '@renderer/api';
import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import { formatTaskDisplayLabel } from '@shared/utils/taskIdentity';
import {
  getTeamTaskWorkflowColumn,
  isTeamTaskFinalForCompletionNotification,
  isTeamTaskNeedsFixActionable,
} from '@shared/utils/teamTaskState';

import type { AppConfig } from '@renderer/types/data';
import type { GlobalTask, TaskComment, TeamMessageNotificationData, TeamSummary } from '@shared/types';

const notifiedClarificationTaskKeys = new Set<string>();
const notifiedStatusChangeKeys = new Set<string>();
const notifiedCommentKeys = new Set<string>();
const notifiedCreatedTaskKeys = new Set<string>();
const notifiedAllCompletedTeams = new Set<string>();
const notifiedBlockedTaskKeys = new Set<string>();

let isFirstFetchAllTasks = true;

export interface ProcessGlobalTaskNotificationsParams {
  oldTasks: GlobalTask[];
  newTasks: GlobalTask[];
  appConfig: AppConfig | null;
  teamByName: Record<string, TeamSummary>;
  isInitialFetch: boolean;
}

export function resetGlobalTaskNotificationTrackerForTests(): void {
  notifiedClarificationTaskKeys.clear();
  notifiedStatusChangeKeys.clear();
  notifiedCommentKeys.clear();
  notifiedCreatedTaskKeys.clear();
  notifiedAllCompletedTeams.clear();
  notifiedBlockedTaskKeys.clear();
  isFirstFetchAllTasks = true;
}

export function consumeFirstGlobalTasksFetchFlag(): boolean {
  const wasFirst = isFirstFetchAllTasks;
  isFirstFetchAllTasks = false;
  return wasFirst;
}

export function processGlobalTaskNotifications(
  params: ProcessGlobalTaskNotificationsParams
): void {
  const { oldTasks, newTasks, appConfig, teamByName, isInitialFetch } = params;

  if (isInitialFetch) {
    seedGlobalTaskNotificationState(newTasks);
    return;
  }

  const notifyOnClarifications = appConfig?.notifications?.notifyOnClarifications ?? true;
  detectClarificationNotifications(oldTasks, newTasks, notifyOnClarifications);
  detectBlockedTaskNotifications(oldTasks, newTasks, notifyOnClarifications);
  detectStatusChangeNotifications(oldTasks, newTasks, appConfig, teamByName);

  const notifyOnTaskComments = appConfig?.notifications?.notifyOnTaskComments ?? true;
  detectTaskCommentNotifications(oldTasks, newTasks, notifyOnTaskComments);

  const notifyOnTaskCreated = appConfig?.notifications?.notifyOnTaskCreated ?? true;
  detectTaskCreatedNotifications(oldTasks, newTasks, notifyOnTaskCreated);

  const notifyOnAllCompleted = appConfig?.notifications?.notifyOnAllTasksCompleted ?? true;
  detectAllTasksCompletedNotification(oldTasks, newTasks, notifyOnAllCompleted);
}

function seedGlobalTaskNotificationState(tasks: readonly GlobalTask[]): void {
  for (const task of tasks) {
    if (task.needsClarification === 'user') {
      notifiedClarificationTaskKeys.add(`${task.teamName}:${task.id}`);
    }
    if ((task.blockedBy?.length ?? 0) > 0) {
      notifiedBlockedTaskKeys.add(`${task.teamName}:${task.id}:${(task.blockedBy ?? []).join(',')}`);
    }
    notifiedStatusChangeKeys.add(`${task.teamName}:${task.id}:${task.status}`);
    if (isTeamTaskNeedsFixActionable(task)) {
      notifiedStatusChangeKeys.add(`${task.teamName}:${task.id}:needsFix`);
    }
    if (getTeamTaskWorkflowColumn(task) === 'approved') {
      notifiedStatusChangeKeys.add(`${task.teamName}:${task.id}:approved`);
    }
    if (getTeamTaskWorkflowColumn(task) === 'review') {
      notifiedStatusChangeKeys.add(`${task.teamName}:${task.id}:review`);
    }
    for (const comment of task.comments ?? []) {
      notifiedCommentKeys.add(`${task.teamName}:${task.id}:${comment.id}`);
    }
    notifiedCreatedTaskKeys.add(`${task.teamName}:${task.id}`);
  }

  const teamTasksMap = new Map<string, GlobalTask[]>();
  for (const task of tasks) {
    const list = teamTasksMap.get(task.teamName) ?? [];
    list.push(task);
    teamTasksMap.set(task.teamName, list);
  }
  for (const [teamName, teamTasks] of teamTasksMap) {
    if (teamTasks.every(isTeamTaskFinalForCompletionNotification)) {
      notifiedAllCompletedTeams.add(teamName);
    }
  }
}

function showTeamNotification(data: TeamMessageNotificationData): void {
  void api.teams?.showMessageNotification(data).catch(() => undefined);
}

function detectClarificationNotifications(
  oldTasks: GlobalTask[],
  newTasks: GlobalTask[],
  notifyEnabled: boolean
): void {
  for (const task of newTasks) {
    const key = `${task.teamName}:${task.id}`;
    if (task.needsClarification === 'user') {
      const oldTask = oldTasks.find((t) => t.teamName === task.teamName && t.id === task.id);
      if (oldTask?.needsClarification !== 'user' && !notifiedClarificationTaskKeys.has(key)) {
        notifiedClarificationTaskKeys.add(key);
        showClarificationNotification(task, !notifyEnabled);
      }
    } else {
      notifiedClarificationTaskKeys.delete(key);
    }
  }
}

function showClarificationNotification(task: GlobalTask, suppressToast: boolean): void {
  const latestComment = task.comments?.length ? task.comments[task.comments.length - 1] : undefined;
  const rawBody =
    latestComment?.text || task.description || `${formatTaskDisplayLabel(task)}: ${task.subject}`;
  const body = stripAgentBlocks(rawBody).trim();

  showTeamNotification({
    teamName: task.teamName,
    teamDisplayName: task.teamDisplayName,
    from: latestComment?.author || 'team-lead',
    to: 'user',
    summary: `Clarification needed — Task ${formatTaskDisplayLabel(task)}`,
    body,
    teamEventType: 'task_clarification',
    dedupeKey: `clarification:${task.teamName}:${task.id}:${task.updatedAt ?? Date.now()}`,
    target: {
      kind: 'task',
      teamName: task.teamName,
      taskId: task.id,
      commentId: latestComment?.id,
      focus: 'comments',
    },
    suppressToast,
  });
}

function detectStatusChangeNotifications(
  oldTasks: GlobalTask[],
  newTasks: GlobalTask[],
  config: AppConfig | null,
  teamByName: Record<string, TeamSummary>
): void {
  const statusChangeEnabled =
    !!config?.notifications?.notifyOnStatusChange && !!config.notifications.enabled;
  const statuses = config?.notifications?.statusChangeStatuses ?? ['in_progress', 'completed'];
  if (statuses.length === 0) return;

  const onlySolo = config?.notifications?.statusChangeOnlySolo ?? true;

  for (const task of newTasks) {
    const oldTask = oldTasks.find((t) => t.teamName === task.teamName && t.id === task.id);
    if (!oldTask) continue;

    const taskKanbanColumn = getTeamTaskWorkflowColumn(task);
    const oldTaskKanbanColumn = getTeamTaskWorkflowColumn(oldTask);
    const becameApproved = taskKanbanColumn === 'approved' && oldTaskKanbanColumn !== 'approved';
    const becameReview = taskKanbanColumn === 'review' && oldTaskKanbanColumn !== 'review';
    const becameNeedsFix =
      isTeamTaskNeedsFixActionable(task) && !isTeamTaskNeedsFixActionable(oldTask);

    const statusChanged = oldTask.status !== task.status;
    if (!statusChanged && !becameApproved && !becameReview && !becameNeedsFix) continue;

    if (onlySolo) {
      const team = teamByName[task.teamName];
      if (team && team.memberCount > 0) continue;
    }

    const effectiveStatus = becameApproved
      ? 'approved'
      : becameReview
        ? 'review'
        : becameNeedsFix
          ? 'needsFix'
          : task.status;
    if (!statuses.includes(effectiveStatus)) continue;

    const key = `${task.teamName}:${task.id}:${effectiveStatus}`;
    if (notifiedStatusChangeKeys.has(key)) continue;
    notifiedStatusChangeKeys.add(key);

    const fromLabel = becameApproved ? 'Completed' : becameReview ? 'Completed' : oldTask.status;
    showStatusChangeNotification(
      task,
      fromLabel,
      becameApproved
        ? 'approved'
        : becameReview
          ? 'review'
          : becameNeedsFix
            ? 'needsFix'
            : undefined,
      !statusChangeEnabled
    );
  }
}

function showStatusChangeNotification(
  task: GlobalTask,
  fromStatus: string,
  overrideToStatus?: string,
  suppressToast?: boolean
): void {
  const statusLabels: Record<string, string> = {
    pending: 'Pending',
    in_progress: 'In Progress',
    completed: 'Completed',
    deleted: 'Deleted',
    review: 'Review',
    needsFix: 'Needs Fixes',
    approved: 'Approved',
  };
  const from = statusLabels[fromStatus] ?? fromStatus;
  const toStatus = overrideToStatus ?? task.status;
  const to = statusLabels[toStatus] ?? toStatus;

  showTeamNotification({
    teamName: task.teamName,
    teamDisplayName: task.teamDisplayName,
    from: task.owner ?? 'system',
    to: 'user',
    summary: `Task ${formatTaskDisplayLabel(task)}: ${from} → ${to}`,
    body: task.subject,
    teamEventType: 'task_status_change',
    dedupeKey: `status:${task.teamName}:${task.id}:${fromStatus}:${toStatus}:${task.updatedAt ?? Date.now()}`,
    target: {
      kind: 'task',
      teamName: task.teamName,
      taskId: task.id,
      focus: 'status',
    },
    suppressToast,
  });
}

function detectTaskCommentNotifications(
  oldTasks: GlobalTask[],
  newTasks: GlobalTask[],
  notifyEnabled: boolean
): void {
  const oldTaskMap = new Map(oldTasks.map((t) => [`${t.teamName}:${t.id}`, t]));

  for (const task of newTasks) {
    const mapKey = `${task.teamName}:${task.id}`;
    const oldTask = oldTaskMap.get(mapKey);
    const oldCommentCount = oldTask?.comments?.length ?? 0;
    const newCommentCount = task.comments?.length ?? 0;

    if (newCommentCount <= oldCommentCount) continue;

    const newComments = (task.comments ?? []).slice(oldCommentCount);
    for (const comment of newComments) {
      if (comment.author === 'user') continue;

      const key = `${task.teamName}:${task.id}:${comment.id}`;
      if (notifiedCommentKeys.has(key)) continue;
      notifiedCommentKeys.add(key);

      if (comment.type === 'review_request') {
        showTaskReviewRequestedNotification(task, comment, !notifyEnabled);
        continue;
      }
      if (comment.type === 'review_approved') continue;

      showTaskCommentNotification(task, comment, !notifyEnabled);
    }
  }
}

function showTaskCommentNotification(
  task: GlobalTask,
  comment: Pick<TaskComment, 'author' | 'text' | 'id'>,
  suppressToast: boolean
): void {
  if (comment.author === 'user') return;

  const stripped = stripAgentBlocks(comment.text).trim();
  const preview = stripped.length > 100 ? stripped.slice(0, 100) + '...' : stripped;

  showTeamNotification({
    teamName: task.teamName,
    teamDisplayName: task.teamDisplayName,
    from: comment.author,
    to: 'user',
    summary: `Comment on ${formatTaskDisplayLabel(task)}: ${task.subject}`,
    body: preview,
    teamEventType: 'task_comment',
    dedupeKey: `comment:${task.teamName}:${task.id}:${comment.id}`,
    target: {
      kind: 'task',
      teamName: task.teamName,
      taskId: task.id,
      commentId: comment.id,
      focus: 'comments',
    },
    suppressToast,
  });
}

function showTaskReviewRequestedNotification(
  task: GlobalTask,
  comment: Pick<TaskComment, 'author' | 'text' | 'id'>,
  suppressToast: boolean
): void {
  const stripped = stripAgentBlocks(comment.text).trim();
  const preview = stripped.length > 100 ? stripped.slice(0, 100) + '...' : stripped;

  showTeamNotification({
    teamName: task.teamName,
    teamDisplayName: task.teamDisplayName,
    from: comment.author,
    to: 'user',
    summary: `Review requested ${formatTaskDisplayLabel(task)}: ${task.subject}`,
    body: preview || task.subject,
    teamEventType: 'task_review_requested',
    dedupeKey: `review-request:${task.teamName}:${task.id}:${comment.id}`,
    target: {
      kind: 'task',
      teamName: task.teamName,
      taskId: task.id,
      commentId: comment.id,
      focus: 'review',
    },
    suppressToast,
  });
}

function detectBlockedTaskNotifications(
  oldTasks: GlobalTask[],
  newTasks: GlobalTask[],
  notifyEnabled: boolean
): void {
  const oldTaskMap = new Map(oldTasks.map((task) => [`${task.teamName}:${task.id}`, task]));

  for (const task of newTasks) {
    const oldTask = oldTaskMap.get(`${task.teamName}:${task.id}`);
    const oldBlockedBy = new Set(oldTask?.blockedBy?.filter(Boolean) ?? []);
    const newBlockedBy = Array.from(new Set(task.blockedBy?.filter(Boolean) ?? []));
    const taskKeyPrefix = `${task.teamName}:${task.id}:`;
    const key = `${taskKeyPrefix}${[...newBlockedBy].sort().join(',')}`;
    const addedBlockedBy = newBlockedBy.filter((id) => !oldBlockedBy.has(id));

    for (const existingKey of Array.from(notifiedBlockedTaskKeys)) {
      if (existingKey.startsWith(taskKeyPrefix) && existingKey !== key) {
        notifiedBlockedTaskKeys.delete(existingKey);
      }
    }

    if (newBlockedBy.length > 0 && addedBlockedBy.length > 0) {
      if (notifiedBlockedTaskKeys.has(key)) continue;
      notifiedBlockedTaskKeys.add(key);
      showTaskBlockedNotification(task, newBlockedBy, !notifyEnabled);
    } else if (newBlockedBy.length === 0) {
      for (const existingKey of Array.from(notifiedBlockedTaskKeys)) {
        if (existingKey.startsWith(taskKeyPrefix)) {
          notifiedBlockedTaskKeys.delete(existingKey);
        }
      }
    }
  }
}

function showTaskBlockedNotification(
  task: GlobalTask,
  blockedBy: readonly string[],
  suppressToast: boolean
): void {
  const blockerRefs = blockedBy.map((id) => formatTaskDisplayLabel({ id })).join(', ');

  showTeamNotification({
    teamName: task.teamName,
    teamDisplayName: task.teamDisplayName,
    from: task.owner ?? 'system',
    to: 'user',
    summary: `Blocked ${formatTaskDisplayLabel(task)}: ${task.subject}`,
    body: blockerRefs ? `Blocked by ${blockerRefs}` : task.subject,
    teamEventType: 'task_blocked',
    dedupeKey: `blocked:${task.teamName}:${task.id}:${blockedBy.join(',')}`,
    target: {
      kind: 'task',
      teamName: task.teamName,
      taskId: task.id,
      focus: 'detail',
    },
    suppressToast,
  });
}

function detectTaskCreatedNotifications(
  oldTasks: GlobalTask[],
  newTasks: GlobalTask[],
  notifyEnabled: boolean
): void {
  const oldTaskKeys = new Set(oldTasks.map((t) => `${t.teamName}:${t.id}`));

  for (const task of newTasks) {
    const key = `${task.teamName}:${task.id}`;
    if (oldTaskKeys.has(key)) continue;
    if (notifiedCreatedTaskKeys.has(key)) continue;
    notifiedCreatedTaskKeys.add(key);

    showTaskCreatedNotification(task, !notifyEnabled);
  }
}

function showTaskCreatedNotification(task: GlobalTask, suppressToast: boolean): void {
  showTeamNotification({
    teamName: task.teamName,
    teamDisplayName: task.teamDisplayName,
    from: task.owner ?? 'system',
    to: 'user',
    summary: `New task ${formatTaskDisplayLabel(task)}: ${task.subject}`,
    body: stripAgentBlocks(task.description || task.subject).trim(),
    teamEventType: 'task_created',
    dedupeKey: `created:${task.teamName}:${task.id}`,
    target: {
      kind: 'task',
      teamName: task.teamName,
      taskId: task.id,
      focus: 'detail',
    },
    suppressToast,
  });
}

function detectAllTasksCompletedNotification(
  oldTasks: GlobalTask[],
  newTasks: GlobalTask[],
  notifyEnabled: boolean
): void {
  const teamTasks = new Map<string, GlobalTask[]>();
  for (const task of newTasks) {
    const list = teamTasks.get(task.teamName) ?? [];
    list.push(task);
    teamTasks.set(task.teamName, list);
  }

  for (const [teamName, tasks] of teamTasks) {
    if (tasks.length === 0) continue;
    const allCompleted = tasks.every(isTeamTaskFinalForCompletionNotification);
    if (!allCompleted) {
      notifiedAllCompletedTeams.delete(teamName);
      continue;
    }
    if (notifiedAllCompletedTeams.has(teamName)) continue;

    const oldTeamTasks = oldTasks.filter((t) => t.teamName === teamName);
    const wasAlreadyAllCompleted =
      oldTeamTasks.length > 0 && oldTeamTasks.every(isTeamTaskFinalForCompletionNotification);
    if (wasAlreadyAllCompleted) {
      notifiedAllCompletedTeams.add(teamName);
      continue;
    }

    notifiedAllCompletedTeams.add(teamName);
    showAllTasksCompletedNotification(tasks[0], tasks.length, !notifyEnabled);
  }
}

function showAllTasksCompletedNotification(
  sampleTask: GlobalTask,
  taskCount: number,
  suppressToast: boolean
): void {
  showTeamNotification({
    teamName: sampleTask.teamName,
    teamDisplayName: sampleTask.teamDisplayName,
    from: 'system',
    to: 'user',
    summary: `All ${taskCount} tasks completed`,
    body: `All tasks in team "${sampleTask.teamDisplayName}" are done`,
    teamEventType: 'all_tasks_completed',
    dedupeKey: `all-done:${sampleTask.teamName}:${Date.now()}`,
    target: {
      kind: 'team',
      teamName: sampleTask.teamName,
      section: 'tasks',
    },
    suppressToast,
  });
}
