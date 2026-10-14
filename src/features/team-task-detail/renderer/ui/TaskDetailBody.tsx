import { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { OngoingIndicator } from '@renderer/components/common/OngoingIndicator';
import { SourceMessageAttachments } from '@renderer/components/team/attachments/SourceMessageAttachments';
import { CollapsibleTeamSection } from '@renderer/components/team/CollapsibleTeamSection';
import { TaskAttachments } from '@renderer/components/team/dialogs/TaskAttachments';
import { TaskCommentAwaitingReply } from '@renderer/components/team/dialogs/TaskCommentAwaitingReply';
import { TaskCommentInput } from '@renderer/components/team/dialogs/TaskCommentInput';
import { TaskCommentsSection } from '@renderer/components/team/dialogs/TaskCommentsSection';
import { FileIcon } from '@renderer/components/team/editor/FileIcon';
import { TaskLogsPanel } from '@renderer/components/team/taskLogs/TaskLogsPanel';
import { Button } from '@renderer/components/ui/button';
import { ExpandableContent } from '@renderer/components/ui/ExpandableContent';
import { TiptapEditor } from '@renderer/components/ui/tiptap';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { linkifyTaskIdsInMarkdown, parseTaskLinkHref } from '@renderer/utils/taskReferenceUtils';
import {
  AlertTriangle,
  AlignLeft,
  Check,
  FileDiff,
  GitCompareArrows,
  History,
  ImageIcon,
  Info,
  Loader2,
  MessageSquare,
  Pencil,
  RefreshCw,
  ScrollText,
  SquarePen,
  X,
} from 'lucide-react';

import { TaskDetailCommentImages } from './TaskDetailCommentImages';
import {
  TaskImplementationDurationBadge,
  WorkflowTimelineWithDuration,
} from './TaskDetailWorkflow';

import type {
  TaskDetailPresentationActions,
  TaskDetailPresentationModel,
} from '../hooks/useTaskDetailPresentation';
import type { TaskDetailSessionController } from '../hooks/useTaskDetailSession';

const TASK_SECTION_HEADER_CLASS = '-mx-[calc(1.5rem-5px)] w-[calc(100%+3rem-10px)]';

export interface TaskDetailBodyProps {
  actions: TaskDetailPresentationActions;
  model: TaskDetailPresentationModel;
  onOpenInEditor?: (filePath: string) => void;
  onViewChanges?: (taskId: string, filePath?: string) => void;
  sessionController: TaskDetailSessionController;
  showTeamIO: boolean;
}

export const TaskDetailBody = ({
  actions,
  model,
  onOpenInEditor,
  onViewChanges,
  sessionController,
  showTeamIO,
}: TaskDetailBodyProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [focusDescriptionOnMount, setFocusDescriptionOnMount] = useState(false);
  const startEditDescription = () => {
    setFocusDescriptionOnMount(true);
    sessionController.startEditDescription();
  };
  const {
    attachmentCount,
    colorMap,
    commentImageAttachments,
    currentTask,
    descriptionDraft,
    editingDescription,
    projectPath,
    savingDescription,
    taskChanges,
    teamName,
  } = model;
  const openChangeFile = (filePath: string): void => {
    if (!onViewChanges) return;
    onViewChanges(currentTask.id, filePath);
  };

  return (
    <div className="min-w-0 [&>section:last-of-type>div:first-child]:border-b-0 [&>section]:!mb-0">
      <CollapsibleTeamSection
        variant="flat"
        title={t('taskDetail.sections.description')}
        icon={<AlignLeft size={14} />}
        contentClassName="pl-2.5"
        headerClassName={TASK_SECTION_HEADER_CLASS}
        defaultOpen
      >
        {editingDescription ? (
          <div className="space-y-2">
            <TiptapEditor
              content={descriptionDraft}
              onChange={actions.setDescriptionDraft}
              placeholder={t('taskDetail.description.placeholder')}
              autoFocus={focusDescriptionOnMount}
              minHeight="120px"
              maxHeight="200px"
              toolbar
              disabled={savingDescription || !sessionController.isOwner}
            />
            {sessionController.session.saveErrorByPart.description ? (
              <p role="alert" className="text-xs text-red-400">
                {sessionController.session.saveErrorByPart.description}
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                className="h-7 text-xs"
                disabled={savingDescription || !sessionController.isOwner}
                onClick={() => void actions.saveDescription()}
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
                disabled={savingDescription || !sessionController.isOwner}
                onClick={actions.cancelEditDescription}
              >
                <X size={12} className="mr-1" />
                {t('taskDetail.actions.cancel')}
              </Button>
            </div>
          </div>
        ) : currentTask.description ? (
          <div
            className="group relative"
            onClickCapture={(event) => {
              const link = (event.target as HTMLElement).closest<HTMLAnchorElement>(
                'a[href^="task://"]'
              );
              if (!link) return;
              event.preventDefault();
              event.stopPropagation();
              const href = link.getAttribute('href');
              const parsed = href ? parseTaskLinkHref(href) : null;
              if (parsed?.taskId) actions.handleDependencyClick(parsed.taskId, parsed.teamName);
            }}
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

      <CollapsibleTeamSection
        variant="flat"
        title={t('taskDetail.sections.attachments')}
        icon={<ImageIcon size={14} />}
        badge={attachmentCount}
        contentClassName="pl-2.5"
        headerClassName={TASK_SECTION_HEADER_CLASS}
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
          <TaskDetailCommentImages
            items={commentImageAttachments}
            teamName={teamName}
            taskId={currentTask.id}
            loadAttachmentData={actions.getTaskAttachmentData}
          />
        ) : null}
      </CollapsibleTeamSection>

      {showTeamIO ? (
        <CollapsibleTeamSection
          key={`task-changes:${currentTask.id}`}
          variant="flat"
          title={t('taskDetail.sections.changes')}
          icon={<FileDiff size={14} />}
          badge={taskChanges.badge}
          headerExtra={
            taskChanges.loading && !taskChanges.sectionOpen ? (
              <Loader2
                size={12}
                className="pointer-events-none animate-spin text-[var(--color-text-muted)]"
              />
            ) : taskChanges.sectionOpen ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="pointer-events-auto rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-section-hover)] hover:text-[var(--color-text)] disabled:opacity-50"
                    onClick={(event) => {
                      event.stopPropagation();
                      actions.refreshChanges();
                    }}
                    disabled={taskChanges.loading}
                    aria-label={t('taskDetail.changes.refresh')}
                  >
                    <RefreshCw
                      size={12}
                      className={taskChanges.loading ? 'animate-spin' : undefined}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{t('taskDetail.changes.refreshShort')}</TooltipContent>
              </Tooltip>
            ) : null
          }
          contentClassName="pl-2.5"
          headerClassName={TASK_SECTION_HEADER_CLASS}
          defaultOpen={false}
          onOpenChange={actions.setChangesSectionOpen}
        >
          {taskChanges.loading && (!taskChanges.files || taskChanges.files.length === 0) ? (
            <div className="flex items-center gap-2 py-2 text-xs text-[var(--color-text-muted)]">
              <Loader2 size={14} className="animate-spin" />
              {t('taskDetail.changes.loading')}
            </div>
          ) : taskChanges.error ? (
            <p className="text-xs text-red-400">{taskChanges.error}</p>
          ) : taskChanges.files ? (
            <div
              className={
                taskChanges.warnings.length > 0 || taskChanges.files.length > 0
                  ? 'border-y border-[var(--color-border-subtle)]'
                  : undefined
              }
            >
              {taskChanges.warnings.length > 0 ? (
                <div
                  className={`space-y-1 border-b border-[var(--color-border-subtle)] px-2 py-1.5 ${
                    taskChanges.reviewability === 'attention_required' ? 'bg-amber-500/5' : ''
                  }`}
                >
                  {taskChanges.warnings.slice(0, 2).map((warning) => (
                    <div
                      key={warning}
                      className={`flex items-center gap-2 text-xs ${
                        taskChanges.reviewability === 'attention_required'
                          ? 'text-[var(--step-warning-text)]'
                          : 'text-[var(--color-text-muted)]'
                      }`}
                    >
                      {taskChanges.reviewability === 'attention_required' ? (
                        <AlertTriangle size={13} className="shrink-0" />
                      ) : (
                        <Info size={13} className="shrink-0" />
                      )}
                      <span className="min-w-0 truncate">{warning}</span>
                    </div>
                  ))}
                  {taskChanges.warnings.length > 2 ? (
                    <p className="text-[10px] text-[var(--color-text-muted)]">
                      {t('taskDetail.changes.moreDiagnostics', {
                        count: taskChanges.warnings.length - 2,
                      })}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {taskChanges.files.length > 0 ? (
                <div className="max-h-[200px] overflow-y-auto">
                  {taskChanges.files.map((file) => (
                    <div
                      key={file.filePath}
                      role="button"
                      aria-disabled={!onViewChanges}
                      aria-label={file.relativePath}
                      tabIndex={onViewChanges ? 0 : -1}
                      className={`group flex w-full items-center gap-2 border-b border-[var(--color-border-subtle)] px-2 py-1.5 text-left text-xs transition-colors last:border-b-0 hover:bg-[var(--color-surface-raised)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-emphasis)] ${
                        onViewChanges ? 'cursor-pointer' : ''
                      }`}
                      onClick={onViewChanges ? () => openChangeFile(file.filePath) : undefined}
                      onKeyDown={(event) => {
                        if (!onViewChanges || event.target !== event.currentTarget) return;
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          openChangeFile(file.filePath);
                        }
                      }}
                    >
                      <FileIcon
                        fileName={file.relativePath.split(/[\\\\/]/).pop() ?? file.relativePath}
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
                                  openChangeFile(file.filePath);
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
              ) : taskChanges.sectionOpen ? (
                <p className="text-xs text-[var(--color-text-muted)]">
                  {taskChanges.warnings.length > 0
                    ? taskChanges.reviewability === 'attention_required'
                      ? t('taskDetail.changes.empty.noReviewableChangesRecovered')
                      : taskChanges.reviewability === 'diagnostic_only'
                        ? t('taskDetail.changes.empty.noSafeDiffAvailable')
                        : t('taskDetail.changes.empty.noFileChangesRecordedYet')
                    : t('taskDetail.changes.empty.noFileChangesRecorded')}
                </p>
              ) : null}
            </div>
          ) : taskChanges.sectionOpen ? (
            <p className="text-xs text-[var(--color-text-muted)]">
              {t('taskDetail.changes.empty.noFileChangesRecorded')}
            </p>
          ) : null}
        </CollapsibleTeamSection>
      ) : null}

      {showTeamIO ? (
        <CollapsibleTeamSection
          key={`task-logs:${currentTask.id}`}
          variant="flat"
          title={t('taskDetail.sections.taskLogs')}
          icon={<ScrollText size={14} />}
          badge={model.taskLogStreamCount}
          headerExtra={
            model.taskLogActivityActive ? (
              <OngoingIndicator size="sm" title={t('taskDetail.logs.newArriving')} />
            ) : null
          }
          contentClassName="pl-2.5 overflow-visible"
          headerClassName={TASK_SECTION_HEADER_CLASS}
          defaultOpen={false}
          onOpenChange={actions.setLogsSectionOpen}
          keepMounted
        >
          <div className="min-w-0">
            <TaskLogsPanel
              contextId={sessionController.identity.contextId}
              surfaceId={sessionController.surfaceId}
              visible={model.commentReadEnabled}
              teamName={teamName}
              task={currentTask}
              isOpen={model.logsSectionOpen}
              taskSince={taskChanges.since}
              isExecutionRefreshing={model.isExecutionRefreshing}
              isExecutionPreviewOnline={model.isExecutionPreviewOnline}
              onRefreshingChange={actions.setLogsRefreshing}
              showSubagentPreview={Boolean(currentTask.owner) && !model.isLeadOwnedTask}
              showLeadPreview={model.allowLeadExecutionPreview && model.isLeadOwnedTask}
              onPreviewOnlineChange={actions.setExecutionPreviewOnline}
              onTaskLogActivityChange={actions.setTaskLogActivityActive}
              onTaskLogCountChange={actions.setTaskLogStreamCount}
            />
          </div>
        </CollapsibleTeamSection>
      ) : null}

      {model.kanbanTaskState?.errorDescription ? (
        <div className="mb-2 text-xs text-red-400">{model.kanbanTaskState.errorDescription}</div>
      ) : null}

      {currentTask.historyEvents?.length ? (
        <CollapsibleTeamSection
          variant="flat"
          title={t('taskDetail.sections.workflowHistory')}
          icon={<History size={14} />}
          badge={currentTask.historyEvents.length}
          contentClassName="pl-2.5"
          headerClassName={TASK_SECTION_HEADER_CLASS}
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

      <CollapsibleTeamSection
        variant="flat"
        title={t('taskDetail.sections.comments')}
        icon={<MessageSquare size={14} />}
        badge={currentTask.comments?.length || undefined}
        contentClassName="overflow-x-visible pl-0"
        headerClassName={TASK_SECTION_HEADER_CLASS}
        defaultOpen
      >
        <div className="pl-2.5">
          <TaskCommentInput
            contextId={sessionController.identity.contextId}
            surfaceId={sessionController.surfaceId}
            teamName={teamName}
            taskId={currentTask.id}
            projectPath={projectPath}
            members={model.members}
            controller={sessionController}
          />
        </div>
        <TaskCommentAwaitingReply
          comments={currentTask.comments}
          taskOwner={currentTask.owner}
          taskCreatedBy={currentTask.createdBy}
          members={model.members}
        />
        <TaskCommentsSection
          contextId={sessionController.identity.contextId}
          surfaceId={sessionController.surfaceId}
          active={model.commentReadEnabled}
          teamName={teamName}
          taskId={currentTask.id}
          comments={currentTask.comments ?? []}
          members={model.members}
          hideHeader
          onReply={actions.handleReply}
          onTaskIdClick={actions.handleDependencyClick}
          containerClassName="-mx-6"
          unreadCommentIds={model.unreadCommentIds}
          focusCommentId={model.focusCommentId}
          registerCommentForViewport={model.registerComment}
        />
      </CollapsibleTeamSection>
    </div>
  );
};
