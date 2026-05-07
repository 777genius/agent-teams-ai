import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  deriveReviewActivityTimerAnchor,
  deriveWorkActivityTimerAnchor,
  syncMemberActivityTimer,
} from '@renderer/utils/memberActivityTimer';
import { buildMemberColorMap, shouldDisplayMemberCurrentTask } from '@renderer/utils/memberHelpers';
import { resolveMemberRuntimeSummary } from '@renderer/utils/memberRuntimeSummary';
import { isDisplayableCurrentTask } from '@renderer/utils/teamTaskDisplayState';
import { isLeadMember } from '@shared/utils/leadDetection';
import { getTeamTaskWorkflowColumn } from '@shared/utils/teamTaskState';

import { MemberCard } from './MemberCard';

import type { TeamLaunchParams } from '@renderer/store/slices/teamSlice';
import type { MemberActivityTimerAnchor } from '@renderer/utils/memberActivityTimer';
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

interface MemberListProps {
  teamName?: string;
  members: ResolvedTeamMember[];
  memberTaskCounts?: Map<string, TaskStatusCounts>;
  taskMap?: Map<string, TeamTaskWithKanban>;
  pendingRepliesByMember?: Record<string, number>;
  memberSpawnStatuses?: Map<string, MemberSpawnStatusEntry>;
  memberRuntimeEntries?: Map<string, TeamAgentRuntimeEntry>;
  runtimeRunId?: string | null;
  isLaunchSettling?: boolean;
  isTeamAlive?: boolean;
  isTeamProvisioning?: boolean;
  leadActivity?: LeadActivityState;
  launchParams?: TeamLaunchParams;
  onMemberClick?: (member: ResolvedTeamMember) => void;
  onSendMessage?: (member: ResolvedTeamMember) => void;
  onAssignTask?: (member: ResolvedTeamMember) => void;
  onOpenTask?: (taskId: string) => void;
  onRestartMember?: (memberName: string) => Promise<void> | void;
  onSkipMemberForLaunch?: (memberName: string) => Promise<void> | void;
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

function areTaskWorkIntervalsEquivalent(
  left: TeamTaskWithKanban['workIntervals'],
  right: TeamTaskWithKanban['workIntervals']
): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  if (left.length !== right.length) return false;
  return left.every((interval, index) => {
    const other = right[index];
    if (!other) return false;
    return interval.startedAt === other.startedAt && interval.completedAt === other.completedAt;
  });
}

