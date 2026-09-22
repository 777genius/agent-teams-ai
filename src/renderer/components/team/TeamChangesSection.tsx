import { memo, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { classifyTaskChangeReviewability } from '@shared/utils/taskChangeReviewability';
import { deriveTaskDisplayId } from '@shared/utils/taskIdentity';
import { AlertTriangle, FileDiff, GitCompareArrows, Info, Loader2, RefreshCw } from 'lucide-react';

import { FileIcon } from './editor/FileIcon';
import {
  CollapsibleTeamSection,
  type CollapsibleTeamSectionVariant,
} from './CollapsibleTeamSection';
import { MemberBadge } from './MemberBadge';
import {
  getTeamChangeTaskTimeMs,
  TEAM_CHANGES_MAX_RENDERED_FILE_ROWS,
} from './teamChangesRequestPlan';
import { type TeamChangeSummaryState, useTeamChangesSummaries } from './useTeamChangesSummaries';

import type { FileChangeSummary, TaskChangeSetV2, TeamTaskWithKanban } from '@shared/types';

interface TeamChangesSectionProps {
  teamName: string;
  tasks: TeamTaskWithKanban[];
  memberColorMap?: ReadonlyMap<string, string>;
  sectionVariant?: CollapsibleTeamSectionVariant;
  onOpenTask: (task: TeamTaskWithKanban) => void;
  onViewChanges: (taskId: string, filePath?: string) => void;
}

interface RenderedTeamChangeSummary {
  summary: TeamChangeSummaryState;
  task: TeamTaskWithKanban;
  visibleFiles: FileChangeSummary[];
  fileBudget: number;
}

const EMPTY_MEMBER_COLOR_MAP = new Map<string, string>();
const COMPACT_HIDDEN_INTERVAL_SCOPE_WARNINGS = new Set([
  'Task boundaries missing - scoped by workIntervals timestamps.',
  'Task start boundary missing - scoped by persisted workIntervals timestamps.',
]);

function getChangeSetFiles(changeSet: TaskChangeSetV2 | null): FileChangeSummary[] {
  if (!Array.isArray(changeSet?.files)) {
    return [];
  }
  return changeSet.files.filter((file): file is FileChangeSummary =>
    Boolean(
      file &&
      typeof file === 'object' &&
      typeof (file as Partial<FileChangeSummary>).filePath === 'string'
    )
  );
}

function getChangeSetWarnings(changeSet: TaskChangeSetV2): string[] {
  return Array.isArray(changeSet.warnings)
    ? changeSet.warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
}

function getTaskChangeContributors(
  task: TeamTaskWithKanban,
  changeSet: TaskChangeSetV2 | null
): string[] {
  const names = new Set<string>();
  const contributors = Array.isArray(changeSet?.scope?.contributors)
    ? changeSet.scope.contributors
    : [];
  for (const contributor of contributors) {
    const memberName =
      contributor && typeof contributor.memberName === 'string' ? contributor.memberName : '';
    if (memberName) names.add(memberName);
  }
  const memberNames = Array.isArray(changeSet?.scope?.memberNames)
    ? changeSet.scope.memberNames
    : [];
  for (const name of memberNames) {
    if (typeof name === 'string' && name) names.add(name);
  }
  if (
    typeof changeSet?.scope?.primaryMemberName === 'string' &&
    changeSet.scope.primaryMemberName
  ) {
    names.add(changeSet.scope.primaryMemberName);
  }
  for (const file of getChangeSetFiles(changeSet)) {
    const fileMemberNames = Array.isArray(file.ledgerSummary?.memberNames)
      ? file.ledgerSummary.memberNames
      : [];
    for (const name of fileMemberNames) {
      if (typeof name === 'string' && name) names.add(name);
    }
  }
  if (names.size === 0 && task.owner) {
    names.add(task.owner);
  }
  return [...names];
}

function getVisibleFileName(file: FileChangeSummary): string {
  const value = getVisibleFilePath(file);
  return value.split(/[\\/]/).pop() ?? value;
}

function getVisibleFilePath(file: FileChangeSummary): string {
  return typeof file.relativePath === 'string' && file.relativePath.trim() !== ''
    ? file.relativePath
    : file.filePath;
}

function getTaskSummaryBadge(
  changeSet: TaskChangeSetV2 | null,
  labels: {
    files: (count: number) => string;
    attention: string;
    noSafeDiff: string;
  }
): string | undefined {
  if (!changeSet) return undefined;
  const reviewability = classifyTaskChangeReviewability(changeSet).reviewability;
  if (changeSet.totalFiles > 0) return labels.files(changeSet.totalFiles);
  if (reviewability === 'attention_required') return labels.attention;
  if (reviewability === 'diagnostic_only') return labels.noSafeDiff;
  return undefined;
}

function isWorkIntervalScopedFileChange(changeSet: TaskChangeSetV2): boolean {
  const reason = changeSet.scope?.confidence?.reason;
  return (
    getChangeSetFiles(changeSet).length > 0 &&
    changeSet.confidence === 'medium' &&
    typeof reason === 'string' &&
    reason.toLowerCase().includes('workinterval')
  );
}

function shouldHideCompactDiagnostic(changeSet: TaskChangeSetV2, message: string): boolean {
  return (
    isWorkIntervalScopedFileChange(changeSet) &&
    COMPACT_HIDDEN_INTERVAL_SCOPE_WARNINGS.has(message.trim())
  );
}

function getTaskChangeDiagnosticMessages(changeSet: TaskChangeSetV2): string[] {
  const status = classifyTaskChangeReviewability(changeSet);
  if (status.reviewability === 'unknown' || status.reviewability === 'none') {
    return [];
  }
  const messages =
    status.diagnostics.length > 0
      ? status.diagnostics.map((diagnostic) => diagnostic.message)
      : getChangeSetWarnings(changeSet);
  return [
    ...new Set(
      messages.filter(
        (message) => message.trim().length > 0 && !shouldHideCompactDiagnostic(changeSet, message)
      )
    ),
  ];
}

export const TeamChangesSection = memo(function TeamChangesSection({
  teamName,
  tasks,
  memberColorMap = EMPTY_MEMBER_COLOR_MAP,
  sectionVariant,
  onOpenTask,
  onViewChanges,
}: TeamChangesSectionProps): React.JSX.Element {
  const { t } = useAppTranslation('team');
  const [sectionOpen, setSectionOpen] = useState(false);
  const { summariesByTaskId, badgeCount, stats, loading, refreshing, error, refresh } =
    useTeamChangesSummaries({
      teamName,
      tasks,
      sectionOpen,
    });
  const taskMap = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  const visibleSummaries = useMemo(() => {
    return Object.values(summariesByTaskId)
      .map((summary) => ({ summary, task: taskMap.get(summary.taskId) }))
      .filter((entry): entry is { summary: TeamChangeSummaryState; task: TeamTaskWithKanban } => {
        const changeSet = entry.summary.changeSet;
        return (
          Boolean(entry.task) &&
          (Boolean(entry.summary.error) ||
            getChangeSetFiles(changeSet).length > 0 ||
            (changeSet ? getTaskChangeDiagnosticMessages(changeSet).length > 0 : false))
        );
      })
      .sort((a, b) => getTeamChangeTaskTimeMs(b.task) - getTeamChangeTaskTimeMs(a.task));
  }, [summariesByTaskId, taskMap]);

  const totalFiles = visibleSummaries.reduce(
    (sum, entry) => sum + getChangeSetFiles(entry.summary.changeSet).length,
    0
  );
  const hiddenFileRows = Math.max(0, totalFiles - TEAM_CHANGES_MAX_RENDERED_FILE_ROWS);
  const badge = badgeCount ?? undefined;
  const renderedSummaries = useMemo(() => {
    const entries: RenderedTeamChangeSummary[] = [];
    let remainingFileRows = TEAM_CHANGES_MAX_RENDERED_FILE_ROWS;
    for (const entry of visibleSummaries) {
      const files = getChangeSetFiles(entry.summary.changeSet);
      const fileBudget = Math.max(0, remainingFileRows);
      const visibleFiles = files.slice(0, fileBudget);
      entries.push({ ...entry, visibleFiles, fileBudget });
      remainingFileRows -= visibleFiles.length;
    }
    return entries;
  }, [visibleSummaries]);

  return (
    <CollapsibleTeamSection
      sectionId="changes"
      variant={sectionVariant}
      title={t('taskDetail.changes.title')}
      icon={<FileDiff size={14} />}
      badge={badge}
      defaultOpen={false}
      onOpenChange={setSectionOpen}
      headerExtra={
        loading && !sectionOpen ? (
          <Loader2
            size={12}
            className="pointer-events-none animate-spin text-[var(--color-text-muted)]"
          />
        ) : sectionOpen ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="pointer-events-auto rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-section-hover)] hover:text-[var(--color-text)] disabled:opacity-50"
                onClick={(event) => {
                  event.stopPropagation();
                  refresh();
                }}
                disabled={loading || refreshing}
                aria-label={t('taskDetail.changes.refreshTeamChanges')}
              >
                <RefreshCw
                  size={12}
                  className={loading || refreshing ? 'animate-spin' : undefined}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('taskDetail.changes.refreshShort')}</TooltipContent>
          </Tooltip>
        ) : null
      }
      contentClassName="pl-2.5"
    >
      {visibleSummaries.length > 0 ? (
        <div className="space-y-2">
          <div className="max-h-[360px] overflow-y-auto border-y border-[var(--color-border-subtle)] pr-1">
            {renderedSummaries.map(({ summary, task, visibleFiles, fileBudget }) => {
              const changeSet = summary.changeSet;
              const files = getChangeSetFiles(changeSet);
              const reviewability = changeSet
                ? classifyTaskChangeReviewability(changeSet).reviewability
                : 'unknown';
              const contributors = getTaskChangeContributors(task, changeSet);
              const contributorLabel =
                contributors.length > 0
                  ? contributors.slice(0, 3).join(', ')
                  : t('taskDetail.unassigned');
              const extraContributors = Math.max(0, contributors.length - 3);
              const badgeText = getTaskSummaryBadge(changeSet, {
                files: (count) => t('taskDetail.changes.fileCount', { count }),
                attention: t('taskDetail.changes.badges.attention'),
                noSafeDiff: t('taskDetail.changes.badges.noSafeDiff'),
              });
              const diagnosticMessages = changeSet
                ? getTaskChangeDiagnosticMessages(changeSet)
                : [];

              if (visibleFiles.length === 0 && !summary.error && diagnosticMessages.length === 0) {
                return null;
              }

              return (
                <div
                  key={summary.taskId}
                  className="border-b border-[var(--color-border-subtle)] py-1 last:border-b-0"
                >
                  <div className="flex min-w-0 items-center gap-1 px-2 py-1.5 transition-colors hover:bg-[var(--color-surface-raised)]">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() => onOpenTask(task)}
                      aria-label={t('taskDetail.changes.openTask', { subject: task.subject })}
                    >
                      <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">
                        #{deriveTaskDisplayId(task.id)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--color-text)]">
                        {task.subject}
                      </span>
                      {contributors[0] ? (
                        <span className="hidden min-w-0 max-w-[220px] shrink-0 items-center gap-1 sm:inline-flex">
                          <MemberBadge
                            name={contributors[0]}
                            color={memberColorMap.get(contributors[0])}
                            size="xs"
                            disableHoverCard
                          />
                          {extraContributors > 0 ? (
                            <span
                              className="shrink-0 text-[10px] text-[var(--color-text-muted)]"
                              title={contributors.join(', ')}
                            >
                              +{extraContributors}
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span
                          className="hidden max-w-[180px] shrink-0 truncate text-[10px] text-[var(--color-text-muted)] sm:inline"
                          title={contributors.join(', ')}
                        >
                          {contributorLabel}
                        </span>
                      )}
                      {badgeText ? (
                        <span className="shrink-0 rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                          {badgeText}
                        </span>
                      ) : null}
                    </button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="shrink-0 rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-border-emphasis)] hover:text-[var(--color-text)]"
                          onClick={() => onViewChanges(task.id)}
                          aria-label={t('taskDetail.changes.reviewTaskDiff')}
                        >
                          <GitCompareArrows size={13} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        {t('taskDetail.changes.reviewDiff')}
                      </TooltipContent>
                    </Tooltip>
                  </div>

                  {summary.error ? (
                    <div className="flex items-center gap-2 py-1.5 pl-8 pr-2 text-xs text-red-400">
                      <AlertTriangle size={13} className="shrink-0" />
                      <span className="min-w-0 truncate">{summary.error}</span>
                    </div>
                  ) : null}

                  {diagnosticMessages.length ? (
                    <div className="space-y-1 py-1.5 pl-8 pr-2">
                      {diagnosticMessages.slice(0, 2).map((message) => (
                        <div
                          key={message}
                          className={`flex items-center gap-2 text-xs ${
                            reviewability === 'attention_required'
                              ? 'text-[var(--step-warning-text)]'
                              : 'text-[var(--color-text-muted)]'
                          }`}
                        >
                          {reviewability === 'attention_required' ? (
                            <AlertTriangle size={13} className="shrink-0" />
                          ) : (
                            <Info size={13} className="shrink-0" />
                          )}
                          <span className="min-w-0 truncate">{message}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {visibleFiles.length > 0 ? (
                    <div className="py-0.5">
                      {visibleFiles.map((file) => (
                        <div
                          key={`${summary.taskId}:${file.filePath}`}
                          role="button"
                          tabIndex={0}
                          title={getVisibleFilePath(file)}
                          className="group flex w-full cursor-pointer items-center gap-2 py-1.5 pl-8 pr-2 text-left text-xs transition-colors hover:bg-[var(--color-surface-raised)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-emphasis)]"
                          onClick={() => onViewChanges(task.id, file.filePath)}
                          onKeyDown={(event) => {
                            if (event.target !== event.currentTarget) return;
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              onViewChanges(task.id, file.filePath);
                            }
                          }}
                        >
                          <FileIcon fileName={getVisibleFileName(file)} className="size-3.5" />
                          <span className="min-w-0 flex-1 truncate text-left font-mono text-[var(--color-text-secondary)] transition-colors group-hover:text-[var(--color-text)]">
                            {getVisibleFilePath(file)}
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
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-border-emphasis)] hover:text-[var(--color-text)]"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    onViewChanges(task.id, file.filePath);
                                  }}
                                  aria-label={t('taskDetail.changes.reviewDiff')}
                                >
                                  <GitCompareArrows size={13} />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent side="top">
                                {t('taskDetail.changes.reviewDiff')}
                              </TooltipContent>
                            </Tooltip>
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {files.length > visibleFiles.length && fileBudget > 0 ? (
                    <div className="py-1.5 pl-8 pr-2 text-xs text-[var(--color-text-muted)]">
                      {t('taskDetail.changes.moreFiles', {
                        count: files.length - visibleFiles.length,
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
            {loading || refreshing ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 size={11} className="animate-spin" />
                {t('taskDetail.changes.refreshing')}
              </span>
            ) : null}
            {error ? (
              <span className="text-red-400">
                {t('taskDetail.changes.refreshFailed', { error })}
              </span>
            ) : null}
            {hiddenFileRows > 0 ? (
              <span>{t('taskDetail.changes.fileRowsHidden', { count: hiddenFileRows })}</span>
            ) : null}
            {stats.deferredCount > 0 ? (
              <span>{t('taskDetail.changes.tasksDeferred', { count: stats.deferredCount })}</span>
            ) : null}
          </div>
        </div>
      ) : loading || refreshing ? (
        <div className="flex items-center gap-2 py-2 text-xs text-[var(--color-text-muted)]">
          <Loader2 size={14} className="animate-spin" />
          {loading ? t('taskDetail.changes.loading') : t('taskDetail.changes.refreshingChanges')}
        </div>
      ) : error ? (
        <p className="text-xs text-red-400">{error}</p>
      ) : (
        <div className="space-y-1 py-1">
          <p className="text-xs text-[var(--color-text-muted)]">
            {t('taskDetail.changes.empty.noFileChangesRecorded')}
          </p>
          {stats.eligibleCount > 0 ? (
            <p className="text-[10px] text-[var(--color-text-muted)]">
              {t('taskDetail.changes.scannedCandidateTasks', {
                requested: stats.requestedCount,
                eligible: stats.eligibleCount,
              })}
            </p>
          ) : null}
        </div>
      )}
    </CollapsibleTeamSection>
  );
});

TeamChangesSection.displayName = 'TeamChangesSection';
