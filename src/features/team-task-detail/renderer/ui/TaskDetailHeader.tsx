import { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { MemberSelect } from '@renderer/components/ui/MemberSelect';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import {
  getTeamColorSet,
  getThemedBadge,
  getThemedBorder,
  getThemedText,
} from '@renderer/constants/teamColors';
import { isImeComposing } from '@renderer/utils/imeComposition';
import {
  agentAvatarUrl,
  displayMemberName,
  REVIEW_STATE_DISPLAY,
} from '@renderer/utils/memberHelpers';
import { deriveTaskDisplayId, formatTaskDisplayLabel } from '@shared/utils/taskIdentity';
import {
  isTeamTaskFinishedForDependency,
  isTeamTaskNeedsFixActionable,
} from '@shared/utils/teamTaskState';
import { format, formatDistanceToNow } from 'date-fns';
import {
  ArrowLeftFromLine,
  ArrowRightFromLine,
  Clock,
  ExternalLink,
  HelpCircle,
  Link2,
  Loader2,
  Pencil,
  PenLine,
  Trash2,
} from 'lucide-react';

import type {
  TaskDetailPresentationActions,
  TaskDetailPresentationModel,
} from '../hooks/useTaskDetailPresentation';
import type { TaskDetailSessionController } from '../hooks/useTaskDetailSession';
import type { ReactNode } from 'react';

export interface TaskDetailHeadingProps {
  children: ReactNode;
  className: string;
}

export interface TaskDetailHeaderProps {
  actions: TaskDetailPresentationActions;
  headerExtra?: ReactNode;
  model: TaskDetailPresentationModel;
  onDeleteTask?: (taskId: string) => void;
  onOpenInTaskTab?: () => void | Promise<void>;
  onOwnerChange?: (taskId: string, owner: string | null) => void;
  renderDescription: (content: string) => ReactNode;
  renderHeading: (props: TaskDetailHeadingProps) => ReactNode;
  sessionController: TaskDetailSessionController;
}

export const TaskDetailHeader = ({
  actions,
  headerExtra,
  model,
  onDeleteTask,
  onOpenInTaskTab,
  onOwnerChange,
  renderDescription,
  renderHeading,
  sessionController,
}: TaskDetailHeaderProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [focusSubjectOnMount, setFocusSubjectOnMount] = useState(false);
  const {
    avatarMap,
    canReassign,
    colorMap,
    currentTask,
    isLight,
    kanbanColumn,
    members,
    statusLabel,
    statusStyle,
  } = model;
  const blockedByIds = currentTask.blockedBy?.filter((id) => id.length > 0) ?? [];
  const blocksIds = currentTask.blocks?.filter((id) => id.length > 0) ?? [];
  const relatedIds = (currentTask.related ?? []).filter(
    (id) => id.length > 0 && id !== currentTask.id
  );
  const relatedByIds = [...model.taskMap.values()]
    .filter((task) => task.id !== currentTask.id && task.related?.includes(currentTask.id))
    .map((task) => task.id);

  const reviewBadge =
    (kanbanColumn === 'approved' || kanbanColumn === 'review') &&
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
          ?.filter((event) =>
            kanbanColumn === 'approved'
              ? event.type === 'review_approved'
              : event.type === 'review_requested' || event.type === 'review_started'
          )
          .at(-1);
        const reviewDate = lastReviewEvent ? new Date(lastReviewEvent.timestamp) : undefined;
        const reviewTimeLabel =
          reviewDate && !Number.isNaN(reviewDate.getTime())
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
                  avatarMap.get(currentTask.reviewer) ?? agentAvatarUrl(currentTask.reviewer, 18)
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
    );

  return (
    <>
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
          {formatTaskDisplayLabel(currentTask)}
        </Badge>
        {reviewBadge}
        {isTeamTaskNeedsFixActionable(currentTask) ? (
          <span
            className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${REVIEW_STATE_DISPLAY.needsFix.bg} ${REVIEW_STATE_DISPLAY.needsFix.text}`}
          >
            {REVIEW_STATE_DISPLAY.needsFix.label}
          </span>
        ) : null}
        {onOpenInTaskTab ? (
          <div className="ml-auto mr-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  data-task-detail-open-tab
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  aria-label={t('taskDetail.actions.openInTaskTab')}
                  onPointerDown={actions.beginHandoff}
                  onPointerUp={actions.endHandoff}
                  onPointerCancel={actions.endHandoff}
                  onPointerLeave={actions.endHandoff}
                  onClick={async () => {
                    actions.beginHandoff();
                    try {
                      await onOpenInTaskTab();
                    } finally {
                      actions.endHandoff();
                    }
                  }}
                >
                  <ExternalLink size={13} />
                  {t('taskDetail.actions.openInTaskTab')}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('taskDetail.actions.openInTaskTab')}</TooltipContent>
            </Tooltip>
          </div>
        ) : null}
        {headerExtra ? (
          <div className={onOpenInTaskTab ? 'mr-4' : 'ml-auto mr-4'}>{headerExtra}</div>
        ) : null}
      </div>

      {model.editingSubject ? (
        <div className="flex items-center gap-2">
          <Input
            autoFocus={focusSubjectOnMount}
            value={model.subjectDraft}
            onChange={(event) => actions.setSubjectDraft(event.target.value)}
            onKeyDown={(event) => {
              if (!isImeComposing(event) && event.key === 'Enter') {
                event.stopPropagation();
                void actions.saveSubject();
              }
              if (event.key === 'Escape') actions.cancelEditSubject();
            }}
            onBlur={(event) => {
              if (
                event.relatedTarget instanceof Element &&
                event.relatedTarget.closest('[data-task-detail-open-tab]')
              )
                return;
              void actions.saveSubject();
            }}
            disabled={model.savingSubject || !sessionController.isOwner}
            className="h-8 text-base"
          />
          {model.savingSubject ? <Loader2 size={14} className="animate-spin" /> : null}
        </div>
      ) : (
        renderHeading({
          className:
            'group flex cursor-pointer items-center gap-1.5 text-base hover:text-[var(--color-text)]',
          children: (
            <Button
              type="button"
              variant="ghost"
              className="h-auto justify-start gap-1.5 p-0 text-left text-base"
              disabled={!sessionController.isOwner}
              onClick={() => {
                setFocusSubjectOnMount(true);
                sessionController.startEditSubject();
              }}
            >
              {currentTask.subject}
              <Pencil
                size={12}
                className="shrink-0 text-[var(--color-text-muted)] opacity-0 transition-opacity group-hover:opacity-100"
              />
            </Button>
          ),
        })
      )}
      {currentTask.activeForm ? renderDescription(currentTask.activeForm) : null}
      {model.editingSubject && sessionController.session.saveErrorByPart.subject ? (
        <p role="alert" className="text-xs text-red-400">
          {sessionController.session.saveErrorByPart.subject}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <div className="flex min-w-0 items-center gap-2">
          {canReassign && onOwnerChange ? (
            <MemberSelect
              members={members}
              value={currentTask.owner ?? null}
              onChange={(owner) => onOwnerChange(currentTask.id, owner)}
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
        {currentTask.createdAt && !Number.isNaN(new Date(currentTask.createdAt).getTime()) ? (
          <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
            <Clock size={12} />
            <span className="text-[var(--color-text-secondary)]">
              {formatDistanceToNow(new Date(currentTask.createdAt), { addSuffix: true })}
            </span>
          </div>
        ) : null}
        {onDeleteTask ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 gap-1 text-xs text-[var(--color-text-muted)] hover:text-red-400"
            disabled={!sessionController.isOwner}
            onClick={() => {
              if (!sessionController.canEditNow()) return;
              onDeleteTask(currentTask.id);
            }}
          >
            <Trash2 size={12} />
            {t('taskDetail.actions.delete')}
          </Button>
        ) : null}
      </div>

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
            disabled={!sessionController.isOwner}
            onClick={actions.markClarificationResolved}
          >
            {t('taskDetail.actions.markResolved')}
          </Button>
        </div>
      ) : null}

      {relatedIds.length || relatedByIds.length || blockedByIds.length || blocksIds.length ? (
        <div className="space-y-2">
          {relatedIds.length || relatedByIds.length ? (
            <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-muted)]">
              <Link2 size={12} />
              {t('taskDetail.related.title')}
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {renderDependencyGroup({
              actionIcon: <Link2 size={12} />,
              actionLabel: t('taskDetail.related.links'),
              actions,
              colorClassName: 'text-[var(--color-text-muted)]',
              ids: relatedIds,
              kind: 'related',
              model,
            })}
            {renderDependencyGroup({
              actionIcon: <Link2 size={12} />,
              actionLabel: t('taskDetail.related.linkedFrom'),
              actions,
              colorClassName: 'text-[var(--color-text-muted)]',
              ids: relatedByIds,
              kind: 'relatedBy',
              model,
            })}
            {renderDependencyGroup({
              actionIcon: <ArrowLeftFromLine size={12} />,
              actionLabel: t('taskDetail.related.blockedBy'),
              actions,
              colorClassName: 'text-yellow-700 dark:text-yellow-300',
              ids: blockedByIds,
              kind: 'blockedBy',
              model,
            })}
            {renderDependencyGroup({
              actionIcon: <ArrowRightFromLine size={12} />,
              actionLabel: t('taskDetail.related.blocks'),
              actions,
              colorClassName: 'text-blue-600 dark:text-blue-400',
              ids: blocksIds,
              kind: 'blocks',
              model,
            })}
          </div>
        </div>
      ) : null}
    </>
  );
};

function renderDependencyGroup({
  actionIcon,
  actionLabel,
  actions,
  colorClassName,
  ids,
  kind,
  model,
}: {
  actionIcon: ReactNode;
  actionLabel: string;
  actions: TaskDetailPresentationActions;
  colorClassName: string;
  ids: string[];
  kind: 'related' | 'relatedBy' | 'blockedBy' | 'blocks';
  model: TaskDetailPresentationModel;
}): React.JSX.Element | null {
  if (ids.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={`inline-flex items-center gap-0.5 text-xs ${colorClassName}`}>
        {actionIcon}
        {actionLabel}
      </span>
      {ids.map((id) => {
        const task = model.taskMap.get(id);
        const displayId = task ? formatTaskDisplayLabel(task) : `#${deriveTaskDisplayId(id)}`;
        const label = task ? `${displayId}: ${task.subject}` : displayId;
        const completed = task ? isTeamTaskFinishedForDependency(task) : false;
        const tone =
          kind === 'related'
            ? 'bg-purple-500/15 text-purple-300 hover:bg-purple-500/25'
            : kind === 'relatedBy'
              ? 'bg-fuchsia-500/15 text-fuchsia-300 hover:bg-fuchsia-500/25'
              : completed
                ? 'bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-400'
                : kind === 'blockedBy'
                  ? 'bg-yellow-500/15 text-yellow-700 hover:bg-yellow-500/25 dark:text-yellow-300'
                  : 'bg-blue-500/15 text-blue-600 hover:bg-blue-500/25 dark:text-blue-400';
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={`inline-flex cursor-pointer items-center rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${tone}`}
                onClick={() => actions.handleDependencyClick(id)}
              >
                {displayId}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{label}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
