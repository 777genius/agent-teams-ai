import {
  DISPLAY_COMPLETE_STEP_INDEX,
  getDisplayStepIndex,
  getLaunchJoinMilestonesFromMembers,
  getLaunchJoinState,
} from '@renderer/components/team/provisioningSteps';
import { isLeadMember } from '@shared/utils/leadDetection';

import type {
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  TeamProvisioningProgress,
} from '@shared/types';

type MemberSpawnStatusCollection =
  | Record<string, MemberSpawnStatusEntry>
  | Map<string, MemberSpawnStatusEntry>
  | undefined;

interface ProvisioningMemberLike {
  name: string;
  removedAt?: number;
  agentType?: string;
  providerId?: string;
  laneId?: string;
  laneKind?: 'primary' | 'secondary';
  laneOwnerProviderId?: string;
  status?: string;
  currentTaskId?: string | null;
  taskCount?: number;
  lastActiveAt?: string | null;
  messageCount?: number;
}

interface FailedSpawnDetail {
  name: string;
  reason: string | null;
}

interface SkippedSpawnDetail {
  name: string;
  reason: string | null;
}

type PendingDiagnosticBucket =
  | 'bootstrapStalled'
  | 'shellOnly'
  | 'runtimeProcess'
  | 'runtimeCandidate'
  | 'permission'
  | 'noRuntime';

type PendingDiagnosticNameGroups = Record<PendingDiagnosticBucket, string[]>;

const MAX_PENDING_DIAGNOSTIC_NAMES = 4;

function translateProvisioning(
  t: unknown,
  key: string,
  fallback: string,
  options?: Record<string, unknown>
): string {
  if (!t) {
    return fallback;
  }

  return (t as (translationKey: string, options?: Record<string, unknown>) => string)(key, {
    defaultValue: fallback,
    ...options,
  });
}

function parseStatusUpdatedAtMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isFailedSpawnEntry(entry: MemberSpawnStatusEntry | undefined): boolean {
  return entry?.launchState === 'failed_to_start' || entry?.status === 'error';
}

function isSkippedSpawnEntry(entry: MemberSpawnStatusEntry | undefined): boolean {
  return entry?.launchState === 'skipped_for_launch' || entry?.skippedForLaunch === true;
}

function isOpenCodeSecondaryRetryCandidate(params: {
  member: ProvisioningMemberLike | undefined;
  entry: MemberSpawnStatusEntry | undefined;
}): boolean {
  const { member, entry } = params;
  if (!member || !entry) {
    return false;
  }
  if (member.providerId !== 'opencode' || member.removedAt) {
    return false;
  }
  if (isLeadMember({ name: member.name, agentType: member.agentType })) {
    return false;
  }
  if (member.laneKind && member.laneKind !== 'secondary') {
    return false;
  }
  if (member.laneOwnerProviderId && member.laneOwnerProviderId !== 'opencode') {
    return false;
  }
  if (
    entry.launchState === 'skipped_for_launch' ||
    entry.skippedForLaunch === true ||
    entry.launchState === 'runtime_pending_permission' ||
    entry.launchState === 'runtime_pending_bootstrap' ||
    (entry.pendingPermissionRequestIds?.length ?? 0) > 0 ||
    entry.launchState === 'starting' ||
    entry.status === 'spawning' ||
    entry.launchState === 'confirmed_alive' ||
    entry.bootstrapConfirmed === true
  ) {
    return false;
  }
  return entry.launchState === 'failed_to_start' || entry.status === 'error';
}

function shouldPreferSnapshotEntryOverLive(params: {
  liveEntry: MemberSpawnStatusEntry | undefined;
  snapshotEntry: MemberSpawnStatusEntry | undefined;
  snapshotUpdatedAt?: string;
}): boolean {
  const { liveEntry, snapshotEntry, snapshotUpdatedAt } = params;
  if (!liveEntry || !snapshotEntry) {
    return false;
  }
  if (!isFailedSpawnEntry(liveEntry) || isFailedSpawnEntry(snapshotEntry)) {
    return false;
  }

  const liveUpdatedAtMs = parseStatusUpdatedAtMs(liveEntry.updatedAt);
  const snapshotUpdatedAtMs =
    parseStatusUpdatedAtMs(snapshotEntry.updatedAt) ?? parseStatusUpdatedAtMs(snapshotUpdatedAt);
  return (
    snapshotUpdatedAtMs != null &&
    (liveUpdatedAtMs == null || snapshotUpdatedAtMs >= liveUpdatedAtMs)
  );
}

function getPreferredSpawnEntry(params: {
  liveEntry: MemberSpawnStatusEntry | undefined;
  snapshotEntry: MemberSpawnStatusEntry | undefined;
  snapshotUpdatedAt?: string;
}): MemberSpawnStatusEntry | undefined {
  return shouldPreferSnapshotEntryOverLive(params)
    ? params.snapshotEntry
    : (params.liveEntry ?? params.snapshotEntry);
}

function countPermissionBlockedMembers(params: {
  memberSpawnStatuses: MemberSpawnStatusCollection;
  memberSpawnSnapshotStatuses?: MemberSpawnStatusesSnapshot['statuses'];
  memberSpawnSnapshotUpdatedAt?: string;
}): number {
  const names = new Set<string>();
  if (params.memberSpawnStatuses instanceof Map) {
    for (const name of params.memberSpawnStatuses.keys()) {
      names.add(name);
    }
  } else if (params.memberSpawnStatuses) {
    for (const name of Object.keys(params.memberSpawnStatuses)) {
      names.add(name);
    }
  }
  for (const name of Object.keys(params.memberSpawnSnapshotStatuses ?? {})) {
    names.add(name);
  }

  let count = 0;
  for (const name of names) {
    const liveEntry =
      params.memberSpawnStatuses instanceof Map
        ? params.memberSpawnStatuses.get(name)
        : params.memberSpawnStatuses?.[name];
    const snapshotEntry = params.memberSpawnSnapshotStatuses?.[name];
    const entry = getPreferredSpawnEntry({
      liveEntry,
      snapshotEntry,
      snapshotUpdatedAt: params.memberSpawnSnapshotUpdatedAt,
    });
    if (!entry) {
      continue;
    }
    if (
      entry.launchState === 'runtime_pending_permission' ||
      (entry.pendingPermissionRequestIds?.length ?? 0) > 0
    ) {
      count += 1;
    }
  }
  return count;
}