function areTaskHistoryEventsEquivalent(
  left: TeamTaskWithKanban['historyEvents'],
  right: TeamTaskWithKanban['historyEvents']
): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  if (left.length !== right.length) return false;
  return left.every((event, index) => {
    const other = right[index];
    if (!other) return false;
    const leftRow = event as unknown as Record<string, unknown>;
    const rightRow = other as unknown as Record<string, unknown>;
    return (
      event.id === other.id &&
      event.type === other.type &&
      event.timestamp === other.timestamp &&
      leftRow.actor === rightRow.actor &&
      leftRow.reviewer === rightRow.reviewer &&
      leftRow.from === rightRow.from &&
      leftRow.to === rightRow.to &&
      leftRow.status === rightRow.status
    );
  });
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
      leftTask.kanbanColumn !== rightTask.kanbanColumn ||
      !areTaskWorkIntervalsEquivalent(leftTask.workIntervals, rightTask.workIntervals) ||
      !areTaskHistoryEventsEquivalent(leftTask.historyEvents, rightTask.historyEvents)
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
      leftEntry.skippedForLaunch !== rightEntry.skippedForLaunch ||
      leftEntry.skipReason !== rightEntry.skipReason ||
      leftEntry.skippedAt !== rightEntry.skippedAt ||
      leftEntry.livenessSource !== rightEntry.livenessSource ||
      leftEntry.livenessKind !== rightEntry.livenessKind ||
      leftEntry.runtimeDiagnostic !== rightEntry.runtimeDiagnostic ||
      leftEntry.runtimeDiagnosticSeverity !== rightEntry.runtimeDiagnosticSeverity ||
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
    const leftDiagnostics = leftEntry.diagnostics ?? [];
    const rightDiagnostics = rightEntry?.diagnostics ?? [];
    if (
      leftEntry.memberName !== rightEntry?.memberName ||
      leftEntry.alive !== rightEntry?.alive ||
      leftEntry.restartable !== rightEntry?.restartable ||
      leftEntry.backendType !== rightEntry?.backendType ||
      leftEntry.providerId !== rightEntry?.providerId ||
      leftEntry.providerBackendId !== rightEntry?.providerBackendId ||
      leftEntry.laneId !== rightEntry?.laneId ||
      leftEntry.laneKind !== rightEntry?.laneKind ||
      leftEntry.pid !== rightEntry?.pid ||
      leftEntry.runtimeModel !== rightEntry?.runtimeModel ||
      leftEntry.rssBytes !== rightEntry?.rssBytes ||
      leftEntry.livenessKind !== rightEntry?.livenessKind ||
      leftEntry.pidSource !== rightEntry?.pidSource ||
      leftEntry.processCommand !== rightEntry?.processCommand ||
      leftEntry.paneId !== rightEntry?.paneId ||
      leftEntry.panePid !== rightEntry?.panePid ||
      leftEntry.paneCurrentCommand !== rightEntry?.paneCurrentCommand ||
      leftEntry.runtimePid !== rightEntry?.runtimePid ||
      leftEntry.runtimeSessionId !== rightEntry?.runtimeSessionId ||
      leftEntry.runtimeDiagnostic !== rightEntry?.runtimeDiagnostic ||
      leftEntry.runtimeDiagnosticSeverity !== rightEntry?.runtimeDiagnosticSeverity ||
      leftEntry.runtimeLastSeenAt !== rightEntry?.runtimeLastSeenAt ||
      leftEntry.historicalBootstrapConfirmed !== rightEntry?.historicalBootstrapConfirmed ||
      leftDiagnostics.length !== rightDiagnostics.length ||
      !leftDiagnostics.every((value, index) => value === rightDiagnostics[index])
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
    prev.teamName === next.teamName &&
    areResolvedMembersEquivalent(prev.members, next.members) &&
    areTaskStatusCountsMapsEquivalent(prev.memberTaskCounts, next.memberTaskCounts) &&
    areMemberTaskMapsEquivalent(prev.taskMap, next.taskMap) &&
    arePendingRepliesEquivalent(prev.pendingRepliesByMember, next.pendingRepliesByMember) &&
    areMemberSpawnStatusesEquivalent(prev.memberSpawnStatuses, next.memberSpawnStatuses) &&
    areMemberRuntimeEntriesEquivalent(prev.memberRuntimeEntries, next.memberRuntimeEntries) &&
    prev.runtimeRunId === next.runtimeRunId &&
    prev.isLaunchSettling === next.isLaunchSettling &&
    prev.isTeamAlive === next.isTeamAlive &&
    prev.isTeamProvisioning === next.isTeamProvisioning &&
    prev.leadActivity === next.leadActivity &&
    prev.onRestartMember === next.onRestartMember &&
    prev.onSkipMemberForLaunch === next.onSkipMemberForLaunch &&
    areLaunchParamsEquivalent(prev.launchParams, next.launchParams)
  );
}

// ---------------------------------------------------------------------------
// Per-member row wrapper — creates stable callbacks so MemberCard memo holds
// ---------------------------------------------------------------------------

interface MemberCardRowProps {
  member: ResolvedTeamMember;
  isRemoved: boolean;
  memberColor: string;
  currentTask: TeamTaskWithKanban | null;
  reviewTask: TeamTaskWithKanban | null;
  currentTaskTimer: MemberActivityTimerAnchor | null;
  reviewTaskTimer: MemberActivityTimerAnchor | null;
  currentTaskTimerRunning: boolean;
  reviewTaskTimerRunning: boolean;
  awaitingReply: boolean;
  taskCounts?: TaskStatusCounts | null;
  runtimeSummary?: string;
  runtimeEntry?: TeamAgentRuntimeEntry;
  runtimeRunId?: string | null;
  spawnStatus?: MemberSpawnStatus;
  spawnEntry?: MemberSpawnStatusEntry;
  spawnError?: string;
  spawnLivenessSource?: MemberSpawnLivenessSource;
  spawnLaunchState?: MemberLaunchState;
  spawnRuntimeAlive?: boolean;
  isTeamAlive?: boolean;
  isTeamProvisioning?: boolean;
  leadActivity?: LeadActivityState;
  isLaunchSettling?: boolean;
  onOpenTask?: (taskId: string) => void;
  onMemberClick?: (member: ResolvedTeamMember) => void;
  onSendMessage?: (member: ResolvedTeamMember) => void;
  onAssignTask?: (member: ResolvedTeamMember) => void;
  onRestartMember?: (memberName: string) => Promise<void> | void;
  onSkipMemberForLaunch?: (memberName: string) => Promise<void> | void;
}

