import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { useTheme } from '@renderer/hooks/useTheme';
import {
  deriveReviewActivityTimerAnchor,
  deriveWorkActivityTimerAnchor,
  syncMemberActivityTimer,
} from '@renderer/utils/memberActivityTimer';
import {
  buildMemberAvatarMap,
  buildMemberColorMap,
  shouldDisplayMemberCurrentTask,
} from '@renderer/utils/memberHelpers';
import { resolveMemberRuntimeSummary } from '@renderer/utils/memberRuntimeSummary';
import { isDisplayableCurrentTask } from '@renderer/utils/teamTaskDisplayState';
import { isLeadMember } from '@shared/utils/leadDetection';
import {
  hasUnsafeProvisionedButNotAliveRuntimeEvidenceWithSpawnContext,
  isBootstrapConfirmedProvisionedButNotAliveFailure,
} from '@shared/utils/teamLaunchFailureReason';
import { getTeamTaskWorkflowColumn } from '@shared/utils/teamTaskState';

import { getPendingMemberDeliveryState } from '../messages/messagesPanelLogic';

import { MemberCard, type RuntimeTelemetryScale } from './MemberCard';

import type { PendingMemberDeliveryState } from '../messages/messagesPanelLogic';
import type { TeamLaunchParams } from '@renderer/store/slices/teamSlice';
import type { MemberActivityTimerAnchor } from '@renderer/utils/memberActivityTimer';
import type { TaskStatusCounts } from '@renderer/utils/pathNormalize';
import type {
  InboxMessage,
  LeadActivityState,
  MemberLaunchState,
  MemberSpawnLivenessSource,
  MemberSpawnStatus,
  MemberSpawnStatusEntry,
  ResolvedTeamMember,
  TeamAgentRuntimeEntry,
  TeamAgentRuntimeResourceSample,
  TeamTaskWithKanban,
} from '@shared/types';

