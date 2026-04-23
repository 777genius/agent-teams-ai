import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { resolveMemberRuntimeSummary } from '@renderer/utils/memberRuntimeSummary';
import { isLeadMember } from '@shared/utils/leadDetection';

import { MemberCard } from './MemberCard';

import type { TeamLaunchParams } from '@renderer/store/slices/teamSlice';
import type { TaskStatusCounts } from '@renderer/utils/pathNormalize';
import type {
  LeadActivityState,
  MemberSpawnStatusEntry,
  ResolvedTeamMember,
  TeamAgentRuntimeEntry,
  TeamTaskWithKanban,
} from '@shared/types';

interface MemberListProps {
  members: ResolvedTeamMember[];
  memberTaskCounts?: Map<string, TaskStatusCounts>;
  taskMap?: Map<string, TeamTaskWithKanban>;
  pendingRepliesByMember?: Record<string, number>;
  memberSpawnStatuses?: Map<string, MemberSpawnStatusEntry>;
  memberRuntimeEntries?: Map<string, TeamAgentRuntimeEntry>;
  isLaunchSettling?: boolean;
  isTeamAlive?: boolean;
  isTeamProvisioning?: boolean;
  leadActivity?: LeadActivityState;
  launchParams?: TeamLaunchParams;
  onMemberClick?: (member: ResolvedTeamMember) => void;
  onSendMessage?: (member: ResolvedTeamMember) => void;
  onAssignTask?: (member: ResolvedTeamMember) => void;
  onOpenTask?: (taskId: string) => void;
}

function areResolvedMembersEquivalent(
  left: readonly ResolvedTeamMember[],
  right: readonly ResolvedTeamMember[]
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    const leftMember = left[index];
    const rightMember = right[index];
    if (
      leftMember.name !== rightMember.name ||
      leftMember.status !== rightMember.status ||
      leftMember.currentTaskId !== rightMember.currentTaskId ||
      leftMember.taskCount !== rightMember.taskCount ||
      leftMember.color !== rightMember.color ||
      leftMember.agentType !== rightMember.agentType ||
      leftMember.role !== rightMember.role ||
      leftMember.workflow !== rightMember.workflow ||
      leftMember.providerId !== rightMember.providerId ||
      leftMember.model !== rightMember.model ||
      leftMember.effort !== rightMember.effort ||
      leftMember.cwd !== rightMember.cwd ||
      leftMember.gitBranch !== rightMember.gitBranch ||
      leftMember.removedAt !== rightMember.removedAt ||
      leftMember.runtimeAdvisory?.kind !== rightMember.runtimeAdvisory?.kind ||
      leftMember.runtimeAdvisory?.observedAt !== rightMember.runtimeAdvisory?.observedAt ||
      leftMember.runtimeAdvisory?.retryUntil !== rightMember.runtimeAdvisory?.retryUntil ||
      leftMember.runtimeAdvisory?.retryDelayMs !== rightMember.runtimeAdvisory?.retryDelayMs ||
      leftMember.runtimeAdvisory?.reasonCode !== rightMember.runtimeAdvisory?.reasonCode ||
      leftMember.runtimeAdvisory?.message !== rightMember.runtimeAdvisory?.message
    ) {
      return false;
    }
  }

  return true;
}

function areTaskStatusCountsMapsEquivalent(
  left: Map<string, TaskStatusCounts> | undefined,
  right: Map<string, TaskStatusCounts> | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  if (left.size !== right.size) return false;
  for (const [key, leftCounts] of left) {
    const rightCounts = right.get(key);
    if (
      leftCounts.pending !== rightCounts?.pending ||
      leftCounts.inProgress !== rightCounts.inProgress ||
      leftCounts.completed !== rightCounts.completed
    ) {
      return false;
    }
  }
  return true;
}

