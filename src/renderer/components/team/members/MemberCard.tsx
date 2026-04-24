import { useMemo, useState } from 'react';

import { Badge } from '@renderer/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { useStore } from '@renderer/store';
import { selectResolvedMembersForTeamName } from '@renderer/store/slices/teamSlice';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import {
  agentAvatarUrl,
  buildMemberAvatarMap,
  buildMemberLaunchPresentation,
  displayMemberName,
} from '@renderer/utils/memberHelpers';
import {
  buildMemberLaunchDiagnosticsPayload,
  hasMemberLaunchDiagnosticsDetails,
  hasMemberLaunchDiagnosticsError,
} from '@renderer/utils/memberLaunchDiagnostics';
import { getRuntimeMemorySourceLabel } from '@renderer/utils/memberRuntimeSummary';
import { deriveTaskDisplayId } from '@shared/utils/taskIdentity';
import { isLeadMember } from '@shared/utils/leadDetection';
import {
  AlertTriangle,
  Ban,
  GitBranch,
  Loader2,
  MessageSquare,
  Plus,
  RotateCcw,
} from 'lucide-react';

import { CurrentTaskIndicator } from './CurrentTaskIndicator';
import { MemberLaunchDiagnosticsButton } from './MemberLaunchDiagnosticsButton';

import type { TaskStatusCounts } from '@renderer/utils/pathNormalize';
import type {
  LeadActivityState,
  MemberLaunchState,
  MemberSpawnLivenessSource,
  MemberSpawnStatus,
  MemberSpawnStatusEntry,
  ResolvedTeamMember,
  TeamAgentRuntimeEntry,
  TeamTaskWithKanban,
} from '@shared/types';

interface MemberCardProps {
  member: ResolvedTeamMember;
  memberColor: string;
  runtimeSummary?: string;
  runtimeEntry?: TeamAgentRuntimeEntry;
  runtimeRunId?: string | null;
  taskCounts?: TaskStatusCounts | null;
  isTeamAlive?: boolean;
  isTeamProvisioning?: boolean;
  leadActivity?: LeadActivityState;
  currentTask?: TeamTaskWithKanban | null;
  reviewTask?: TeamTaskWithKanban | null;
  isAwaitingReply?: boolean;
  isRemoved?: boolean;
  spawnStatus?: MemberSpawnStatus;
  spawnEntry?: MemberSpawnStatusEntry;
  spawnError?: string;
  spawnLivenessSource?: MemberSpawnLivenessSource;
  spawnLaunchState?: MemberLaunchState;
  spawnRuntimeAlive?: boolean;
  isLaunchSettling?: boolean;
  onOpenTask?: () => void;
  onOpenReviewTask?: () => void;
  onClick?: () => void;
  onSendMessage?: () => void;
  onAssignTask?: () => void;
  onRestartMember?: (memberName: string) => Promise<void> | void;
  onSkipMemberForLaunch?: (memberName: string) => Promise<void> | void;
}

function splitRuntimeSummaryMemory(runtimeSummary: string | undefined): {
  summary: string | undefined;
  memory: string | undefined;
} {
  const trimmed = runtimeSummary?.trim();
  if (!trimmed) {
    return { summary: undefined, memory: undefined };
  }

  const match = /^(.*?)(?:\s·\s(\d+(?:\.\d+)?\s(?:B|KB|MB|GB|TB)))$/.exec(trimmed);
  if (!match) {
    return { summary: trimmed, memory: undefined };
  }

  return {
    summary: match[1]?.trim() || undefined,
    memory: match[2]?.trim() || undefined,
  };
}