interface MemberListProps {
  teamName?: string;
  members: ResolvedTeamMember[];
  expectedTeammateCount?: number;
  memberTaskCounts?: Map<string, TaskStatusCounts>;
  taskMap?: Map<string, TeamTaskWithKanban>;
  pendingRepliesByMember?: Record<string, number>;
  messages?: InboxMessage[];
  memberSpawnStatuses?: Map<string, MemberSpawnStatusEntry>;
  memberRuntimeEntries?: Map<string, TeamAgentRuntimeEntry>;
  runtimeRunId?: string | null;
  isLaunchSettling?: boolean;
  isRosterLoading?: boolean;
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
  onRestoreMember?: (memberName: string) => Promise<void> | void;
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
      leftMember.agentId !== rightMember.agentId ||
      leftMember.status !== rightMember.status ||
      leftMember.currentTaskId !== rightMember.currentTaskId ||
      leftMember.taskCount !== rightMember.taskCount ||
      leftMember.lastActiveAt !== rightMember.lastActiveAt ||
      leftMember.messageCount !== rightMember.messageCount ||
      leftMember.color !== rightMember.color ||
      leftMember.agentType !== rightMember.agentType ||
      leftMember.role !== rightMember.role ||
      leftMember.workflow !== rightMember.workflow ||
      leftMember.isolation !== rightMember.isolation ||
      leftMember.providerId !== rightMember.providerId ||
      leftMember.providerBackendId !== rightMember.providerBackendId ||
      leftMember.model !== rightMember.model ||
      leftMember.effort !== rightMember.effort ||
      leftMember.selectedFastMode !== rightMember.selectedFastMode ||
      leftMember.resolvedFastMode !== rightMember.resolvedFastMode ||
      leftMember.laneId !== rightMember.laneId ||
      leftMember.laneKind !== rightMember.laneKind ||
      leftMember.laneOwnerProviderId !== rightMember.laneOwnerProviderId ||
      leftMember.cwd !== rightMember.cwd ||
      leftMember.gitBranch !== rightMember.gitBranch ||
      leftMember.removedAt !== rightMember.removedAt ||
      !areMemberMcpPoliciesEquivalent(leftMember.mcpPolicy, rightMember.mcpPolicy) ||
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

function areMemberMcpPoliciesEquivalent(
  left: ResolvedTeamMember['mcpPolicy'],
  right: ResolvedTeamMember['mcpPolicy']
): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  return (
    left.mode === right.mode &&
    left.scopes?.user === right.scopes?.user &&
    left.scopes?.project === right.scopes?.project &&
    left.scopes?.local === right.scopes?.local &&
    (left.serverNames ?? []).length === (right.serverNames ?? []).length &&
    (left.serverNames ?? []).every((serverName, index) => serverName === right.serverNames?.[index])
  );
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

function areTaskReviewIntervalsEquivalent(
  left: TeamTaskWithKanban['reviewIntervals'],
  right: TeamTaskWithKanban['reviewIntervals']
): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  if (left.length !== right.length) return false;
  return left.every((interval, index) => {
    const other = right[index];
    if (!other) return false;
    return (
      interval.reviewer === other.reviewer &&
      interval.startedAt === other.startedAt &&
      interval.completedAt === other.completedAt
    );
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
      !areTaskReviewIntervalsEquivalent(leftTask.reviewIntervals, rightTask.reviewIntervals) ||
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

function isRuntimeResourceSampleLike(value: unknown): value is TeamAgentRuntimeResourceSample {
  return Boolean(value) && typeof value === 'object';
}

function buildRuntimeResourceHistorySignature(
  history: TeamAgentRuntimeEntry['resourceHistory']
): string {
  if (!Array.isArray(history)) return '';
  return history
    .map((sample) => {
      if (!isRuntimeResourceSampleLike(sample)) return '';
      return [
        sample.timestamp,
        sample.cpuPercent,
        sample.rssBytes,
        sample.primaryCpuPercent,
        sample.primaryRssBytes,
        sample.childCpuPercent,
        sample.childRssBytes,
        sample.processCount,
        sample.runtimeLoadScope,
        sample.runtimeLoadTruncated,
        sample.pidSource,
        sample.pid,
        sample.runtimePid,
      ].join('\u001d');
    })
    .join('\u001c');
}

function areRuntimeResourceHistoriesEquivalent(
  left: TeamAgentRuntimeEntry['resourceHistory'],
  right: TeamAgentRuntimeEntry['resourceHistory']
): boolean {
  return buildRuntimeResourceHistorySignature(left) === buildRuntimeResourceHistorySignature(right);
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
    const leftDiagnostics = Array.isArray(leftEntry.diagnostics) ? leftEntry.diagnostics : [];
    const rightDiagnostics = Array.isArray(rightEntry?.diagnostics) ? rightEntry.diagnostics : [];
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
      leftEntry.cwd !== rightEntry?.cwd ||
      leftEntry.rssBytes !== rightEntry?.rssBytes ||
      leftEntry.cpuPercent !== rightEntry?.cpuPercent ||
      leftEntry.primaryCpuPercent !== rightEntry?.primaryCpuPercent ||
      leftEntry.primaryRssBytes !== rightEntry?.primaryRssBytes ||
      leftEntry.childCpuPercent !== rightEntry?.childCpuPercent ||
      leftEntry.childRssBytes !== rightEntry?.childRssBytes ||
      leftEntry.processCount !== rightEntry?.processCount ||
      leftEntry.runtimeLoadScope !== rightEntry?.runtimeLoadScope ||
      leftEntry.runtimeLoadTruncated !== rightEntry?.runtimeLoadTruncated ||
      leftEntry.livenessKind !== rightEntry?.livenessKind ||
      leftEntry.pidSource !== rightEntry?.pidSource ||
      leftEntry.processCommand !== rightEntry?.processCommand ||
      leftEntry.paneId !== rightEntry?.paneId ||
      leftEntry.panePid !== rightEntry?.panePid ||
      leftEntry.paneCurrentCommand !== rightEntry?.paneCurrentCommand ||
      leftEntry.runtimePid !== rightEntry?.runtimePid ||
      leftEntry.runtimeSessionId !== rightEntry?.runtimeSessionId ||
      leftEntry.runtimeLeaseExpiresAt !== rightEntry?.runtimeLeaseExpiresAt ||
      leftEntry.runtimeDiagnostic !== rightEntry?.runtimeDiagnostic ||
      leftEntry.runtimeDiagnosticSeverity !== rightEntry?.runtimeDiagnosticSeverity ||
      leftEntry.runtimeLastSeenAt !== rightEntry?.runtimeLastSeenAt ||
      leftEntry.updatedAt !== rightEntry?.updatedAt ||
      leftEntry.historicalBootstrapConfirmed !== rightEntry?.historicalBootstrapConfirmed ||
      !areRuntimeResourceHistoriesEquivalent(
        leftEntry.resourceHistory,
        rightEntry?.resourceHistory
      ) ||
      leftDiagnostics.length !== rightDiagnostics.length ||
      !leftDiagnostics.every((value, index) => value === rightDiagnostics[index])
    ) {
      return false;
    }
  }
  return true;
}

const MEMBER_CARD_RUNTIME_TELEMETRY_CACHE_MS = 30_000;

interface CachedMemberRuntimeEntry {
  signature: string;
  cachedAt: number;
  entry: TeamAgentRuntimeEntry;
}

function buildMemberRuntimeCardSignature(entry: TeamAgentRuntimeEntry): string {
  const diagnostics = Array.isArray(entry.diagnostics) ? entry.diagnostics : [];
  return [
    entry.memberName,
    entry.alive,
    entry.restartable,
    entry.backendType,
    entry.providerId,
    entry.providerBackendId,
    entry.laneId,
    entry.laneKind,
    entry.pid,
    entry.runtimeModel,
    entry.cwd,
    entry.rssBytes,
    entry.cpuPercent,
    entry.primaryCpuPercent,
    entry.primaryRssBytes,
    entry.childCpuPercent,
    entry.childRssBytes,
    entry.processCount,
    entry.runtimeLoadScope,
    entry.runtimeLoadTruncated,
    entry.livenessKind,
    entry.pidSource,
    entry.processCommand,
    entry.paneId,
    entry.panePid,
    entry.paneCurrentCommand,
    entry.runtimePid,
    entry.runtimeSessionId,
    entry.runtimeLeaseExpiresAt,
    entry.runtimeDiagnostic,
    entry.runtimeDiagnosticSeverity,
    entry.runtimeLastSeenAt,
    entry.updatedAt,
    entry.historicalBootstrapConfirmed,
    buildRuntimeResourceHistorySignature(entry.resourceHistory),
    diagnostics.join('\u001f'),
  ].join('\u001e');
}

function buildCachedMemberRuntimeEntries(
  runtimeEntries: Map<string, TeamAgentRuntimeEntry> | undefined,
  cache: Map<string, CachedMemberRuntimeEntry>,
  nowMs: number
): Map<string, TeamAgentRuntimeEntry> | undefined {
  if (!runtimeEntries) {
    cache.clear();
    return undefined;
  }

  const nextEntries = new Map<string, TeamAgentRuntimeEntry>();
  const seenMemberNames = new Set<string>();
  for (const [memberName, entry] of runtimeEntries) {
    seenMemberNames.add(memberName);
    const signature = buildMemberRuntimeCardSignature(entry);
    const cached = cache.get(memberName);
    if (
      !cached ||
      cached.signature !== signature ||
      nowMs - cached.cachedAt >= MEMBER_CARD_RUNTIME_TELEMETRY_CACHE_MS
    ) {
      cache.set(memberName, { signature, cachedAt: nowMs, entry });
      nextEntries.set(memberName, entry);
      continue;
    }
    nextEntries.set(memberName, cached.entry);
  }

  for (const memberName of cache.keys()) {
    if (!seenMemberNames.has(memberName)) {
      cache.delete(memberName);
    }
  }

  return nextEntries.size > 0 ? nextEntries : undefined;
}

function reuseRuntimeEntriesMapIfUnchanged(
  previous: Map<string, TeamAgentRuntimeEntry> | undefined,
  next: Map<string, TeamAgentRuntimeEntry> | undefined
): Map<string, TeamAgentRuntimeEntry> | undefined {
  if (previous === next) return previous;
  if (!previous || !next) return next;
  if (previous.size !== next.size) return next;
  for (const [memberName, entry] of next) {
    if (previous.get(memberName) !== entry) {
      return next;
    }
  }
  return previous;
}

function isFiniteNonNegative(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function percentile(values: readonly number[], percentileValue: number): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * percentileValue;
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  if (lower == null || upper == null) {
    return sorted[sorted.length - 1];
  }
  if (lowerIndex === upperIndex) {
    return lower;
  }
  return lower + (upper - lower) * (rank - lowerIndex);
}

function collectRuntimeTelemetryValues(
  entry: TeamAgentRuntimeEntry | undefined,
  getSampleValue: (sample: TeamAgentRuntimeResourceSample) => number | undefined,
  currentValue: number | undefined
): { historyValues: number[]; currentValues: number[] } {
  const history = Array.isArray(entry?.resourceHistory) ? entry.resourceHistory : [];
  const historyValues = history.flatMap((sample) => {
    if (!isRuntimeResourceSampleLike(sample)) {
      return [];
    }
    const value = getSampleValue(sample);
    return isFiniteNonNegative(value) ? [value] : [];
  });
  const currentValues = isFiniteNonNegative(currentValue) ? [currentValue] : [];
  return { historyValues, currentValues };
}

function buildRuntimeTelemetryScale(
  members: readonly ResolvedTeamMember[],
  runtimeEntries: Map<string, TeamAgentRuntimeEntry> | undefined
): RuntimeTelemetryScale | undefined {
  if (!runtimeEntries || members.length === 0) {
    return undefined;
  }

  const memoryHistoryValues: number[] = [];
  const memoryCurrentValues: number[] = [];
  const cpuHistoryValues: number[] = [];
  const cpuCurrentValues: number[] = [];

  for (const member of members) {
    const runtimeEntry = runtimeEntries.get(member.name);
    const memoryValues = collectRuntimeTelemetryValues(
      runtimeEntry,
      (sample) => sample.rssBytes,
      runtimeEntry?.rssBytes
    );
    memoryHistoryValues.push(...memoryValues.historyValues);
    memoryCurrentValues.push(...memoryValues.currentValues);

    const cpuValues = collectRuntimeTelemetryValues(
      runtimeEntry,
      (sample) => sample.cpuPercent,
      runtimeEntry?.cpuPercent
    );
    cpuHistoryValues.push(...cpuValues.historyValues);
    cpuCurrentValues.push(...cpuValues.currentValues);
  }

  const memoryP95 = percentile(memoryHistoryValues, 0.95);
  const memoryCurrentMax =
    memoryCurrentValues.length > 0 ? Math.max(...memoryCurrentValues) : undefined;
  const memoryReference = Math.max(memoryP95 ?? 0, memoryCurrentMax ?? 0);

  const cpuP95 = percentile(cpuHistoryValues, 0.95);
  const cpuCurrentMax = cpuCurrentValues.length > 0 ? Math.max(...cpuCurrentValues) : undefined;
  const cpuReference = Math.max(cpuP95 ?? 0, cpuCurrentMax ?? 0);
  const hasCpuValues = cpuHistoryValues.length > 0 || cpuCurrentValues.length > 0;

  const scale: RuntimeTelemetryScale = {
    ...(memoryReference > 0 ? { memoryCapBytes: memoryReference * 1.1 } : {}),
    ...(hasCpuValues ? { cpuCapPercent: Math.max(25, cpuReference) } : {}),
  };
  return scale.memoryCapBytes != null || scale.cpuCapPercent != null ? scale : undefined;
}

function buildActivityTimerRuntimeSignature(
  members: readonly ResolvedTeamMember[],
  runtimeEntries: Map<string, TeamAgentRuntimeEntry> | undefined
): string {
  if (!runtimeEntries || members.length === 0) {
    return '';
  }

  return members
    .map((member) => {
      const entry = runtimeEntries.get(member.name);
      return [
        member.name,
        entry?.alive,
        entry?.livenessKind,
        entry?.runtimeDiagnosticSeverity,
        entry?.runtimeDiagnostic,
      ].join('\u001f');
    })
    .join('\u001e');
}

function areMemberListPropsEqual(
  prev: Readonly<MemberListProps>,
  next: Readonly<MemberListProps>
): boolean {
  return (
    prev.teamName === next.teamName &&
    areResolvedMembersEquivalent(prev.members, next.members) &&
    prev.expectedTeammateCount === next.expectedTeammateCount &&
    areTaskStatusCountsMapsEquivalent(prev.memberTaskCounts, next.memberTaskCounts) &&
    areMemberTaskMapsEquivalent(prev.taskMap, next.taskMap) &&
    arePendingRepliesEquivalent(prev.pendingRepliesByMember, next.pendingRepliesByMember) &&
    prev.messages === next.messages &&
    areMemberSpawnStatusesEquivalent(prev.memberSpawnStatuses, next.memberSpawnStatuses) &&
    areMemberRuntimeEntriesEquivalent(prev.memberRuntimeEntries, next.memberRuntimeEntries) &&
    prev.runtimeRunId === next.runtimeRunId &&
    prev.isLaunchSettling === next.isLaunchSettling &&
    prev.isRosterLoading === next.isRosterLoading &&
    prev.isTeamAlive === next.isTeamAlive &&
    prev.isTeamProvisioning === next.isTeamProvisioning &&
    prev.leadActivity === next.leadActivity &&
    prev.onMemberClick === next.onMemberClick &&
    prev.onSendMessage === next.onSendMessage &&
    prev.onAssignTask === next.onAssignTask &&
    prev.onOpenTask === next.onOpenTask &&
    prev.onRestartMember === next.onRestartMember &&
    prev.onSkipMemberForLaunch === next.onSkipMemberForLaunch &&
    prev.onRestoreMember === next.onRestoreMember &&
    areLaunchParamsEquivalent(prev.launchParams, next.launchParams)
  );
}

// ---------------------------------------------------------------------------
// Per-member row wrapper — creates stable callbacks so MemberCard memo holds
// ---------------------------------------------------------------------------

interface MemberCardRowProps {
  teamName: string;
  member: ResolvedTeamMember;
  isRemoved: boolean;
  memberColor: string;
  avatarUrl?: string;
  fullBleedSurface: boolean;
  currentTask: TeamTaskWithKanban | null;
  reviewTask: TeamTaskWithKanban | null;
  currentTaskTimer: MemberActivityTimerAnchor | null;
  reviewTaskTimer: MemberActivityTimerAnchor | null;
  currentTaskTimerRunning: boolean;
  reviewTaskTimerRunning: boolean;
  pendingDeliveryState?: PendingMemberDeliveryState;
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
  runtimeTelemetryScale?: RuntimeTelemetryScale;
  renderRuntimeTelemetryStrip?: boolean;
  onOpenTask?: (taskId: string) => void;
  onMemberClick?: (member: ResolvedTeamMember) => void;
  onSendMessage?: (member: ResolvedTeamMember) => void;
  onAssignTask?: (member: ResolvedTeamMember) => void;
  onRestartMember?: (memberName: string) => Promise<void> | void;
  onSkipMemberForLaunch?: (memberName: string) => Promise<void> | void;
  onRestoreMember?: (memberName: string) => Promise<void> | void;
}

const MemberCardRow = memo(function MemberCardRow({
  teamName,
  member,
  isRemoved,
  memberColor,
  avatarUrl,
  fullBleedSurface,
  currentTask,
  reviewTask,
  currentTaskTimer,
  reviewTaskTimer,
  currentTaskTimerRunning,
  reviewTaskTimerRunning,
  pendingDeliveryState,
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
  runtimeTelemetryScale,
  renderRuntimeTelemetryStrip,
  onOpenTask,
  onMemberClick,
  onSendMessage,
  onAssignTask,
  onRestartMember,
  onSkipMemberForLaunch,
  onRestoreMember,
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
      teamName={teamName}
      member={member}
      memberColor={memberColor}
      avatarUrl={avatarUrl}
      fullBleedSurface={fullBleedSurface}
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
      pendingDeliveryState={pendingDeliveryState}
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
      runtimeTelemetryScale={runtimeTelemetryScale}
      renderRuntimeTelemetryStrip={renderRuntimeTelemetryStrip}
      onOpenTask={currentTask ? handleOpenTask : undefined}
      onOpenReviewTask={reviewTask ? handleOpenReviewTask : undefined}
      onClick={handleClick}
      onSendMessage={handleSendMessage}
      onAssignTask={handleAssignTask}
      onRestartMember={onRestartMember}
      onSkipMemberForLaunch={onSkipMemberForLaunch}
      onRestoreMember={onRestoreMember}
    />
  );
});

const MEMBER_LOADING_ACCENTS = ['#46d93b', '#3b82f6', '#facc15', '#14b8a6', '#ef4444'];

function getMemberLoadingSkeletonCount(expectedTeammateCount: number | undefined): number {
  if (!Number.isFinite(expectedTeammateCount) || !expectedTeammateCount) {
    return 3;
  }
  return Math.min(Math.max(1, Math.floor(expectedTeammateCount)), MEMBER_LOADING_ACCENTS.length);
}

const MemberListLoadingSkeleton = ({
  expectedTeammateCount,
}: Readonly<{
  expectedTeammateCount?: number;
}>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const skeletonCount = getMemberLoadingSkeletonCount(expectedTeammateCount);
  const { isLight } = useTheme();

  return (
    <div
      className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-sidebar)] p-3"
      role="status"
      aria-label={t('members.list.loading')}
    >
      <div className="grid grid-cols-1 gap-1">
        {Array.from({ length: skeletonCount }, (_, index) => {
          const accent = MEMBER_LOADING_ACCENTS[index] ?? MEMBER_LOADING_ACCENTS[0];
          return (
            <div key={index} className="flex min-h-[52px] min-w-0 items-center gap-2.5">
              <div className="relative size-[34px] shrink-0">
                <div
                  className="absolute inset-0 rounded-full border-2 bg-[var(--color-surface-raised)]"
                  style={{
                    borderColor: accent,
                    boxShadow: isLight ? 'none' : `0 0 0 1px ${accent}26`,
                  }}
                />
                <div
                  className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-[var(--color-surface)]"
                  style={{ backgroundColor: accent }}
                />
              </div>
              <div className="min-w-0 flex-1">
                <div
                  className="skeleton-shimmer h-4 rounded-sm"
                  style={{
                    width: index % 2 === 0 ? '3.5rem' : '4.25rem',
                    backgroundColor: 'var(--skeleton-base)',
                  }}
                />
                <div
                  className="skeleton-shimmer mt-1.5 h-2.5 rounded-sm"
                  style={{
                    width: index % 3 === 0 ? '13rem' : index % 3 === 1 ? '15rem' : '11rem',
                    maxWidth: '76%',
                    backgroundColor: 'var(--skeleton-base-dim)',
                  }}
                />
              </div>
              <div className="hidden shrink-0 items-center gap-3 sm:flex">
                <div
                  className="skeleton-shimmer h-[18px] w-[62px] rounded-full border border-[var(--color-border)]"
                  style={{ backgroundColor: 'var(--skeleton-base-dim)' }}
                />
                <div
                  className="skeleton-shimmer h-[18px] w-[62px] rounded-full border border-[var(--color-border)]"
                  style={{ backgroundColor: 'var(--skeleton-base-dim)' }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const MemberRosterUnavailableState = ({
  expectedTeammateCount,
}: Readonly<{
  expectedTeammateCount?: number;
}>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const count = Number.isFinite(expectedTeammateCount)
    ? Math.max(0, Math.floor(expectedTeammateCount ?? 0))
    : 0;
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-sidebar)] p-4 text-sm text-[var(--color-text-muted)]">
      <div className="font-medium text-[var(--color-text)]">{t('members.list.unavailable')}</div>
      <div className="mt-1 text-xs">{t('members.list.unavailableDescription', { count })}</div>
    </div>
  );
};

export const MemberList = memo(function MemberList({
  teamName = '__unknown_team__',
  members,
  expectedTeammateCount,
  memberTaskCounts,
  taskMap,
  pendingRepliesByMember,
  messages = [],
  memberSpawnStatuses,
  memberRuntimeEntries,
  runtimeRunId,
  isLaunchSettling,
  isRosterLoading,
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
  onRestoreMember,
}: MemberListProps): React.JSX.Element {
  const { t } = useAppTranslation('team');
  const containerRef = useRef<HTMLDivElement>(null);
  const [isWide, setIsWide] = useState(false);
  const [runtimeTelemetryPreviewActive, setRuntimeTelemetryPreviewActive] = useState(false);
  const memberRuntimeEntriesRef = useRef(memberRuntimeEntries);
  const memberRuntimeEntryCacheRef = useRef(new Map<string, CachedMemberRuntimeEntry>());
  const displayedRuntimeEntriesRef = useRef<Map<string, TeamAgentRuntimeEntry> | undefined>(
    undefined
  );
  memberRuntimeEntriesRef.current = memberRuntimeEntries;
  const [runtimeTelemetryCacheNowMs, setRuntimeTelemetryCacheNowMs] = useState(() => Date.now());
  const hasMemberRuntimeEntries = Boolean(memberRuntimeEntries && memberRuntimeEntries.size > 0);

  useEffect(() => {
    if (!hasMemberRuntimeEntries) return;
    const intervalId = window.setInterval(() => {
      setRuntimeTelemetryCacheNowMs(Date.now());
    }, MEMBER_CARD_RUNTIME_TELEMETRY_CACHE_MS);
    return () => window.clearInterval(intervalId);
  }, [hasMemberRuntimeEntries]);

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

  const activateRuntimeTelemetryPreview = useCallback(() => {
    setRuntimeTelemetryPreviewActive(true);
  }, []);

  const deactivateRuntimeTelemetryPreview = useCallback(() => {
    setRuntimeTelemetryPreviewActive(false);
  }, []);

  const handleRuntimeTelemetryPreviewBlur = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
        return;
      }
      deactivateRuntimeTelemetryPreview();
    },
    [deactivateRuntimeTelemetryPreview]
  );

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
  const activeTeammateCount = useMemo(
    () => activeMembers.filter((member) => !isLeadMember(member)).length,
    [activeMembers]
  );
  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);
  const avatarMap = useMemo(() => buildMemberAvatarMap(members), [members]);
  const cardRuntimeEntries = useMemo(() => {
    const nextEntries = buildCachedMemberRuntimeEntries(
      memberRuntimeEntries,
      memberRuntimeEntryCacheRef.current,
      runtimeTelemetryCacheNowMs
    );
    const reusedEntries = reuseRuntimeEntriesMapIfUnchanged(
      displayedRuntimeEntriesRef.current,
      nextEntries
    );
    displayedRuntimeEntriesRef.current = reusedEntries;
    return reusedEntries;
  }, [memberRuntimeEntries, runtimeTelemetryCacheNowMs]);
  const runtimeTelemetryScale = useMemo(
    () =>
      runtimeTelemetryPreviewActive
        ? buildRuntimeTelemetryScale(activeMembers, cardRuntimeEntries)
        : undefined,
    [activeMembers, cardRuntimeEntries, runtimeTelemetryPreviewActive]
  );
  const activityTimerRuntimeSignature = useMemo(
    () => buildActivityTimerRuntimeSignature(activeMembers, memberRuntimeEntries),
    [activeMembers, memberRuntimeEntries]
  );
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
      member: ResolvedTeamMember,
      spawnEntry: MemberSpawnStatusEntry | undefined,
      runtimeEntry: TeamAgentRuntimeEntry | undefined
    ): boolean => {
      return shouldDisplayMemberCurrentTask({
        member,
        isTeamAlive,
        spawnStatus: spawnEntry?.status,
        spawnLaunchState: spawnEntry?.launchState,
        spawnRuntimeAlive: spawnEntry?.runtimeAlive,
        spawnEntry,
        runtimeEntry,
      });
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
    const latestRuntimeEntries = memberRuntimeEntriesRef.current;
    for (const member of activeMembers) {
      const spawnEntry = memberSpawnStatuses?.get(member.name);
      const runtimeEntry = latestRuntimeEntries?.get(member.name);
      const running = isMemberActivityTimerRunning(member, spawnEntry, runtimeEntry);
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
              spawnEntry,
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
    activityTimerRuntimeSignature,
    getActivityTimerRunId,
    isMemberActivityTimerRunning,
    isTeamAlive,
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

  const expectsTeammates = (expectedTeammateCount ?? 0) > 0;
  const canStillHydrateExpectedTeammates =
    Boolean(isRosterLoading || isTeamProvisioning) ||
    (isTeamAlive !== false && Boolean(isLaunchSettling));
  const shouldShowExpectedTeammateSkeleton = expectsTeammates && canStillHydrateExpectedTeammates;
  const hasOnlyLeadWhileTeammatesLoad =
    shouldShowExpectedTeammateSkeleton && activeTeammateCount === 0 && removedMembers.length === 0;

  if (members.length === 0) {
    if (shouldShowExpectedTeammateSkeleton) {
      return <MemberListLoadingSkeleton expectedTeammateCount={expectedTeammateCount} />;
    }
    if (expectsTeammates) {
      return <MemberRosterUnavailableState expectedTeammateCount={expectedTeammateCount} />;
    }

    return (
      <div className="rounded-md border border-[var(--color-border)] p-4 text-sm text-[var(--color-text-muted)]">
        {t('members.list.soloLeadOnly')}
      </div>
    );
  }

  if (hasOnlyLeadWhileTeammatesLoad) {
    return <MemberListLoadingSkeleton expectedTeammateCount={expectedTeammateCount} />;
  }

  return (
    <div
      ref={containerRef}
      className="runtime-telemetry-list flex flex-col gap-1"
      onPointerEnter={activateRuntimeTelemetryPreview}
      onPointerLeave={deactivateRuntimeTelemetryPreview}
      onFocusCapture={activateRuntimeTelemetryPreview}
      onBlurCapture={handleRuntimeTelemetryPreviewBlur}
    >
      <div className={gridClass}>
        {activeMembers.map((member) => {
          const spawnEntry = memberSpawnStatuses?.get(member.name);
          const liveRuntimeEntry = memberRuntimeEntries?.get(member.name);
          const cardRuntimeEntry = cardRuntimeEntries?.get(member.name);
          const runtimeEntry = liveRuntimeEntry;
          const displayRuntimeEntry = cardRuntimeEntry ?? liveRuntimeEntry;
          const bootstrapConfirmedProvisionedButNotAlive =
            isBootstrapConfirmedProvisionedButNotAliveFailure(spawnEntry);
          const hasUnsafeProvisionedButNotAliveEvidence =
            bootstrapConfirmedProvisionedButNotAlive &&
            hasUnsafeProvisionedButNotAliveRuntimeEvidenceWithSpawnContext(
              spawnEntry,
              runtimeEntry
            );
          const canPromoteBootstrapConfirmedVisualState =
            bootstrapConfirmedProvisionedButNotAlive &&
            spawnEntry?.runtimeDiagnosticSeverity !== 'error' &&
            runtimeEntry?.runtimeDiagnosticSeverity !== 'error' &&
            !hasUnsafeProvisionedButNotAliveEvidence;
          const effectiveSpawnStatus = canPromoteBootstrapConfirmedVisualState
            ? 'online'
            : spawnEntry?.status;
          const effectiveSpawnLaunchState = canPromoteBootstrapConfirmedVisualState
            ? 'confirmed_alive'
            : spawnEntry?.launchState;
          const useBootstrapConfirmedRuntimeAlive =
            canPromoteBootstrapConfirmedVisualState &&
            runtimeEntry?.runtimeDiagnosticSeverity !== 'error' &&
            spawnEntry?.runtimeDiagnosticSeverity !== 'error';
          const effectiveSpawnRuntimeAlive = useBootstrapConfirmedRuntimeAlive
            ? true
            : spawnEntry?.runtimeAlive;
          const currentTaskCandidate =
            member.currentTaskId && taskMap ? (taskMap.get(member.currentTaskId) ?? null) : null;
          const currentTask =
            isDisplayableCurrentTask(currentTaskCandidate) &&
            shouldDisplayMemberCurrentTask({
              member,
              isTeamAlive,
              spawnStatus: effectiveSpawnStatus,
              spawnLaunchState: effectiveSpawnLaunchState,
              spawnRuntimeAlive: effectiveSpawnRuntimeAlive,
              spawnEntry,
              runtimeEntry,
            })
              ? currentTaskCandidate
              : null;
          const reviewCandidate = reviewTaskByMember.get(member.name) ?? null;
          const reviewTask =
            reviewCandidate &&
            reviewCandidate.id !== currentTask?.id &&
            shouldDisplayMemberCurrentTask({
              member,
              isTeamAlive,
              spawnStatus: effectiveSpawnStatus,
              spawnLaunchState: effectiveSpawnLaunchState,
              spawnRuntimeAlive: effectiveSpawnRuntimeAlive,
              spawnEntry,
              runtimeEntry,
            })
              ? reviewCandidate
              : null;
          const activityTimerRunning = isMemberActivityTimerRunning(
            member,
            spawnEntry,
            runtimeEntry
          );
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
              teamName={teamName}
              member={member}
              isRemoved={false}
              memberColor={colorMap.get(member.name) ?? 'blue'}
              avatarUrl={avatarMap.get(member.name)}
              fullBleedSurface={!isWide}
              currentTask={currentTask}
              reviewTask={reviewTask}
              currentTaskTimer={currentTaskTimer}
              reviewTaskTimer={reviewTaskTimer}
              currentTaskTimerRunning={currentTask !== null && activityTimerRunning}
              reviewTaskTimerRunning={reviewTask !== null && activityTimerRunning}
              pendingDeliveryState={
                pendingRepliesByMember?.[member.name] != null
                  ? getPendingMemberDeliveryState(
                      isTeamAlive,
                      messages,
                      member.name,
                      pendingRepliesByMember[member.name]
                    )
                  : undefined
              }
              taskCounts={memberTaskCounts?.get(member.name.toLowerCase())}
              runtimeSummary={buildRuntimeSummary(member, spawnEntry, displayRuntimeEntry)}
              runtimeEntry={displayRuntimeEntry}
              runtimeRunId={runtimeRunId}
              spawnStatus={effectiveSpawnStatus}
              spawnEntry={spawnEntry}
              spawnError={
                canPromoteBootstrapConfirmedVisualState
                  ? undefined
                  : (spawnEntry?.error ?? spawnEntry?.hardFailureReason)
              }
              spawnLivenessSource={spawnEntry?.livenessSource}
              spawnLaunchState={effectiveSpawnLaunchState}
              spawnRuntimeAlive={effectiveSpawnRuntimeAlive}
              isTeamAlive={isTeamAlive}
              isTeamProvisioning={isTeamProvisioning}
              leadActivity={leadActivity}
              isLaunchSettling={isLaunchSettling}
              runtimeTelemetryScale={runtimeTelemetryScale}
              renderRuntimeTelemetryStrip={runtimeTelemetryPreviewActive}
              onOpenTask={onOpenTask}
              onMemberClick={onMemberClick}
              onSendMessage={onSendMessage}
              onAssignTask={onAssignTask}
              onRestartMember={onRestartMember}
              onSkipMemberForLaunch={onSkipMemberForLaunch}
              onRestoreMember={onRestoreMember}
            />
          );
        })}
      </div>
      {removedMembers.length > 0 && (
        <>
          <div className="mt-2 text-[10px] text-[var(--color-text-muted)]">
            {t('members.list.removedCount', { count: removedMembers.length })}
          </div>
          <div className={gridClass}>
            {removedMembers.map((member) => (
              <MemberCardRow
                key={member.name}
                teamName={teamName}
                member={member}
                isRemoved={true}
                memberColor={colorMap.get(member.name) ?? 'blue'}
                avatarUrl={avatarMap.get(member.name)}
                fullBleedSurface={!isWide}
                currentTask={null}
                reviewTask={null}
                currentTaskTimer={null}
                reviewTaskTimer={null}
                currentTaskTimerRunning={false}
                reviewTaskTimerRunning={false}
                pendingDeliveryState={undefined}
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
                runtimeTelemetryScale={runtimeTelemetryScale}
                renderRuntimeTelemetryStrip={runtimeTelemetryPreviewActive}
                onOpenTask={onOpenTask}
                onMemberClick={onMemberClick}
                onSendMessage={onSendMessage}
                onAssignTask={onAssignTask}
                onRestartMember={undefined}
                onSkipMemberForLaunch={undefined}
                onRestoreMember={onRestoreMember}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}, areMemberListPropsEqual);