function areMemberTaskMapsEquivalent(
  left: Map<string, TeamTaskWithKanban> | undefined,
  right: Map<string, TeamTaskWithKanban> | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  if (left.size !== right.size) return false;
  for (const [key, leftTask] of left) {
    const rightTask = right.get(key);
    if (
      leftTask.id !== rightTask?.id ||
      leftTask.displayId !== rightTask.displayId ||
      leftTask.subject !== rightTask.subject ||
      leftTask.owner !== rightTask.owner ||
      leftTask.status !== rightTask.status ||
      leftTask.reviewer !== rightTask.reviewer ||
      leftTask.reviewState !== rightTask.reviewState ||
      leftTask.kanbanColumn !== rightTask.kanbanColumn
    ) {
      return false;
    }
  }
  return true;
}

function arePendingRepliesEquivalent(
  left: Record<string, number> | undefined,
  right: Record<string, number> | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (left[key] !== right[key]) {
      return false;
    }
  }
  return true;
}

function areMemberSpawnStatusesEquivalent(
  left: Map<string, MemberSpawnStatusEntry> | undefined,
  right: Map<string, MemberSpawnStatusEntry> | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  if (left.size !== right.size) return false;
  for (const [key, leftEntry] of left) {
    const rightEntry = right.get(key);
    if (
      leftEntry.status !== rightEntry?.status ||
      leftEntry.launchState !== rightEntry.launchState ||
      leftEntry.error !== rightEntry.error ||
      leftEntry.hardFailure !== rightEntry.hardFailure ||
      leftEntry.hardFailureReason !== rightEntry.hardFailureReason ||
      leftEntry.livenessSource !== rightEntry.livenessSource ||
      leftEntry.runtimeModel !== rightEntry.runtimeModel ||
      leftEntry.runtimeAlive !== rightEntry.runtimeAlive ||
      leftEntry.bootstrapConfirmed !== rightEntry.bootstrapConfirmed ||
      leftEntry.agentToolAccepted !== rightEntry.agentToolAccepted ||
      (leftEntry.pendingPermissionRequestIds ?? []).join('\0') !==
        (rightEntry.pendingPermissionRequestIds ?? []).join('\0')
    ) {
      return false;
    }
  }
  return true;
}

function areLaunchParamsEquivalent(
  left: TeamLaunchParams | undefined,
  right: TeamLaunchParams | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  return (
    left.providerId === right.providerId &&
    left.providerBackendId === right.providerBackendId &&
    left.model === right.model &&
    left.effort === right.effort &&
    left.fastMode === right.fastMode &&
    left.limitContext === right.limitContext
  );
}

function areMemberRuntimeEntriesEquivalent(
  left: Map<string, TeamAgentRuntimeEntry> | undefined,
  right: Map<string, TeamAgentRuntimeEntry> | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  if (left.size !== right.size) return false;
  for (const [key, leftEntry] of left) {
    const rightEntry = right.get(key);
    if (
      leftEntry.memberName !== rightEntry?.memberName ||
      leftEntry.alive !== rightEntry?.alive ||
      leftEntry.restartable !== rightEntry?.restartable ||
      leftEntry.backendType !== rightEntry?.backendType ||
      leftEntry.pid !== rightEntry?.pid ||
      leftEntry.runtimeModel !== rightEntry?.runtimeModel ||
      leftEntry.rssBytes !== rightEntry?.rssBytes
    ) {
      return false;
    }
  }
  return true;
}

function areMemberListPropsEqual(
  prev: Readonly<MemberListProps>,
  next: Readonly<MemberListProps>
): boolean {
  return (
    areResolvedMembersEquivalent(prev.members, next.members) &&
    areTaskStatusCountsMapsEquivalent(prev.memberTaskCounts, next.memberTaskCounts) &&
    areMemberTaskMapsEquivalent(prev.taskMap, next.taskMap) &&
    arePendingRepliesEquivalent(prev.pendingRepliesByMember, next.pendingRepliesByMember) &&
    areMemberSpawnStatusesEquivalent(prev.memberSpawnStatuses, next.memberSpawnStatuses) &&
    areMemberRuntimeEntriesEquivalent(prev.memberRuntimeEntries, next.memberRuntimeEntries) &&
    prev.isLaunchSettling === next.isLaunchSettling &&
    prev.isTeamAlive === next.isTeamAlive &&
    prev.isTeamProvisioning === next.isTeamProvisioning &&
    prev.leadActivity === next.leadActivity &&
    areLaunchParamsEquivalent(prev.launchParams, next.launchParams)
  );
}

