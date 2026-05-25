import { getMemberColorByName } from '@shared/constants/memberColors';
import { isLeadMember } from '@shared/utils/leadDetection';
import {
  getTeamTaskWorkflowColumn,
  isTeamTaskFinalForCompletionNotification,
} from '@shared/utils/teamTaskState';

import { selectTeamDataForName, type TeamDataSelectorState } from './teamDataSelectors';

import type {
  MemberActivityMetaEntry,
  ResolvedTeamMember,
  TeamMemberActivityMeta,
  TeamMemberSnapshot,
  TeamSummary,
  TeamViewSnapshot,
} from '@shared/types';

export interface ResolvedMemberSelectorState extends TeamDataSelectorState {
  memberActivityMetaByTeam: Record<string, TeamMemberActivityMeta>;
  teamByName?: Record<string, TeamSummary>;
}

export interface ResolvedMemberSelectorCacheSnapshot {
  hasResolvedMembersSelector: boolean;
  resolvedMemberSelectorCount: number;
}

const resolvedMembersSelectorCache = new Map<
  string,
  {
    snapshotRef: TeamViewSnapshot['members'];
    configMembersRef: TeamViewSnapshot['config']['members'] | undefined;
    summaryRef: TeamSummary | undefined;
    tasksRef: TeamViewSnapshot['tasks'] | undefined;
    metaMembersRef: TeamMemberActivityMeta['members'] | undefined;
    result: ResolvedTeamMember[];
  }
>();
const resolvedMemberSelectorCache = new Map<
  string,
  {
    snapshotMemberRef: TeamMemberSnapshot | undefined;
    metaEntryRef: MemberActivityMetaEntry | undefined;
    result: ResolvedTeamMember | null;
  }
>();

export function clearResolvedMemberSelectorCaches(): void {
  resolvedMembersSelectorCache.clear();
  resolvedMemberSelectorCache.clear();
}

export function clearResolvedMemberSelectorCachesForTeam(teamName: string): void {
  resolvedMembersSelectorCache.delete(teamName);

  const teamScopedPrefix = `${teamName}:`;
  for (const key of resolvedMemberSelectorCache.keys()) {
    if (key.startsWith(teamScopedPrefix)) {
      resolvedMemberSelectorCache.delete(key);
    }
  }
}

export function getResolvedMemberSelectorCacheSnapshotForTeam(
  teamName: string
): ResolvedMemberSelectorCacheSnapshot {
  const teamScopedPrefix = `${teamName}:`;
  let resolvedMemberSelectorCount = 0;

  for (const key of resolvedMemberSelectorCache.keys()) {
    if (key.startsWith(teamScopedPrefix)) {
      resolvedMemberSelectorCount += 1;
    }
  }

  return {
    hasResolvedMembersSelector: resolvedMembersSelectorCache.has(teamName),
    resolvedMemberSelectorCount,
  };
}

function resolveMemberStatus(
  snapshot: TeamMemberSnapshot,
  activity: MemberActivityMetaEntry | undefined
): ResolvedTeamMember['status'] {
  if (activity?.latestAuthoredMessageSignalsTermination) {
    return 'terminated';
  }

  if (!activity?.lastAuthoredMessageAt) {
    return snapshot.currentTaskId ? 'active' : 'idle';
  }

  const ageMs = Date.now() - Date.parse(activity.lastAuthoredMessageAt);
  if (Number.isNaN(ageMs)) {
    return 'unknown';
  }
  if (ageMs < 5 * 60 * 1000) {
    return 'active';
  }
  return 'idle';
}

function buildResolvedMembers(
  snapshots: readonly TeamMemberSnapshot[],
  meta: TeamMemberActivityMeta | undefined
): ResolvedTeamMember[] {
  return snapshots.map((member) => buildResolvedMember(member, meta?.members[member.name]));
}

function isDisplayableFallbackCurrentTask(task: TeamViewSnapshot['tasks'][number]): boolean {
  return (
    task.status === 'in_progress' &&
    getTeamTaskWorkflowColumn(task) !== 'review' &&
    !isTeamTaskFinalForCompletionNotification(task)
  );
}

