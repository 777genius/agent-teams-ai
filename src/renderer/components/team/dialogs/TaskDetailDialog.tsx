import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { OngoingIndicator } from '@renderer/components/common/OngoingIndicator';
import {
  ImageLightbox,
  LightboxLockProvider,
} from '@renderer/components/team/attachments/ImageLightbox';
import { CollapsibleTeamSection } from '@renderer/components/team/CollapsibleTeamSection';
import { FileIcon } from '@renderer/components/team/editor/FileIcon';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { TaskLogsPanel } from '@renderer/components/team/taskLogs/TaskLogsPanel';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { ExpandableContent } from '@renderer/components/ui/ExpandableContent';
import { Input } from '@renderer/components/ui/input';
import { MemberSelect } from '@renderer/components/ui/MemberSelect';
import { TiptapEditor } from '@renderer/components/ui/tiptap';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import {
  getTeamColorSet,
  getThemedBadge,
  getThemedBorder,
  getThemedText,
} from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { useViewportCommentRead } from '@renderer/hooks/useViewportCommentRead';
import { getLegacyCutoff, getReadCommentIds } from '@renderer/services/commentReadStorage';
import { useStore } from '@renderer/store';
import { isImageMimeType } from '@renderer/utils/attachmentUtils';
import {
  agentAvatarUrl,
  buildMemberAvatarMap,
  buildMemberColorMap,
  displayMemberName,
  KANBAN_COLUMN_DISPLAY,
  REVIEW_STATE_DISPLAY,
  TASK_STATUS_LABELS,
  TASK_STATUS_STYLES,
} from '@renderer/utils/memberHelpers';
import { resolveTaskChangePresenceFromResult } from '@renderer/utils/taskChangePresence';
import {
  buildTaskChangeRequestOptions,
  buildTaskChangeSignature,
  deriveTaskSince,
} from '@renderer/utils/taskChangeRequest';
import { linkifyTaskIdsInMarkdown, parseTaskLinkHref } from '@renderer/utils/taskReferenceUtils';
import { isLeadMember } from '@shared/utils/leadDetection';
import { classifyTaskChangeReviewability } from '@shared/utils/taskChangeReviewability';
import {
  deriveTaskDisplayId,
  formatTaskDisplayLabel,
  taskMatchesRef,
} from '@shared/utils/taskIdentity';
import {
  calculateTaskImplementationDuration,
  formatTaskImplementationDuration,
  shouldShowTaskImplementationDuration,
} from '@shared/utils/taskWorkDuration';
import {
  getTeamTaskWorkflowColumn,
  isTeamTaskFinishedForDependency,
  isTeamTaskNeedsFixActionable,
} from '@shared/utils/teamTaskState';
import { format, formatDistanceToNow } from 'date-fns';
import {
  AlertTriangle,
  AlignLeft,
  ArrowLeftFromLine,
  ArrowRightFromLine,
  Check,
  Clock,
  FileDiff,
  GitCompareArrows,
  HelpCircle,
  History,
  ImageIcon,
  Info,
  Link2,
  Loader2,
  MessageSquare,
  Pencil,
  PenLine,
  RefreshCw,
  ScrollText,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react';

import { SourceMessageAttachments } from '../attachments/SourceMessageAttachments';

import { WorkflowTimeline } from './StatusHistoryTimeline';
import { TaskAttachments } from './TaskAttachments';
import { TaskCommentAwaitingReply } from './TaskCommentAwaitingReply';
import { TaskCommentInput } from './TaskCommentInput';
import { TaskCommentsSection } from './TaskCommentsSection';

import type {
  FileChangeSummary,
  KanbanTaskState,
  ResolvedTeamMember,
  TaskAttachmentMeta,
  TaskChangeReviewability,
  TaskChangeSetV2,
  TeamTaskWithKanban,
} from '@shared/types';

const TASK_CHANGES_AUTO_REFRESH_MS = 20_000;
const TASK_CHANGES_INITIAL_LOAD_DELAY_MS = 1_500;

interface TaskDetailDialogProps {
  open: boolean;
  loading?: boolean;
  variant?: 'team' | 'global';
  task: TeamTaskWithKanban | null;
  teamName: string;
  kanbanTaskState?: KanbanTaskState;
  taskMap: Map<string, TeamTaskWithKanban>;
  members: ResolvedTeamMember[];
  onClose: () => void;
  onScrollToTask?: (taskId: string) => void;
  onOwnerChange?: (taskId: string, owner: string | null) => void;
  onViewChanges?: (taskId: string, filePath?: string) => void;
  onOpenInEditor?: (filePath: string) => void;
  onDeleteTask?: (taskId: string) => void;
  focusCommentId?: string;
  /** Extra content rendered in the dialog header (e.g. "Open team" button). */
  headerExtra?: React.ReactNode;
}

function useTaskImplementationDurationClock(task: TeamTaskWithKanban): {
  duration: ReturnType<typeof calculateTaskImplementationDuration>;
  nowMs: number;
} {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const duration = useMemo(() => calculateTaskImplementationDuration(task, nowMs), [task, nowMs]);

  useEffect(() => {
    if (!duration.hasRunningInterval) return;

    setNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [duration.hasRunningInterval, task.id]);

  return { duration, nowMs };
}

const TaskImplementationDurationBadge = memo(function TaskImplementationDurationBadge({
  task,
}: {
  task: TeamTaskWithKanban;
}): React.JSX.Element | null {
  const { t } = useAppTranslation('team');
  const { duration } = useTaskImplementationDurationClock(task);
  if (!shouldShowTaskImplementationDuration(duration)) {
    return null;
  }

  return (
    <span
      className="inline-flex items-center gap-1 rounded-md bg-[var(--color-bg-secondary)] px-1.5 py-0.5 text-[10px] font-normal leading-none text-[var(--color-text-muted)]"
      title={t('taskDetail.workflow.implementationTimeTitle')}
    >
      <Clock size={10} />
      <span>
        {t('taskDetail.workflow.inProgressTime', {
          duration: formatTaskImplementationDuration(duration.elapsedMs),
        })}
      </span>
    </span>
  );
});

const WorkflowTimelineWithDuration = memo(function WorkflowTimelineWithDuration({
  task,
  events,
  memberColorMap,
}: {
  task: TeamTaskWithKanban;
  events: NonNullable<TeamTaskWithKanban['historyEvents']>;
  memberColorMap: Map<string, string>;
}): React.JSX.Element {
  const { nowMs } = useTaskImplementationDurationClock(task);
  return (
    <WorkflowTimeline
      events={events}
      memberColorMap={memberColorMap}
      implementationDurationTask={task}
      nowMs={nowMs}
    />
  );
});

export const TaskDetailDialog = ({
  open,
  loading = false,
  variant = 'team',
  task,
  teamName,
  kanbanTaskState,
  taskMap,
  members,
  onClose,
  onScrollToTask,
  onOwnerChange,
  onViewChanges,
  onOpenInEditor,
  onDeleteTask,
  focusCommentId,
  headerExtra,
}: TaskDetailDialogProps): React.JSX.Element => {
  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);
  const avatarMap = useMemo(() => buildMemberAvatarMap(members), [members]);
  const { isLight } = useTheme();
  const { t } = useAppTranslation('team');
  const currentTask = task ? (taskMap.get(task.id) ?? task) : null;
  const updateTaskFields = useStore((s) => s.updateTaskFields);
  const recordTaskChangePresence = useStore((s) => s.recordTaskChangePresence);
  const setSelectedTeamTaskChangePresence = useStore((s) => s.setSelectedTeamTaskChangePresence);

  const [logsRefreshing, setLogsRefreshing] = useState(false);
  const [executionPreviewOnline, setExecutionPreviewOnline] = useState(false);
  const [logsSectionOpen, setLogsSectionOpen] = useState(false);
  const [taskLogActivityActive, setTaskLogActivityActive] = useState(false);
  const [taskLogStreamCount, setTaskLogStreamCount] = useState<number | undefined>(undefined);
  const [changesSectionOpen, setChangesSectionOpen] = useState(false);
  const [taskChangesFiles, setTaskChangesFiles] = useState<FileChangeSummary[] | null>(null);
  const [taskChangesWarnings, setTaskChangesWarnings] = useState<string[]>([]);
  const [taskChangesReviewability, setTaskChangesReviewability] =
    useState<TaskChangeReviewability | null>(null);
  const [taskChangesLoading, setTaskChangesLoading] = useState(false);
  const [taskChangesError, setTaskChangesError] = useState<string | null>(null);
  const loadedTaskChangeSummaryKeyRef = useRef<string | null>(null);
  const taskChangesLoadInFlightKeysRef = useRef<Set<string>>(new Set());
  const currentTaskChangeSummaryKeyRef = useRef<string | null>(null);

  // Inline editing: subject
  const [editingSubject, setEditingSubject] = useState(false);
  const [subjectDraft, setSubjectDraft] = useState('');
  const [savingSubject, setSavingSubject] = useState(false);

  // Inline editing: description
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const [savingDescription, setSavingDescription] = useState(false);

  const startEditSubject = useCallback(() => {
    if (!currentTask) return;
    setSubjectDraft(currentTask.subject);
    setEditingSubject(true);
  }, [currentTask]);

  const saveSubject = useCallback(async () => {
    if (!currentTask || savingSubject) return;
    const trimmed = subjectDraft.trim();
    if (!trimmed || trimmed === currentTask.subject) {
      setEditingSubject(false);
      return;
    }
    setSavingSubject(true);
    try {
      await updateTaskFields(teamName, currentTask.id, { subject: trimmed });
      setEditingSubject(false);
    } finally {
      setSavingSubject(false);
    }
  }, [currentTask, subjectDraft, savingSubject, teamName, updateTaskFields]);

  const startEditDescription = useCallback(() => {
    if (!currentTask) return;
    setDescriptionDraft(currentTask.description ?? '');
    setEditingDescription(true);
  }, [currentTask]);

  const saveDescription = useCallback(async () => {
    if (!currentTask || savingDescription) return;
    const newDesc = descriptionDraft.trim();
    if (newDesc === (currentTask.description ?? '')) {
      setEditingDescription(false);
      return;
    }
    setSavingDescription(true);
    try {
      await updateTaskFields(teamName, currentTask.id, { description: newDesc });
      setEditingDescription(false);
    } finally {
      setSavingDescription(false);
    }
  }, [currentTask, descriptionDraft, savingDescription, teamName, updateTaskFields]);

  // Reset editing state on dialog close or task change
  useEffect(() => {
    setEditingSubject(false);
    setEditingDescription(false);
  }, [open, currentTask?.id]);

  useEffect(() => {
    setChangesSectionOpen(false);
    setTaskChangesFiles(null);
    setTaskChangesWarnings([]);
    setTaskChangesReviewability(null);
    setTaskChangesLoading(false);
    setTaskChangesError(null);
    setLogsRefreshing(false);
    setExecutionPreviewOnline(false);
    setLogsSectionOpen(false);
    setTaskLogActivityActive(false);
    setTaskLogStreamCount(undefined);
  }, [open, currentTask?.id]);

  const [replyTo, setReplyTo] = useState<{
    taskId: string;
    author: string;
    text: string;
  } | null>(null);

  // Track whether a lightbox is open to block Dialog dismiss events.
  // Using a ref for synchronous reads (no render cycle delay) + a stable
  // callback so context consumers never cause re-renders.
  const lightboxOpenRef = useRef(false);
  const setLightboxOpen = useCallback((isOpen: boolean) => {
    lightboxOpenRef.current = isOpen;
  }, []);

  // Callback-ref + useState for the scrollable DialogContent — needed as IO root
  // for viewport-based read tracking. Using useState (not useRef) ensures that
  // useViewportObserver recreates the IntersectionObserver when the portal mounts
  // and the DOM element becomes available.
  const [dialogContentEl, setDialogContentEl] = useState<HTMLDivElement | null>(null);
  const handleReply = useCallback(
    (author: string, text: string) => {
      if (currentTask) setReplyTo({ taskId: currentTask.id, author, text });
    },
    [currentTask]
  );
  const clearReply = useCallback(() => setReplyTo(null), []);

  const effectiveReplyTo =
    replyTo && replyTo.taskId === currentTask?.id
      ? { author: replyTo.author, text: replyTo.text }
      : null;

  // Snapshot unread comment IDs when dialog opens — these will show blue dots.
  // Dots persist for the duration of the dialog session; markAsRead happens
  // per-comment via IntersectionObserver inside TaskCommentsSection.
  const unreadSnapshotRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!open || !currentTask) {
      unreadSnapshotRef.current = new Set();
      return;
    }
    const comments = currentTask.comments ?? [];
    if (comments.length === 0) {
      unreadSnapshotRef.current = new Set();
      return;
    }
    const readIds = getReadCommentIds(teamName, currentTask.id);
    const cutoff = getLegacyCutoff(teamName, currentTask.id);
    const unread = new Set<string>();
    for (const c of comments) {
      if (readIds.has(c.id)) continue;
      const ts = new Date(c.createdAt).getTime();
      if (cutoff > 0 && ts <= cutoff) continue;
      unread.add(c.id);
    }
    unreadSnapshotRef.current = unread;
  }, [open, teamName, currentTask?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- Snapshot should reset only when the dialog opens or task identity changes.

  // Viewport-based comment read tracking (replaces mark-all-on-mount)
  const { registerComment, flush: flushCommentRead } = useViewportCommentRead({
    teamName,
    taskId: currentTask?.id ?? '',
    scrollContainer: dialogContentEl,
  });

  const handleClose = useCallback(() => {
    flushCommentRead();
    setReplyTo(null);
    onClose();
  }, [onClose, flushCommentRead]);

  // Collect image attachments from comments for the Attachments section
  const commentImageAttachments = useMemo(() => {
    const comments = currentTask?.comments ?? [];
    const result: { attachment: TaskAttachmentMeta; commentText: string; commentAuthor: string }[] =
      [];
    for (const c of comments) {
      if (!c.attachments) continue;
      for (const att of c.attachments) {
        if (isImageMimeType(att.mimeType)) {
          result.push({ attachment: att, commentText: c.text, commentAuthor: c.author });
        }
      }
    }
    return result;
  }, [currentTask?.comments]);

  const sourceAttachmentCount =
    currentTask?.sourceMessageId && currentTask?.sourceMessage?.attachments?.length
      ? currentTask.sourceMessage.attachments.length
      : 0;
  const attachmentCount =
    (currentTask?.attachments?.length ?? 0) +
    commentImageAttachments.length +
    sourceAttachmentCount;

  // Changes is the explicit lazy-load entry point. Keep it visible for all team tasks,
  // including old/pending tasks that may resolve to an empty result.
  const canShowTaskChanges = Boolean(currentTask);
  const taskSince = useMemo(() => deriveTaskSince(currentTask), [currentTask]);
  const taskChangeRequestOptions = useMemo(
    () => (currentTask ? buildTaskChangeRequestOptions(currentTask) : null),
    [currentTask]
  );
  const taskChangeRequestSignature = useMemo(
    () => (taskChangeRequestOptions ? buildTaskChangeSignature(taskChangeRequestOptions) : null),
    [taskChangeRequestOptions]
  );
  const currentTaskChangeSummaryKey = useMemo(
    () =>
      currentTask
        ? `${teamName}:${currentTask.id}:${taskChangeRequestSignature ?? 'default'}`
        : null,
    [currentTask, teamName, taskChangeRequestSignature]
  );
  const taskChangeSummaryOptions = useMemo(
    () =>
      currentTask
        ? buildTaskChangeRequestOptions(currentTask, {
            since: taskSince,
            summaryOnly: true,
          })
        : null,
    [currentTask, taskSince]
  );
  const setTaskNeedsClarification = useStore((s) => s.setTaskNeedsClarification);

  useEffect(() => {
    currentTaskChangeSummaryKeyRef.current = currentTaskChangeSummaryKey;
  }, [currentTaskChangeSummaryKey]);

  const loadTaskChangeSummary = useCallback(
    async (forceFresh = false): Promise<TaskChangeSetV2 | null> => {
      if (!currentTask || !taskChangeSummaryOptions || variant !== 'team' || !canShowTaskChanges) {
        return null;
      }
      const data = await api.review.getTaskChanges(teamName, currentTask.id, {
        ...taskChangeSummaryOptions,
        forceFresh,
      });
      return data;
    },
    [canShowTaskChanges, currentTask, taskChangeSummaryOptions, teamName, variant]
  );

  const syncTaskChangeSummaryResult = useCallback(
    (data: TaskChangeSetV2 | null) => {
      setTaskChangesFiles(data?.files ?? null);
      const status = data ? classifyTaskChangeReviewability(data) : null;
      const diagnosticMessages =
        status && status.diagnostics.length > 0
          ? status.diagnostics.map((diagnostic) => diagnostic.message)
          : (data?.warnings ?? []);
      setTaskChangesWarnings([
        ...new Set(diagnosticMessages.filter((message) => message.trim().length > 0)),
      ]);
      setTaskChangesReviewability(status?.reviewability ?? null);
      const nextPresence = data ? resolveTaskChangePresenceFromResult(data) : null;
      if (currentTask && taskChangeRequestOptions) {
        recordTaskChangePresence(teamName, currentTask.id, taskChangeRequestOptions, nextPresence);
      }
      if (currentTask) {
        setSelectedTeamTaskChangePresence(teamName, currentTask.id, nextPresence ?? 'unknown');
      }
    },
    [
      currentTask,
      recordTaskChangePresence,
      setSelectedTeamTaskChangePresence,
      taskChangeRequestOptions,
      teamName,
    ]
  );

  const requestTaskChangeSummary = useCallback(
    async ({
      forceFresh = false,
      showSpinner = false,
      preserveFilesOnError = false,
    }: {
      forceFresh?: boolean;
      showSpinner?: boolean;
      preserveFilesOnError?: boolean;
    } = {}): Promise<void> => {
      const requestKey = currentTaskChangeSummaryKeyRef.current;
      if (!requestKey || !currentTask || variant !== 'team' || !canShowTaskChanges) return;
      if (taskChangesLoadInFlightKeysRef.current.has(requestKey)) return;

      taskChangesLoadInFlightKeysRef.current.add(requestKey);
      if (showSpinner) {
        setTaskChangesLoading(true);
      }
      setTaskChangesError(null);

      try {
        const data = await loadTaskChangeSummary(forceFresh);
        if (currentTaskChangeSummaryKeyRef.current !== requestKey) {
          return;
        }
        syncTaskChangeSummaryResult(data);
      } catch (error) {
        if (currentTaskChangeSummaryKeyRef.current !== requestKey) {
          return;
        }
        if (!preserveFilesOnError) {
          setTaskChangesFiles(null);
          setTaskChangesWarnings([]);
          setTaskChangesReviewability(null);
        }
        setTaskChangesError(
          error instanceof Error ? error.message : t('taskDetail.changes.loadFailed')
        );
      } finally {
        taskChangesLoadInFlightKeysRef.current.delete(requestKey);
        if (showSpinner && currentTaskChangeSummaryKeyRef.current === requestKey) {
          setTaskChangesLoading(false);
        }
      }
    },
    [
      canShowTaskChanges,
      currentTask,
      loadTaskChangeSummary,
      syncTaskChangeSummaryResult,
      t,
      variant,
    ]
  );

  useEffect(() => {
    if (variant !== 'team') return;
    if (!open || !currentTask || !canShowTaskChanges || !changesSectionOpen) return;

    const summaryKey = currentTaskChangeSummaryKey;
    if (loadedTaskChangeSummaryKeyRef.current === summaryKey) {
      return;
    }
    if (taskChangesFiles !== null) {
      loadedTaskChangeSummaryKeyRef.current = summaryKey;
      return;
    }
    loadedTaskChangeSummaryKeyRef.current = summaryKey;

    // The manual open path only reaches this branch when no summary is cached yet.
    void requestTaskChangeSummary({
      forceFresh: false,
      showSpinner: true,
      preserveFilesOnError: false,
    });
  }, [
    changesSectionOpen,
    open,
    currentTask,
    canShowTaskChanges,
    teamName,
    currentTaskChangeSummaryKey,
    taskChangeRequestSignature,
    variant,
    requestTaskChangeSummary,
    taskChangesFiles,
  ]);

  useEffect(() => {
    if (variant !== 'team') return;
    if (!open || !currentTask || !canShowTaskChanges || changesSectionOpen) return;
    if (!currentTaskChangeSummaryKey || taskChangesFiles !== null) return;

    const summaryKey = currentTaskChangeSummaryKey;
    if (loadedTaskChangeSummaryKeyRef.current === summaryKey) {
      return;
    }

    const timer = window.setTimeout(() => {
      if (currentTaskChangeSummaryKeyRef.current !== summaryKey) {
        return;
      }
      void requestTaskChangeSummary({
        forceFresh: false,
        showSpinner: true,
        preserveFilesOnError: true,
      });
    }, TASK_CHANGES_INITIAL_LOAD_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    changesSectionOpen,
    open,
    currentTask,
    canShowTaskChanges,
    currentTaskChangeSummaryKey,
    requestTaskChangeSummary,
    taskChangesFiles,
    variant,
  ]);

  useEffect(() => {
    if (!open || !changesSectionOpen) {
      loadedTaskChangeSummaryKeyRef.current = null;
    }
  }, [open, changesSectionOpen]);

  useEffect(() => {
    if (variant !== 'team') return;
    if (!open || !currentTask || !canShowTaskChanges || !changesSectionOpen) {
      return;
    }

    const timer = window.setInterval(() => {
      void requestTaskChangeSummary({
        forceFresh: true,
        showSpinner: false,
        preserveFilesOnError: true,
      });
    }, TASK_CHANGES_AUTO_REFRESH_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [
    changesSectionOpen,
    open,
    currentTask,
    canShowTaskChanges,
    requestTaskChangeSummary,
    variant,
  ]);

  const handleRefreshChanges = useCallback(() => {
    void requestTaskChangeSummary({
      forceFresh: true,
      showSpinner: true,
      preserveFilesOnError: false,
    });
  }, [requestTaskChangeSummary]);

  const handleTaskChangeFileOpen = useCallback(
    (filePath: string): void => {
      if (!currentTask || !onViewChanges) return;
      handleClose();
      onViewChanges(currentTask.id, filePath);
    },
    [currentTask, handleClose, onViewChanges]
  );

  const handleDependencyClick = (taskId: string): void => {
    // Resolve short displayId (e.g. "8ce74455") to full UUID via taskMap,
    // since kanban cards use the full UUID in data-task-id.
    let resolvedId = taskId;
    if (!taskMap.has(taskId)) {
      for (const [fullId, t] of taskMap) {
        if (taskMatchesRef(t, taskId)) {
          resolvedId = fullId;
          break;
        }
      }
    }
    handleClose();
    onScrollToTask?.(resolvedId);
  };

  const handleChangesSectionOpenChange = useCallback((isOpen: boolean): void => {
    setChangesSectionOpen(isOpen);
  }, []);

  const taskChangesBadge = !taskChangesLoading
    ? taskChangesFiles && taskChangesFiles.length > 0
      ? taskChangesFiles.length
      : taskChangesFiles && taskChangesWarnings.length > 0
        ? taskChangesReviewability === 'attention_required'
          ? t('taskDetail.changes.badges.attention')
          : taskChangesReviewability === 'diagnostic_only'
            ? t('taskDetail.changes.badges.noSafeDiff')
            : undefined
        : undefined
    : undefined;

  if (loading) {
    return (
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{t('taskDetail.loading.title')}</DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            <Loader2 className="size-4 animate-spin" />
            <span>{t('taskDetail.loading.fetchingTeamData')}</span>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (!currentTask) {
    return (
      <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{t('taskDetail.notFound')}</DialogTitle>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

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
  const blockedByIds = currentTask.blockedBy?.filter((id) => id.length > 0) ?? [];
  const blocksIds = currentTask.blocks?.filter((id) => id.length > 0) ?? [];
  const relatedIds = (currentTask.related ?? []).filter(
    (id) => id.length > 0 && id !== currentTask.id
  );
  const relatedByIds = Array.from(taskMap.values())
    .filter(
      (t) =>
        t.id !== currentTask.id && Array.isArray(t.related) && t.related.includes(currentTask.id)
    )
    .map((t) => t.id);
  const isTodo = status === 'pending' && !kanbanColumn;
  const canReassign = isTodo && onOwnerChange;
  const leadName = members.find((m) => isLeadMember(m))?.name ?? 'team-lead';
  const isLeadOwnedTask =
    (currentTask.owner ?? '').trim().toLowerCase() === leadName.trim().toLowerCase() ||
    (currentTask.owner ?? '').trim().toLowerCase() === 'team-lead';
  const allowLeadExecutionPreview = true;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && lightboxOpenRef.current) return;
        if (!v) handleClose();
      }}
    >
      <DialogContent
        ref={setDialogContentEl}
        className="sm:min-w-[500px] sm:max-w-4xl"
        onInteractOutside={(e) => {
          if (lightboxOpenRef.current) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (lightboxOpenRef.current) e.preventDefault();
        }}
      >
        <LightboxLockProvider value={setLightboxOpen}>
          <DialogHeader>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
                {formatTaskDisplayLabel(currentTask)}
              </Badge>
              {(kanbanColumn === 'approved' || kanbanColumn === 'review') &&
              currentTask.reviewer &&
              currentTask.reviewer !== 'user' ? (
                (() => {
                  const reviewerColor = colorMap.get(currentTask.reviewer);
                  const colors =
                    kanbanColumn === 'review'
                      ? getTeamColorSet('blue')
                      : getTeamColorSet(reviewerColor ?? '');
                  const reviewerBadgeStyle = {
                    backgroundColor: getThemedBadge(colors, isLight),
                    color: getThemedText(colors, isLight),
                    borderTop: `1px solid ${getThemedBorder(colors, isLight)}40`,
                    borderRight: `1px solid ${getThemedBorder(colors, isLight)}40`,
                    borderBottom: `1px solid ${getThemedBorder(colors, isLight)}40`,
                  };
                  const lastReviewEvent = currentTask.historyEvents
                    ?.filter((e) =>
                      kanbanColumn === 'approved'
                        ? e.type === 'review_approved'
                        : e.type === 'review_requested' || e.type === 'review_started'
                    )
                    .at(-1);
                  const reviewDate = lastReviewEvent
                    ? new Date(lastReviewEvent.timestamp)
                    : undefined;
                  const reviewTimeLabel =
                    reviewDate && !isNaN(reviewDate.getTime())
                      ? Date.now() - reviewDate.getTime() < 24 * 60 * 60 * 1000
                        ? formatDistanceToNow(reviewDate, { addSuffix: true })
                        : format(reviewDate, 'MMM d, yyyy HH:mm')
                      : undefined;
                  const badge = (
                    <span className="inline-flex items-stretch">
                      <span
                        className={`inline-flex items-center rounded-l-full px-2 py-0.5 text-[10px] font-medium ${statusStyle.bg} ${statusStyle.text}`}
                      >
                        {statusLabel}
                      </span>
                      <span
                        className="inline-flex items-center gap-1 rounded-r-full px-1.5 py-0.5 text-[10px] font-medium"
                        style={reviewerBadgeStyle}
                      >
                        <img
                          src={
                            avatarMap.get(currentTask.reviewer) ??
                            agentAvatarUrl(currentTask.reviewer, 18)
                          }
                          alt=""
                          className="size-4 shrink-0 rounded-full bg-[var(--color-surface-raised)]"
                          loading="lazy"
                        />
                        {displayMemberName(currentTask.reviewer)}
                      </span>
                    </span>
                  );
                  return reviewTimeLabel ? (
                    <Tooltip>
                      <TooltipTrigger asChild>{badge}</TooltipTrigger>
                      <TooltipContent side="bottom">{reviewTimeLabel}</TooltipContent>
                    </Tooltip>
                  ) : (
                    badge
                  );
                })()
              ) : (
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${statusStyle.bg} ${statusStyle.text}`}
                >
                  {statusLabel}
                </span>
              )}
              {isTeamTaskNeedsFixActionable(currentTask) ? (
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${REVIEW_STATE_DISPLAY.needsFix.bg} ${REVIEW_STATE_DISPLAY.needsFix.text}`}
                >
                  {REVIEW_STATE_DISPLAY.needsFix.label}
                </span>
              ) : null}
              {headerExtra ? <div className="ml-auto mr-4">{headerExtra}</div> : null}
            </div>
            {editingSubject ? (
              <div className="flex items-center gap-2">
                <Input
                  autoFocus
                  value={subjectDraft}
                  onChange={(e) => setSubjectDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.stopPropagation();
                      void saveSubject();
                    }
                    if (e.key === 'Escape') setEditingSubject(false);
                  }}
                  onBlur={() => void saveSubject()}
                  disabled={savingSubject}
                  className="h-8 text-base"
                />
                {savingSubject ? <Loader2 size={14} className="animate-spin" /> : null}
              </div>
            ) : (
              <DialogTitle
                className="group flex cursor-pointer items-center gap-1.5 text-base hover:text-[var(--color-text)]"
                onClick={startEditSubject}
              >
                {currentTask.subject}
                <Pencil
                  size={12}
                  className="shrink-0 text-[var(--color-text-muted)] opacity-0 transition-opacity group-hover:opacity-100"
                />
              </DialogTitle>
            )}
            {currentTask.activeForm ? (
              <DialogDescription>{currentTask.activeForm}</DialogDescription>
            ) : null}
          </DialogHeader>

          {/* Metadata */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <div className="flex min-w-0 items-center gap-2">
              {canReassign ? (
                <MemberSelect
                  members={members}
                  value={currentTask.owner ?? null}
                  onChange={(v) => onOwnerChange(currentTask.id, v)}
                  allowUnassigned
                  size="sm"
                  className="min-w-[160px]"
                />
              ) : currentTask.owner ? (
                <MemberBadge
                  name={currentTask.owner}
                  color={colorMap.get(currentTask.owner)}
                  size="md"
                />
              ) : (
                <span className="text-xs italic text-[var(--color-text-muted)]">
                  {t('taskDetail.unassigned')}
                </span>
              )}
            </div>
            {currentTask.createdBy ? (
              <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
                <PenLine size={12} />
                <span className="text-[var(--color-text-secondary)]">{currentTask.createdBy}</span>
              </div>
            ) : null}
            {currentTask.createdAt
              ? (() => {
                  const date = new Date(currentTask.createdAt);
                  return isNaN(date.getTime()) ? null : (
                    <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
                      <Clock size={12} />
                      <span className="text-[var(--color-text-secondary)]">
                        {formatDistanceToNow(date, { addSuffix: true })}
                      </span>
                    </div>
                  );
                })()
              : null}
            {onDeleteTask && currentTask ? (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-6 gap-1 text-xs text-[var(--color-text-muted)] hover:text-red-400"
                onClick={() => {
                  onDeleteTask(currentTask.id);
                  handleClose();
                }}
              >
                <Trash2 size={12} />
                {t('taskDetail.actions.delete')}
              </Button>
            ) : null}
          </div>

          {/* Clarification banner */}
          {currentTask.needsClarification ? (
            <div
              className={`flex items-center justify-between rounded-md px-3 py-2 text-xs ${
                currentTask.needsClarification === 'user'
                  ? 'border border-red-500/20 bg-red-500/10 text-red-400'
                  : 'border border-blue-500/20 bg-blue-500/10 text-blue-400'
              }`}
            >
              <span className="flex items-center gap-1.5">
                <HelpCircle size={14} />
                {currentTask.needsClarification === 'user'
                  ? t('taskDetail.clarification.awaitingUser')
                  : t('taskDetail.clarification.awaitingLead')}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  void setTaskNeedsClarification(teamName, currentTask.id, null);
                }}
              >
                {t('taskDetail.actions.markResolved')}
              </Button>
            </div>
          ) : null}

          {/* Related tasks & Dependencies — 2-column grid */}
          {(relatedIds.length > 0 ||
            relatedByIds.length > 0 ||
            blockedByIds.length > 0 ||
            blocksIds.length > 0) && (
            <div className="space-y-2">
              {/* "Related tasks" header — only if links exist */}
              {(relatedIds.length > 0 || relatedByIds.length > 0) && (
                <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-muted)]">
                  <Link2 size={12} />
                  {t('taskDetail.related.title')}
                </div>
              )}

              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                {relatedIds.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {t('taskDetail.related.links')}
                    </span>
                    {relatedIds.map((id) => {
                      const depTask = taskMap.get(id);
                      const label = depTask
                        ? `${formatTaskDisplayLabel(depTask)}: ${depTask.subject}`
                        : `#${deriveTaskDisplayId(id)}`;
                      return (
                        <Tooltip key={`related:${currentTask.id}:${id}`}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="inline-flex items-center rounded bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-medium text-purple-300 transition-colors hover:bg-purple-500/25"
                              onClick={() => handleDependencyClick(id)}
                            >
                              {depTask
                                ? formatTaskDisplayLabel(depTask)
                                : `#${deriveTaskDisplayId(id)}`}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">{label}</TooltipContent>
                        </Tooltip>
                      );
                    })}
                  </div>
                ) : null}

                {relatedByIds.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {t('taskDetail.related.linkedFrom')}
                    </span>
                    {relatedByIds.map((id) => {
                      const depTask = taskMap.get(id);
                      const label = depTask
                        ? `${formatTaskDisplayLabel(depTask)}: ${depTask.subject}`
                        : `#${deriveTaskDisplayId(id)}`;
                      return (
                        <Tooltip key={`related-by:${currentTask.id}:${id}`}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="inline-flex items-center rounded bg-fuchsia-500/15 px-1.5 py-0.5 text-[10px] font-medium text-fuchsia-300 transition-colors hover:bg-fuchsia-500/25"
                              onClick={() => handleDependencyClick(id)}
                            >
                              {depTask
                                ? formatTaskDisplayLabel(depTask)
                                : `#${deriveTaskDisplayId(id)}`}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">{label}</TooltipContent>
                        </Tooltip>
                      );
                    })}
                  </div>
                ) : null}

                {blockedByIds.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center gap-0.5 text-xs text-yellow-700 dark:text-yellow-300">
                      <ArrowLeftFromLine size={12} />
                      {t('taskDetail.related.blockedBy')}
                    </span>
                    {blockedByIds.map((id) => {
                      const depTask = taskMap.get(id);
                      const isCompleted = depTask
                        ? isTeamTaskFinishedForDependency(depTask)
                        : false;
                      const label = depTask
                        ? `${formatTaskDisplayLabel(depTask)}: ${depTask.subject}`
                        : `#${deriveTaskDisplayId(id)}`;
                      return (
                        <Tooltip key={id}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                                isCompleted
                                  ? 'bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-400'
                                  : 'bg-yellow-500/15 text-yellow-700 hover:bg-yellow-500/25 dark:text-yellow-300'
                              } cursor-pointer`}
                              onClick={() => handleDependencyClick(id)}
                            >
                              {depTask
                                ? formatTaskDisplayLabel(depTask)
                                : `#${deriveTaskDisplayId(id)}`}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">{label}</TooltipContent>
                        </Tooltip>
                      );
                    })}
                  </div>
                ) : null}

                {blocksIds.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center gap-0.5 text-xs text-blue-600 dark:text-blue-400">
                      <ArrowRightFromLine size={12} />
                      {t('taskDetail.related.blocks')}
                    </span>
                    {blocksIds.map((id) => {
                      const depTask = taskMap.get(id);
                      const isCompleted = depTask
                        ? isTeamTaskFinishedForDependency(depTask)
                        : false;
                      const label = depTask
                        ? `${formatTaskDisplayLabel(depTask)}: ${depTask.subject}`
                        : `#${deriveTaskDisplayId(id)}`;
                      return (
                        <Tooltip key={id}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                                isCompleted
                                  ? 'bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-400'
                                  : 'bg-blue-500/15 text-blue-600 hover:bg-blue-500/25 dark:text-blue-400'
                              } cursor-pointer`}
                              onClick={() => handleDependencyClick(id)}
                            >
                              {depTask
                                ? formatTaskDisplayLabel(depTask)
                                : `#${deriveTaskDisplayId(id)}`}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">{label}</TooltipContent>
                        </Tooltip>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          )}

          {/* Sections container with uniform spacing */}
          <div className="min-w-0 space-y-1">
            {/* Description */}
            <CollapsibleTeamSection
              title={t('taskDetail.sections.description')}
              icon={<AlignLeft size={14} />}
              contentClassName="pl-2.5"
              headerClassName="-mx-6 w-[calc(100%+3rem)]"
              headerContentClassName="pl-6"
              defaultOpen
            >
              {editingDescription ? (
                <div className="space-y-2">
                  <TiptapEditor
                    content={descriptionDraft}
                    onChange={setDescriptionDraft}
                    placeholder={t('taskDetail.description.placeholder')}
                    autoFocus
                    minHeight="120px"
                    maxHeight="200px"
                    toolbar
                    disabled={savingDescription}
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      className="h-7 text-xs"
                      disabled={savingDescription}
                      onClick={() => void saveDescription()}
                    >
                      {savingDescription ? (
                        <Loader2 size={12} className="mr-1 animate-spin" />
                      ) : (
                        <Check size={12} className="mr-1" />
                      )}
                      {t('taskDetail.actions.save')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={savingDescription}
                      onClick={() => setEditingDescription(false)}
                    >
                      <X size={12} className="mr-1" />
                      {t('taskDetail.actions.cancel')}
                    </Button>
                  </div>
                </div>
              ) : currentTask.description ? (
                <div
                  className="group relative"
                  onClickCapture={
                    onScrollToTask
                      ? (e) => {
                          const link = (e.target as HTMLElement).closest<HTMLAnchorElement>(
                            'a[href^="task://"]'
                          );
                          if (link) {
                            e.preventDefault();
                            e.stopPropagation();
                            const href = link.getAttribute('href');
                            const parsed = href ? parseTaskLinkHref(href) : null;
                            if (parsed?.taskId) handleDependencyClick(parsed.taskId);
                          }
                        }
                      : undefined
                  }
                >
                  <ExpandableContent collapsedHeight={200}>
                    <MarkdownViewer
                      content={linkifyTaskIdsInMarkdown(
                        currentTask.description,
                        currentTask.descriptionTaskRefs
                      )}
                      maxHeight="max-h-none"
                      bare
                    />
                  </ExpandableContent>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="absolute right-0 top-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)] group-hover:opacity-100"
                        onClick={startEditDescription}
                      >
                        <Pencil size={12} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">{t('taskDetail.description.edit')}</TooltipContent>
                  </Tooltip>
                </div>
              ) : (
                <button
                  type="button"
                  className="text-xs text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
                  onClick={startEditDescription}
                >
                  {t('taskDetail.description.add')}
                </button>
              )}
            </CollapsibleTeamSection>

            {/* Attachments */}
            <CollapsibleTeamSection
              title={t('taskDetail.sections.attachments')}
              icon={<ImageIcon size={14} />}
              badge={attachmentCount}
              contentClassName="pl-2.5"
              headerClassName="-mx-6 w-[calc(100%+3rem)]"
              headerContentClassName="pl-6"
              defaultOpen={attachmentCount > 0}
            >
              {currentTask.sourceMessageId && currentTask.sourceMessage ? (
                <SourceMessageAttachments
                  teamName={teamName}
                  sourceMessageId={currentTask.sourceMessageId}
                  sourceMessage={currentTask.sourceMessage}
                />
              ) : null}
              <TaskAttachments
                teamName={teamName}
                taskId={currentTask.id}
                attachments={currentTask.attachments ?? []}
              />
              {commentImageAttachments.length > 0 ? (
                <CommentImagesGrid
                  items={commentImageAttachments}
                  teamName={teamName}
                  taskId={currentTask.id}
                />
              ) : null}
            </CollapsibleTeamSection>

            {/* Changes */}
            {variant === 'team' && canShowTaskChanges ? (
              <CollapsibleTeamSection
                key={`task-changes:${currentTask.id}`}
                title={t('taskDetail.sections.changes')}
                icon={<FileDiff size={14} />}
                badge={taskChangesBadge}
                headerExtra={
                  taskChangesLoading && !changesSectionOpen ? (
                    <Loader2
                      size={12}
                      className="pointer-events-none animate-spin text-[var(--color-text-muted)]"
                    />
                  ) : changesSectionOpen ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="pointer-events-auto rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-section-hover)] hover:text-[var(--color-text)] disabled:opacity-50"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRefreshChanges();
                          }}
                          disabled={taskChangesLoading}
                          aria-label={t('taskDetail.changes.refresh')}
                        >
                          <RefreshCw
                            size={12}
                            className={taskChangesLoading ? 'animate-spin' : undefined}
                          />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        {t('taskDetail.changes.refreshShort')}
                      </TooltipContent>
                    </Tooltip>
                  ) : null
                }
                contentClassName="pl-2.5"
                headerClassName="-mx-6 w-[calc(100%+3rem)]"
                headerContentClassName="pl-6"
                defaultOpen={false}
                onOpenChange={handleChangesSectionOpenChange}
              >
                {taskChangesLoading && (!taskChangesFiles || taskChangesFiles.length === 0) ? (
                  <div className="flex items-center gap-2 py-2 text-xs text-[var(--color-text-muted)]">
                    <Loader2 size={14} className="animate-spin" />
                    {t('taskDetail.changes.loading')}
                  </div>
                ) : taskChangesError ? (
                  <p className="text-xs text-red-400">{taskChangesError}</p>
                ) : taskChangesFiles ? (
                  <div className="space-y-2">
                    {taskChangesWarnings.length > 0 ? (
                      <div
                        className={`space-y-1 rounded-md border px-2 py-1.5 ${
                          taskChangesReviewability === 'attention_required'
                            ? 'border-amber-500/20 bg-amber-500/10'
                            : 'border-[var(--color-border)] bg-[var(--color-bg-secondary)]'
                        }`}
                      >
                        {taskChangesWarnings.slice(0, 2).map((warning) => (
                          <div
                            key={warning}
                            className={`flex items-center gap-2 text-xs ${
                              taskChangesReviewability === 'attention_required'
                                ? 'text-[var(--step-warning-text)]'
                                : 'text-[var(--color-text-muted)]'
                            }`}
                          >
                            {taskChangesReviewability === 'attention_required' ? (
                              <AlertTriangle size={13} className="shrink-0" />
                            ) : (
                              <Info size={13} className="shrink-0" />
                            )}
                            <span className="min-w-0 truncate">{warning}</span>
                          </div>
                        ))}
                        {taskChangesWarnings.length > 2 ? (
                          <p className="text-[10px] text-[var(--color-text-muted)]">
                            {t('taskDetail.changes.moreDiagnostics', {
                              count: taskChangesWarnings.length - 2,
                            })}
                          </p>
                        ) : null}
                      </div>
                    ) : null}

                    {taskChangesFiles.length > 0 ? (
                      <div className="max-h-[200px] space-y-0.5 overflow-y-auto">
                        {taskChangesFiles.map((file) => (
                          <div
                            key={file.filePath}
                            role={onViewChanges ? 'button' : undefined}
                            tabIndex={onViewChanges ? 0 : undefined}
                            title={file.relativePath}
                            className={`group flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-surface-raised)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-emphasis)] ${
                              onViewChanges ? 'cursor-pointer' : ''
                            }`}
                            onClick={
                              onViewChanges
                                ? () => handleTaskChangeFileOpen(file.filePath)
                                : undefined
                            }
                            onKeyDown={
                              onViewChanges
                                ? (event) => {
                                    if (event.target !== event.currentTarget) return;
                                    if (event.key === 'Enter' || event.key === ' ') {
                                      event.preventDefault();
                                      handleTaskChangeFileOpen(file.filePath);
                                    }
                                  }
                                : undefined
                            }
                          >
                            <FileIcon
                              fileName={file.relativePath.split(/[\\/]/).pop() ?? file.relativePath}
                              className="size-3.5"
                            />
                            <span className="min-w-0 flex-1 truncate text-left font-mono text-[var(--color-text-secondary)] transition-colors group-hover:text-[var(--color-text)]">
                              {file.relativePath}
                            </span>
                            <span className="flex shrink-0 items-center gap-1.5">
                              {file.linesAdded > 0 ? (
                                <span className="text-emerald-400">+{file.linesAdded}</span>
                              ) : null}
                              {file.linesRemoved > 0 ? (
                                <span className="text-red-400">-{file.linesRemoved}</span>
                              ) : null}
                            </span>
                            <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                              {onViewChanges ? (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <button
                                      type="button"
                                      className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-border-emphasis)] hover:text-[var(--color-text)]"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        handleTaskChangeFileOpen(file.filePath);
                                      }}
                                    >
                                      <GitCompareArrows size={13} />
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent side="top">
                                    {t('taskDetail.changes.reviewDiff')}
                                  </TooltipContent>
                                </Tooltip>
                              ) : null}
                              {onOpenInEditor ? (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <button
                                      type="button"
                                      className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-border-emphasis)] hover:text-[var(--color-text)]"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        onOpenInEditor(file.filePath);
                                      }}
                                    >
                                      <SquarePen size={13} />
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent side="top">
                                    {t('taskDetail.changes.openInEditor')}
                                  </TooltipContent>
                                </Tooltip>
                              ) : null}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : changesSectionOpen ? (
                      <p className="text-xs text-[var(--color-text-muted)]">
                        {taskChangesWarnings.length > 0
                          ? taskChangesReviewability === 'attention_required'
                            ? t('taskDetail.changes.empty.noReviewableChangesRecovered')
                            : taskChangesReviewability === 'diagnostic_only'
                              ? t('taskDetail.changes.empty.noSafeDiffAvailable')
                              : t('taskDetail.changes.empty.noFileChangesRecordedYet')
                          : t('taskDetail.changes.empty.noFileChangesRecorded')}
                      </p>
                    ) : null}
                  </div>
                ) : changesSectionOpen ? (
                  <p className="text-xs text-[var(--color-text-muted)]">
                    {t('taskDetail.changes.empty.noFileChangesRecorded')}
                  </p>
                ) : null}
              </CollapsibleTeamSection>
            ) : null}

            {/* Execution Logs — sessions that reference this task */}
            {variant === 'team' ? (
              <CollapsibleTeamSection
                key={`task-logs:${currentTask.id}`}
                title={t('taskDetail.sections.taskLogs')}
                icon={<ScrollText size={14} />}
                badge={taskLogStreamCount}
                headerExtra={
                  taskLogActivityActive ? (
                    <OngoingIndicator size="sm" title={t('taskDetail.logs.newArriving')} />
                  ) : null
                }
                contentClassName="pl-2.5 overflow-visible"
                headerClassName="-mx-6 w-[calc(100%+3rem)]"
                headerContentClassName="pl-6"
                defaultOpen={false}
                onOpenChange={setLogsSectionOpen}
                keepMounted
              >
                <div className="min-w-0">
                  <TaskLogsPanel
                    teamName={teamName}
                    task={currentTask}
                    isOpen={logsSectionOpen}
                    taskSince={taskSince}
                    isExecutionRefreshing={logsRefreshing}
                    isExecutionPreviewOnline={executionPreviewOnline}
                    onRefreshingChange={setLogsRefreshing}
                    showSubagentPreview={Boolean(currentTask.owner) && !isLeadOwnedTask}
                    showLeadPreview={allowLeadExecutionPreview && isLeadOwnedTask}
                    onPreviewOnlineChange={setExecutionPreviewOnline}
                    onTaskLogActivityChange={setTaskLogActivityActive}
                    onTaskLogCountChange={setTaskLogStreamCount}
                  />
                </div>
              </CollapsibleTeamSection>
            ) : null}

            {/* Review info */}
            {kanbanTaskState?.reviewer || kanbanTaskState?.errorDescription ? (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  {kanbanTaskState.reviewer ? (
                    <span className="text-xs text-[var(--color-text-secondary)]">
                      {t('taskDetail.review.reviewer', { reviewer: kanbanTaskState.reviewer })}
                    </span>
                  ) : null}
                  {kanbanTaskState.errorDescription ? (
                    <span className="text-xs text-red-400">{kanbanTaskState.errorDescription}</span>
                  ) : null}
                </div>
              </div>
            ) : null}

            {/* Workflow History */}
            {currentTask.historyEvents && currentTask.historyEvents.length > 0 ? (
              <CollapsibleTeamSection
                title={t('taskDetail.sections.workflowHistory')}
                icon={<History size={14} />}
                badge={currentTask.historyEvents.length}
                contentClassName="pl-2.5"
                headerClassName="-mx-6 w-[calc(100%+3rem)]"
                headerContentClassName="pl-6"
                headerExtra={<TaskImplementationDurationBadge task={currentTask} />}
                defaultOpen={false}
              >
                <WorkflowTimelineWithDuration
                  task={currentTask}
                  events={currentTask.historyEvents}
                  memberColorMap={colorMap}
                />
              </CollapsibleTeamSection>
            ) : null}

            {/* Comments */}
            <CollapsibleTeamSection
              title={t('taskDetail.sections.comments')}
              icon={<MessageSquare size={14} />}
              badge={
                (currentTask.comments?.length ?? 0) > 0
                  ? (currentTask.comments?.length ?? 0)
                  : undefined
              }
              contentClassName="overflow-x-visible pl-0"
              headerClassName="-mx-6 w-[calc(100%+3rem)]"
              headerContentClassName="pl-6"
              defaultOpen
            >
              <div className="pl-2.5">
                <TaskCommentInput
                  teamName={teamName}
                  taskId={currentTask.id}
                  members={members}
                  replyTo={effectiveReplyTo}
                  onClearReply={clearReply}
                />
              </div>
              <TaskCommentAwaitingReply
                comments={currentTask.comments}
                taskOwner={currentTask.owner}
                taskCreatedBy={currentTask.createdBy}
                members={members}
              />
              <TaskCommentsSection
                teamName={teamName}
                taskId={currentTask.id}
                comments={currentTask.comments ?? []}
                members={members}
                hideHeader
                hideInput
                onReply={handleReply}
                onTaskIdClick={
                  onScrollToTask ? (taskId) => handleDependencyClick(taskId) : undefined
                }
                containerClassName="-mx-6"
                unreadCommentIds={unreadSnapshotRef.current}
                focusCommentId={focusCommentId}
                registerCommentForViewport={registerComment}
              />
            </CollapsibleTeamSection>
          </div>
        </LightboxLockProvider>
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// Comment images grid — accumulated images from task comments
// ---------------------------------------------------------------------------