export const MemberList = memo(function MemberList({
  members,
  memberTaskCounts,
  taskMap,
  pendingRepliesByMember,
  memberSpawnStatuses,
  memberRuntimeEntries,
  isLaunchSettling,
  isTeamAlive,
  isTeamProvisioning,
  leadActivity,
  launchParams,
  onMemberClick,
  onSendMessage,
  onAssignTask,
  onOpenTask,
}: MemberListProps): React.JSX.Element {
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
  const activeMembers = useMemo(
    () =>
      members
        .filter((m) => !m.removedAt)
        .sort((a, b) => {
          if (isLeadMember(a)) return -1;
          if (isLeadMember(b)) return 1;
          return 0;
        }),
    [members]
  );
  const removedMembers = useMemo(() => members.filter((m) => m.removedAt), [members]);
  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);

  const buildRuntimeSummary = useCallback(
    (
      member: ResolvedTeamMember,
      spawnEntry: MemberSpawnStatusEntry | undefined,
      runtimeEntry: TeamAgentRuntimeEntry | undefined
    ): string | undefined => {
      return resolveMemberRuntimeSummary(member, launchParams, spawnEntry, runtimeEntry);
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

  // Pre-compute reviewer→task map to avoid O(n×m) scan per member
  const reviewTaskByMember = useMemo(() => {
    const result = new Map<string, TeamTaskWithKanban>();
    if (!taskMap) return result;
    for (const task of taskMap.values()) {
      if (task.reviewer && (task.reviewState === 'review' || task.kanbanColumn === 'review')) {
        result.set(task.reviewer, task);
      }
    }
    return result;
  }, [taskMap]);

  const renderCard = (member: ResolvedTeamMember, isRemoved: boolean): React.JSX.Element => {
    const currentTask =
      member.currentTaskId && taskMap ? (taskMap.get(member.currentTaskId) ?? null) : null;
    const reviewCandidate = reviewTaskByMember.get(member.name) ?? null;
    const reviewTask =
      reviewCandidate && reviewCandidate.id !== member.currentTaskId ? reviewCandidate : null;
    const awaitingReply = isTeamAlive !== false && Boolean(pendingRepliesByMember?.[member.name]);
    const spawnEntry = memberSpawnStatuses?.get(member.name);
    const runtimeEntry = memberRuntimeEntries?.get(member.name);
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
        runtimeSummary={buildRuntimeSummary(
          member,
          isRemoved ? undefined : spawnEntry,
          isRemoved ? undefined : runtimeEntry
        )}
        spawnStatus={isRemoved ? undefined : spawnEntry?.status}
        spawnError={isRemoved ? undefined : (spawnEntry?.error ?? spawnEntry?.hardFailureReason)}
        spawnLivenessSource={isRemoved ? undefined : spawnEntry?.livenessSource}
        spawnLaunchState={isRemoved ? undefined : spawnEntry?.launchState}
        spawnRuntimeAlive={isRemoved ? undefined : spawnEntry?.runtimeAlive}
        isLaunchSettling={isRemoved ? false : isLaunchSettling}
        onOpenTask={!isRemoved && currentTask ? () => onOpenTask?.(currentTask.id) : undefined}
        onOpenReviewTask={!isRemoved && reviewTask ? () => onOpenTask?.(reviewTask.id) : undefined}
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
}, areMemberListPropsEqual);