function buildConfigFallbackMemberSnapshots(snapshot: TeamViewSnapshot): TeamMemberSnapshot[] {
  const configMembers = snapshot.config.members ?? [];
  const hasConfiguredTeammate = configMembers.some((member) => {
    const name = member.name?.trim();
    return Boolean(name) && !member.removedAt && !isLeadMember(member);
  });
  if (!hasConfiguredTeammate) {
    return [];
  }

  const seenNames = new Set<string>();
  const fallbackMembers: TeamMemberSnapshot[] = [];
  for (const member of configMembers) {
    const name = member.name?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);

    const ownedTasks = snapshot.tasks.filter((task) => task.owner === name);
    const currentTask = ownedTasks.find(isDisplayableFallbackCurrentTask);
    fallbackMembers.push({
      name,
      agentId: member.agentId,
      currentTaskId: currentTask?.id ?? null,
      taskCount: ownedTasks.length,
      color: member.color ?? getMemberColorByName(name),
      agentType: member.agentType,
      role: member.role,
      workflow: member.workflow,
      isolation: member.isolation,
      providerId: member.providerId,
      providerBackendId: member.providerBackendId,
      model: member.model,
      effort: member.effort,
      mcpPolicy: member.mcpPolicy,
      selectedFastMode: member.fastMode,
      cwd: member.cwd,
      removedAt: member.removedAt,
    });
  }

  return fallbackMembers;
}

function getActiveRawTeammateNameKeys(snapshot: TeamViewSnapshot | null | undefined): string[] {
  if (!snapshot) {
    return [];
  }
  const names = new Set<string>();
  for (const member of snapshot.members) {
    const name = member.name.trim();
    const key = name.toLowerCase();
    if (!name || key === 'user' || member.removedAt || isLeadMember(member)) {
      continue;
    }
    names.add(key);
  }
  return Array.from(names).sort((left, right) => left.localeCompare(right));
}

function hasActiveRawTeammateRoster(snapshot: TeamViewSnapshot | null | undefined): boolean {
  return getActiveRawTeammateNameKeys(snapshot).length > 0;
}

function hasRemovedRawMemberRoster(snapshot: TeamViewSnapshot | null | undefined): boolean {
  return Boolean(snapshot?.members.some((member) => member.removedAt));
}

function hasConfigTeammateRoster(snapshot: TeamViewSnapshot | null | undefined): boolean {
  return Boolean(
    snapshot?.config.members?.some((member) => {
      const name = member.name?.trim();
      return Boolean(name) && !member.removedAt && !isLeadMember(member);
    })
  );
}

interface SummaryFallbackMemberSource {
  name: string;
  agentId?: string;
  role?: string;
  color?: string;
  mcpPolicy?: TeamMemberSnapshot['mcpPolicy'];
}

function normalizeSummaryTeammateName(
  name: string | undefined | null,
  leadName?: string
): string | null {
  const trimmed = name?.trim();
  const normalizedName = trimmed?.toLowerCase();
  const normalizedLeadName = leadName?.trim().toLowerCase();
  if (
    !trimmed ||
    normalizedName === 'user' ||
    isLeadMember({ name: trimmed }) ||
    (normalizedLeadName && normalizedName === normalizedLeadName)
  ) {
    return null;
  }
  return trimmed;
}

function getSummaryRosterTeammateSources(summary: TeamSummary): SummaryFallbackMemberSource[] {
  const seenNames = new Set<string>();
  const sources: SummaryFallbackMemberSource[] = [];
  for (const member of summary.members ?? []) {
    const name = normalizeSummaryTeammateName(member.name, summary.leadName);
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (seenNames.has(key)) {
      continue;
    }
    seenNames.add(key);
    sources.push({
      name,
      agentId: member.agentId,
      role: member.role,
      color: member.color,
      mcpPolicy: member.mcpPolicy,
    });
  }
  return sources;
}

function shouldUseSummaryLaunchTeammateSources(summary: TeamSummary): boolean {
  return (
    summary.partialLaunchFailure === true ||
    summary.teamLaunchState === 'partial_failure' ||
    summary.teamLaunchState === 'partial_pending' ||
    summary.teamLaunchState === 'partial_skipped'
  );
}

function getSummaryLaunchTeammateSources(summary: TeamSummary): SummaryFallbackMemberSource[] {
  if (!shouldUseSummaryLaunchTeammateSources(summary)) {
    return [];
  }

  const seenNames = new Set<string>();
  const sources: SummaryFallbackMemberSource[] = [];
  for (const rawName of [...(summary.missingMembers ?? []), ...(summary.skippedMembers ?? [])]) {
    const name = normalizeSummaryTeammateName(rawName, summary.leadName);
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (seenNames.has(key)) {
      continue;
    }
    seenNames.add(key);
    sources.push({ name });
  }
  return sources;
}

