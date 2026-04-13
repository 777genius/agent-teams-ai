import { Badge } from '@renderer/components/ui/badge';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card';
import {
  getTeamColorSet,
  getThemedBadge,
  getThemedBorder,
  getThemedText,
} from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { useStore } from '@renderer/store';
import { getCurrentProvisioningProgressForTeam } from '@renderer/store/slices/teamSlice';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import {
  agentAvatarUrl,
  buildMemberLaunchPresentation,
  displayMemberName,
} from '@renderer/utils/memberHelpers';
import { isLeadMember } from '@shared/utils/leadDetection';
import { ExternalLink } from 'lucide-react';

import { getLaunchJoinMilestonesFromMembers, getLaunchJoinState } from '../provisioningSteps';

import { CurrentTaskIndicator } from './CurrentTaskIndicator';

import type { LeadActivityState, TeamTaskWithKanban } from '@shared/types';

interface MemberHoverCardProps {
  /** The member name to look up */
  name: string;
  /** Color key for the member */
  color?: string;
  /** Owning team context for store lookups. */
  teamName?: string;
  /** Called when user clicks on the current task */
  onOpenTask?: (task: TeamTaskWithKanban) => void;
  children: React.ReactNode;
}

/**
 * Wraps children in a HoverCard that shows member info on hover.
 * Reads member data from the store (selectedTeamData.members).
 * Falls back to a simple wrapper when member data is unavailable.
 */
export const MemberHoverCard = ({
  name,
  color,
  teamName,
  onOpenTask,
  children,
}: MemberHoverCardProps): React.JSX.Element => {
  const { isLight } = useTheme();
  const selectedTeamName = useStore((s) => s.selectedTeamName);
  const effectiveTeamName = teamName ?? selectedTeamName;
  const {
    member,
    members,
    isTeamAlive,
    progress,
    memberSpawnSnapshot,
    memberSpawnStatuses,
    spawnEntry,
    leadActivity,
  } = useStore((s) => {
    const isSelectedTeam = Boolean(effectiveTeamName && s.selectedTeamName === effectiveTeamName);
    const selectedTeamData = isSelectedTeam ? s.selectedTeamData : null;
    return {
      member: selectedTeamData?.members.find((m) => m.name === name) ?? null,
      members: selectedTeamData?.members ?? [],
      isTeamAlive: selectedTeamData?.isAlive,
      progress: effectiveTeamName
        ? getCurrentProvisioningProgressForTeam(s, effectiveTeamName)
        : null,
      memberSpawnSnapshot: effectiveTeamName
        ? s.memberSpawnSnapshotsByTeam[effectiveTeamName]
        : undefined,
      memberSpawnStatuses: effectiveTeamName
        ? s.memberSpawnStatusesByTeam[effectiveTeamName]
        : undefined,
      spawnEntry: effectiveTeamName
        ? s.memberSpawnStatusesByTeam[effectiveTeamName]?.[name]
        : undefined,
      leadActivity: effectiveTeamName ? s.leadActivityByTeam[effectiveTeamName] : undefined,
    };
  });
  const openMemberProfile = useStore((s) => s.openMemberProfile);
  const tasks = useStore((s) =>
    effectiveTeamName && s.selectedTeamName === effectiveTeamName
      ? s.selectedTeamData?.tasks
      : undefined
  );

  if (!member) {
    return <>{children}</>;
  }

  const launchJoinMilestones = getLaunchJoinMilestonesFromMembers({
    members,
    memberSpawnStatuses,
    memberSpawnSnapshot,
  });
  const isLaunchSettling =
    progress?.state === 'ready' && getLaunchJoinState(launchJoinMilestones).hasMembersStillJoining;
  const colors = getTeamColorSet(color ?? member.color ?? '');
  const roleLabel = formatAgentRole(member.role) ?? formatAgentRole(member.agentType);
  const launchPresentation = buildMemberLaunchPresentation({
    member,
    spawnStatus: spawnEntry?.status,
    spawnLaunchState: spawnEntry?.launchState,
    spawnLivenessSource: spawnEntry?.livenessSource,
    spawnRuntimeAlive: spawnEntry?.runtimeAlive,
    runtimeAdvisory: member.runtimeAdvisory,
    isLaunchSettling,
    isTeamAlive,
    isTeamProvisioning: false,
    leadActivity: isLeadMember(member) ? leadActivity : undefined,
  });
  const presenceLabel = launchPresentation.presenceLabel;
  const dotClass = launchPresentation.dotClass;
  const runtimeAdvisoryTitle = launchPresentation.runtimeAdvisoryTitle;
  const currentTask: TeamTaskWithKanban | null =
    member.currentTaskId && tasks
      ? (tasks.find((t) => t.id === member.currentTaskId) ?? null)
      : null;
  const reviewTask: TeamTaskWithKanban | null = tasks
    ? (tasks.find(
        (task) =>
          task.reviewer === member.name &&
          task.id !== member.currentTaskId &&
          (task.reviewState === 'review' || task.kanbanColumn === 'review')
      ) ?? null)
    : null;

  return (
    <HoverCard openDelay={300} closeDelay={200}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent side="top" align="start" sideOffset={8}>
        <div className="flex flex-col gap-2.5">
          {/* Header: avatar + name + presence */}
          <div className="flex items-center gap-3">
            <div className="relative shrink-0">
              <img
                src={agentAvatarUrl(member.name, 64)}
                alt={member.name}
                className="size-10 rounded-full bg-[var(--color-surface-raised)]"
                loading="lazy"
              />
              <span
                className={`absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-[var(--color-surface)] ${dotClass}`}
                aria-label={presenceLabel}
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span
                  className="truncate text-sm font-semibold"
                  style={{ color: getThemedText(colors, isLight) }}
                >
                  {displayMemberName(member.name)}
                </span>
                <Badge
                  variant="secondary"
                  className="shrink-0 px-1.5 py-0 text-[10px] font-normal leading-tight"
                  title={runtimeAdvisoryTitle}
                  style={{
                    backgroundColor: getThemedBadge(colors, isLight),
                    color: getThemedText(colors, isLight),
                    border: `1px solid ${getThemedBorder(colors, isLight)}40`,
                  }}
                >
                  {presenceLabel}
                </Badge>
              </div>
              {roleLabel && (
                <span className="text-xs text-[var(--color-text-muted)]">{roleLabel}</span>
              )}
            </div>
          </div>

          {/* Current task */}
          {currentTask && (
            <div className="flex items-center gap-1 overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5">
              <CurrentTaskIndicator
                task={currentTask}
                borderColor={colors.border}
                maxSubjectLength={28}
                activityLabel="working on"
                onOpenTask={onOpenTask ? () => onOpenTask(currentTask) : undefined}
              />
            </div>
          )}

          {/* Review task */}
          {reviewTask && (
            <div className="flex items-center gap-1 overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5">
              <CurrentTaskIndicator
                task={reviewTask}
                borderColor={colors.border}
                maxSubjectLength={28}
                activityLabel="reviewing"
                onOpenTask={onOpenTask ? () => onOpenTask(reviewTask) : undefined}
              />
            </div>
          )}

          {/* Open profile button */}
          <button
            type="button"
            className="flex w-full items-center justify-center gap-1.5 rounded border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
            onClick={(e) => {
              e.stopPropagation();
              openMemberProfile(member.name);
            }}
          >
            <ExternalLink size={12} />
            Open profile
          </button>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
};
