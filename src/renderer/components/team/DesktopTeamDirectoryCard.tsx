import { useAppTranslation } from '@features/localization/renderer';
import { TeamDirectoryRowHeading } from '@features/team-directory/renderer';
import { Badge } from '@renderer/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import {
  getTeamColorSet,
  getThemedBorder,
  type TeamColorSet,
} from '@renderer/constants/teamColors';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { normalizePath, type TaskStatusCounts } from '@renderer/utils/pathNormalize';
import { buildPendingRuntimeSummaryCopy } from '@renderer/utils/teamLaunchSummaryCopy';
import { Copy, FolderOpen, GitBranch, Play, Square, Trash2, UsersRound } from 'lucide-react';

import { formatTeamProjectPathName } from './teamListPresentation';
import { TeamStatusBadge } from './TeamStatusBadge';
import { TeamTaskStatusSummary } from './TeamTaskStatusSummary';

import type { TeamLaunchDialogMode } from './dialogs/LaunchTeamDialog';
import type { TeamStatus } from '@renderer/utils/teamListStatus';
import type { TeamSummary, TeamSummaryMember } from '@shared/types';

function getRecentProjects(team: TeamSummary): string[] {
  const history = team.projectPathHistory;
  if (!history || history.length === 0) {
    return team.projectPath ? [team.projectPath] : [];
  }
  return history.slice(-3).reverse();
}

export const DesktopTeamDirectoryMemberNames = ({
  members,
}: {
  members: TeamSummaryMember[];
}): React.JSX.Element => {
  const teamColorMap = buildMemberColorMap(members);
  return (
    <>
      {members.map((m) => {
        const resolvedColor = teamColorMap.get(m.name);
        const memberColor = resolvedColor ? getTeamColorSet(resolvedColor) : null;
        return (
          <span key={m.name} className="inline-flex items-center gap-1">
            <span
              className="text-[10px] font-medium tracking-wide"
              style={memberColor ? { color: memberColor.text } : undefined}
            >
              {m.name}
            </span>
            {m.role ? (
              <span className="text-[9px] text-[var(--color-text-muted)]">{m.role}</span>
            ) : null}
          </span>
        );
      })}
    </>
  );
};

function renderTeamRecentPaths(
  team: TeamSummary,
  status: TeamStatus,
  matchesCurrentProject: boolean,
  isLight: boolean,
  selectedProjectPath: string | null
): React.JSX.Element | null {
  const recentPaths = getRecentProjects(team);
  const visibleRecentPaths =
    matchesCurrentProject && selectedProjectPath
      ? recentPaths.filter((path) => normalizePath(path) !== normalizePath(selectedProjectPath))
      : recentPaths;
  if (visibleRecentPaths.length === 0) return null;
  return (
    <div className="mt-2 flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
      {matchesCurrentProject && !selectedProjectPath ? (
        <span
          className={`inline-flex items-center gap-1 truncate rounded-full px-2 py-0.5 text-[12px] font-medium ${
            isLight ? 'bg-emerald-100 text-emerald-700' : 'bg-emerald-500/15 text-emerald-400'
          }`}
        >
          <FolderOpen size={12} className="shrink-0" />
          {visibleRecentPaths.map((p, i) => (
            <span key={p} title={p}>
              {formatTeamProjectPathName(p)}
              {i < visibleRecentPaths.length - 1 ? ', ' : ''}
            </span>
          ))}
        </span>
      ) : (
        <>
          <FolderOpen size={10} className="shrink-0" />
          <span className="truncate">
            {visibleRecentPaths.map((p, i) => (
              <span key={p} title={p}>
                {i === 0 && (status === 'active' || status === 'idle') ? (
                  <span className="text-emerald-400">{formatTeamProjectPathName(p)}</span>
                ) : (
                  formatTeamProjectPathName(p)
                )}
                {i < visibleRecentPaths.length - 1 ? ', ' : ''}
              </span>
            ))}
          </span>
        </>
      )}
    </div>
  );
}