function getSummaryLaunchTeammateNameKeys(summary: TeamSummary): string[] {
  return getSummaryLaunchTeammateSources(summary)
    .map((member) => member.name.toLowerCase())
    .sort((left, right) => left.localeCompare(right));
}

function getSummaryTeammateNameKeys(summary: TeamSummary): string[] {
  const rosterNames = getSummaryRosterTeammateSources(summary)
    .map((member) => member.name.toLowerCase())
    .sort((left, right) => left.localeCompare(right));
  if (rosterNames.length > 0) {
    return rosterNames;
  }

  const launchNames = getSummaryLaunchTeammateNameKeys(summary);
  const expectedCount = summary.expectedMemberCount ?? summary.memberCount;
  if (expectedCount > 0 && launchNames.length === expectedCount) {
    return launchNames;
  }
  return [];
}

function getSummaryFallbackTeammateSources(summary: TeamSummary): SummaryFallbackMemberSource[] {
  return getSummaryRosterTeammateSources(summary);
}

function areNameKeyListsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function summaryConfirmsActiveTeammateRoster(
  current: TeamViewSnapshot,
  summary: TeamSummary
): boolean {
  if ((summary.expectedMemberCount ?? summary.memberCount) <= 0) {
    return false;
  }

  const currentNames = getActiveRawTeammateNameKeys(current);
  const summaryNames = getSummaryTeammateNameKeys(summary);
  if (summaryNames.length === 0 || summaryNames.length !== currentNames.length) {
    return false;
  }

  return areNameKeyListsEqual(summaryNames, currentNames);
}

function buildSummaryFallbackMemberSnapshots(
  snapshot: TeamViewSnapshot,
  summary: TeamSummary | undefined
): TeamMemberSnapshot[] {
  if (!summary) {
    return [];
  }
  const summaryMembers = getSummaryFallbackTeammateSources(summary);
  if (summaryMembers.length === 0) {
    return [];
  }

  const seenNames = new Set<string>();
  const buildSnapshot = (
    name: string,
    source?: Omit<SummaryFallbackMemberSource, 'name'>,
    lead = false
  ): TeamMemberSnapshot | null => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const key = trimmed.toLowerCase();
    if (seenNames.has(key)) return null;
    seenNames.add(key);

    const ownedTasks = snapshot.tasks.filter((task) => task.owner === trimmed);
    const currentTask = ownedTasks.find(isDisplayableFallbackCurrentTask);
    return {
      name: trimmed,
      agentId: source?.agentId,
      currentTaskId: currentTask?.id ?? null,
      taskCount: ownedTasks.length,
      color: source?.color ?? getMemberColorByName(trimmed),
      agentType: lead ? 'team-lead' : undefined,
      role: source?.role ?? (lead ? 'Team Lead' : undefined),
      mcpPolicy: source?.mcpPolicy,
    };
  };

  const teammates = summaryMembers.flatMap((member) => {
    const item = buildSnapshot(member.name, member);
    return item ? [item] : [];
  });
  if (teammates.length === 0) {
    return [];
  }

  const existingLead = snapshot.members.find((member) => !member.removedAt && isLeadMember(member));
  if (existingLead) {
    return [existingLead, ...teammates];
  }

  const configuredLead = snapshot.config.members?.find(
    (member) => !member.removedAt && isLeadMember(member)
  );
  const leadName = configuredLead?.name?.trim() || summary.leadName?.trim();
  const lead = leadName
    ? buildSnapshot(
        leadName,
        {
          agentId: configuredLead?.agentId,
          role: configuredLead?.role,
          color: configuredLead?.color ?? summary.leadColor,
        },
        true
      )
    : null;

  return lead ? [lead, ...teammates] : teammates;
}

function getResolvableMemberSnapshots(
  snapshot: TeamViewSnapshot,
  summary?: TeamSummary
): readonly TeamMemberSnapshot[] {
  if (
    snapshot.members.length > 0 &&
    (hasActiveRawTeammateRoster(snapshot) || hasRemovedRawMemberRoster(snapshot))
  ) {
    return snapshot.members;
  }

  const configFallbackMembers = buildConfigFallbackMemberSnapshots(snapshot);
  if (configFallbackMembers.length > 0) {
    return configFallbackMembers;
  }

  const summaryFallbackMembers = buildSummaryFallbackMemberSnapshots(snapshot, summary);
  if (summaryFallbackMembers.length > 0) {
    return summaryFallbackMembers;
  }

  return snapshot.members;
}