export const MemberCard = ({
  member,
  memberColor,
  runtimeSummary,
  runtimeEntry,
  runtimeRunId,
  taskCounts,
  isTeamAlive,
  isTeamProvisioning,
  leadActivity,
  currentTask,
  reviewTask,
  isAwaitingReply,
  isRemoved,
  spawnStatus,
  spawnEntry,
  spawnError,
  spawnLivenessSource,
  spawnLaunchState,
  spawnRuntimeAlive,
  isLaunchSettling,
  onOpenTask,
  onOpenReviewTask,
  onClick,
  onSendMessage,
  onAssignTask,
  onRestartMember,
  onSkipMemberForLaunch,
}: MemberCardProps): React.JSX.Element => {
  // NOTE: lead context display disabled — usage formula is inaccurate
  // const teamName = useStore((s) => s.selectedTeamName);
  // const leadContext = useStore((s) =>
  //   member.agentType === 'team-lead' && teamName ? s.leadContextByTeam[teamName] : undefined
  // );
  const selectedTeamName = useStore((s) => s.selectedTeamName);
  const [retryingLaunch, setRetryingLaunch] = useState(false);
  const [retryLaunchError, setRetryLaunchError] = useState<string | null>(null);
  const [skippingLaunch, setSkippingLaunch] = useState(false);
  const [skipLaunchError, setSkipLaunchError] = useState<string | null>(null);
  const teamMembers = useStore((s) =>
    selectedTeamName ? selectResolvedMembersForTeamName(s, selectedTeamName) : []
  );
  const avatarMap = useMemo(() => buildMemberAvatarMap(teamMembers), [teamMembers]);
  const launchPresentation = buildMemberLaunchPresentation({
    member,
    spawnStatus,
    spawnLaunchState,
    spawnLivenessSource,
    spawnRuntimeAlive,
    runtimeEntry,
    runtimeAdvisory: member.runtimeAdvisory,
    isLaunchSettling,
    isTeamAlive,
    isTeamProvisioning,
    leadActivity,
  });
  const dotClass = launchPresentation.dotClass;
  const runtimeAdvisoryLabel = launchPresentation.runtimeAdvisoryLabel;
  const runtimeAdvisoryTitle = launchPresentation.runtimeAdvisoryTitle;
  const runtimeAdvisoryTone = launchPresentation.runtimeAdvisoryTone;
  const presenceLabel = launchPresentation.presenceLabel;
  const spawnCardClass = launchPresentation.cardClass;
  const launchVisualState = launchPresentation.launchVisualState;
  const launchStatusLabel = launchPresentation.launchStatusLabel;
  const displayPresenceLabel =
    launchVisualState === 'runtime_pending' ||
    launchVisualState === 'permission_pending' ||
    launchVisualState === 'shell_only' ||
    launchVisualState === 'runtime_candidate' ||
    launchVisualState === 'registered_only' ||
    launchVisualState === 'stale_runtime'
      ? (launchStatusLabel ?? presenceLabel)
      : presenceLabel;
  const colors = getTeamColorSet(memberColor);
  const { isLight } = useTheme();
  const pending = taskCounts?.pending ?? 0;
  const inProgress = taskCounts?.inProgress ?? 0;
  const completed = taskCounts?.completed ?? 0;
  const totalTasks = pending + inProgress + completed;
  const progressPercent = totalTasks > 0 ? Math.round((completed / totalTasks) * 100) : 0;
  const roleLabel = formatAgentRole(member.role) ?? formatAgentRole(member.agentType);
  const { summary: runtimeSummaryText, memory: memoryLabel } =
    splitRuntimeSummaryMemory(runtimeSummary);
  const memorySourceLabel = getRuntimeMemorySourceLabel(runtimeEntry);
  const activityTask = currentTask ?? reviewTask ?? null;
  const activityTitle = currentTask
    ? `Current task: #${deriveTaskDisplayId(currentTask.id)}`
    : reviewTask
      ? `Reviewing task: #${deriveTaskDisplayId(reviewTask.id)}`
      : undefined;
  const showStartingSkeleton =
    !isRemoved &&
    presenceLabel === 'starting' &&
    spawnLaunchState !== 'failed_to_start' &&
    !activityTask &&
    !runtimeSummary;
  const showLaunchBadge =
    !isRemoved &&
    !activityTask &&
    !runtimeAdvisoryLabel &&
    (presenceLabel === 'starting' ||
      presenceLabel === 'connecting' ||
      launchVisualState === 'runtime_pending' ||
      launchVisualState === 'shell_only' ||
      launchVisualState === 'runtime_candidate' ||
      launchVisualState === 'registered_only' ||
      launchVisualState === 'stale_runtime');
  const launchBadgeLabel = presenceLabel === 'starting' ? presenceLabel : displayPresenceLabel;
  const launchDiagnosticsPayload = useMemo(
    () =>
      buildMemberLaunchDiagnosticsPayload({
        teamName: selectedTeamName,
        runId: runtimeRunId,
        memberName: member.name,
        spawnStatus,
        launchState: spawnLaunchState,
        livenessSource: spawnLivenessSource,
        spawnEntry,
        runtimeEntry,
      }),
    [
      member.name,
      runtimeEntry,
      runtimeRunId,
      selectedTeamName,
      spawnEntry,
      spawnLaunchState,
      spawnLivenessSource,
      spawnStatus,
    ]
  );
  const showCopyDiagnostics =
    !isRemoved &&
    hasMemberLaunchDiagnosticsError(launchDiagnosticsPayload) &&
    hasMemberLaunchDiagnosticsDetails(launchDiagnosticsPayload);
  const isFailedLaunch = spawnStatus === 'error' || spawnLaunchState === 'failed_to_start';
  const isSkippedLaunch =
    spawnStatus === 'skipped' ||
    spawnLaunchState === 'skipped_for_launch' ||
    spawnEntry?.skippedForLaunch === true;
  const showFailedLaunchBadge = !isRemoved && isFailedLaunch;
  const showSkippedLaunchBadge = !isRemoved && isSkippedLaunch;
  const hasLiveLaunchControls =
    isTeamAlive === true || isTeamProvisioning === true || isLaunchSettling === true;
  const canRetryLaunch =
    (showFailedLaunchBadge || showSkippedLaunchBadge) &&
    !isLeadMember(member) &&
    Boolean(onRestartMember) &&
    hasLiveLaunchControls;
  const canSkipFailedLaunch =
    showFailedLaunchBadge &&
    !isLeadMember(member) &&
    Boolean(onSkipMemberForLaunch) &&
    hasLiveLaunchControls;
  const showRuntimeAdvisoryBadge =
    !isRemoved &&
    Boolean(runtimeAdvisoryLabel) &&
    !showLaunchBadge &&
    !isFailedLaunch &&
    !isSkippedLaunch &&
    (Boolean(activityTask) || !isAwaitingReply);
  const handleRetryFailedLaunch = async (
    event: React.MouseEvent<HTMLButtonElement>
  ): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();
    if (!onRestartMember || retryingLaunch) {
      return;
    }
    setRetryLaunchError(null);
    setRetryingLaunch(true);
    try {
      await onRestartMember(member.name);
    } catch (error) {
      setRetryLaunchError(error instanceof Error ? error.message : 'Failed to retry teammate');
    } finally {
      setRetryingLaunch(false);
    }
  };
  const handleSkipFailedLaunch = async (
    event: React.MouseEvent<HTMLButtonElement>
  ): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();
    if (!onSkipMemberForLaunch || skippingLaunch) {
      return;
    }
    setSkipLaunchError(null);
    setSkippingLaunch(true);
    try {
      await onSkipMemberForLaunch(member.name);
    } catch (error) {
      setSkipLaunchError(error instanceof Error ? error.message : 'Failed to skip teammate');
    } finally {
      setSkippingLaunch(false);
    }
  };

  return (
    <div
      className={`rounded transition-opacity duration-300 ${isRemoved ? 'opacity-50' : ''} ${spawnCardClass}`}
    >
      <div
        className="group relative cursor-pointer rounded py-1.5"
        style={undefined}
        title={activityTitle}
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick?.();
          }
        }}
      >
        <div className="pointer-events-none absolute inset-0 rounded transition-colors group-hover:bg-white/5" />
        <div className="flex items-center gap-2.5">
          <div className="relative shrink-0">
            <div
              className="rounded-full border-2 p-px"
              style={{
                borderColor: colors.border,
                boxShadow: isLight ? 'none' : `0 0 0 1px ${colors.badge}`,
              }}
            >
              <img
                src={avatarMap.get(member.name) ?? agentAvatarUrl(member.name)}
                alt={member.name}
                className="size-7 rounded-full bg-[var(--color-surface-raised)]"
                loading="lazy"
              />
            </div>
            <span
              className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-[var(--color-surface)] ${dotClass}`}
              aria-label={displayPresenceLabel}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5 text-sm">
              <span className="shrink-0 font-medium text-[var(--color-text)]">
                {displayMemberName(member.name)}
              </span>
              {member.gitBranch ? (
                <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-[var(--color-text-muted)]">
                  <GitBranch size={10} />
                  {member.gitBranch}
                </span>
              ) : null}
              {currentTask ? (
                <CurrentTaskIndicator
                  task={currentTask}
                  borderColor={colors.border}
                  activityLabel="working on"
                  onOpenTask={onOpenTask}
                />
              ) : null}
              {reviewTask ? (
                <CurrentTaskIndicator
                  task={reviewTask}
                  borderColor={colors.border}
                  activityLabel="reviewing"
                  onOpenTask={onOpenReviewTask}
                />
              ) : null}
              {!activityTask && isAwaitingReply ? (
                <>
                  {runtimeAdvisoryTone === 'error' ? (
                    <AlertTriangle className="size-3 shrink-0 text-red-400" />
                  ) : (
                    <Loader2
                      className={`size-3 shrink-0 animate-spin ${runtimeAdvisoryLabel ? 'text-amber-400' : ''}`}
                      style={runtimeAdvisoryLabel ? undefined : { color: colors.border }}
                    />
                  )}
                  <span
                    className={`shrink-0 text-[10px] ${
                      runtimeAdvisoryTone === 'error'
                        ? 'text-red-300'
                        : runtimeAdvisoryLabel
                          ? 'text-amber-300'
                          : 'text-[var(--color-text-muted)]'
                    }`}
                    title={runtimeAdvisoryTitle ?? 'Message sent, awaiting reply'}
                  >
                    {runtimeAdvisoryLabel ?? 'awaiting reply'}
                  </span>
                </>
              ) : null}
            </div>
            {showStartingSkeleton ? (
              <div className="mt-1 flex items-center gap-1.5" aria-hidden="true">
                <div
                  className="skeleton-shimmer h-2 w-24 rounded-sm"
                  style={{ backgroundColor: 'var(--skeleton-base-dim)' }}
                />
                <div
                  className="skeleton-shimmer h-2 w-16 rounded-sm"
                  style={{ backgroundColor: 'var(--skeleton-base)' }}
                />
              </div>
            ) : runtimeSummaryText || roleLabel || memoryLabel ? (
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] font-medium text-[var(--color-text-muted)]">
                {runtimeSummaryText ? (
                  <span className="min-w-0 truncate">{runtimeSummaryText}</span>
                ) : null}
                {runtimeSummaryText && roleLabel ? (
                  <span className="shrink-0 opacity-60">•</span>
                ) : null}
                {roleLabel ? <span className="shrink-0">{roleLabel}</span> : null}
                {(runtimeSummaryText || roleLabel) && memoryLabel ? (
                  <span className="shrink-0 opacity-60">•</span>
                ) : null}
                {memoryLabel ? (
                  <span className="shrink-0" title={memorySourceLabel}>
                    {memoryLabel}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          {showLaunchBadge ? (
            <span
              className="flex shrink-0 items-center gap-1"
              title={runtimeEntry?.runtimeDiagnostic}
            >
              <Loader2
                className="size-3.5 shrink-0 animate-spin text-[var(--color-text-muted)]"
                aria-label={launchBadgeLabel}
              />
              <Badge
                variant="secondary"
                className="shrink-0 px-1.5 py-0.5 text-[10px] font-normal leading-none text-[var(--color-text-muted)]"
              >
                {launchBadgeLabel}
              </Badge>
            </span>
          ) : showFailedLaunchBadge ? (
            <span className="flex shrink-0 items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex shrink-0 items-center gap-1">
                    <AlertTriangle className="size-3.5 shrink-0 text-red-400" />
                    <Badge
                      variant="secondary"
                      className="shrink-0 bg-red-500/15 px-1.5 py-0.5 text-[10px] font-normal leading-none text-red-400"
                    >
                      {displayPresenceLabel}
                    </Badge>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">{spawnError ?? 'Spawn failed'}</TooltipContent>
              </Tooltip>
              {showCopyDiagnostics ? (
                <MemberLaunchDiagnosticsButton
                  payload={launchDiagnosticsPayload}
                  className="size-auto rounded p-1 text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200"
                />
              ) : null}
              {canSkipFailedLaunch ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={skippingLaunch ? 'Skipping teammate' : 'Skip for this launch'}
                      className="rounded p-1 text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={skippingLaunch || retryingLaunch}
                      onClick={handleSkipFailedLaunch}
                    >
                      {skippingLaunch ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Ban className="size-3.5" />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {skipLaunchError ??
                      (skippingLaunch ? 'Skipping teammate...' : 'Skip for this launch')}
                  </TooltipContent>
                </Tooltip>
              ) : null}
              {canRetryLaunch ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={retryingLaunch ? 'Retrying teammate' : 'Retry teammate'}
                      className="rounded p-1 text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={retryingLaunch || skippingLaunch}
                      onClick={handleRetryFailedLaunch}
                    >
                      {retryingLaunch ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="size-3.5" />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {retryLaunchError ??
                      (retryingLaunch ? 'Retrying teammate...' : 'Retry teammate')}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </span>
          ) : showSkippedLaunchBadge ? (
            <span className="flex shrink-0 items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex shrink-0 items-center gap-1">
                    <Ban className="size-3.5 shrink-0 text-zinc-400" />
                    <Badge
                      variant="secondary"
                      className="shrink-0 bg-zinc-500/15 px-1.5 py-0.5 text-[10px] font-normal leading-none text-zinc-300"
                    >
                      {displayPresenceLabel}
                    </Badge>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {spawnEntry?.skipReason ?? 'Skipped for this launch'}
                </TooltipContent>
              </Tooltip>
              {canRetryLaunch ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={retryingLaunch ? 'Retrying teammate' : 'Retry teammate'}
                      className="rounded p-1 text-zinc-300 transition-colors hover:bg-zinc-500/10 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={retryingLaunch}
                      onClick={handleRetryFailedLaunch}
                    >
                      {retryingLaunch ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="size-3.5" />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {retryLaunchError ??
                      (retryingLaunch ? 'Retrying teammate...' : 'Retry teammate')}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </span>
          ) : showRuntimeAdvisoryBadge ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex shrink-0 items-center gap-1">
                  <AlertTriangle
                    className={`size-3.5 shrink-0 ${
                      runtimeAdvisoryTone === 'error' ? 'text-red-400' : 'text-amber-400'
                    }`}
                  />
                  <Badge
                    variant="secondary"
                    className={`shrink-0 px-1.5 py-0.5 text-[10px] font-normal leading-none ${
                      runtimeAdvisoryTone === 'error'
                        ? 'bg-red-500/15 text-red-300'
                        : 'bg-amber-500/15 text-amber-300'
                    }`}
                    title={runtimeAdvisoryTitle}
                  >
                    {runtimeAdvisoryLabel}
                  </Badge>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {runtimeAdvisoryTitle ?? runtimeAdvisoryLabel}
              </TooltipContent>
            </Tooltip>
          ) : !activityTask ? (
            <Badge
              variant="secondary"
              className={`shrink-0 px-1.5 py-0.5 text-[10px] font-normal leading-none ${isRemoved ? 'bg-zinc-600 text-zinc-300' : 'text-[var(--color-text-muted)]'}`}
              title={isRemoved ? 'This member has been removed' : activityTitle}
            >
              {isRemoved ? 'removed' : displayPresenceLabel}
            </Badge>
          ) : null}
          {showStartingSkeleton ? (
            <div className="shrink-0" aria-hidden="true">
              <div
                className="skeleton-shimmer h-[18px] w-[62px] rounded-full border"
                style={{
                  backgroundColor: 'var(--skeleton-base-dim)',
                  borderColor: 'var(--color-border)',
                }}
              />
              <div
                className="skeleton-shimmer mx-1 mt-1 h-[2px] w-10 rounded-full"
                style={{ backgroundColor: 'var(--skeleton-base)' }}
              />
            </div>
          ) : (
            <div
              className="shrink-0"
              title={totalTasks > 0 ? `${completed}/${totalTasks} completed` : undefined}
            >
              <Badge
                variant="secondary"
                className="shrink-0 px-1.5 py-0.5 text-[10px] font-normal leading-none"
              >
                {member.taskCount} {member.taskCount === 1 ? 'task' : 'tasks'}
              </Badge>
              {totalTasks > 0 && (
                <div className="mx-0.5 mt-0.5 h-[2px] rounded-full bg-[var(--color-border)]">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              )}
              {/* NOTE: lead context bar disabled — usage formula is inaccurate */}
            </div>
          )}
          {!isRemoved && (
            <div className="flex shrink-0 items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSendMessage?.();
                    }}
                  >
                    <MessageSquare size={13} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Send message</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAssignTask?.();
                    }}
                  >
                    <Plus size={13} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Assign task</TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
