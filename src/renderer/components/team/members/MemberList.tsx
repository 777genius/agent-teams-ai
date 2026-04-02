import { useCallback, useEffect, useRef, useState } from 'react';

import {
  getTeamEffortLabel,
  getTeamModelLabel,
  getTeamProviderLabel,
} from '@renderer/components/team/dialogs/TeamModelSelector';
import type { TeamLaunchParams } from '@renderer/store/slices/teamSlice';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { isLeadAgentType, isLeadMember } from '@shared/utils/leadDetection';

import { MemberCard } from './MemberCard';

import type { TaskStatusCounts } from '@renderer/utils/pathNormalize';
import type {
  LeadActivityState,
  MemberSpawnStatus,
  ResolvedTeamMember,
  TeamTaskWithKanban,
} from '@shared/types';

export interface MemberSpawnEntry {
  status: MemberSpawnStatus;
  error?: string;
}

interface MemberListProps {
  members: ResolvedTeamMember[];
  memberTaskCounts?: Map<string, TaskStatusCounts>;
  taskMap?: Map<string, TeamTaskWithKanban>;
  pendingRepliesByMember?: Record<string, number>;
  memberSpawnStatuses?: Map<string, MemberSpawnEntry>;
  isTeamAlive?: boolean;
  isTeamProvisioning?: boolean;
  leadActivity?: LeadActivityState;
  launchParams?: TeamLaunchParams;
  onMemberClick?: (member: ResolvedTeamMember) => void;
  onSendMessage?: (member: ResolvedTeamMember) => void;
  onAssignTask?: (member: ResolvedTeamMember) => void;
  onOpenTask?: (task: TeamTaskWithKanban) => void;
}

export const MemberList = ({
  members,
  memberTaskCounts,
  taskMap,
  pendingRepliesByMember,
  memberSpawnStatuses,
  isTeamAlive,
  isTeamProvisioning,
  leadActivity,
  launchParams,
  onMemberClick,
  onSendMessage,
  onAssignTask,
  onOpenTask,
}: MemberListProps): React.JSX.Element => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isWide, setIsWide] = useState(false);

  const handleResize = useCallback((entries: ResizeObserverEntry[]) => {
    const entry = entries[0];
    if (entry) {
      setIsWide(entry.contentRect.width > 1000);
    }
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver(handleResize);
    observer.observe(el);
    return () => observer.disconnect();
  }, [handleResize]);

  const gridClass = isWide ? 'grid grid-cols-2 gap-1' : 'grid grid-cols-1 gap-1';
  const activeMembers = members
    .filter((m) => !m.removedAt)
    .sort((a, b) => {
      if (isLeadMember(a)) return -1;
      if (isLeadMember(b)) return 1;
      return 0;
    });
  const removedMembers = members.filter((m) => m.removedAt);
  const colorMap = buildMemberColorMap(members);

  const buildRuntimeSummary = useCallback(
    (member: ResolvedTeamMember): string | undefined => {
      const hasMemberOverride = Boolean(member.providerId || member.model || member.effort);
      if (!hasMemberOverride && launchParams) {
        return undefined;
      }

      const defaultProvider = launchParams?.providerId ?? 'anthropic';
      const memberProvider = member.providerId ?? defaultProvider;
      const defaultModel = launchParams?.model?.trim() || '';
      const memberModel = member.model?.trim() || '';
      const defaultEffort = launchParams?.effort;
      const memberEffort = member.effort;

      const showProvider =
        !launchParams || Boolean(member.providerId && memberProvider !== defaultProvider);
      const showModel = !launchParams
        ? Boolean(memberModel)
        : Boolean(memberModel && memberModel !== defaultModel);
      const showEffort = !launchParams
        ? Boolean(memberEffort)
        : Boolean(memberEffort && memberEffort !== defaultEffort);

      const parts: string[] = [];
      if (showProvider) {
        parts.push(getTeamProviderLabel(memberProvider));
      }
      if (showModel) {
        parts.push(getTeamModelLabel(memberModel));
      }
      if (showEffort && memberEffort) {
        parts.push(getTeamEffortLabel(memberEffort));
      }

      return parts.length > 0 ? parts.join(' · ') : undefined;
    },
    [launchParams]
  );

  if (members.length === 0) {
    return (
      <div className="rounded-md border border-[var(--color-border)] p-4 text-sm text-[var(--color-text-muted)]">
        Solo team — lead only
      </div>
    );
  }

  const renderCard = (member: ResolvedTeamMember, isRemoved: boolean): React.JSX.Element => {
    const currentTask =
      member.currentTaskId && taskMap ? (taskMap.get(member.currentTaskId) ?? null) : null;
    const reviewTask = taskMap
      ? (Array.from(taskMap.values()).find(
          (task) =>
            task.reviewer === member.name &&
            task.id !== member.currentTaskId &&
            (task.reviewState === 'review' || task.kanbanColumn === 'review')
        ) ?? null)
      : null;
    const awaitingReply = Boolean(pendingRepliesByMember?.[member.name]);
    const spawnEntry = memberSpawnStatuses?.get(member.name);
    return (
      <MemberCard
        key={member.name}
        member={member}
        memberColor={colorMap.get(member.name) ?? 'blue'}
        taskCounts={memberTaskCounts?.get(member.name.toLowerCase())}
        isTeamAlive={isTeamAlive}
        isTeamProvisioning={isTeamProvisioning}
        leadActivity={isLeadMember(member) ? leadActivity : undefined}
        currentTask={isRemoved ? null : currentTask}
        reviewTask={isRemoved ? null : reviewTask}
        isAwaitingReply={isRemoved ? false : awaitingReply}
        isRemoved={isRemoved}
        runtimeSummary={isRemoved ? buildRuntimeSummary(member) : buildRuntimeSummary(member)}
        spawnStatus={isRemoved ? undefined : spawnEntry?.status}
        spawnError={isRemoved ? undefined : spawnEntry?.error}
        onOpenTask={!isRemoved && currentTask ? () => onOpenTask?.(currentTask) : undefined}
        onOpenReviewTask={!isRemoved && reviewTask ? () => onOpenTask?.(reviewTask) : undefined}
        onClick={() => onMemberClick?.(member)}
        onSendMessage={() => onSendMessage?.(member)}
        onAssignTask={() => onAssignTask?.(member)}
      />
    );
  };

  return (
    <div ref={containerRef} className="flex flex-col gap-1">
      <div className={gridClass}>{activeMembers.map((member) => renderCard(member, false))}</div>
      {removedMembers.length > 0 && (
        <>
          <div className="mt-2 text-[10px] text-[var(--color-text-muted)]">
            Removed ({removedMembers.length})
          </div>
          <div className={gridClass}>
            {removedMembers.map((member) => renderCard(member, true))}
          </div>
        </>
      )}
    </div>
  );
};
