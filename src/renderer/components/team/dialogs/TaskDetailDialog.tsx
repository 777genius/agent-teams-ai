import { useCallback, useEffect, useMemo, useState } from 'react';

import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { CollapsibleTeamSection } from '@renderer/components/team/CollapsibleTeamSection';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { MemberLogsTab } from '@renderer/components/team/members/MemberLogsTab';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { Textarea } from '@renderer/components/ui/textarea';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { markAsRead } from '@renderer/services/commentReadStorage';
import { useStore } from '@renderer/store';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import {
  buildMemberColorMap,
  KANBAN_COLUMN_DISPLAY,
  TASK_STATUS_LABELS,
  TASK_STATUS_STYLES,
} from '@renderer/utils/memberHelpers';
import { formatDistanceToNow } from 'date-fns';
import {
  AlignLeft,
  ArrowLeftFromLine,
  ArrowRightFromLine,
  Check,
  Clock,
  Eye,
  FileCode,
  FileDiff,
  HelpCircle,
  Link2,
  Loader2,
  MessageSquare,
  Pencil,
  PenLine,
  ScrollText,
  Trash2,
  X,
} from 'lucide-react';

import { TaskCommentInput } from './TaskCommentInput';
import { TaskCommentsSection } from './TaskCommentsSection';

