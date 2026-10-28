import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useDocumentVisibility } from '@renderer/hooks/useDocumentVisibility';
import { useTheme } from '@renderer/hooks/useTheme';
import { useViewportCommentRead } from '@renderer/hooks/useViewportCommentRead';
import { getLegacyCutoff, getReadCommentIds } from '@renderer/services/commentReadStorage';
import { useStore } from '@renderer/store';
import { isImageMimeType } from '@renderer/utils/attachmentUtils';
import {
  buildMemberAvatarMap,
  buildMemberColorMap,
  KANBAN_COLUMN_DISPLAY,
  TASK_STATUS_LABELS,
  TASK_STATUS_STYLES,
} from '@renderer/utils/memberHelpers';
import {
  resolveTaskReferenceCandidate,
  type TaskIdClickHandler,
} from '@renderer/utils/taskReferenceUtils';
import { isLeadMember } from '@shared/utils/leadDetection';
import { getTeamTaskWorkflowColumn } from '@shared/utils/teamTaskState';

import { useTaskDetailChanges } from './useTaskDetailChanges';

import type { TaskDetailCommentImage } from '../ui/TaskDetailCommentImages';
import type { KanbanTaskState, ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

const EMPTY_UNREAD_COMMENT_IDS: ReadonlySet<string> = new Set();

export interface TaskDetailPresentationModel {
  allowLeadExecutionPreview: boolean;
  attachmentCount: number;
  avatarMap: Map<string, string>;
  canReassign: boolean;
  colorMap: Map<string, string>;
  commentImageAttachments: TaskDetailCommentImage[];
  commentReadEnabled: boolean;
  currentTask: TeamTaskWithKanban;
  descriptionDraft: string;
  editingDescription: boolean;
  editingSubject: boolean;
  focusCommentId?: string;
  isExecutionPreviewOnline: boolean;
  isExecutionRefreshing: boolean;
  isLight: boolean;
  isLeadOwnedTask: boolean;
  logsSectionOpen: boolean;
  kanbanColumn: ReturnType<typeof getTeamTaskWorkflowColumn>;
  kanbanTaskState?: KanbanTaskState;
  members: ResolvedTeamMember[];
  projectPath: string | null;
  registerComment: ReturnType<typeof useViewportCommentRead>['registerComment'];
  savingDescription: boolean;
  savingSubject: boolean;
  status: TeamTaskWithKanban['status'];
  statusLabel: string;
  statusStyle: { bg: string; text: string };
  subjectDraft: string;
  taskLogActivityActive: boolean;
  taskLogStreamCount: number | undefined;
  taskChanges: ReturnType<typeof useTaskDetailChanges>['state'];
  taskMap: Map<string, TeamTaskWithKanban>;
  teamName: string;
  unreadCommentIds: ReadonlySet<string>;
}

export interface TaskDetailPresentationActions {
  beginHandoff: () => void;
  cancelEditDescription: () => void;
  cancelEditSubject: () => void;
  endHandoff: () => void;
  flushCommentRead: () => void;
  getTaskAttachmentData: (
    teamName: string,
    taskId: string,
    attachmentId: string,
    mimeType: string
  ) => Promise<string | null>;
  handleDependencyClick: TaskIdClickHandler;
  handleReply: (author: string, text: string) => void;
  markClarificationResolved: () => void;
  refreshChanges: () => void;
  saveDescription: () => Promise<void>;
  saveSubject: () => Promise<void>;
  setChangesSectionOpen: (open: boolean) => void;
  setDescriptionDraft: (value: string) => void;
  setRootElement: (element: HTMLElement | null) => void;
  setSubjectDraft: (value: string) => void;
  setTaskLogActivityActive: (active: boolean) => void;
  setTaskLogStreamCount: (count: number | undefined) => void;
  setExecutionPreviewOnline: (online: boolean) => void;
  setLogsRefreshing: (refreshing: boolean) => void;
  setLogsSectionOpen: (open: boolean) => void;
}

export interface TaskDetailPresentationInput {
  active: boolean;
  currentTask: TeamTaskWithKanban;
  enabled: boolean;
  focusCommentId?: string;
  kanbanTaskState?: KanbanTaskState;
  members: ResolvedTeamMember[];
  onOpenChangeFile: (filePath: string) => void;
  onTaskNavigate: (taskId: string, teamName?: string) => void;
  projectPath: string | null;
  sessionController: import('./useTaskDetailSession').TaskDetailSessionController;
  taskMap: Map<string, TeamTaskWithKanban>;
  teamName: string;
}

export function useTaskDetailPresentation(input: TaskDetailPresentationInput): {
  actions: TaskDetailPresentationActions;
  model: TaskDetailPresentationModel;
} {
  const {
    active,
    currentTask,
    enabled,
    focusCommentId,
    kanbanTaskState,
    members,
    onOpenChangeFile,
    onTaskNavigate,
    projectPath,
    sessionController,
    taskMap,
    teamName,
  } = input;
  const { isLight } = useTheme();
  const documentVisible = useDocumentVisibility();
  const resourceVisible =
    active && enabled && documentVisible && sessionController.isOriginCurrent();
  const setResourceDemand = useStore((state) => state.setTaskDetailVisibleResourceDemand);
  const { identity: resourceIdentity, surfaceId } = sessionController;
  useEffect(() => {
    setResourceDemand(surfaceId, resourceIdentity, 'detail', resourceVisible);
    return () => setResourceDemand(surfaceId, resourceIdentity, 'detail', false);
  }, [resourceIdentity, resourceVisible, setResourceDemand, surfaceId]);
  const getTaskAttachmentData = useStore((state) => state.getTaskAttachmentData);
  const setTaskNeedsClarification = useStore((state) => state.setTaskNeedsClarification);
  const handoffIntentRef = useRef(false);
  const [rootElement, setRootElement] = useState<HTMLElement | null>(null);
  const [logsRefreshing, setLogsRefreshing] = useState(false);
  const [executionPreviewOnline, setExecutionPreviewOnline] = useState(false);
  const [logsSectionOpen, setLogsSectionOpen] = useState(false);
  const [taskLogActivityActive, setTaskLogActivityActive] = useState(false);
  const [taskLogStreamCount, setTaskLogStreamCount] = useState<number | undefined>(undefined);

  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);
  const avatarMap = useMemo(() => buildMemberAvatarMap(members), [members]);
  const taskChanges = useTaskDetailChanges({
    contextId: sessionController.identity.contextId,
    surfaceId: sessionController.surfaceId,
    isOriginCurrent: sessionController.isOriginCurrent,
    active: resourceVisible,
    enabled,
    onOpenFile: onOpenChangeFile,
    task: currentTask,
    teamName,
  });

  useEffect(() => {
    setLogsRefreshing(false);
    setExecutionPreviewOnline(false);
    setLogsSectionOpen(false);
    setTaskLogActivityActive(false);
    setTaskLogStreamCount(undefined);
  }, [currentTask.id]);

  const saveSubject = useCallback(async () => {
    if (handoffIntentRef.current) return;
    await sessionController.saveSubject();
  }, [sessionController]);
  const saveDescription = useCallback(async () => {
    if (handoffIntentRef.current) return;
    await sessionController.saveDescription();
  }, [sessionController]);

  const unreadCommentIds = useMemo(() => {
    if (!enabled || !active) return EMPTY_UNREAD_COMMENT_IDS;
    const comments = currentTask.comments ?? [];
    if (comments.length === 0) return EMPTY_UNREAD_COMMENT_IDS;
    const identity = {
      contextId: sessionController.identity.contextId,
      teamName,
      taskId: currentTask.id,
    };
    const readIds = getReadCommentIds(identity);
    const cutoff = getLegacyCutoff(identity);
    const unread = new Set<string>();
    for (const comment of comments) {
      if (readIds.has(comment.id)) continue;
      const timestamp = new Date(comment.createdAt).getTime();
      if (cutoff > 0 && timestamp <= cutoff) continue;
      unread.add(comment.id);
    }
    return unread;
  }, [
    active,
    currentTask.comments,
    currentTask.id,
    enabled,
    sessionController.identity.contextId,
    teamName,
  ]);

  const viewport = useViewportCommentRead({
    identity: {
      contextId: sessionController.identity.contextId,
      teamName,
      taskId: currentTask.id,
    },
    enabled: resourceVisible,
    isOriginCurrent: sessionController.isOriginCurrent,
    scrollContainer: rootElement,
  });

  const handleDependencyClick = useCallback<TaskIdClickHandler>(
    (taskId, referencedTeamName, kind = 'canonical'): void => {
      const targetTeamName = referencedTeamName?.trim() || teamName;
      let resolvedId = taskId;
      if (targetTeamName === teamName) {
        const candidate = resolveTaskReferenceCandidate([...taskMap.values()], taskId, kind);
        if (!candidate && kind === 'display') return;
        resolvedId = candidate?.id ?? taskId;
      }
      onTaskNavigate(resolvedId, targetTeamName);
    },
    [onTaskNavigate, taskMap, teamName]
  );

  const commentImageAttachments = useMemo(() => {
    const result: TaskDetailCommentImage[] = [];
    for (const comment of currentTask.comments ?? []) {
      for (const attachment of comment.attachments ?? []) {
        if (isImageMimeType(attachment.mimeType)) {
          result.push({
            attachment,
            commentText: comment.text,
            commentAuthor: comment.author,
          });
        }
      }
    }
    return result;
  }, [currentTask.comments]);

  const sourceAttachmentCount =
    currentTask.sourceMessageId && currentTask.sourceMessage?.attachments?.length
      ? currentTask.sourceMessage.attachments.length
      : 0;
  const attachmentCount =
    (currentTask.attachments?.length ?? 0) + commentImageAttachments.length + sourceAttachmentCount;

  const kanbanColumn = getTeamTaskWorkflowColumn({
    ...currentTask,
    ...(kanbanTaskState?.column ? { kanbanColumn: kanbanTaskState.column } : {}),
  });
  const status = currentTask.status;
  const statusStyle =
    kanbanColumn && KANBAN_COLUMN_DISPLAY[kanbanColumn]
      ? {
          bg: KANBAN_COLUMN_DISPLAY[kanbanColumn].bg,
          text: KANBAN_COLUMN_DISPLAY[kanbanColumn].text,
        }
      : TASK_STATUS_STYLES[status];
  const statusLabel =
    kanbanColumn && KANBAN_COLUMN_DISPLAY[kanbanColumn]
      ? KANBAN_COLUMN_DISPLAY[kanbanColumn].label
      : TASK_STATUS_LABELS[status];
  const isTodo = status === 'pending' && !kanbanColumn;
  const leadName = members.find((member) => isLeadMember(member))?.name ?? 'team-lead';
  const isLeadOwnedTask =
    (currentTask.owner ?? '').trim().toLowerCase() === leadName.trim().toLowerCase() ||
    (currentTask.owner ?? '').trim().toLowerCase() === 'team-lead';

  return {
    model: {
      allowLeadExecutionPreview: true,
      attachmentCount,
      avatarMap,
      canReassign: isTodo && sessionController.isOwner,
      colorMap,
      commentImageAttachments,
      commentReadEnabled: resourceVisible,
      currentTask,
      descriptionDraft: sessionController.session.descriptionDraft,
      editingDescription: sessionController.session.editingDescription,
      editingSubject: sessionController.session.editingSubject,
      focusCommentId,
      isExecutionPreviewOnline: executionPreviewOnline,
      isExecutionRefreshing: logsRefreshing,
      isLight,
      isLeadOwnedTask,
      logsSectionOpen,
      kanbanColumn,
      kanbanTaskState,
      members,
      projectPath,
      registerComment: viewport.registerComment,
      savingDescription: sessionController.session.savedPartRevisionByPart.description !== null,
      savingSubject: sessionController.session.savedPartRevisionByPart.subject !== null,
      status,
      statusLabel,
      statusStyle,
      subjectDraft: sessionController.session.subjectDraft,
      taskLogActivityActive,
      taskLogStreamCount,
      taskChanges: taskChanges.state,
      taskMap,
      teamName,
      unreadCommentIds,
    },
    actions: {
      beginHandoff: () => {
        handoffIntentRef.current = true;
      },
      cancelEditDescription: sessionController.cancelEditDescription,
      cancelEditSubject: sessionController.cancelEditSubject,
      endHandoff: () => {
        handoffIntentRef.current = false;
      },
      flushCommentRead: viewport.flush,
      getTaskAttachmentData,
      handleDependencyClick,
      handleReply: (author, text) =>
        sessionController.setReply({ taskId: currentTask.id, author, text }),
      markClarificationResolved: () => {
        if (sessionController.canEditNow()) {
          void setTaskNeedsClarification(teamName, currentTask.id, null);
        }
      },
      refreshChanges: taskChanges.actions.refresh,
      saveDescription,
      saveSubject,
      setChangesSectionOpen: taskChanges.actions.setOpen,
      setDescriptionDraft: sessionController.setDescriptionDraft,
      setRootElement,
      setSubjectDraft: sessionController.setSubjectDraft,
      setTaskLogActivityActive,
      setTaskLogStreamCount,
      setExecutionPreviewOnline,
      setLogsRefreshing,
      setLogsSectionOpen,
    },
  };
}