interface CommentImageItem {
  attachment: TaskAttachmentMeta;
  commentText: string;
  commentAuthor: string;
}

const CommentImagesGrid = ({
  items,
  teamName,
  taskId,
}: {
  items: CommentImageItem[];
  teamName: string;
  taskId: string;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  return (
    <div className="mt-3 space-y-1">
      <div className="flex items-center gap-1.5">
        <MessageSquare size={12} className="text-[var(--color-text-muted)]" />
        <span className="text-[11px] font-medium text-[var(--color-text-muted)]">
          {t('taskDetail.attachments.fromComments')}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <CommentImageThumbnail
            key={item.attachment.id}
            item={item}
            teamName={teamName}
            taskId={taskId}
            onPreview={setPreviewUrl}
          />
        ))}
      </div>
      {previewUrl ? (
        <ImageLightbox
          open
          onClose={() => setPreviewUrl(null)}
          src={previewUrl}
          alt={t('taskDetail.attachments.commentAttachment')}
        />
      ) : null}
    </div>
  );
};

const CommentImageThumbnail = ({
  item,
  teamName,
  taskId,
  onPreview,
}: {
  item: CommentImageItem;
  teamName: string;
  taskId: string;
  onPreview: (dataUrl: string) => void;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const getTaskAttachmentData = useStore((s) => s.getTaskAttachmentData);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const base64 = await getTaskAttachmentData(
          teamName,
          taskId,
          item.attachment.id,
          item.attachment.mimeType
        );
        if (!cancelled && base64) {
          setThumbUrl(`data:${item.attachment.mimeType};base64,${base64}`);
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamName, taskId, item.attachment.id, item.attachment.mimeType, getTaskAttachmentData]);

  // Truncate comment text for tooltip
  const tooltipText = `${item.commentAuthor}: ${item.commentText.length > 200 ? item.commentText.slice(0, 200) + '...' : item.commentText}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="group relative flex size-16 cursor-pointer items-center justify-center overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-surface)] transition-colors hover:border-[var(--color-border-emphasis)]"
          onClick={() => thumbUrl && onPreview(thumbUrl)}
          aria-label={t('taskDetail.attachments.preview', { filename: item.attachment.filename })}
        >
          {thumbUrl ? (
            <img src={thumbUrl} alt={item.attachment.filename} className="size-full object-cover" />
          ) : (
            <Loader2 size={12} className="animate-spin text-[var(--color-text-muted)]" />
          )}
          <div className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-0.5 py-px text-center text-[7px] text-white opacity-0 transition-opacity group-hover:opacity-100">
            {item.attachment.filename}
          </div>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[300px] text-xs">
        {tooltipText}
      </TooltipContent>
    </Tooltip>
  );
};