const MemberCardRow = memo(function MemberCardRow({
  member,
  isRemoved,
  memberColor,
  currentTask,
  reviewTask,
  currentTaskTimer,
  reviewTaskTimer,
  currentTaskTimerRunning,
  reviewTaskTimerRunning,
  awaitingReply,
  taskCounts,
  runtimeSummary,
  runtimeEntry,
  runtimeRunId,
  spawnStatus,
  spawnEntry,
  spawnError,
  spawnLivenessSource,
  spawnLaunchState,
  spawnRuntimeAlive,
  isTeamAlive,
  isTeamProvisioning,
  leadActivity,
  isLaunchSettling,
  onOpenTask,
  onMemberClick,
  onSendMessage,
  onAssignTask,
  onRestartMember,
  onSkipMemberForLaunch,
}: MemberCardRowProps): React.JSX.Element {
  const currentTaskId = currentTask?.id;
  const reviewTaskId = reviewTask?.id;

  const handleOpenTask = useCallback(() => {
    if (currentTaskId) onOpenTask?.(currentTaskId);
  }, [onOpenTask, currentTaskId]);

  const handleOpenReviewTask = useCallback(() => {
    if (reviewTaskId) onOpenTask?.(reviewTaskId);
  }, [onOpenTask, reviewTaskId]);

  const handleClick = useCallback(() => onMemberClick?.(member), [onMemberClick, member]);
  const handleSendMessage = useCallback(() => onSendMessage?.(member), [onSendMessage, member]);
  const handleAssignTask = useCallback(() => onAssignTask?.(member), [onAssignTask, member]);

  return (
    <MemberCard
      member={member}
      memberColor={memberColor}
      taskCounts={taskCounts}
      isTeamAlive={isTeamAlive}
      isTeamProvisioning={isTeamProvisioning}
      leadActivity={isLeadMember(member) ? leadActivity : undefined}
      currentTask={currentTask}
      reviewTask={reviewTask}
      currentTaskTimer={currentTaskTimer}
      reviewTaskTimer={reviewTaskTimer}
      currentTaskTimerRunning={currentTaskTimerRunning}
      reviewTaskTimerRunning={reviewTaskTimerRunning}
      isAwaitingReply={awaitingReply}
      isRemoved={isRemoved}
      runtimeSummary={runtimeSummary}
      runtimeEntry={runtimeEntry}
      runtimeRunId={runtimeRunId}
      spawnStatus={spawnStatus}
      spawnEntry={spawnEntry}
      spawnError={spawnError}
      spawnLivenessSource={spawnLivenessSource}
      spawnLaunchState={spawnLaunchState}
      spawnRuntimeAlive={spawnRuntimeAlive}
      isLaunchSettling={isLaunchSettling}
      onOpenTask={currentTask ? handleOpenTask : undefined}
      onOpenReviewTask={reviewTask ? handleOpenReviewTask : undefined}
      onClick={handleClick}
      onSendMessage={handleSendMessage}
      onAssignTask={handleAssignTask}
      onRestartMember={onRestartMember}
      onSkipMemberForLaunch={onSkipMemberForLaunch}
    />
  );
});