export function shouldPreserveSelectedTeamSnapshot(
  current: TeamViewSnapshot | null,
  baseline: TeamViewSnapshot | null | undefined,
  incoming: TeamViewSnapshot,
  summary: TeamSummary | undefined
): boolean {
  if (!current || !hasActiveRawTeammateRoster(current)) {
    return false;
  }
  if (
    hasActiveRawTeammateRoster(incoming) ||
    hasRemovedRawMemberRoster(incoming) ||
    hasConfigTeammateRoster(incoming)
  ) {
    return false;
  }
  const currentNames = getActiveRawTeammateNameKeys(current);
  if (
    current !== baseline &&
    !areNameKeyListsEqual(currentNames, getActiveRawTeammateNameKeys(baseline))
  ) {
    return true;
  }
  if (summary) {
    return summaryConfirmsActiveTeammateRoster(current, summary);
  }

  return false;
}

function buildResolvedMember(
  snapshot: TeamMemberSnapshot,
  activity: MemberActivityMetaEntry | undefined
): ResolvedTeamMember {
  return {
    ...snapshot,
    status: resolveMemberStatus(snapshot, activity),
    messageCount: activity?.messageCountExact ?? 0,
    lastActiveAt: activity?.lastAuthoredMessageAt ?? null,
  };
}

export function selectResolvedMembersForTeamName(
  state: ResolvedMemberSelectorState,
  teamName: string | null | undefined
): ResolvedTeamMember[] {
  const snapshot = selectTeamDataForName(state, teamName);
  if (!snapshot || !teamName) {
    return [];
  }

  const meta = state.memberActivityMetaByTeam[teamName];
  const metaMembers = meta?.members;
  const shouldUseMemberFallback =
    snapshot.members.length === 0 ||
    (!hasActiveRawTeammateRoster(snapshot) && !hasRemovedRawMemberRoster(snapshot));
  const configMembersRef = shouldUseMemberFallback ? snapshot.config.members : undefined;
  const summaryRef = shouldUseMemberFallback ? state.teamByName?.[teamName] : undefined;
  const tasksRef = shouldUseMemberFallback ? snapshot.tasks : undefined;
  const cached = resolvedMembersSelectorCache.get(teamName);
  if (
    cached?.snapshotRef === snapshot.members &&
    cached.configMembersRef === configMembersRef &&
    cached.summaryRef === summaryRef &&
    cached.tasksRef === tasksRef &&
    cached.metaMembersRef === metaMembers
  ) {
    return cached.result;
  }

  const result = buildResolvedMembers(getResolvableMemberSnapshots(snapshot, summaryRef), meta);
  resolvedMembersSelectorCache.set(teamName, {
    snapshotRef: snapshot.members,
    configMembersRef,
    summaryRef,
    tasksRef,
    metaMembersRef: metaMembers,
    result,
  });
  return result;
}

export function selectResolvedMemberForTeamName(
  state: ResolvedMemberSelectorState,
  teamName: string | null | undefined,
  memberName: string | null | undefined
): ResolvedTeamMember | null {
  const snapshot = selectTeamDataForName(state, teamName);
  if (!snapshot || !teamName || !memberName) {
    return null;
  }

  const snapshotMember = getResolvableMemberSnapshots(snapshot, state.teamByName?.[teamName]).find(
    (member) => member.name === memberName
  );
  if (!snapshotMember) {
    return null;
  }

  const metaEntry = state.memberActivityMetaByTeam[teamName]?.members[memberName];
  const cacheKey = `${teamName}:${memberName}`;
  const cached = resolvedMemberSelectorCache.get(cacheKey);
  if (cached?.snapshotMemberRef === snapshotMember && cached.metaEntryRef === metaEntry) {
    return cached.result;
  }

  const result = buildResolvedMember(snapshotMember, metaEntry);
  resolvedMemberSelectorCache.set(cacheKey, {
    snapshotMemberRef: snapshotMember,
    metaEntryRef: metaEntry,
    result,
  });
  return result;
}