function buildAwaitingPermissionPhrase(count: number, t?: unknown): string {
  return translateProvisioning(
    t,
    'provisioning.presentation.awaitingPermission',
    count === 1
      ? '1 teammate awaiting permission approval'
      : `${count} teammates awaiting permission approval`,
    { count }
  );
}

function formatMemberNameList(names: readonly string[], t?: unknown): string {
  const listedNames = names.slice(0, MAX_PENDING_DIAGNOSTIC_NAMES).join(', ');
  const remainingCount = names.length - Math.min(names.length, MAX_PENDING_DIAGNOSTIC_NAMES);
  return remainingCount > 0
    ? translateProvisioning(
        t,
        'provisioning.presentation.nameListWithMore',
        `${listedNames}, +${remainingCount} more`,
        { names: listedNames, count: remainingCount }
      )
    : listedNames;
}

function getMemberNamesFromSpawnSources(params: {
  memberSpawnStatuses: MemberSpawnStatusCollection;
  memberSpawnSnapshotStatuses?: MemberSpawnStatusesSnapshot['statuses'];
}): string[] {
  const names = new Set<string>();
  if (params.memberSpawnStatuses instanceof Map) {
    for (const name of params.memberSpawnStatuses.keys()) {
      names.add(name);
    }
  } else if (params.memberSpawnStatuses) {
    for (const name of Object.keys(params.memberSpawnStatuses)) {
      names.add(name);
    }
  }
  for (const name of Object.keys(params.memberSpawnSnapshotStatuses ?? {})) {
    names.add(name);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function getPendingDiagnosticNameGroups(params: {
  memberSpawnStatuses: MemberSpawnStatusCollection;
  memberSpawnSnapshotStatuses?: MemberSpawnStatusesSnapshot['statuses'];
  memberSpawnSnapshotUpdatedAt?: string;
}): PendingDiagnosticNameGroups {
  const groups: PendingDiagnosticNameGroups = {
    bootstrapStalled: [],
    shellOnly: [],
    runtimeProcess: [],
    runtimeCandidate: [],
    permission: [],
    noRuntime: [],
  };

  for (const name of getMemberNamesFromSpawnSources(params)) {
    const liveEntry =
      params.memberSpawnStatuses instanceof Map
        ? params.memberSpawnStatuses.get(name)
        : params.memberSpawnStatuses?.[name];
    const snapshotEntry = params.memberSpawnSnapshotStatuses?.[name];
    const entry = getPreferredSpawnEntry({
      liveEntry,
      snapshotEntry,
      snapshotUpdatedAt: params.memberSpawnSnapshotUpdatedAt,
    });
    if (
      !entry ||
      entry.launchState === 'confirmed_alive' ||
      isFailedSpawnEntry(entry) ||
      isSkippedSpawnEntry(entry)
    ) {
      continue;
    }
    if (
      entry.launchState === 'runtime_pending_permission' ||
      (entry.pendingPermissionRequestIds?.length ?? 0) > 0
    ) {
      groups.permission.push(name);
      continue;
    }
    if (entry.bootstrapStalled === true) {
      groups.bootstrapStalled.push(name);
      continue;
    }
    if (entry.livenessKind === 'shell_only') {
      groups.shellOnly.push(name);
    } else if (entry.livenessKind === 'runtime_process') {
      groups.runtimeProcess.push(name);
    } else if (entry.livenessKind === 'runtime_process_candidate') {
      groups.runtimeCandidate.push(name);
    } else if (
      entry.livenessKind === 'not_found' ||
      entry.livenessKind === 'stale_metadata' ||
      entry.livenessKind === 'registered_only'
    ) {
      groups.noRuntime.push(name);
    }
  }

  return groups;
}

function getPendingSpawnNames(params: {
  memberSpawnStatuses: MemberSpawnStatusCollection;
  memberSpawnSnapshotStatuses?: MemberSpawnStatusesSnapshot['statuses'];
  memberSpawnSnapshotUpdatedAt?: string;
}): string[] {
  return getMemberNamesFromSpawnSources(params).filter((name) => {
    const liveEntry =
      params.memberSpawnStatuses instanceof Map
        ? params.memberSpawnStatuses.get(name)
        : params.memberSpawnStatuses?.[name];
    const snapshotEntry = params.memberSpawnSnapshotStatuses?.[name];
    const entry = getPreferredSpawnEntry({
      liveEntry,
      snapshotEntry,
      snapshotUpdatedAt: params.memberSpawnSnapshotUpdatedAt,
    });
    return (
      entry != null &&
      entry.launchState !== 'confirmed_alive' &&
      !isFailedSpawnEntry(entry) &&
      !isSkippedSpawnEntry(entry)
    );
  });
}

function isOpenCodeSecondaryMember(member: ProvisioningMemberLike | undefined): boolean {
  if (!member || member.removedAt != null || member.providerId !== 'opencode') {
    return false;
  }
  return (
    member.laneKind === 'secondary' ||
    member.laneOwnerProviderId === 'opencode' ||
    member.laneId?.startsWith('secondary:opencode:') === true
  );
}

function buildOpenCodeSecondaryWaitPhrase(params: {
  members: readonly ProvisioningMemberLike[];
  memberSpawnStatuses: MemberSpawnStatusCollection;
  memberSpawnSnapshotStatuses?: MemberSpawnStatusesSnapshot['statuses'];
  memberSpawnSnapshotUpdatedAt?: string;
  t?: unknown;
}): string | null {
  const pendingNames = getPendingSpawnNames({
    memberSpawnStatuses: params.memberSpawnStatuses,
    memberSpawnSnapshotStatuses: params.memberSpawnSnapshotStatuses,
    memberSpawnSnapshotUpdatedAt: params.memberSpawnSnapshotUpdatedAt,
  });
  if (pendingNames.length === 0) {
    return null;
  }

  const memberByName = new Map(params.members.map((member) => [member.name, member]));
  const pendingOnlyOpenCodeSecondary = pendingNames.every((name) =>
    isOpenCodeSecondaryMember(memberByName.get(name))
  );
  if (!pendingOnlyOpenCodeSecondary) {
    return null;
  }

  const groups = getPendingDiagnosticNameGroups({
    memberSpawnStatuses: params.memberSpawnStatuses,
    memberSpawnSnapshotStatuses: params.memberSpawnSnapshotStatuses,
    memberSpawnSnapshotUpdatedAt: params.memberSpawnSnapshotUpdatedAt,
  });
  if (groups.bootstrapStalled.length === 0) {
    return translateProvisioning(
      params.t,
      'provisioning.presentation.waitingForOpenCode',
      `Waiting for OpenCode: ${formatMemberNameList(pendingNames, params.t)}`,
      { names: formatMemberNameList(pendingNames, params.t) }
    );
  }

  const stalled = translateProvisioning(
    params.t,
    'provisioning.presentation.bootstrapStalled',
    `Bootstrap stalled: ${formatMemberNameList(groups.bootstrapStalled, params.t)}`,
    { names: formatMemberNameList(groups.bootstrapStalled, params.t) }
  );
  const waitingNames = pendingNames.filter((name) => !groups.bootstrapStalled.includes(name));
  return waitingNames.length > 0
    ? translateProvisioning(
        params.t,
        'provisioning.presentation.bootstrapStalledWithOpenCodeWait',
        `${stalled}; Waiting for OpenCode: ${formatMemberNameList(waitingNames, params.t)}`,
        { stalled, names: formatMemberNameList(waitingNames, params.t) }
      )
    : stalled;
}

function formatNamedPendingDiagnostic(
  label: string,
  names: readonly string[],
  t?: unknown
): string | null {
  if (names.length === 0) {
    return null;
  }
  return translateProvisioning(
    t,
    'provisioning.presentation.namedPendingDiagnostic',
    `${label}: ${formatMemberNameList(names, t)}`,
    { label, names: formatMemberNameList(names, t) }
  );
}

function formatCountPendingDiagnostic(
  count: number | undefined,
  label: string,
  t?: unknown
): string | null {
  return count && count > 0
    ? translateProvisioning(
        t,
        'provisioning.presentation.countPendingDiagnostic',
        `${count} ${label}`,
        {
          count,
          label,
        }
      )
    : null;
}

function buildPendingDiagnosticPhrase({
  summary,
  memberSpawnStatuses,
  memberSpawnSnapshotStatuses,
  memberSpawnSnapshotUpdatedAt,
  fallbackJoiningPhrase,
  t,
}: {
  summary: MemberSpawnStatusesSnapshot['summary'] | undefined;
  memberSpawnStatuses: MemberSpawnStatusCollection;
  memberSpawnSnapshotStatuses?: MemberSpawnStatusesSnapshot['statuses'];
  memberSpawnSnapshotUpdatedAt?: string;
  fallbackJoiningPhrase: string;
  t?: unknown;
}): string {
  const groups = getPendingDiagnosticNameGroups({
    memberSpawnStatuses,
    memberSpawnSnapshotStatuses,
    memberSpawnSnapshotUpdatedAt,
  });
  const namedParts = [
    formatNamedPendingDiagnostic(
      translateProvisioning(
        t,
        'provisioning.presentation.pendingLabels.bootstrapStalled',
        'Bootstrap stalled'
      ),
      groups.bootstrapStalled,
      t
    ),
    formatNamedPendingDiagnostic(
      translateProvisioning(t, 'provisioning.presentation.pendingLabels.shellOnly', 'Shell-only'),
      groups.shellOnly,
      t
    ),
    formatNamedPendingDiagnostic(
      translateProvisioning(
        t,
        'provisioning.presentation.pendingLabels.waitingForBootstrap',
        'Waiting for bootstrap'
      ),
      groups.runtimeProcess,
      t
    ),
    formatNamedPendingDiagnostic(
      translateProvisioning(
        t,
        'provisioning.presentation.pendingLabels.bootstrapUnconfirmed',
        'Bootstrap unconfirmed'
      ),
      groups.runtimeCandidate,
      t
    ),
    formatNamedPendingDiagnostic(
      translateProvisioning(
        t,
        'provisioning.presentation.pendingLabels.awaitingPermission',
        'Awaiting permission'
      ),
      groups.permission,
      t
    ),
    formatNamedPendingDiagnostic(
      translateProvisioning(
        t,
        'provisioning.presentation.pendingLabels.waitingForRuntime',
        'Waiting for runtime'
      ),
      groups.noRuntime,
      t
    ),
  ].filter(Boolean);
  if (namedParts.length > 0) {
    return namedParts.join(', ');
  }
  if (!summary) {
    return fallbackJoiningPhrase;
  }
  const countParts = [
    formatCountPendingDiagnostic(
      summary.shellOnlyPendingCount,
      translateProvisioning(
        t,
        'provisioning.presentation.pendingLabels.shellOnlyLower',
        'shell-only'
      ),
      t
    ),
    formatCountPendingDiagnostic(
      summary.runtimeProcessPendingCount,
      translateProvisioning(
        t,
        'provisioning.presentation.pendingLabels.waitingForBootstrapLower',
        'waiting for bootstrap'
      ),
      t
    ),
    formatCountPendingDiagnostic(
      summary.runtimeCandidatePendingCount,
      translateProvisioning(
        t,
        'provisioning.presentation.pendingLabels.bootstrapUnconfirmedLower',
        'bootstrap unconfirmed'
      ),
      t
    ),
    formatCountPendingDiagnostic(
      summary.permissionPendingCount,
      translateProvisioning(
        t,
        'provisioning.presentation.pendingLabels.awaitingPermissionLower',
        'awaiting permission'
      ),
      t
    ),
    formatCountPendingDiagnostic(
      summary.noRuntimePendingCount,
      translateProvisioning(
        t,
        'provisioning.presentation.pendingLabels.waitingForRuntimeLower',
        'waiting for runtime'
      ),
      t
    ),
  ].filter(Boolean);
  return countParts.length > 0 ? countParts.join(', ') : fallbackJoiningPhrase;
}

const ACTIVE_PROVISIONING_STATES = new Set([
  'validating',
  'spawning',
  'configuring',
  'assembling',
  'finalizing',
  'verifying',
]);

function getFailedSpawnDetails(params: {
  memberSpawnStatuses: MemberSpawnStatusCollection;
  memberSpawnSnapshotStatuses?: MemberSpawnStatusesSnapshot['statuses'];
  memberSpawnSnapshotUpdatedAt?: string;
}): FailedSpawnDetail[] {
  const names = new Set<string>();
  if (params.memberSpawnStatuses instanceof Map) {
    for (const name of params.memberSpawnStatuses.keys()) {
      names.add(name);
    }
  } else if (params.memberSpawnStatuses) {
    for (const name of Object.keys(params.memberSpawnStatuses)) {
      names.add(name);
    }
  }
  for (const name of Object.keys(params.memberSpawnSnapshotStatuses ?? {})) {
    names.add(name);
  }

  if (names.size === 0) {
    return [];
  }

  return [...names]
    .map((name) => {
      const liveEntry =
        params.memberSpawnStatuses instanceof Map
          ? params.memberSpawnStatuses.get(name)
          : params.memberSpawnStatuses?.[name];
      const snapshotEntry = params.memberSpawnSnapshotStatuses?.[name];
      return [
        name,
        getPreferredSpawnEntry({
          liveEntry,
          snapshotEntry,
          snapshotUpdatedAt: params.memberSpawnSnapshotUpdatedAt,
        }),
      ] as const;
    })
    .filter(
      ([, entry]) => entry && (entry.launchState === 'failed_to_start' || entry.status === 'error')
    )
    .map(([name, entry]) => ({
      name,
      reason:
        typeof entry?.hardFailureReason === 'string' && entry.hardFailureReason.trim().length > 0
          ? entry.hardFailureReason.trim()
          : typeof entry?.error === 'string' && entry.error.trim().length > 0
            ? entry.error.trim()
            : null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function getSkippedSpawnDetails(params: {
  memberSpawnStatuses: MemberSpawnStatusCollection;
  memberSpawnSnapshotStatuses?: MemberSpawnStatusesSnapshot['statuses'];
  memberSpawnSnapshotUpdatedAt?: string;
}): SkippedSpawnDetail[] {
  const names = new Set<string>();
  if (params.memberSpawnStatuses instanceof Map) {
    for (const name of params.memberSpawnStatuses.keys()) {
      names.add(name);
    }
  } else if (params.memberSpawnStatuses) {
    for (const name of Object.keys(params.memberSpawnStatuses)) {
      names.add(name);
    }
  }
  for (const name of Object.keys(params.memberSpawnSnapshotStatuses ?? {})) {
    names.add(name);
  }

  if (names.size === 0) {
    return [];
  }

  return [...names]
    .map((name) => {
      const liveEntry =
        params.memberSpawnStatuses instanceof Map
          ? params.memberSpawnStatuses.get(name)
          : params.memberSpawnStatuses?.[name];
      const snapshotEntry = params.memberSpawnSnapshotStatuses?.[name];
      return [
        name,
        getPreferredSpawnEntry({
          liveEntry,
          snapshotEntry,
          snapshotUpdatedAt: params.memberSpawnSnapshotUpdatedAt,
        }),
      ] as const;
    })
    .filter(([, entry]) => isSkippedSpawnEntry(entry))
    .map(([name, entry]) => ({
      name,
      reason:
        typeof entry?.skipReason === 'string' && entry.skipReason.trim().length > 0
          ? entry.skipReason.trim()
          : null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function getRetryableOpenCodeSecondaryFailedNames(params: {
  members: readonly ProvisioningMemberLike[];
  memberSpawnStatuses: MemberSpawnStatusCollection;
  memberSpawnSnapshotStatuses?: MemberSpawnStatusesSnapshot['statuses'];
  memberSpawnSnapshotUpdatedAt?: string;
}): string[] {
  const membersByName = new Map(
    params.members
      .map((member) => [member.name.trim(), member] as const)
      .filter(([name]) => name.length > 0)
  );
  const names = new Set<string>(membersByName.keys());
  if (params.memberSpawnStatuses instanceof Map) {
    for (const name of params.memberSpawnStatuses.keys()) {
      names.add(name);
    }
  } else if (params.memberSpawnStatuses) {
    for (const name of Object.keys(params.memberSpawnStatuses)) {
      names.add(name);
    }
  }
  for (const name of Object.keys(params.memberSpawnSnapshotStatuses ?? {})) {
    names.add(name);
  }

  return [...names]
    .filter((name) => {
      const liveEntry =
        params.memberSpawnStatuses instanceof Map
          ? params.memberSpawnStatuses.get(name)
          : params.memberSpawnStatuses?.[name];
      const snapshotEntry = params.memberSpawnSnapshotStatuses?.[name];
      const entry = getPreferredSpawnEntry({
        liveEntry,
        snapshotEntry,
        snapshotUpdatedAt: params.memberSpawnSnapshotUpdatedAt,
      });
      return isOpenCodeSecondaryRetryCandidate({
        member: membersByName.get(name),
        entry,
      });
    })
    .sort((left, right) => left.localeCompare(right));
}

function normalizeFailureReason(reason: string): string {
  return reason.replace(/\s+/g, ' ').trim();
}

function buildFailedSpawnPanelMessage(
  failedSpawnDetails: readonly FailedSpawnDetail[],
  t?: unknown
): string | null {
  if (failedSpawnDetails.length === 0) {
    return null;
  }
  if (failedSpawnDetails.length === 1) {
    const [failed] = failedSpawnDetails;
    return translateProvisioning(
      t,
      'provisioning.presentation.failed.memberFailedToStart',
      `${failed.name} failed to start`,
      { name: failed.name }
    );
  }
  return translateProvisioning(
    t,
    'provisioning.presentation.failed.teammatesFailedToStart',
    `${failedSpawnDetails.length} teammates failed to start`,
    { count: failedSpawnDetails.length }
  );
}

function buildFailedSpawnCompactDetail(
  failedSpawnDetails: readonly FailedSpawnDetail[],
  t?: unknown
): string | null {
  if (failedSpawnDetails.length === 0) {
    return null;
  }
  if (failedSpawnDetails.length === 1) {
    return translateProvisioning(
      t,
      'provisioning.presentation.failed.memberFailedToStart',
      `${failedSpawnDetails[0].name} failed to start`,
      { name: failedSpawnDetails[0].name }
    );
  }
  return translateProvisioning(
    t,
    'provisioning.presentation.failed.teammatesFailedToStart',
    `${failedSpawnDetails.length} teammates failed to start`,
    { count: failedSpawnDetails.length }
  );
}

function buildGenericFailedSpawnPanelMessage(
  failedSpawnCount: number,
  expectedTeammateCount: number,
  t?: unknown
): string | null {
  if (failedSpawnCount <= 0) {
    return null;
  }
  if (failedSpawnCount === 1) {
    return translateProvisioning(
      t,
      'provisioning.presentation.failed.teammatesFailedToStart',
      '1 teammate failed to start',
      { count: failedSpawnCount }
    );
  }
  return translateProvisioning(
    t,
    'provisioning.presentation.failed.teammatesFailedRatio',
    `${failedSpawnCount}/${Math.max(expectedTeammateCount, failedSpawnCount)} teammates failed to start`,
    { count: failedSpawnCount, total: Math.max(expectedTeammateCount, failedSpawnCount) }
  );
}

function buildSkippedSpawnPanelMessage(
  skippedSpawnDetails: readonly SkippedSpawnDetail[],
  t?: unknown
): string | null {
  if (skippedSpawnDetails.length === 0) {
    return null;
  }
  if (skippedSpawnDetails.length === 1) {
    const [skipped] = skippedSpawnDetails;
    return skipped.reason
      ? translateProvisioning(
          t,
          'provisioning.presentation.skipped.memberSkippedWithReason',
          `${skipped.name} skipped for this launch - ${normalizeFailureReason(skipped.reason)}`,
          { name: skipped.name, reason: normalizeFailureReason(skipped.reason) }
        )
      : translateProvisioning(
          t,
          'provisioning.presentation.skipped.memberSkipped',
          `${skipped.name} skipped for this launch`,
          { name: skipped.name }
        );
  }
  const listedSkipped = skippedSpawnDetails
    .slice(0, 3)
    .map((skipped) =>
      skipped.reason ? `${skipped.name} - ${normalizeFailureReason(skipped.reason)}` : skipped.name
    )
    .join('; ');
  const remainingCount = skippedSpawnDetails.length - Math.min(skippedSpawnDetails.length, 3);
  return translateProvisioning(
    t,
    'provisioning.presentation.skipped.teammatesSkippedList',
    `Skipped teammates: ${listedSkipped}${remainingCount > 0 ? `; +${remainingCount} more` : ''}`,
    { list: listedSkipped, count: remainingCount }
  );
}

function buildSkippedSpawnCompactDetail(
  skippedSpawnDetails: readonly SkippedSpawnDetail[],
  t?: unknown
): string | null {
  if (skippedSpawnDetails.length === 0) {
    return null;
  }
  if (skippedSpawnDetails.length === 1) {
    return translateProvisioning(
      t,
      'provisioning.presentation.skipped.memberSkippedCompact',
      `${skippedSpawnDetails[0].name} skipped`,
      { name: skippedSpawnDetails[0].name }
    );
  }
  return translateProvisioning(
    t,
    'provisioning.presentation.skipped.teammatesSkipped',
    `${skippedSpawnDetails.length} teammates skipped`,
    { count: skippedSpawnDetails.length }
  );
}

export interface TeamProvisioningPresentation {
  progress: TeamProvisioningProgress;
  isActive: boolean;
  isReady: boolean;
  isFailed: boolean;
  canCancel: boolean;
  currentStepIndex: number;
  expectedTeammateCount: number;
  heartbeatConfirmedCount: number;
  processOnlyAliveCount: number;
  pendingSpawnCount: number;
  failedSpawnCount: number;
  skippedSpawnCount: number;
  allTeammatesConfirmedAlive: boolean;
  hasMembersStillJoining: boolean;
  remainingJoinCount: number;
  retryableOpenCodeSecondaryFailedCount: number;
  retryableOpenCodeSecondaryFailedNames: string[];
  panelTitle: string;
  panelMessage?: string | null;
  panelMessageSeverity?: 'error' | 'warning' | 'info';
  panelTone?: 'default' | 'error';
  successMessage?: string | null;
  successMessageSeverity?: 'success' | 'warning' | 'info';
  defaultLiveOutputOpen: boolean;
  compactTitle: string;
  compactDetail?: string | null;
  compactTone: 'default' | 'warning' | 'error' | 'success';
}

export function isProvisioningProgressActive(
  progress: Pick<TeamProvisioningProgress, 'state'> | null | undefined
): boolean {
  return progress != null && ACTIVE_PROVISIONING_STATES.has(progress.state);
}

export function buildTeamProvisioningPresentation({
  progress,
  members,
  memberSpawnStatuses,
  memberSpawnSnapshot,
  t,
}: {
  progress: TeamProvisioningProgress | null | undefined;
  members: readonly ProvisioningMemberLike[];
  memberSpawnStatuses?: MemberSpawnStatusCollection;
  memberSpawnSnapshot?: Pick<
    MemberSpawnStatusesSnapshot,
    'expectedMembers' | 'summary' | 'updatedAt'
  > & {
    statuses?: MemberSpawnStatusesSnapshot['statuses'];
  };
  t?: unknown;
}): TeamProvisioningPresentation | null {
  if (!progress) {
    return null;
  }

  if (progress.state === 'cancelled' || progress.state === 'disconnected') {
    return null;
  }

  const isReady = progress.state === 'ready';
  const isFailed = progress.state === 'failed';
  const isActive = isProvisioningProgressActive(progress);
  const canCancel =
    progress.state === 'spawning' ||
    progress.state === 'configuring' ||
    progress.state === 'assembling' ||
    progress.state === 'finalizing' ||
    progress.state === 'verifying';

  const {
    expectedTeammateCount,
    heartbeatConfirmedCount,
    processOnlyAliveCount,
    pendingSpawnCount,
    failedSpawnCount,
    skippedSpawnCount,
  } = getLaunchJoinMilestonesFromMembers({
    members,
    memberSpawnStatuses,
    memberSpawnSnapshot,
  });
  const failedSpawnDetails = getFailedSpawnDetails({
    memberSpawnStatuses,
    memberSpawnSnapshotStatuses: memberSpawnSnapshot?.statuses,
    memberSpawnSnapshotUpdatedAt: memberSpawnSnapshot?.updatedAt,
  });
  const failedSpawnPanelMessage = buildFailedSpawnPanelMessage(failedSpawnDetails, t);
  const failedSpawnCompactDetail = buildFailedSpawnCompactDetail(failedSpawnDetails, t);
  const genericFailedSpawnPanelMessage = buildGenericFailedSpawnPanelMessage(
    failedSpawnCount,
    expectedTeammateCount,
    t
  );
  const skippedSpawnDetails = getSkippedSpawnDetails({
    memberSpawnStatuses,
    memberSpawnSnapshotStatuses: memberSpawnSnapshot?.statuses,
    memberSpawnSnapshotUpdatedAt: memberSpawnSnapshot?.updatedAt,
  });
  const skippedSpawnPanelMessage = buildSkippedSpawnPanelMessage(skippedSpawnDetails, t);
  const skippedSpawnCompactDetail = buildSkippedSpawnCompactDetail(skippedSpawnDetails, t);
  const permissionBlockedCount = countPermissionBlockedMembers({
    memberSpawnStatuses,
    memberSpawnSnapshotStatuses: memberSpawnSnapshot?.statuses,
    memberSpawnSnapshotUpdatedAt: memberSpawnSnapshot?.updatedAt,
  });
  const openCodeSecondaryWaitPhrase = buildOpenCodeSecondaryWaitPhrase({
    members,
    memberSpawnStatuses,
    memberSpawnSnapshotStatuses: memberSpawnSnapshot?.statuses,
    memberSpawnSnapshotUpdatedAt: memberSpawnSnapshot?.updatedAt,
  });
  const retryableOpenCodeSecondaryFailedNames = getRetryableOpenCodeSecondaryFailedNames({
    members,
    memberSpawnStatuses,
    memberSpawnSnapshotStatuses: memberSpawnSnapshot?.statuses,
    memberSpawnSnapshotUpdatedAt: memberSpawnSnapshot?.updatedAt,
  });
  const retryableOpenCodeSecondaryFailedCount = retryableOpenCodeSecondaryFailedNames.length;

  const { allTeammatesConfirmedAlive, hasMembersStillJoining, remainingJoinCount } =
    getLaunchJoinState({
      expectedTeammateCount,
      heartbeatConfirmedCount,
      processOnlyAliveCount,
      pendingSpawnCount,
      failedSpawnCount,
      skippedSpawnCount,
    });

  const progressStepIndex = getDisplayStepIndex({
    progress,
    expectedTeammateCount,
    heartbeatConfirmedCount,
    processOnlyAliveCount,
    pendingSpawnCount,
    failedSpawnCount,
    skippedSpawnCount,
  });

  if (isFailed) {
    return {
      progress,
      isActive: false,
      isReady: false,
      isFailed: true,
      canCancel: false,
      currentStepIndex: progressStepIndex,
      expectedTeammateCount,
      heartbeatConfirmedCount,
      processOnlyAliveCount,
      pendingSpawnCount,
      failedSpawnCount,
      skippedSpawnCount,
      allTeammatesConfirmedAlive,
      hasMembersStillJoining,
      remainingJoinCount,
      retryableOpenCodeSecondaryFailedCount,
      retryableOpenCodeSecondaryFailedNames,
      panelTitle: translateProvisioning(
        t,
        'provisioning.presentation.panel.launchFailed',
        'Launch failed'
      ),
      panelMessage: progress.error ?? failedSpawnPanelMessage ?? genericFailedSpawnPanelMessage,
      panelTone: 'error',
      defaultLiveOutputOpen: true,
      compactTitle: translateProvisioning(
        t,
        'provisioning.presentation.panel.launchFailed',
        'Launch failed'
      ),
      compactDetail: progress.message ?? null,
      compactTone: 'error',
    };
  }

  if (isReady) {
    const joiningPhrase =
      remainingJoinCount === 1
        ? translateProvisioning(
            t,
            'provisioning.presentation.joining.teammatesStillJoining',
            '1 teammate still joining',
            { count: remainingJoinCount }
          )
        : translateProvisioning(
            t,
            'provisioning.presentation.joining.teammatesStillJoining',
            `${remainingJoinCount} teammates still joining`,
            { count: remainingJoinCount }
          );
    const pendingMembersAwaitApproval =
      failedSpawnCount === 0 &&
      permissionBlockedCount > 0 &&
      permissionBlockedCount === remainingJoinCount;
    const pendingDetailPhrase = pendingMembersAwaitApproval
      ? buildAwaitingPermissionPhrase(permissionBlockedCount, t)
      : (openCodeSecondaryWaitPhrase ??
        buildPendingDiagnosticPhrase({
          summary: memberSpawnSnapshot?.summary,
          memberSpawnStatuses,
          memberSpawnSnapshotStatuses: memberSpawnSnapshot?.statuses,
          memberSpawnSnapshotUpdatedAt: memberSpawnSnapshot?.updatedAt,
          fallbackJoiningPhrase: joiningPhrase,
          t,
        }));
    const readyCompactDetail =
      failedSpawnCount > 0
        ? (failedSpawnCompactDetail ??
          translateProvisioning(
            t,
            'provisioning.presentation.failed.teammatesFailedToStart',
            `${failedSpawnCount} teammate${failedSpawnCount === 1 ? '' : 's'} failed to start`,
            { count: failedSpawnCount }
          ))
        : skippedSpawnCount > 0
          ? (skippedSpawnCompactDetail ??
            translateProvisioning(
              t,
              'provisioning.presentation.skipped.teammatesSkipped',
              `${skippedSpawnCount} teammate${skippedSpawnCount === 1 ? '' : 's'} skipped`,
              { count: skippedSpawnCount }
            ))
          : hasMembersStillJoining
            ? pendingDetailPhrase
            : expectedTeammateCount === 0
              ? translateProvisioning(
                  t,
                  'provisioning.presentation.ready.leadOnline',
                  'Lead online'
                )
              : translateProvisioning(
                  t,
                  'provisioning.presentation.ready.allTeammatesJoined',
                  `All ${expectedTeammateCount} teammates joined`,
                  { count: expectedTeammateCount }
                );
    const readyDetailMessage =
      failedSpawnCount > 0
        ? (failedSpawnPanelMessage ?? genericFailedSpawnPanelMessage ?? progress.message)
        : skippedSpawnCount > 0
          ? (skippedSpawnPanelMessage ??
            translateProvisioning(
              t,
              'provisioning.presentation.skipped.teammatesSkippedRatio',
              `${skippedSpawnCount}/${Math.max(expectedTeammateCount, skippedSpawnCount)} teammates skipped for this launch`,
              {
                count: skippedSpawnCount,
                total: Math.max(expectedTeammateCount, skippedSpawnCount),
              }
            ))
          : expectedTeammateCount === 0
            ? translateProvisioning(
                t,
                'provisioning.presentation.ready.teamProvisionedLeadOnline',
                'Team provisioned - lead online'
              )
            : allTeammatesConfirmedAlive
              ? translateProvisioning(
                  t,
                  'provisioning.presentation.ready.teamProvisionedAllJoined',
                  `Team provisioned - all ${expectedTeammateCount} teammates joined`,
                  { count: expectedTeammateCount }
                )
              : hasMembersStillJoining
                ? pendingDetailPhrase
                : translateProvisioning(
                    t,
                    'provisioning.presentation.ready.teamProvisionedStillJoining',
                    'Team provisioned - teammates are still joining'
                  );
    const readyDetailSeverity =
      failedSpawnCount > 0 || skippedSpawnCount > 0
        ? 'warning'
        : hasMembersStillJoining
          ? 'info'
          : undefined;
    const readyMessage =
      failedSpawnCount > 0
        ? translateProvisioning(
            t,
            'provisioning.presentation.ready.launchFinishedWithErrors',
            `Launch finished with errors - ${failedSpawnCount}/${Math.max(expectedTeammateCount, failedSpawnCount)} teammates failed to start`,
            { count: failedSpawnCount, total: Math.max(expectedTeammateCount, failedSpawnCount) }
          )
        : skippedSpawnCount > 0
          ? translateProvisioning(
              t,
              'provisioning.presentation.ready.launchContinuedSkipped',
              `Launch continued - ${skippedSpawnCount}/${Math.max(expectedTeammateCount, skippedSpawnCount)} teammates skipped`,
              {
                count: skippedSpawnCount,
                total: Math.max(expectedTeammateCount, skippedSpawnCount),
              }
            )
          : expectedTeammateCount === 0
            ? translateProvisioning(
                t,
                'provisioning.presentation.ready.teamLaunchedLeadOnline',
                'Team launched - lead online'
              )
            : allTeammatesConfirmedAlive
              ? translateProvisioning(
                  t,
                  'provisioning.presentation.ready.teamLaunchedAllJoined',
                  `Team launched - all ${expectedTeammateCount} teammates joined`,
                  { count: expectedTeammateCount }
                )
              : openCodeSecondaryWaitPhrase
                ? translateProvisioning(
                    t,
                    'provisioning.presentation.panel.coreTeamReady',
                    'Core team ready'
                  )
                : translateProvisioning(
                    t,
                    'provisioning.presentation.panel.finishingLaunch',
                    'Finishing launch'
                  );

    return {
      progress,
      isActive: false,
      isReady: true,
      isFailed: false,
      canCancel: false,
      expectedTeammateCount,
      heartbeatConfirmedCount,
      processOnlyAliveCount,
      pendingSpawnCount,
      failedSpawnCount,
      skippedSpawnCount,
      allTeammatesConfirmedAlive,
      hasMembersStillJoining,
      remainingJoinCount,
      retryableOpenCodeSecondaryFailedCount,
      retryableOpenCodeSecondaryFailedNames,
      panelTitle: translateProvisioning(
        t,
        'provisioning.presentation.panel.launchDetails',
        'Launch details'
      ),
      panelMessage:
        failedSpawnCount > 0 || skippedSpawnCount > 0 || hasMembersStillJoining
          ? readyDetailMessage
          : null,
      panelMessageSeverity: readyDetailSeverity,
      successMessage: readyMessage,
      successMessageSeverity:
        failedSpawnCount > 0 || skippedSpawnCount > 0
          ? 'warning'
          : hasMembersStillJoining
            ? 'info'
            : 'success',
      defaultLiveOutputOpen: false,
      compactTitle:
        failedSpawnCount > 0
          ? translateProvisioning(
              t,
              'provisioning.presentation.panel.launchFinishedWithErrors',
              'Launch finished with errors'
            )
          : skippedSpawnCount > 0
            ? translateProvisioning(
                t,
                'provisioning.presentation.panel.launchContinuedSkipped',
                'Launch continued with skipped teammates'
              )
            : hasMembersStillJoining
              ? openCodeSecondaryWaitPhrase
                ? translateProvisioning(
                    t,
                    'provisioning.presentation.panel.coreTeamReady',
                    'Core team ready'
                  )
                : translateProvisioning(
                    t,
                    'provisioning.presentation.panel.finishingLaunch',
                    'Finishing launch'
                  )
              : translateProvisioning(
                  t,
                  'provisioning.presentation.panel.teamLaunched',
                  'Team launched'
                ),
      compactDetail: readyCompactDetail,
      compactTone:
        failedSpawnCount > 0 || skippedSpawnCount > 0
          ? 'warning'
          : hasMembersStillJoining
            ? 'default'
            : 'success',
      currentStepIndex:
        failedSpawnCount > 0 || skippedSpawnCount > 0
          ? 2
          : hasMembersStillJoining
            ? 2
            : DISPLAY_COMPLETE_STEP_INDEX,
    };
  }

  if (isActive) {
    const activeJoiningPhrase =
      remainingJoinCount === 1
        ? translateProvisioning(
            t,
            'provisioning.presentation.joining.teammatesStillJoining',
            '1 teammate still joining',
            { count: remainingJoinCount }
          )
        : translateProvisioning(
            t,
            'provisioning.presentation.joining.teammatesStillJoining',
            `${remainingJoinCount} teammates still joining`,
            { count: remainingJoinCount }
          );
    const activePendingDetailPhrase =
      failedSpawnCount === 0 &&
      hasMembersStillJoining &&
      permissionBlockedCount > 0 &&
      permissionBlockedCount === remainingJoinCount
        ? buildAwaitingPermissionPhrase(permissionBlockedCount, t)
        : (openCodeSecondaryWaitPhrase ??
          buildPendingDiagnosticPhrase({
            summary: memberSpawnSnapshot?.summary,
            memberSpawnStatuses,
            memberSpawnSnapshotStatuses: memberSpawnSnapshot?.statuses,
            memberSpawnSnapshotUpdatedAt: memberSpawnSnapshot?.updatedAt,
            fallbackJoiningPhrase: activeJoiningPhrase,
            t,
          }));
    return {
      progress,
      isActive: true,
      isReady: false,
      isFailed: false,
      canCancel,
      currentStepIndex: progressStepIndex >= 0 ? progressStepIndex : -1,
      expectedTeammateCount,
      heartbeatConfirmedCount,
      processOnlyAliveCount,
      pendingSpawnCount,
      failedSpawnCount,
      skippedSpawnCount,
      allTeammatesConfirmedAlive,
      hasMembersStillJoining,
      remainingJoinCount,
      retryableOpenCodeSecondaryFailedCount,
      retryableOpenCodeSecondaryFailedNames,
      panelTitle: openCodeSecondaryWaitPhrase
        ? translateProvisioning(
            t,
            'provisioning.presentation.panel.coreTeamReady',
            'Core team ready'
          )
        : translateProvisioning(
            t,
            'provisioning.presentation.panel.launchingTeam',
            'Launching team'
          ),
      panelMessage:
        failedSpawnCount > 0
          ? (failedSpawnPanelMessage ?? genericFailedSpawnPanelMessage ?? progress.message)
          : skippedSpawnCount > 0
            ? (skippedSpawnPanelMessage ??
              translateProvisioning(
                t,
                'provisioning.presentation.skipped.teammatesSkippedRatio',
                `${skippedSpawnCount}/${Math.max(expectedTeammateCount, skippedSpawnCount)} teammates skipped for this launch`,
                {
                  count: skippedSpawnCount,
                  total: Math.max(expectedTeammateCount, skippedSpawnCount),
                }
              ))
            : openCodeSecondaryWaitPhrase
              ? openCodeSecondaryWaitPhrase
              : hasMembersStillJoining &&
                  permissionBlockedCount > 0 &&
                  permissionBlockedCount === remainingJoinCount
                ? activePendingDetailPhrase
                : progress.message,
      panelMessageSeverity:
        failedSpawnCount > 0 || skippedSpawnCount > 0 ? 'warning' : progress.messageSeverity,
      defaultLiveOutputOpen: false,
      compactTitle: openCodeSecondaryWaitPhrase
        ? translateProvisioning(
            t,
            'provisioning.presentation.panel.coreTeamReady',
            'Core team ready'
          )
        : translateProvisioning(
            t,
            'provisioning.presentation.panel.launchingTeam',
            'Launching team'
          ),
      compactDetail:
        failedSpawnCount > 0
          ? (failedSpawnCompactDetail ??
            translateProvisioning(
              t,
              'provisioning.presentation.failed.teammatesFailedToStart',
              `${failedSpawnCount} teammate${failedSpawnCount === 1 ? '' : 's'} failed to start`,
              { count: failedSpawnCount }
            ))
          : skippedSpawnCount > 0
            ? (skippedSpawnCompactDetail ??
              translateProvisioning(
                t,
                'provisioning.presentation.skipped.teammatesSkipped',
                `${skippedSpawnCount} teammate${skippedSpawnCount === 1 ? '' : 's'} skipped`,
                { count: skippedSpawnCount }
              ))
            : openCodeSecondaryWaitPhrase
              ? openCodeSecondaryWaitPhrase
              : hasMembersStillJoining && failedSpawnCount === 0 && permissionBlockedCount > 0
                ? permissionBlockedCount === remainingJoinCount
                  ? buildAwaitingPermissionPhrase(permissionBlockedCount, t)
                  : translateProvisioning(
                      t,
                      'provisioning.presentation.joining.teammatesConfirmedRatio',
                      `${heartbeatConfirmedCount}/${expectedTeammateCount} teammates confirmed`,
                      { count: heartbeatConfirmedCount, total: expectedTeammateCount }
                    )
                : expectedTeammateCount > 0 && progressStepIndex >= 2
                  ? translateProvisioning(
                      t,
                      'provisioning.presentation.joining.teammatesConfirmedRatio',
                      `${heartbeatConfirmedCount}/${expectedTeammateCount} teammates confirmed`,
                      { count: heartbeatConfirmedCount, total: expectedTeammateCount }
                    )
                  : progress.message,
      compactTone: failedSpawnCount > 0 || skippedSpawnCount > 0 ? 'warning' : 'default',
    };
  }

  return null;
}