type TeamT = ReturnType<typeof useAppTranslation>['t'];

interface ActiveTeamCardProps {
  team: TeamSummary;
  status: TeamStatus;
  runtimeUnknown: boolean;
  unknownLabel: string;
  teamColorSet: TeamColorSet;
  isLight: boolean;
  matchesCurrentProject: boolean;
  currentProjectPath: string | null;
  branchName?: string;
  taskCounts?: TaskStatusCounts;
  launchingTeamName: string | null;
  isStopping: boolean;
  onOpenTeam: (teamName: string, projectPath?: string) => void;
  onLaunchTeam: (
    teamName: string,
    projectPath: string | undefined,
    mode: TeamLaunchDialogMode,
    event: React.MouseEvent
  ) => void;
  onStopTeam: (teamName: string, event: React.MouseEvent) => void;
  onCopyTeam: (teamName: string, event: React.MouseEvent) => void;
  onDeleteTeam: (teamName: string, pendingCreate: boolean, event: React.MouseEvent) => void;
  t: TeamT;
}

export const ActiveTeamCard = ({
  team,
  status,
  runtimeUnknown,
  unknownLabel,
  teamColorSet,
  isLight,
  matchesCurrentProject,
  currentProjectPath,
  branchName,
  taskCounts,
  launchingTeamName,
  isStopping,
  onOpenTeam,
  onLaunchTeam,
  onStopTeam,
  onCopyTeam,
  onDeleteTeam,
  t,
}: Readonly<ActiveTeamCardProps>): React.JSX.Element => {
  const canLaunch =
    !runtimeUnknown &&
    (status === 'offline' ||
      status === 'partial_failure' ||
      status === 'partial_skipped' ||
      status === 'partial_pending') &&
    Boolean(team.projectPath);
  const launchMode: TeamLaunchDialogMode = status === 'offline' ? 'launch' : 'relaunch';
  const launchLabel =
    launchMode === 'relaunch' ? t('list.actions.relaunchTeam') : t('list.actions.launchTeam');
  const launchTitle =
    launchingTeamName === team.teamName ? t('list.actions.launching') : launchLabel;
  const stopTitle = isStopping ? t('list.actions.stopping') : t('list.actions.stopTeam');
  const stopIconClass = isStopping ? 'animate-pulse' : '';
  const copyTitle = t('list.actions.copyTeam');
  const deleteTitle = t('list.actions.deleteTeam');

  return (
    <div className="team-row-zebra-card group relative flex flex-col overflow-hidden rounded-lg border border-[var(--color-border)] p-4 transition-colors duration-200 hover:border-[var(--color-border-emphasis)]">
      <button
        type="button"
        className="absolute inset-0 z-0 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
        aria-label={team.displayName}
        onClick={() => onOpenTeam(team.teamName, team.projectPath ?? undefined)}
      />
      <div className="pointer-events-none relative z-10 flex flex-1 flex-col">
        <div className="space-y-2">
          <TeamDirectoryRowHeading
            displayName={team.displayName}
            status={
              runtimeUnknown ? undefined : (
                <span className="pointer-events-none shrink-0">
                  <TeamStatusBadge status={status} teamName={team.teamName} />
                </span>
              )
            }
            statusLabel={runtimeUnknown ? unknownLabel : undefined}
            statusTone={runtimeUnknown ? 'muted' : undefined}
            className="flex min-w-0 items-start gap-2.5"
            icon={
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-overlay)] transition-colors group-hover:border-[var(--color-border-emphasis)]">
                <UsersRound
                  className="size-4 transition-colors"
                  style={{ color: getThemedBorder(teamColorSet, isLight) }}
                />
              </span>
            }
          />
          <div className="flex min-h-6 items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {branchName ? (
                <span
                  className="flex max-w-full items-center gap-1 rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]"
                  title={branchName}
                >
                  <GitBranch size={10} className="shrink-0" />
                  <span className="truncate">{branchName}</span>
                </span>
              ) : null}
            </div>
            <div className="pointer-events-auto flex shrink-0 gap-1">
              {canLaunch ? (
                <button
                  type="button"
                  className="shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-emerald-500/10 hover:text-emerald-300 disabled:opacity-50 group-hover:opacity-100"
                  onClick={(event) =>
                    onLaunchTeam(team.teamName, team.projectPath ?? undefined, launchMode, event)
                  }
                  disabled={launchingTeamName === team.teamName}
                  aria-label={launchTitle}
                  title={launchTitle}
                >
                  <Play size={14} fill="currentColor" />
                </button>
              ) : null}
              {!runtimeUnknown && (status === 'active' || status === 'idle') ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-amber-500/10 hover:text-amber-300 focus-visible:opacity-100 disabled:opacity-50 group-hover:opacity-100"
                      onClick={(event) => onStopTeam(team.teamName, event)}
                      onKeyDown={(event) => event.stopPropagation()}
                      disabled={isStopping}
                      aria-busy={isStopping}
                      aria-label={stopTitle}
                    >
                      <Square size={14} fill="currentColor" className={stopIconClass} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{stopTitle}</TooltipContent>
                </Tooltip>
              ) : null}
              {!team.pendingCreate ? (
                <button
                  type="button"
                  className="shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-blue-500/10 hover:text-blue-300 group-hover:opacity-100"
                  onClick={(event) => onCopyTeam(team.teamName, event)}
                  aria-label={copyTitle}
                  title={copyTitle}
                >
                  <Copy size={14} />
                </button>
              ) : null}
              <button
                type="button"
                className="shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-300 group-hover:opacity-100"
                onClick={(event) => onDeleteTeam(team.teamName, !!team.pendingCreate, event)}
                aria-label={deleteTitle}
                title={deleteTitle}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        </div>
        <div className="mt-2 flex min-h-10 items-start gap-2">
          <p className="line-clamp-2 min-w-0 flex-1 text-xs text-[var(--color-text-muted)]">
            {team.description || t('list.noDescription')}
          </p>
        </div>
        {team.teamLaunchState === 'partial_pending' ? (
          <p className="mt-2 text-[11px] text-amber-300">
            {team.runtimeProcessPendingCount && team.runtimeProcessPendingCount > 0
              ? buildPendingRuntimeSummaryCopy({
                  confirmedCount: team.confirmedCount,
                  expectedMemberCount: team.expectedMemberCount,
                  memberCount: team.memberCount,
                  runtimeProcessPendingCount: team.runtimeProcessPendingCount,
                  includePeriod: true,
                })
              : t('list.partial.pending')}
          </p>
        ) : team.partialLaunchFailure || team.teamLaunchState === 'partial_failure' ? (
          <p className="mt-2 text-[11px] text-amber-400">
            {team.missingMembers?.length
              ? t('detail.offline.partialMissing', {
                  missing: team.missingMembers.length,
                  expected: team.expectedMemberCount ?? team.missingMembers.length,
                })
              : t('detail.offline.partialFailed')}
          </p>
        ) : team.teamLaunchState === 'partial_skipped' ? (
          <p className="mt-2 text-[11px] text-sky-300">
            {team.skippedMembers?.length
              ? t('list.partial.skippedWithCount', {
                  count: team.skippedMembers.length,
                  expected: team.expectedMemberCount ?? team.skippedMembers.length,
                })
              : t('list.partial.skipped')}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
          {team.members && team.members.length > 0 ? (
            <DesktopTeamDirectoryMemberNames members={team.members} />
          ) : team.memberCount === 0 ? (
            <Badge variant="secondary" className="text-[10px] font-normal">
              {t('list.solo')}
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-[10px] font-normal">
              {t('list.membersCount', { count: team.memberCount })}
            </Badge>
          )}
        </div>
        <div className="mt-auto">
          <TeamTaskStatusSummary counts={taskCounts} />
          {renderTeamRecentPaths(team, status, matchesCurrentProject, isLight, currentProjectPath)}
        </div>
      </div>
    </div>
  );
};