import type { KanbanTaskState, ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

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
  onDeleteTask?: (taskId: string) => void;
  /** Extra content rendered in the dialog header (e.g. "Open team" button). */
  headerExtra?: React.ReactNode;
}

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
  onDeleteTask,
  headerExtra,
}: TaskDetailDialogProps): React.JSX.Element => {
  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);
  const currentTask = task ? (taskMap.get(task.id) ?? task) : null;
  const updateTaskFields = useStore((s) => s.updateTaskFields);

  // Inline editing: subject
  const [editingSubject, setEditingSubject] = useState(false);
  const [subjectDraft, setSubjectDraft] = useState('');
  const [savingSubject, setSavingSubject] = useState(false);

  // Inline editing: description
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const [descriptionPreview, setDescriptionPreview] = useState(false);
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
    setDescriptionPreview(false);
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

  const [replyTo, setReplyTo] = useState<{
    taskId: string;
    author: string;
    text: string;
  } | null>(null);
  const handleReply = useCallback(
    (author: string, text: string) => {
      if (currentTask) setReplyTo({ taskId: currentTask.id, author, text });
    },
    [currentTask]
  );
  const clearReply = useCallback(() => setReplyTo(null), []);

  const handleClose = useCallback(() => {
    setReplyTo(null);
    onClose();
  }, [onClose]);

  const effectiveReplyTo =
    replyTo && replyTo.taskId === currentTask?.id
      ? { author: replyTo.author, text: replyTo.text }
      : null;

  useEffect(() => {
    if (!open || !currentTask) return;
    const comments = currentTask.comments ?? [];
    if (comments.length === 0) return;
    const latest = Math.max(...comments.map((c) => new Date(c.createdAt).getTime()));
    if (latest > 0) markAsRead(teamName, currentTask.id, latest);
  }, [open, teamName, currentTask]);

  // Lazy-load task changes when dialog is open and task is completed
  const isTaskCompleted = currentTask?.status === 'completed';
  const setTaskNeedsClarification = useStore((s) => s.setTaskNeedsClarification);
  const activeChangeSet = useStore((s) => s.activeChangeSet);
  const changeSetLoading = useStore((s) => s.changeSetLoading);
  const fetchTaskChanges = useStore((s) => s.fetchTaskChanges);

  // Use the lightweight cache to know if changes exist before full data loads
  const changesCacheKey = currentTask ? `${teamName}:${currentTask.id}` : '';
  const taskKnownHasChanges = useStore((s) => s.taskHasChanges[changesCacheKey]) === true;

  const taskChangesFiles = useMemo(() => {
    if (!activeChangeSet || !currentTask) return null;
    if ('taskId' in activeChangeSet && activeChangeSet.taskId === currentTask.id) {
      return activeChangeSet.files;
    }
    return null;
  }, [activeChangeSet, currentTask]);

  useEffect(() => {
    if (variant !== 'team') return;
    if (!open || !currentTask || !isTaskCompleted || !onViewChanges) return;
    // Only fetch if we don't already have data for this task
    if (taskChangesFiles !== null) return;
    void fetchTaskChanges(teamName, currentTask.id);
  }, [
    open,
    currentTask,
    isTaskCompleted,
    teamName,
    fetchTaskChanges,
    taskChangesFiles,
    onViewChanges,
    variant,
  ]);

  const handleDependencyClick = (taskId: string): void => {
    handleClose();
    onScrollToTask?.(taskId);
  };

  if (loading) {
    return (
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Loading task…</DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            <Loader2 className="size-4 animate-spin" />
            <span>Fetching team data</span>
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
            <DialogTitle>Task not found</DialogTitle>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  const kanbanColumn = kanbanTaskState?.column ?? currentTask.kanbanColumn;
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

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="min-w-0 sm:max-w-4xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
              #{currentTask.id}
            </Badge>
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${statusStyle.bg} ${statusStyle.text}`}
            >
              {statusLabel}
            </span>
            {headerExtra ? <div className="ml-auto mr-4">{headerExtra}</div> : null}
          </div>
          {editingSubject ? (
            <div className="flex items-center gap-2">
              <Input
                autoFocus
                value={subjectDraft}
                onChange={(e) => setSubjectDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveSubject();
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
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
          <div className="flex min-w-0 items-center gap-2">
            {canReassign ? (
              <Select
                value={currentTask.owner ?? '__unassigned__'}
                onValueChange={(v) => {
                  onOwnerChange(currentTask.id, v === '__unassigned__' ? null : v);
                }}
              >
                <SelectTrigger className="h-8 w-auto min-w-[140px] text-xs">
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__unassigned__">Unassigned</SelectItem>
                  {members.map((m) => {
                    const role = formatAgentRole(m.role) ?? formatAgentRole(m.agentType);
                    const resolvedColor = colorMap.get(m.name);
                    const memberColor = resolvedColor ? getTeamColorSet(resolvedColor) : null;
                    return (
                      <SelectItem key={m.name} value={m.name}>
                        <span className="inline-flex items-center gap-1.5">
                          {memberColor ? (
                            <span
                              className="inline-block size-2 shrink-0 rounded-full"
                              style={{ backgroundColor: memberColor.border }}
                            />
                          ) : null}
                          <span style={memberColor ? { color: memberColor.text } : undefined}>
                            {m.name}
                          </span>
                          {role ? (
                            <span className="text-[var(--color-text-muted)]">({role})</span>
                          ) : null}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            ) : currentTask.owner ? (
              <MemberBadge
                name={currentTask.owner}
                color={colorMap.get(currentTask.owner)}
                size="md"
              />
            ) : (
              <span className="text-xs text-[var(--color-text-muted)]">&mdash;</span>
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
                ? 'Awaiting clarification from you'
                : 'Awaiting clarification from team lead'}
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
              Mark resolved
            </Button>
          </div>
        ) : null}

        {/* Description */}
        <CollapsibleTeamSection title="Description" icon={<AlignLeft size={14} />} defaultOpen>
          {editingDescription ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors ${
                    !descriptionPreview
                      ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)]'
                      : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
                  }`}
                  onClick={() => setDescriptionPreview(false)}
                >
                  <Pencil size={12} />
                  Edit
                </button>
                <button
                  type="button"
                  className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors ${
                    descriptionPreview
                      ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)]'
                      : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
                  }`}
                  onClick={() => setDescriptionPreview(true)}
                >
                  <Eye size={12} />
                  Preview
                </button>
              </div>
              {descriptionPreview ? (
                <div className="max-h-[200px] overflow-y-auto rounded border border-[var(--color-border)] p-2">
                  {descriptionDraft.trim() ? (
                    <MarkdownViewer content={descriptionDraft} maxHeight="max-h-[180px]" />
                  ) : (
                    <p className="text-xs text-[var(--color-text-muted)]">Nothing to preview</p>
                  )}
                </div>
              ) : (
                <Textarea
                  autoFocus
                  value={descriptionDraft}
                  onChange={(e) => setDescriptionDraft(e.target.value)}
                  disabled={savingDescription}
                  rows={6}
                  className="text-xs"
                  placeholder="Task description (supports markdown)"
                />
              )}
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
                  Save
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={savingDescription}
                  onClick={() => setEditingDescription(false)}
                >
                  <X size={12} className="mr-1" />
                  Cancel
                </Button>
              </div>
            </div>
          ) : currentTask.description ? (
            <div
              role="button"
              tabIndex={0}
              className="group max-h-[200px] cursor-pointer overflow-y-auto"
              onClick={startEditDescription}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  startEditDescription();
                }
              }}
            >
              <MarkdownViewer content={currentTask.description} maxHeight="max-h-[180px]" />
              <Pencil
                size={12}
                className="mt-1 text-[var(--color-text-muted)] opacity-0 transition-opacity group-hover:opacity-100"
              />
            </div>
          ) : (
            <button
              type="button"
              className="text-xs text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
              onClick={startEditDescription}
            >
              Click to add description...
            </button>
          )}
        </CollapsibleTeamSection>

        {/* Changes */}
        {variant === 'team' && isTaskCompleted && onViewChanges ? (
          <CollapsibleTeamSection
            title="Changes"
            icon={<FileDiff size={14} />}
            badge={taskChangesFiles ? taskChangesFiles.length : undefined}
            defaultOpen={taskKnownHasChanges}
          >
            {changeSetLoading || (!taskChangesFiles && taskKnownHasChanges) ? (
              <div className="flex items-center gap-2 py-2 text-xs text-[var(--color-text-muted)]">
                <Loader2 size={14} className="animate-spin" />
                Loading changes...
              </div>
            ) : taskChangesFiles && taskChangesFiles.length > 0 ? (
              <div className="max-h-[200px] space-y-0.5 overflow-y-auto">
                {taskChangesFiles.map((file) => (
                  <button
                    key={file.filePath}
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-surface-raised)]"
                    onClick={() => {
                      handleClose();
                      onViewChanges(currentTask.id, file.filePath);
                    }}
                  >
                    <FileCode size={14} className="shrink-0 text-[var(--color-text-muted)]" />
                    <span className="truncate font-mono text-[var(--color-text-secondary)]">
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
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-[var(--color-text-muted)]">No file changes detected</p>
            )}
          </CollapsibleTeamSection>
        ) : null}

        {/* Execution Logs — sessions that reference this task */}
        {variant === 'team' ? (
          <CollapsibleTeamSection
            title="Execution Logs"
            icon={<ScrollText size={14} />}
            defaultOpen
          >
            <div className="min-w-0 overflow-hidden">
              <MemberLogsTab
                teamName={teamName}
                taskId={currentTask.id}
                taskOwner={currentTask.owner}
                taskStatus={currentTask.status}
              />
            </div>
          </CollapsibleTeamSection>
        ) : null}

        <div className="mb-3 space-y-2">
          {/* Dependencies */}
          {blockedByIds.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-0.5 text-xs text-yellow-300">
                <ArrowLeftFromLine size={12} />
                Blocked by
              </span>
              {blockedByIds.map((id) => {
                const depTask = taskMap.get(id);
                const isCompleted = depTask?.status === 'completed';
                return (
                  <button
                    key={id}
                    type="button"
                    className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                      isCompleted
                        ? 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25'
                        : 'bg-yellow-500/15 text-yellow-300 hover:bg-yellow-500/25'
                    } cursor-pointer`}
                    title={depTask ? `#${id}: ${depTask.subject}` : `#${id}`}
                    onClick={() => handleDependencyClick(id)}
                  >
                    #{id}
                  </button>
                );
              })}
            </div>
          ) : null}

          {blocksIds.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-0.5 text-xs text-blue-400">
                <ArrowRightFromLine size={12} />
                Blocks
              </span>
              {blocksIds.map((id) => {
                const depTask = taskMap.get(id);
                const isCompleted = depTask?.status === 'completed';
                return (
                  <button
                    key={id}
                    type="button"
                    className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                      isCompleted
                        ? 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25'
                        : 'bg-blue-500/15 text-blue-400 hover:bg-blue-500/25'
                    } cursor-pointer`}
                    title={depTask ? `#${id}: ${depTask.subject}` : `#${id}`}
                    onClick={() => handleDependencyClick(id)}
                  >
                    #{id}
                  </button>
                );
              })}
            </div>
          ) : null}

          {/* Related tasks (explicit) */}
          {relatedIds.length > 0 || relatedByIds.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-muted)]">
                <Link2 size={12} />
                Related tasks
              </div>

              {relatedIds.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-[var(--color-text-muted)]">Links</span>
                  {relatedIds.map((id) => {
                    const depTask = taskMap.get(id);
                    return (
                      <button
                        key={`related:${currentTask.id}:${id}`}
                        type="button"
                        className="inline-flex items-center rounded bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-medium text-purple-300 transition-colors hover:bg-purple-500/25"
                        title={depTask ? `#${id}: ${depTask.subject}` : `#${id}`}
                        onClick={() => handleDependencyClick(id)}
                      >
                        #{id}
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {relatedByIds.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-[var(--color-text-muted)]">Linked from</span>
                  {relatedByIds.map((id) => {
                    const depTask = taskMap.get(id);
                    return (
                      <button
                        key={`related-by:${currentTask.id}:${id}`}
                        type="button"
                        className="inline-flex items-center rounded bg-fuchsia-500/15 px-1.5 py-0.5 text-[10px] font-medium text-fuchsia-300 transition-colors hover:bg-fuchsia-500/25"
                        title={depTask ? `#${id}: ${depTask.subject}` : `#${id}`}
                        onClick={() => handleDependencyClick(id)}
                      >
                        #{id}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Review info */}
          {kanbanTaskState ? (
            <div className="flex items-center gap-2">
              {kanbanTaskState.reviewer ? (
                <span className="text-xs text-[var(--color-text-secondary)]">
                  Reviewer: {kanbanTaskState.reviewer}
                </span>
              ) : null}
              {kanbanTaskState.errorDescription ? (
                <span className="text-xs text-red-400">{kanbanTaskState.errorDescription}</span>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Comments */}
        <CollapsibleTeamSection
          title="Comments"
          icon={<MessageSquare size={14} />}
          badge={
            (currentTask.comments?.length ?? 0) > 0
              ? (currentTask.comments?.length ?? 0)
              : undefined
          }
          defaultOpen
        >
          <TaskCommentInput
            teamName={teamName}
            taskId={currentTask.id}
            members={members}
            replyTo={effectiveReplyTo}
            onClearReply={clearReply}
          />
          <TaskCommentsSection
            teamName={teamName}
            taskId={currentTask.id}
            comments={currentTask.comments ?? []}
            members={members}
            hideHeader
            hideInput
            onReply={handleReply}
          />
        </CollapsibleTeamSection>

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          {onDeleteTask && currentTask ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                onDeleteTask(currentTask.id);
                handleClose();
              }}
            >
              <Trash2 size={14} className="mr-1" />
              Delete
            </Button>
          ) : (
            <div />
          )}
          <Button variant="outline" onClick={handleClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
