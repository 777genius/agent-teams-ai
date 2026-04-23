import { useMemo } from 'react';

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
import { deriveTaskDisplayId } from '@shared/utils/taskIdentity';
import { AlertTriangle, GitBranch, Loader2, MessageSquare, Plus } from 'lucide-react';

import { CurrentTaskIndicator } from './CurrentTaskIndicator';

import type { TaskStatusCounts } from '@renderer/utils/pathNormalize';
import type {
  LeadActivityState,
  MemberLaunchState,
  MemberSpawnLivenessSource,
  MemberSpawnStatus,
  ResolvedTeamMember,
  TeamTaskWithKanban,
} from '@shared/types';

interface MemberCardProps {
  member: ResolvedTeamMember;
  memberColor: string;
  runtimeSummary?: string;
  taskCounts?: TaskStatusCounts | null;
  isTeamAlive?: boolean;
  isTeamProvisioning?: boolean;
  leadActivity?: LeadActivityState;
  currentTask?: TeamTaskWithKanban | null;
  reviewTask?: TeamTaskWithKanban | null;
  isAwaitingReply?: boolean;
  isRemoved?: boolean;
  spawnStatus?: MemberSpawnStatus;
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
  taskCounts,
  isTeamAlive,
  isTeamProvisioning,
  leadActivity,
  currentTask,
  reviewTask,
  isAwaitingReply,
  isRemoved,
  spawnStatus,
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
}: MemberCardProps): React.JSX.Element => {
  // NOTE: lead context display disabled — usage formula is inaccurate
  // const teamName = useStore((s) => s.selectedTeamName);
  // const leadContext = useStore((s) =>
  //   member.agentType === 'team-lead' && teamName ? s.leadContextByTeam[teamName] : undefined
  // );
  const selectedTeamName = useStore((s) => s.selectedTeamName);
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
    launchVisualState === 'runtime_pending' || launchVisualState === 'permission_pending'
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
      launchVisualState === 'runtime_pending');
  const launchBadgeLabel = presenceLabel === 'starting' ? presenceLabel : displayPresenceLabel;
  const showRuntimeAdvisoryBadge =
    !isRemoved &&
    Boolean(runtimeAdvisoryLabel) &&
    !showLaunchBadge &&
    spawnStatus !== 'error' &&
    (Boolean(activityTask) || !isAwaitingReply);

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
              className="rounded-full border-2 p-[1px]"
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
                {memoryLabel ? <span className="shrink-0">{memoryLabel}</span> : null}
              </div>
            ) : null}
          </div>
          {showLaunchBadge ? (
            <span className="flex shrink-0 items-center gap-1">
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
          ) : spawnStatus === 'error' ? (
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