export const MemberList = memo(function MemberList({
  teamName = '__unknown_team__',
  members,
  memberTaskCounts,
  taskMap,
  pendingRepliesByMember,
  memberSpawnStatuses,
  memberRuntimeEntries,
  runtimeRunId,
  isLaunchSettling,
  isTeamAlive,
  isTeamProvisioning,
  leadActivity,
  launchParams,
  onMemberClick,
  onSendMessage,
  onAssignTask,
  onOpenTask,
  onRestartMember,
  onSkipMemberForLaunch,
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
  // Pre-compute reviewer->task map to avoid O(n*n) scan per member.
  const reviewTaskByMember = useMemo(() => {
    const result = new Map<string, TeamTaskWithKanban>();
    if (!taskMap) return result;
    for (const task of taskMap.values()) {
      if (task.reviewer && getTeamTaskWorkflowColumn(task) === 'review') {
        result.set(task.reviewer, task);
      }
    }
    return result;
  }, [taskMap]);

  const isMemberActivityTimerRunning = useCallback(
    (
      spawnEntry: MemberSpawnStatusEntry | undefined,
      runtimeEntry: TeamAgentRuntimeEntry | undefined
    ): boolean => {
      if (isTeamAlive === false) return false;
      if (
        spawnEntry?.status === 'offline' ||
        spawnEntry?.status === 'error' ||
        spawnEntry?.status === 'skipped'
      ) {
        return false;
      }
      if (spawnEntry?.runtimeAlive === false && spawnEntry.status !== 'online') {
        return false;
      }
      if (
        runtimeEntry?.livenessKind === 'shell_only' ||
        runtimeEntry?.livenessKind === 'registered_only' ||
        runtimeEntry?.livenessKind === 'stale_metadata' ||
        runtimeEntry?.livenessKind === 'not_found'
      ) {
        return false;
      }
      return true;
    },
    [isTeamAlive]
  );

  const getActivityTimerRunId = useCallback(
    (running: boolean): string | null => {
      if (!running) return null;
      return runtimeRunId ?? 'runtime:unknown';
    },
    [runtimeRunId]
  );

  const withActivityTimerRunId = useCallback(
    (
      anchor: MemberActivityTimerAnchor | null,
      running: boolean
    ): MemberActivityTimerAnchor | null => {
      if (!anchor) return null;
      return {
        ...anchor,
        runId: getActivityTimerRunId(running),
      };
    },
    [getActivityTimerRunId]
  );

  useEffect(() => {
    if (!taskMap) return;
    const nowMs = Date.now();
    for (const member of activeMembers) {
      const spawnEntry = memberSpawnStatuses?.get(member.name);
      const runtimeEntry = memberRuntimeEntries?.get(member.name);
      const running = isMemberActivityTimerRunning(spawnEntry, runtimeEntry);
      const currentTaskCandidate = member.currentTaskId
        ? (taskMap.get(member.currentTaskId) ?? null)
        : null;
      if (isDisplayableCurrentTask(currentTaskCandidate)) {
        const anchor = deriveWorkActivityTimerAnchor(currentTaskCandidate, {
          teamName,
          memberName: member.name,
        });
        if (anchor) {
          const visible =
            running &&
            shouldDisplayMemberCurrentTask({
              member,
              isTeamAlive,
              spawnStatus: spawnEntry?.status,
              spawnLaunchState: spawnEntry?.launchState,
              spawnRuntimeAlive: spawnEntry?.runtimeAlive,
              runtimeEntry,
            });
          syncMemberActivityTimer({
            timerId: anchor.timerId,
            startedAtMs: anchor.startedAtMs,
            baseElapsedMs: anchor.baseElapsedMs,
            running: visible,
            runId: getActivityTimerRunId(visible),
            nowMs,
          });
        }
      }

      const reviewTask = reviewTaskByMember.get(member.name) ?? null;
      if (reviewTask) {
        const anchor = deriveReviewActivityTimerAnchor(reviewTask, {
          teamName,
          memberName: member.name,
        });
        if (anchor) {
          syncMemberActivityTimer({
            timerId: anchor.timerId,
            startedAtMs: anchor.startedAtMs,
            baseElapsedMs: anchor.baseElapsedMs,
            running,
            runId: getActivityTimerRunId(running),
            nowMs,
          });
        }
      }
    }
  }, [
    activeMembers,
    getActivityTimerRunId,
    isMemberActivityTimerRunning,
    isTeamAlive,
    memberRuntimeEntries,
    memberSpawnStatuses,
    reviewTaskByMember,
    taskMap,
    teamName,
  ]);

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

  return (
    <div ref={containerRef} className="flex flex-col gap-1">
      <div className={gridClass}>
        {activeMembers.map((member) => {
          const spawnEntry = memberSpawnStatuses?.get(member.name);
          const runtimeEntry = memberRuntimeEntries?.get(member.name);
          const currentTaskCandidate =
            member.currentTaskId && taskMap ? (taskMap.get(member.currentTaskId) ?? null) : null;
          const currentTask =
            isDisplayableCurrentTask(currentTaskCandidate) &&
            shouldDisplayMemberCurrentTask({
              member,
              isTeamAlive,
              spawnStatus: spawnEntry?.status,
              spawnLaunchState: spawnEntry?.launchState,
              spawnRuntimeAlive: spawnEntry?.runtimeAlive,
              runtimeEntry,
            })
              ? currentTaskCandidate
              : null;
          const reviewCandidate = reviewTaskByMember.get(member.name) ?? null;
          const reviewTask =
            reviewCandidate && reviewCandidate.id !== currentTask?.id ? reviewCandidate : null;
          const activityTimerRunning = isMemberActivityTimerRunning(spawnEntry, runtimeEntry);
          const currentTaskTimer = withActivityTimerRunId(
            currentTask
              ? deriveWorkActivityTimerAnchor(currentTask, {
                  teamName,
                  memberName: member.name,
                })
              : null,
            activityTimerRunning
          );
          const reviewTaskTimer = withActivityTimerRunId(
            reviewTask
              ? deriveReviewActivityTimerAnchor(reviewTask, {
                  teamName,
                  memberName: member.name,
                })
              : null,
            activityTimerRunning
          );
          return (
            <MemberCardRow
              key={member.name}
              member={member}
              isRemoved={false}
              memberColor={colorMap.get(member.name) ?? 'blue'}
              currentTask={currentTask}
              reviewTask={reviewTask}
              currentTaskTimer={currentTaskTimer}
              reviewTaskTimer={reviewTaskTimer}
              currentTaskTimerRunning={activityTimerRunning}
              reviewTaskTimerRunning={activityTimerRunning}
              awaitingReply={
                isTeamAlive !== false && Boolean(pendingRepliesByMember?.[member.name])
              }
              taskCounts={memberTaskCounts?.get(member.name.toLowerCase())}
              runtimeSummary={buildRuntimeSummary(member, spawnEntry, runtimeEntry)}
              runtimeEntry={runtimeEntry}
              runtimeRunId={runtimeRunId}
              spawnStatus={spawnEntry?.status}
              spawnEntry={spawnEntry}
              spawnError={spawnEntry?.error ?? spawnEntry?.hardFailureReason}
              spawnLivenessSource={spawnEntry?.livenessSource}
              spawnLaunchState={spawnEntry?.launchState}
              spawnRuntimeAlive={spawnEntry?.runtimeAlive}
              isTeamAlive={isTeamAlive}
              isTeamProvisioning={isTeamProvisioning}
              leadActivity={leadActivity}
              isLaunchSettling={isLaunchSettling}
              onOpenTask={onOpenTask}
              onMemberClick={onMemberClick}
              onSendMessage={onSendMessage}
              onAssignTask={onAssignTask}
              onRestartMember={onRestartMember}
              onSkipMemberForLaunch={onSkipMemberForLaunch}
            />
          );
        })}
      </div>
      {removedMembers.length > 0 && (
        <>
          <div className="mt-2 text-[10px] text-[var(--color-text-muted)]">
            Removed ({removedMembers.length})
          </div>
          <div className={gridClass}>
            {removedMembers.map((member) => (
              <MemberCardRow
                key={member.name}
                member={member}
                isRemoved={true}
                memberColor={colorMap.get(member.name) ?? 'blue'}
                currentTask={null}
                reviewTask={null}
                currentTaskTimer={null}
                reviewTaskTimer={null}
                currentTaskTimerRunning={false}
                reviewTaskTimerRunning={false}
                awaitingReply={false}
                taskCounts={memberTaskCounts?.get(member.name.toLowerCase())}
                runtimeSummary={buildRuntimeSummary(member, undefined, undefined)}
                runtimeEntry={undefined}
                runtimeRunId={undefined}
                spawnStatus={undefined}
                spawnEntry={undefined}
                spawnError={undefined}
                spawnLivenessSource={undefined}
                spawnLaunchState={undefined}
                spawnRuntimeAlive={undefined}
                isTeamAlive={isTeamAlive}
                isTeamProvisioning={isTeamProvisioning}
                leadActivity={leadActivity}
                isLaunchSettling={false}
                onOpenTask={onOpenTask}
                onMemberClick={onMemberClick}
                onSendMessage={onSendMessage}
                onAssignTask={onAssignTask}
                onRestartMember={undefined}
                onSkipMemberForLaunch={undefined}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}, areMemberListPropsEqual);
