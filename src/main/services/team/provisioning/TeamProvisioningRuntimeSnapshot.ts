import {
  listTmuxPaneRuntimeInfoForCurrentPlatform,
  type TmuxPaneRuntimeInfo,
} from '@features/tmux-installer/main';
import { isLeadMember } from '@shared/utils/leadDetection';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { hasUnsafeProvisionedButNotAliveRuntimeEvidence } from '@shared/utils/teamLaunchFailureReason';
import {
  inferTeamProviderIdFromModel,
  normalizeOptionalTeamProviderId,
} from '@shared/utils/teamProvider';

import {
  extractCliArgValues,
  hasRuntimeProjectionSnapshotBootstrapConfirmationEvidence,
  isStrongRuntimeEvidence,
  mapRuntimeProjectionMemberEntry,
  mapRuntimeProjectionSnapshot,
  projectRuntimeSnapshotResourceFields,
} from '../runtime-projection';
import { type TeamAgentRuntimeResourceHistoryRecordInput } from '../TeamAgentRuntimeResourceHistory';
import {
  choosePreferredLaunchSnapshot,
  readBootstrapLaunchSnapshot,
} from '../TeamBootstrapStateReader';
import {
  addRuntimeRootOwnersFromProcessRows,
  buildProcessUsageStatsFromRows,
  buildRuntimeProcessLoadStats as buildRuntimeProcessLoadStatsDefault,
  type RuntimeProcessLoadStats,
  type RuntimeProcessUsageStats,
  type RuntimeTelemetryProcessTableRow,
} from '../TeamRuntimeTelemetry';

import {
  isBootstrapProofClearableLaunchFailureReason,
  isProcessBootstrapTransportDiagnostic,
  shouldClearRuntimeDiagnosticAfterBootstrapConfirmation,
} from './TeamProvisioningBootstrapTranscript';
import { mentionsProcessTableUnavailable } from './TeamProvisioningLaunchDiagnostics';
import {
  deriveMemberLaunchState,
  isProvisionedButNotAliveFailureReason,
} from './TeamProvisioningLaunchFailurePolicy';
import {
  matchesExactTeamMemberName,
  matchesObservedMemberNameForExpected,
} from './TeamProvisioningMemberIdentity';
import {
  buildLaunchMemberSpawnStatus,
  findConfiguredMemberModel,
  findMetaMemberModel,
  isLaunchMemberStatusRelevantToRuntimeRun,
  isMemberRemovedInMeta,
  shouldPreferCurrentLaunchMemberStatus,
} from './TeamProvisioningMemberStatusProjection';
import {
  isExplicitLegacyOpenCodeBootstrap,
  isMaterializedOpenCodeSessionId,
  OPENCODE_APP_MANAGED_BOOTSTRAP_STALLED_DIAGNOSTIC,
} from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';
import {
  hasTeamProvisioningRuntimePermissionBlock,
  readTeamProvisioningBootstrapEvidence,
} from './TeamProvisioningRuntimeEvidenceReader';
import { resolveTeamProvisioningRuntimeLiveness } from './TeamProvisioningRuntimeLiveness';
import {
  type LiveTeamAgentRuntimeMetadata,
  shouldReadProcessTableForLiveRuntimeMetadata,
} from './TeamProvisioningRuntimeMetadataPolicy';
import { resolveTeamProvisioningRuntimeSnapshotLiveness } from './TeamProvisioningRuntimeSnapshotResolver';

import type { TeamRuntimeMemberLaunchEvidence } from '../runtime';
import type { TeamProvisioningRuntimeSnapshotResourceSamplingPorts } from './TeamProvisioningRuntimeResourceSampling';
import type {
  TeamProvisioningLiveRuntimeMetadataCacheWritePort,
  TeamProvisioningRuntimeSnapshotBuildCacheReadPort,
  TeamProvisioningRuntimeSnapshotBuildCacheWritePort,
} from './TeamProvisioningRuntimeSnapshotCache';
import type {
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  ProviderModelLaunchIdentity,
  TeamAgentRuntimeBackendType,
  TeamAgentRuntimeDiagnosticSeverity,
  TeamAgentRuntimeEntry,
  TeamAgentRuntimeLoadScope,
  TeamAgentRuntimeResourceSample,
  TeamAgentRuntimeSnapshot,
  TeamConfig,
  TeamCreateRequest,
  TeamFastMode,
  TeamMember,
  TeamProviderBackendId,
  TeamProviderId,
} from '@shared/types';

export interface PersistedRuntimeMemberLike {
  name?: string;
  agentId?: string;
  tmuxPaneId?: string;
  backendType?: string;
  providerId?: string;
  cwd?: string;
  bootstrapExpectedAfter?: string;
  bootstrapProofToken?: string;
  bootstrapRunId?: string;
  bootstrapProofMode?: string;
  bootstrapContextHash?: string;
  bootstrapBriefingHash?: string;
  bootstrapRuntimeEventsPath?: string;
  runtimePid?: number;
  runtimeSessionId?: string;
}

export interface RuntimeAdapterRunSnapshotSource {
  runId: string;
  providerId: TeamProviderId;
  cwd?: string;
  members?: Record<string, TeamRuntimeMemberLaunchEvidence>;
}

export interface TeamProvisioningRuntimeSnapshotRun {
  runId: string;
  child: { pid?: number } | null;
  processKilled?: boolean;
  cancelRequested?: boolean;
  request: TeamCreateRequest;
  spawnContext?: { args: readonly string[] } | null;
  allEffectiveMembers?: TeamCreateRequest['members'];
  effectiveMembers?: TeamCreateRequest['members'];
  memberSpawnStatuses?: Map<string, MemberSpawnStatusEntry>;
  mixedSecondaryLanes?: readonly {
    laneId?: string;
    member: TeamCreateRequest['members'][number];
    runId?: string | null;
    result?: {
      runId?: string;
      members?: Record<string, TeamRuntimeMemberLaunchEvidence>;
    } | null;
  }[];
}

interface TeamMetaRuntimeSnapshotSource {
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId | string;
  fastMode?: TeamFastMode;
  launchIdentity?: ProviderModelLaunchIdentity;
}

interface RuntimeSnapshotStores {
  runs: ReadonlyMap<string, TeamProvisioningRuntimeSnapshotRun>;
  runtimeAdapterRunByTeam: ReadonlyMap<string, RuntimeAdapterRunSnapshotSource>;
  teamMetaStore: {
    getMeta(teamName: string): Promise<TeamMetaRuntimeSnapshotSource | null>;
  };
  membersMetaStore: {
    getMembers(teamName: string): Promise<TeamMember[]>;
  };
  launchStateStore: {
    read(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  };
  readConfigSnapshot(teamName: string): Promise<TeamConfig | null>;
  readPersistedRuntimeMembers(teamName: string): PersistedRuntimeMemberLike[];
}

interface RuntimeSnapshotLogging {
  logDebug(message: string): void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function getPersistedLaunchMemberNames(snapshot: PersistedTeamLaunchSnapshot): string[] {
  return Array.from(new Set([...snapshot.expectedMembers, ...Object.keys(snapshot.members)]));
}

function shouldUseLaunchMemberRuntimeEvidence(
  member: PersistedTeamLaunchMemberState | undefined,
  activeRuntimeRunId: string
): boolean {
  if (!member) {
    return false;
  }
  if (activeRuntimeRunId.length === 0) {
    return true;
  }
  return isLaunchMemberStatusRelevantToRuntimeRun(member, activeRuntimeRunId);
}

function resolveActiveRuntimeRunId(
  run: { runId?: string } | null | undefined,
  paramsRunId: string | null | undefined,
  runtimeAdapterRun: RuntimeAdapterRunSnapshotSource | undefined
): string {
  return run?.runId?.trim() || paramsRunId?.trim() || runtimeAdapterRun?.runId?.trim() || '';
}

function shouldUseRuntimeAdapterRunEvidence(
  runtimeAdapterRun: RuntimeAdapterRunSnapshotSource | undefined,
  activeRuntimeRunId: string
): runtimeAdapterRun is RuntimeAdapterRunSnapshotSource {
  if (!runtimeAdapterRun) {
    return false;
  }
  const adapterRunId = runtimeAdapterRun.runId.trim();
  if (activeRuntimeRunId.length === 0) {
    return true;
  }
  return adapterRunId.length > 0 && adapterRunId === activeRuntimeRunId;
}

function shouldUsePersistedRuntimeMemberRuntimeEvidence(
  member: PersistedRuntimeMemberLike,
  activeRuntimeRunId: string
): boolean {
  if (activeRuntimeRunId.length === 0) {
    return true;
  }
  const bootstrapRunId = member.bootstrapRunId?.trim() ?? '';
  return bootstrapRunId.length > 0 && bootstrapRunId === activeRuntimeRunId;
}

function normalizeRuntimeLaneKind(value: unknown): 'primary' | 'secondary' | undefined {
  return value === 'primary' || value === 'secondary' ? value : undefined;
}

function normalizeRuntimeLaneIdentity(
  value: unknown
): Pick<TeamAgentRuntimeEntry, 'laneId' | 'laneKind'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const laneId = typeof record.laneId === 'string' ? record.laneId.trim() : '';
  const laneKind = normalizeRuntimeLaneKind(record.laneKind);
  return {
    ...(laneId ? { laneId } : {}),
    ...(laneKind ? { laneKind } : {}),
  };
}

function findExactMemberRecordEntry<T>(
  members: Readonly<Record<string, T>> | null | undefined,
  memberName: string
): [string, T] | undefined {
  return Object.entries(members ?? {}).find(([candidateName]) =>
    matchesExactTeamMemberName(candidateName, memberName)
  );
}

function findExactPersistedLaunchMember(
  snapshot: PersistedTeamLaunchSnapshot | null | undefined,
  memberName: string
): PersistedTeamLaunchMemberState | undefined {
  const entry = findExactMemberRecordEntry(snapshot?.members, memberName);
  if (!entry || !matchesExactTeamMemberName(entry[1].name, memberName)) {
    return undefined;
  }
  return entry[1];
}

function memberIdentityKey(memberName: string): string {
  return memberName.trim().toLowerCase();
}

function findExactActiveRunMember(
  run: TeamProvisioningRuntimeSnapshotRun | null,
  memberName: string
): TeamCreateRequest['members'][number] | undefined {
  for (const member of [...(run?.allEffectiveMembers ?? []), ...(run?.effectiveMembers ?? [])]) {
    const candidateName = member.name?.trim() ?? '';
    if (candidateName && matchesExactTeamMemberName(candidateName, memberName)) {
      return member;
    }
  }
  return undefined;
}

function findExactActiveRunMemberModel(
  run: TeamProvisioningRuntimeSnapshotRun | null,
  memberName: string
): string | undefined {
  return findExactActiveRunMember(run, memberName)?.model?.trim() || undefined;
}

function findExactTrackedMemberSpawnStatus(
  run: TeamProvisioningRuntimeSnapshotRun | null,
  memberName: string
): MemberSpawnStatusEntry | undefined {
  return run?.memberSpawnStatuses
    ? findExactMapEntry(run.memberSpawnStatuses, memberName)?.[1]
    : undefined;
}

function findExactRuntimeMemberEvidence(
  members: Readonly<Record<string, TeamRuntimeMemberLaunchEvidence>> | null | undefined,
  memberName: string
): TeamRuntimeMemberLaunchEvidence | undefined {
  for (const [candidateName, evidence] of Object.entries(members ?? {})) {
    if (!matchesExactTeamMemberName(candidateName, memberName)) {
      continue;
    }
    const evidenceMemberName =
      typeof evidence.memberName === 'string' ? evidence.memberName.trim() : '';
    if (
      evidenceMemberName.length > 0 &&
      !matchesExactTeamMemberName(evidenceMemberName, memberName)
    ) {
      continue;
    }
    return evidence;
  }
  return undefined;
}

function findExactMapEntry<T>(
  entries: ReadonlyMap<string, T>,
  memberName: string
): [string, T] | undefined {
  for (const entry of entries) {
    if (matchesExactTeamMemberName(entry[0], memberName)) {
      return entry;
    }
  }
  return undefined;
}

function resolveActiveRunLaneIdentity(
  run: TeamProvisioningRuntimeSnapshotRun | null,
  memberName: string
): Pick<TeamAgentRuntimeEntry, 'laneId' | 'laneKind'> {
  if (!run) {
    return {};
  }
  for (const lane of run.mixedSecondaryLanes ?? []) {
    const laneMemberName = lane.member.name?.trim() ?? '';
    if (!laneMemberName || !matchesExactTeamMemberName(laneMemberName, memberName)) {
      continue;
    }
    const laneId = typeof lane.laneId === 'string' ? lane.laneId.trim() : '';
    return {
      ...(laneId ? { laneId } : {}),
      laneKind: 'secondary',
    };
  }
  return normalizeRuntimeLaneIdentity(findExactActiveRunMember(run, memberName));
}

interface ActiveRunRuntimeAdapterEvidenceResolution {
  owner: 'primary' | 'secondary' | 'none';
  evidence?: TeamRuntimeMemberLaunchEvidence;
}

function resolveActiveRunRuntimeAdapterEvidence(
  run: TeamProvisioningRuntimeSnapshotRun | null,
  runtimeAdapterRun: RuntimeAdapterRunSnapshotSource | undefined,
  memberName: string
): ActiveRunRuntimeAdapterEvidenceResolution {
  for (const lane of run?.mixedSecondaryLanes ?? []) {
    const laneMemberName = lane.member.name?.trim() ?? '';
    if (!laneMemberName || !matchesExactTeamMemberName(laneMemberName, memberName)) {
      continue;
    }
    const laneRunId = lane.runId?.trim() ?? '';
    const resultRunId = lane.result?.runId?.trim() ?? '';
    if (!laneRunId || !resultRunId || resultRunId !== laneRunId) {
      return { owner: 'secondary' };
    }
    return {
      owner: 'secondary',
      evidence: findExactRuntimeMemberEvidence(lane.result?.members, memberName),
    };
  }
  return {
    owner: runtimeAdapterRun ? 'primary' : 'none',
    evidence: findExactRuntimeMemberEvidence(runtimeAdapterRun?.members, memberName),
  };
}

function normalizeRuntimePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

function suppressRuntimeBootstrapConfirmation(
  status: MemberSpawnStatusEntry | undefined
): MemberSpawnStatusEntry | undefined {
  if (!status) {
    return undefined;
  }
  return {
    ...status,
    status: status.status === 'online' ? 'waiting' : status.status,
    launchState:
      status.launchState === 'confirmed_alive' ? 'runtime_pending_bootstrap' : status.launchState,
    runtimeAlive: false,
    bootstrapConfirmed: false,
  };
}

function hasLiveOpenCodeRuntimePidProbe(params: {
  evidence: TeamRuntimeMemberLaunchEvidence | undefined;
  teamName: string;
  memberName: string;
  processRows: readonly RuntimeTelemetryProcessTableRow[];
  processTableAvailable: boolean;
}): boolean {
  const runtimePid = normalizeRuntimePositiveInteger(params.evidence?.runtimePid);
  if (!params.processTableAvailable || runtimePid == null) {
    return false;
  }
  return params.processRows.some(
    (row) =>
      row.pid === runtimePid &&
      row.command.toLowerCase().includes('opencode') &&
      extractCliArgValues(row.command, '--team-name').some(
        (teamName) => teamName === params.teamName
      ) &&
      extractCliArgValues(row.command, '--agent-id').some((memberName) =>
        matchesExactTeamMemberName(memberName, params.memberName)
      )
  );
}

function normalizeRuntimeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function mergeRuntimeDiagnostics(
  previous: string[] | undefined,
  incoming: unknown,
  fallback?: string
): string[] | undefined {
  const merged = [
    ...(previous ?? []),
    ...normalizeRuntimeStringArray(incoming),
    ...(fallback ? [fallback] : []),
  ].filter((value) => value.trim().length > 0);
  return merged.length > 0 ? [...new Set(merged)] : undefined;
}

function normalizeTeamAgentRuntimeBackendType(
  value: string | undefined,
  isLead: boolean
): TeamAgentRuntimeBackendType | undefined {
  if (isLead) return 'lead';
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'tmux' || normalized === 'iterm2' || normalized === 'in-process') {
    return normalized;
  }
  return normalized ? 'process' : undefined;
}

function stripWrappedCliFlagValue(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const unwrapped = trimmed.slice(1, -1).trim();
    return unwrapped.length > 0 ? unwrapped : undefined;
  }
  return trimmed;
}

function extractCliFlagValue(command: string, flagName: string): string | undefined {
  const escapedFlag = flagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\s)${escapedFlag}\\s+("([^"]*)"|'([^']*)'|([^\\s]+))`).exec(
    command
  );
  if (!match) {
    return undefined;
  }
  return stripWrappedCliFlagValue(match[2] ?? match[3] ?? match[4] ?? match[1]);
}

export function buildRuntimeDiagnosticForSpawn(
  metadata: LiveTeamAgentRuntimeMetadata
): string | undefined {
  const baseDiagnostic = metadata.runtimeDiagnostic;
  const processTableUnavailable =
    mentionsProcessTableUnavailable(baseDiagnostic) ||
    metadata.diagnostics?.some((diagnostic) => mentionsProcessTableUnavailable(diagnostic));
  if (!processTableUnavailable) {
    return baseDiagnostic;
  }
  if (mentionsProcessTableUnavailable(baseDiagnostic)) {
    return baseDiagnostic;
  }
  return baseDiagnostic
    ? `${baseDiagnostic}; process table unavailable`
    : 'process table unavailable';
}

function buildRuntimeProcessLoadStatsSafely(
  teamName: string,
  memberName: string,
  params: {
    rootPid: number | undefined;
    usageStatsByPid: ReadonlyMap<number, RuntimeProcessUsageStats>;
    processTree?: { pids: number[]; truncated: boolean };
    scope?: TeamAgentRuntimeLoadScope;
  },
  buildRuntimeProcessLoadStats: typeof buildRuntimeProcessLoadStatsDefault,
  logDebug: (message: string) => void
): RuntimeProcessLoadStats | undefined {
  try {
    return buildRuntimeProcessLoadStats(params);
  } catch (error) {
    logDebug(
      `[${teamName}] Failed to build runtime telemetry stats for ${memberName}; continuing without metrics: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }
}

function recordAgentRuntimeResourceSampleSafely(
  history: {
    record(
      params: TeamAgentRuntimeResourceHistoryRecordInput
    ): TeamAgentRuntimeResourceSample[] | undefined;
  },
  params: TeamAgentRuntimeResourceHistoryRecordInput,
  logDebug: (message: string) => void
): TeamAgentRuntimeResourceSample[] | undefined {
  try {
    return history.record(params);
  } catch (error) {
    logDebug(
      `[${params.teamName}] Failed to record runtime telemetry sample for ${
        params.memberName
      }; continuing without history: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

export function attachLiveRuntimeMetadataToStatuses(params: {
  statuses: Record<string, MemberSpawnStatusEntry>;
  runtimeByMember: ReadonlyMap<string, LiveTeamAgentRuntimeMetadata>;
  openCodeSecondaryBootstrapPendingMembers?: ReadonlySet<string>;
  isOpenCodeBootstrapStallWindowElapsed(firstSpawnAcceptedAt: string | undefined): boolean;
}): Record<string, MemberSpawnStatusEntry> {
  const nextStatuses = { ...params.statuses };
  for (const [memberName, metadata] of params.runtimeByMember.entries()) {
    const resolvedStatusKey =
      nextStatuses[memberName] != null
        ? memberName
        : (() => {
            const matches = Object.keys(nextStatuses).filter((candidateName) =>
              matchesObservedMemberNameForExpected(memberName, candidateName)
            );
            return matches.length === 1 ? matches[0] : null;
          })();
    if (!resolvedStatusKey) {
      continue;
    }
    const current = nextStatuses[resolvedStatusKey];
    if (!current) {
      continue;
    }
    const openCodeSecondaryBootstrapPending =
      params.openCodeSecondaryBootstrapPendingMembers?.has(resolvedStatusKey) === true &&
      current.launchState === 'runtime_pending_bootstrap' &&
      current.bootstrapConfirmed !== true &&
      current.hardFailure !== true;
    const openCodeBootstrapStalled =
      openCodeSecondaryBootstrapPending &&
      (current.bootstrapStalled === true ||
        params.isOpenCodeBootstrapStallWindowElapsed(current.firstSpawnAcceptedAt));
    if (current.launchState === 'skipped_for_launch' || current.skippedForLaunch === true) {
      nextStatuses[resolvedStatusKey] = {
        ...current,
        status: 'skipped',
        launchState: 'skipped_for_launch',
        skippedForLaunch: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        hardFailureReason: undefined,
        error: undefined,
        livenessSource: undefined,
        livenessLastCheckedAt: nowIso(),
      };
      continue;
    }
    const shouldPreserveProcessBootstrapTransportDiagnostic =
      current.bootstrapConfirmed !== true &&
      (current.launchState === 'runtime_pending_bootstrap' ||
        current.launchState === 'failed_to_start') &&
      isProcessBootstrapTransportDiagnostic(current.runtimeDiagnostic);
    const hasStrongEvidence = isStrongRuntimeEvidence(metadata);
    const hasConfirmedBootstrap =
      current.bootstrapConfirmed === true || current.launchState === 'confirmed_alive';
    const shouldSuppressWeakRuntimeMetadataForConfirmedBootstrap =
      hasConfirmedBootstrap && !hasStrongEvidence;
    const failureReason = current.hardFailureReason ?? current.error ?? current.runtimeDiagnostic;
    const bootstrapProofClearableFailure =
      isBootstrapProofClearableLaunchFailureReason(failureReason);
    const metadataRuntimeDiagnosticForUnsafe = buildRuntimeDiagnosticForSpawn(metadata);
    const unsafeRuntimeDiagnosticEvidence =
      metadataRuntimeDiagnosticForUnsafe &&
      current.runtimeDiagnostic &&
      metadataRuntimeDiagnosticForUnsafe !== current.runtimeDiagnostic
        ? `${metadataRuntimeDiagnosticForUnsafe}; ${current.runtimeDiagnostic}`
        : (metadataRuntimeDiagnosticForUnsafe ?? current.runtimeDiagnostic);
    const hasUnsafeProvisionedButNotAliveFailure =
      isProvisionedButNotAliveFailureReason(failureReason) &&
      hasUnsafeProvisionedButNotAliveRuntimeEvidence({
        ...current,
        runtimeDiagnostic: unsafeRuntimeDiagnosticEvidence,
        runtimeDiagnosticSeverity:
          metadata.runtimeDiagnosticSeverity ?? current.runtimeDiagnosticSeverity,
        livenessKind: metadata.livenessKind ?? current.livenessKind,
      });
    const shouldPreserveConfirmedBootstrapRuntimeError =
      hasConfirmedBootstrap &&
      metadata.alive === false &&
      metadata.runtimeDiagnosticSeverity === 'error';
    const shouldPreserveUnsafeMetadataLivenessKind =
      hasUnsafeProvisionedButNotAliveFailure &&
      (metadata.livenessKind === 'not_found' ||
        metadata.livenessKind === 'shell_only' ||
        metadata.livenessKind === 'runtime_process_candidate' ||
        ((metadata.livenessKind === 'registered_only' ||
          metadata.livenessKind === 'stale_metadata') &&
          (metadata.runtimeDiagnosticSeverity ?? current.runtimeDiagnosticSeverity) !== 'error' &&
          !mentionsProcessTableUnavailable(unsafeRuntimeDiagnosticEvidence) &&
          !mentionsProcessTableUnavailable(failureReason)));
    let runtimeDiagnostic: string | undefined;
    let runtimeDiagnosticSeverity: TeamAgentRuntimeDiagnosticSeverity | undefined;
    if (shouldPreserveProcessBootstrapTransportDiagnostic) {
      runtimeDiagnostic = current.runtimeDiagnostic;
      runtimeDiagnosticSeverity = current.runtimeDiagnosticSeverity;
    } else if (shouldSuppressWeakRuntimeMetadataForConfirmedBootstrap) {
      if (
        current.runtimeDiagnostic &&
        !shouldClearRuntimeDiagnosticAfterBootstrapConfirmation(current.runtimeDiagnostic)
      ) {
        runtimeDiagnostic = current.runtimeDiagnostic;
        runtimeDiagnosticSeverity = current.runtimeDiagnosticSeverity;
      } else {
        const metadataRuntimeDiagnostic = metadataRuntimeDiagnosticForUnsafe;
        if (
          metadataRuntimeDiagnostic &&
          !shouldClearRuntimeDiagnosticAfterBootstrapConfirmation(metadataRuntimeDiagnostic)
        ) {
          runtimeDiagnostic = metadataRuntimeDiagnostic;
          runtimeDiagnosticSeverity = metadata.runtimeDiagnosticSeverity;
        }
      }
    } else {
      runtimeDiagnostic = buildRuntimeDiagnosticForSpawn(metadata);
      runtimeDiagnosticSeverity = metadata.runtimeDiagnosticSeverity;
    }
    const metadataLivenessKind = hasConfirmedBootstrap
      ? metadata.livenessKind === 'runtime_process' ||
        metadata.livenessKind === 'confirmed_bootstrap' ||
        shouldPreserveConfirmedBootstrapRuntimeError ||
        shouldPreserveUnsafeMetadataLivenessKind
        ? metadata.livenessKind
        : current.livenessKind === 'stale_metadata' || current.livenessKind === 'registered_only'
          ? 'confirmed_bootstrap'
          : (current.livenessKind ?? 'confirmed_bootstrap')
      : metadata.livenessKind;
    const nextEntry: MemberSpawnStatusEntry = {
      ...current,
      ...(metadata.model ? { runtimeModel: metadata.model } : {}),
      ...(metadataLivenessKind ? { livenessKind: metadataLivenessKind } : {}),
      ...(runtimeDiagnostic || shouldSuppressWeakRuntimeMetadataForConfirmedBootstrap
        ? { runtimeDiagnostic }
        : {}),
      ...(shouldPreserveProcessBootstrapTransportDiagnostic
        ? { runtimeDiagnosticSeverity }
        : runtimeDiagnosticSeverity || shouldSuppressWeakRuntimeMetadataForConfirmedBootstrap
          ? { runtimeDiagnosticSeverity }
          : {}),
      livenessLastCheckedAt: nowIso(),
    };
    const hasWeakEvidence =
      metadata.livenessKind != null && !hasStrongEvidence && current.bootstrapConfirmed !== true;
    if (
      hasStrongEvidence &&
      !openCodeSecondaryBootstrapPending &&
      current.bootstrapStalled !== true &&
      current.hardFailure !== true &&
      current.launchState !== 'failed_to_start'
    ) {
      nextEntry.status = 'online';
      nextEntry.agentToolAccepted = true;
      nextEntry.runtimeAlive = true;
      nextEntry.hardFailure = false;
      nextEntry.hardFailureReason = undefined;
      nextEntry.error = undefined;
      nextEntry.livenessSource = current.bootstrapConfirmed ? current.livenessSource : 'process';
      nextEntry.launchState = deriveMemberLaunchState(nextEntry);
    }
    if (
      (current.bootstrapStalled === true || openCodeSecondaryBootstrapPending) &&
      hasStrongEvidence &&
      current.bootstrapConfirmed !== true &&
      current.launchState !== 'failed_to_start'
    ) {
      nextEntry.status = 'waiting';
      nextEntry.agentToolAccepted = true;
      nextEntry.runtimeAlive = true;
      nextEntry.hardFailure = false;
      nextEntry.hardFailureReason = undefined;
      nextEntry.error = undefined;
      nextEntry.livenessSource = undefined;
      nextEntry.bootstrapStalled = openCodeBootstrapStalled ? true : undefined;
      if (openCodeBootstrapStalled) {
        nextEntry.runtimeDiagnostic = isExplicitLegacyOpenCodeBootstrap(current)
          ? 'Runtime process is alive, but no bootstrap check-in after 5 min.'
          : OPENCODE_APP_MANAGED_BOOTSTRAP_STALLED_DIAGNOSTIC;
        nextEntry.runtimeDiagnosticSeverity = 'warning';
      }
      nextEntry.launchState = deriveMemberLaunchState(nextEntry);
    }
    if (
      hasStrongEvidence &&
      current.launchState === 'failed_to_start' &&
      bootstrapProofClearableFailure &&
      !hasUnsafeProvisionedButNotAliveFailure
    ) {
      nextEntry.status = 'online';
      nextEntry.agentToolAccepted = true;
      nextEntry.runtimeAlive = true;
      nextEntry.hardFailure = false;
      nextEntry.hardFailureReason = undefined;
      nextEntry.error = undefined;
      nextEntry.livenessSource = current.bootstrapConfirmed ? current.livenessSource : 'process';
      nextEntry.launchState = deriveMemberLaunchState(nextEntry);
    }
    if (
      hasConfirmedBootstrap &&
      current.hardFailure === true &&
      bootstrapProofClearableFailure &&
      !hasUnsafeProvisionedButNotAliveFailure
    ) {
      nextEntry.status = 'online';
      nextEntry.agentToolAccepted = true;
      nextEntry.runtimeAlive = true;
      nextEntry.bootstrapConfirmed = true;
      nextEntry.hardFailure = false;
      nextEntry.hardFailureReason = undefined;
      nextEntry.error = undefined;
      nextEntry.bootstrapStalled = undefined;
      nextEntry.launchState = deriveMemberLaunchState(nextEntry);
    }
    const healedConfirmedBootstrapFailure =
      hasConfirmedBootstrap &&
      current.hardFailure === true &&
      bootstrapProofClearableFailure &&
      !hasUnsafeProvisionedButNotAliveFailure;
    if (shouldPreserveConfirmedBootstrapRuntimeError) {
      nextEntry.runtimeAlive = false;
      if (nextEntry.livenessSource === 'process') {
        nextEntry.livenessSource = undefined;
      }
    }
    if (hasWeakEvidence && !healedConfirmedBootstrapFailure) {
      nextEntry.runtimeAlive = false;
      if (nextEntry.livenessSource === 'process') {
        nextEntry.livenessSource = undefined;
      }
      if (
        current.launchState === 'runtime_pending_bootstrap' ||
        current.launchState === 'runtime_pending_permission'
      ) {
        nextEntry.agentToolAccepted = true;
      }
      if (
        current.status === 'online' &&
        current.hardFailure !== true &&
        current.launchState !== 'failed_to_start'
      ) {
        nextEntry.status = nextEntry.agentToolAccepted ? 'waiting' : 'spawning';
      }
      nextEntry.launchState = deriveMemberLaunchState(nextEntry);
    }
    nextStatuses[resolvedStatusKey] = nextEntry;
  }
  for (const [memberName, current] of Object.entries(nextStatuses)) {
    const openCodeSecondaryBootstrapPending =
      params.openCodeSecondaryBootstrapPendingMembers?.has(memberName) === true &&
      current.launchState === 'runtime_pending_bootstrap' &&
      current.bootstrapConfirmed !== true &&
      current.hardFailure !== true;
    if (
      !openCodeSecondaryBootstrapPending ||
      current.bootstrapStalled === true ||
      !params.isOpenCodeBootstrapStallWindowElapsed(current.firstSpawnAcceptedAt)
    ) {
      continue;
    }
    const runtimeProcessAlive =
      current.runtimeAlive === true && current.livenessKind === 'runtime_process';
    const runtimeDiagnostic = isExplicitLegacyOpenCodeBootstrap(current)
      ? runtimeProcessAlive
        ? 'Runtime process is alive, but no bootstrap check-in after 5 min.'
        : 'OpenCode bootstrap did not complete runtime_bootstrap_checkin after 5 min.'
      : OPENCODE_APP_MANAGED_BOOTSTRAP_STALLED_DIAGNOSTIC;
    const nextEntry: MemberSpawnStatusEntry = {
      ...current,
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      agentToolAccepted: true,
      runtimeAlive: runtimeProcessAlive,
      bootstrapConfirmed: false,
      hardFailure: false,
      hardFailureReason: undefined,
      error: undefined,
      livenessSource: undefined,
      livenessKind:
        current.livenessKind ?? (runtimeProcessAlive ? 'runtime_process' : 'registered_only'),
      runtimeDiagnostic,
      runtimeDiagnosticSeverity: 'warning',
      bootstrapStalled: true,
      livenessLastCheckedAt: nowIso(),
      updatedAt: nowIso(),
    };
    nextEntry.launchState = deriveMemberLaunchState(nextEntry);
    nextStatuses[memberName] = nextEntry;
  }
  return nextStatuses;
}

export async function buildTeamAgentRuntimeSnapshot(
  params: {
    teamName: string;
    runId: string | null;
    generationAtStart: number;
    getMemberSpawnStatuses(teamName: string): Promise<MemberSpawnStatusesSnapshot>;
    getLiveTeamAgentRuntimeMetadata(
      teamName: string
    ): Promise<Map<string, LiveTeamAgentRuntimeMetadata>>;
  } & TeamProvisioningRuntimeSnapshotResourceSamplingPorts &
    RuntimeSnapshotStores &
    TeamProvisioningRuntimeSnapshotBuildCacheReadPort &
    TeamProvisioningRuntimeSnapshotBuildCacheWritePort<TeamAgentRuntimeSnapshot> &
    RuntimeSnapshotLogging
): Promise<TeamAgentRuntimeSnapshot> {
  const run = params.runId ? (params.runs.get(params.runId) ?? null) : null;
  const runtimeAdapterRun = params.runtimeAdapterRunByTeam.get(params.teamName);
  const activeRuntimeRunId = resolveActiveRuntimeRunId(run, params.runId, runtimeAdapterRun);
  const currentRuntimeAdapterRun = shouldUseRuntimeAdapterRunEvidence(
    runtimeAdapterRun,
    activeRuntimeRunId
  )
    ? runtimeAdapterRun
    : undefined;
  const persistedTeamMeta = await params.teamMetaStore.getMeta(params.teamName).catch(() => null);

  let configuredMembers: TeamConfig['members'] = [];
  try {
    const config = await params.readConfigSnapshot(params.teamName);
    configuredMembers = config?.members ?? [];
  } catch {
    configuredMembers = [];
  }
  const metaMembers = await params.membersMetaStore.getMembers(params.teamName).catch(() => []);
  const launchSnapshot = choosePreferredLaunchSnapshot(
    await readBootstrapLaunchSnapshot(params.teamName),
    await params.launchStateStore.read(params.teamName)
  );

  const spawnStatusSnapshot = await params
    .getMemberSpawnStatuses(params.teamName)
    .catch(() => null);
  const liveRuntimeByMember = await params.getLiveTeamAgentRuntimeMetadata(params.teamName);
  const spawnStatusRunId = spawnStatusSnapshot?.runId?.trim() ?? '';
  const canUseSpawnStatusEvidence =
    spawnStatusSnapshot != null &&
    (activeRuntimeRunId.length === 0 || spawnStatusRunId === activeRuntimeRunId);
  const canUseCurrentSpawnStatusRuntimeTruth =
    (spawnStatusSnapshot?.source === 'live' || spawnStatusSnapshot?.source === 'merged') &&
    activeRuntimeRunId.length > 0 &&
    spawnStatusRunId === activeRuntimeRunId;
  const runtimeRootOwnersByPid = new Map<number, Set<string>>();
  const runtimeUsageRootPids = new Set<number>();
  const addRuntimeRootPid = (
    pid: unknown,
    ownerKey: string,
    options: { sampleUsage?: boolean } = {}
  ): void => {
    if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
      return;
    }
    const owners = runtimeRootOwnersByPid.get(pid) ?? new Set<string>();
    owners.add(ownerKey);
    runtimeRootOwnersByPid.set(pid, owners);
    if (options.sampleUsage !== false) {
      runtimeUsageRootPids.add(pid);
    }
  };
  const canSampleRuntimeMetadataPid = (
    metadata: LiveTeamAgentRuntimeMetadata,
    pid: unknown
  ): boolean => {
    if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
      return false;
    }
    if (process.platform !== 'win32') {
      return true;
    }
    const paneId = metadata.tmuxPaneId?.trim() ?? '';
    if (metadata.backendType === 'tmux' || (paneId && !paneId.startsWith('process:'))) {
      return false;
    }
    return (
      metadata.pidSource !== 'tmux_child' &&
      metadata.pidSource !== 'tmux_pane' &&
      metadata.pidSource !== 'persisted_metadata'
    );
  };
  const leadPid = run?.child?.pid;
  addRuntimeRootPid(leadPid, '__lead__');
  for (const [memberName, metadata] of liveRuntimeByMember.entries()) {
    const memberPids = [metadata.pid, metadata.metricsPid];
    for (const memberPid of memberPids) {
      addRuntimeRootPid(memberPid, memberName, {
        sampleUsage: canSampleRuntimeMetadataPid(metadata, memberPid),
      });
    }
  }
  let runtimeUsageTreesByRootPid = new Map<number, { pids: number[]; truncated: boolean }>();
  let usageStatsByPid = new Map<number, RuntimeProcessUsageStats>();
  try {
    const runtimeProcessRows =
      runtimeRootOwnersByPid.size > 0
        ? await params.readRuntimeProcessRowsForUsageSnapshot(params.teamName, {
            includeWindowsHostRows: process.platform === 'win32',
          })
        : null;
    addRuntimeRootOwnersFromProcessRows({
      teamName: params.teamName,
      processRows: runtimeProcessRows,
      rootOwnersByPid: runtimeRootOwnersByPid,
      platform: process.platform,
    });
    runtimeUsageTreesByRootPid = params.buildRuntimeUsageProcessTrees({
      rootPids: [...runtimeUsageRootPids],
      processRows: runtimeProcessRows,
      rootOwnersByPid: runtimeRootOwnersByPid,
    });
    const runtimeUsagePids = [
      ...new Set([...runtimeUsageTreesByRootPid.values()].flatMap((tree) => tree.pids)),
    ];
    usageStatsByPid = buildProcessUsageStatsFromRows(runtimeProcessRows, runtimeUsagePids);
    const pidsMissingUsageStats = runtimeUsagePids.filter((pid) => !usageStatsByPid.has(pid));
    if (pidsMissingUsageStats.length > 0) {
      const sampledUsageStats = await params.readProcessUsageStatsByPid(pidsMissingUsageStats);
      for (const [pid, stats] of sampledUsageStats) {
        usageStatsByPid.set(pid, stats);
      }
    }
  } catch (error) {
    params.logDebug(
      `[${params.teamName}] Runtime telemetry sampling failed; continuing without resource metrics: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  // Status/runtime reads can publish evidence while this snapshot is being built.
  // Timestamp the projection after those asynchronous reads so fresh evidence is
  // never rejected as future-dated merely because it is newer than function entry.
  const updatedAt = nowIso();
  const persistedRuntimeMembers = params.readPersistedRuntimeMembers(params.teamName);
  const snapshotMembers: Record<string, TeamAgentRuntimeEntry> = {};
  const activeResourceHistoryKeys = new Set<string>();

  const getPersistedRuntimeMember = (
    memberName: string
  ): PersistedRuntimeMemberLike | undefined => {
    return persistedRuntimeMembers.find((member) => {
      const candidateName = typeof member.name === 'string' ? member.name.trim() : '';
      return candidateName.length > 0 && matchesExactTeamMemberName(candidateName, memberName);
    });
  };

  const getSpawnStatusMember = (memberName: string): MemberSpawnStatusEntry | undefined => {
    if (!canUseSpawnStatusEvidence) {
      return undefined;
    }
    const statuses = spawnStatusSnapshot?.statuses;
    if (!statuses) {
      return undefined;
    }
    return findExactMemberRecordEntry(statuses, memberName)?.[1];
  };

  const activeRunMemberByName = new Map<string, TeamMember>();
  const runAllEffectiveMembers = run?.allEffectiveMembers ?? [];
  const activeRunMembers =
    runAllEffectiveMembers.length > 0 ? runAllEffectiveMembers : (run?.effectiveMembers ?? []);
  for (const member of activeRunMembers) {
    const memberName = typeof member?.name === 'string' ? member.name.trim() : '';
    if (!memberName) continue;
    activeRunMemberByName.set(memberIdentityKey(memberName), member);
  }

  const candidateMembers = new Map<string, TeamMember>();
  for (const member of configuredMembers) {
    const memberName = typeof member?.name === 'string' ? member.name.trim() : '';
    if (!memberName || isMemberRemovedInMeta(metaMembers, memberName)) continue;
    candidateMembers.set(memberIdentityKey(memberName), member);
  }
  for (const member of metaMembers) {
    const memberName = typeof member?.name === 'string' ? member.name.trim() : '';
    const identityKey = memberIdentityKey(memberName);
    if (!memberName || member.removedAt || candidateMembers.has(identityKey)) continue;
    candidateMembers.set(identityKey, member);
  }
  for (const memberName of launchSnapshot ? getPersistedLaunchMemberNames(launchSnapshot) : []) {
    const identityKey = memberIdentityKey(memberName);
    if (candidateMembers.has(identityKey) || isMemberRemovedInMeta(metaMembers, memberName)) {
      continue;
    }
    const launchMember = findExactPersistedLaunchMember(launchSnapshot, memberName);
    if (!shouldUseLaunchMemberRuntimeEvidence(launchMember, activeRuntimeRunId)) {
      continue;
    }
    candidateMembers.set(identityKey, {
      name: memberName,
      agentType: 'general-purpose',
      providerId: launchMember?.providerId,
      providerBackendId: launchMember?.providerBackendId,
      model: launchMember?.model,
      effort: launchMember?.effort,
      fastMode: launchMember?.selectedFastMode,
    });
  }
  for (const memberName of Object.keys(currentRuntimeAdapterRun?.members ?? {})) {
    const identityKey = memberIdentityKey(memberName);
    if (candidateMembers.has(identityKey) || isMemberRemovedInMeta(metaMembers, memberName)) {
      continue;
    }
    const adapterResolution = resolveActiveRunRuntimeAdapterEvidence(
      run,
      currentRuntimeAdapterRun,
      memberName
    );
    if (adapterResolution.owner !== 'primary') {
      continue;
    }
    const adapterEvidence = adapterResolution.evidence;
    candidateMembers.set(identityKey, {
      name: memberName,
      agentType: 'general-purpose',
      providerId: normalizeOptionalTeamProviderId(adapterEvidence?.providerId),
      model: adapterEvidence?.model,
    });
  }
  for (const member of activeRunMemberByName.values()) {
    const memberName = typeof member?.name === 'string' ? member.name.trim() : '';
    if (!memberName || isMemberRemovedInMeta(metaMembers, memberName)) continue;
    candidateMembers.set(memberIdentityKey(memberName), member);
  }

  const getLiveRuntimeMember = (memberName: string): LiveTeamAgentRuntimeMetadata | undefined => {
    const exact = findExactMapEntry(liveRuntimeByMember, memberName)?.[1];
    if (exact) {
      return exact;
    }
    const observedMatches = [...liveRuntimeByMember.entries()].filter(
      ([observedName]) =>
        !candidateMembers.has(memberIdentityKey(observedName)) &&
        matchesObservedMemberNameForExpected(observedName, memberName)
    );
    return observedMatches.length === 1 ? observedMatches[0]?.[1] : undefined;
  };

  for (const member of candidateMembers.values()) {
    const memberName = typeof member?.name === 'string' ? member.name.trim() : '';
    if (!memberName) continue;

    const isLead = isLeadMember({ name: memberName, agentType: member.agentType });
    const exactCandidateLaunchMember = findExactPersistedLaunchMember(launchSnapshot, memberName);
    const candidateLaunchMember = shouldUseLaunchMemberRuntimeEvidence(
      exactCandidateLaunchMember,
      activeRuntimeRunId
    )
      ? exactCandidateLaunchMember
      : undefined;
    const candidateRuntimeAdapterEvidence = resolveActiveRunRuntimeAdapterEvidence(
      run,
      currentRuntimeAdapterRun,
      memberName
    ).evidence;
    const leadRuntimeProviderId =
      normalizeOptionalTeamProviderId(candidateRuntimeAdapterEvidence?.providerId) ??
      normalizeOptionalTeamProviderId(candidateLaunchMember?.providerId) ??
      normalizeOptionalTeamProviderId(member.providerId);
    if (isLead && leadRuntimeProviderId !== 'opencode') {
      const pid = run?.child?.pid;
      const usageStats = pid
        ? buildRuntimeProcessLoadStatsSafely(
            params.teamName,
            memberName,
            {
              rootPid: pid,
              usageStatsByPid,
              processTree: runtimeUsageTreesByRootPid.get(pid),
            },
            params.buildRuntimeProcessLoadStats,
            params.logDebug
          )
        : undefined;
      const runtimeModel =
        run?.request.model?.trim() ||
        (run?.spawnContext
          ? extractCliFlagValue(run.spawnContext.args.join(' '), '--model')
          : undefined) ||
        member.model?.trim() ||
        undefined;
      const resourceHistory = pid
        ? recordAgentRuntimeResourceSampleSafely(
            params.agentRuntimeResourceHistory,
            {
              teamName: params.teamName,
              memberName,
              timestamp: updatedAt,
              runId: activeRuntimeRunId,
              cpuPercent: usageStats?.cpuPercent,
              rssBytes: usageStats?.rssBytes,
              primaryCpuPercent: usageStats?.primaryCpuPercent,
              primaryRssBytes: usageStats?.primaryRssBytes,
              childCpuPercent: usageStats?.childCpuPercent,
              childRssBytes: usageStats?.childRssBytes,
              processCount: usageStats?.processCount,
              runtimeLoadScope: usageStats?.runtimeLoadScope,
              runtimeLoadTruncated: usageStats?.runtimeLoadTruncated,
              pidSource: 'lead_process',
              pid,
              activeKeys: activeResourceHistoryKeys,
            },
            params.logDebug
          )
        : undefined;
      const runtimeResourceFields = projectRuntimeSnapshotResourceFields({
        source: 'live-process',
        pid,
        pidSource: 'lead_process',
        usageStats,
        resourceHistory,
      });
      snapshotMembers[memberName] = mapRuntimeProjectionMemberEntry({
        memberName,
        alive: Boolean(pid && !run?.processKilled && !run?.cancelRequested),
        restartable: false,
        backendType: 'lead',
        pid,
        runtimeModel,
        ...runtimeResourceFields,
        pidSource: pid ? 'lead_process' : undefined,
        updatedAt,
      });
      continue;
    }

    const persistedRuntimeMember = getPersistedRuntimeMember(memberName);
    const persistedRuntimeMemberRuntimeEvidence =
      persistedRuntimeMember &&
      shouldUsePersistedRuntimeMemberRuntimeEvidence(persistedRuntimeMember, activeRuntimeRunId)
        ? persistedRuntimeMember
        : undefined;
    const liveRuntimeMember = getLiveRuntimeMember(memberName);
    const spawnStatusMember = getSpawnStatusMember(memberName);
    const exactLaunchMember = findExactPersistedLaunchMember(launchSnapshot, memberName);
    const launchMember = shouldUseLaunchMemberRuntimeEvidence(exactLaunchMember, activeRuntimeRunId)
      ? exactLaunchMember
      : undefined;
    const activeRunLaneIdentity = resolveActiveRunLaneIdentity(run, memberName);
    const runtimeAdapterEvidenceResolution = resolveActiveRunRuntimeAdapterEvidence(
      run,
      currentRuntimeAdapterRun,
      memberName
    );
    const runtimeAdapterEvidence = runtimeAdapterEvidenceResolution.evidence;
    const activeRunMember = activeRunMemberByName.get(memberIdentityKey(memberName));
    const activeRunModel = activeRunMember?.model?.trim();
    const activeRunProviderId =
      normalizeOptionalTeamProviderId(activeRunMember?.providerId) ??
      inferTeamProviderIdFromModel(activeRunModel);
    const liveRuntimeModel = liveRuntimeMember?.model?.trim();
    const liveRuntimeModelProviderId = inferTeamProviderIdFromModel(liveRuntimeModel);
    const explicitLiveRuntimeProviderId = normalizeOptionalTeamProviderId(
      liveRuntimeMember?.providerId
    );
    const liveRuntimeProviderConflictsWithActive =
      activeRunProviderId != null &&
      ((explicitLiveRuntimeProviderId != null &&
        explicitLiveRuntimeProviderId !== activeRunProviderId) ||
        (liveRuntimeModelProviderId != null && liveRuntimeModelProviderId !== activeRunProviderId));
    const canUseLiveRuntimeModel = !!liveRuntimeModel && !liveRuntimeProviderConflictsWithActive;
    const backendType =
      liveRuntimeMember?.backendType ??
      normalizeTeamAgentRuntimeBackendType(
        persistedRuntimeMemberRuntimeEvidence?.backendType,
        false
      );
    const runtimeModel =
      (canUseLiveRuntimeModel ? liveRuntimeModel : undefined) ??
      activeRunModel ??
      launchMember?.model?.trim() ??
      member.model?.trim() ??
      undefined;
    const memberProviderId =
      activeRunProviderId ??
      normalizeOptionalTeamProviderId(launchMember?.providerId) ??
      normalizeOptionalTeamProviderId(member.providerId) ??
      inferTeamProviderIdFromModel(runtimeModel) ??
      inferTeamProviderIdFromModel(launchMember?.model) ??
      inferTeamProviderIdFromModel(member.model);
    const memberProviderBackendId = migrateProviderBackendId(
      memberProviderId,
      activeRunMember?.providerBackendId ??
        launchMember?.providerBackendId ??
        member.providerBackendId
    );
    const isOpenCodeMember = memberProviderId === 'opencode';
    const runtimeAdapterSessionId =
      typeof runtimeAdapterEvidence?.sessionId === 'string'
        ? runtimeAdapterEvidence.sessionId.trim()
        : '';
    const runtimeAdapterPid =
      typeof runtimeAdapterEvidence?.runtimePid === 'number' &&
      Number.isFinite(runtimeAdapterEvidence.runtimePid) &&
      runtimeAdapterEvidence.runtimePid > 0
        ? runtimeAdapterEvidence.runtimePid
        : undefined;
    const configuredCwd =
      typeof activeRunMember?.cwd === 'string'
        ? activeRunMember.cwd.trim()
        : typeof member.cwd === 'string'
          ? member.cwd.trim()
          : '';
    const runtimeCwd =
      liveRuntimeMember?.cwd ??
      (configuredCwd || (isOpenCodeMember ? currentRuntimeAdapterRun?.cwd : undefined));
    const metricsPid = liveRuntimeMember?.metricsPid;
    const isSharedOpenCodeHost =
      isOpenCodeMember &&
      typeof metricsPid === 'number' &&
      metricsPid > 0 &&
      liveRuntimeMember?.pidSource !== 'agent_process_table';
    const rssPid = isSharedOpenCodeHost ? metricsPid : (liveRuntimeMember?.pid ?? metricsPid);
    const displayPid = isSharedOpenCodeHost
      ? rssPid
      : (liveRuntimeMember?.pid ?? runtimeAdapterPid);
    const restartable = isOpenCodeMember
      ? !isSharedOpenCodeHost && Boolean(liveRuntimeMember?.pid)
      : isSharedOpenCodeHost
        ? false
        : backendType !== 'in-process';
    const historicalBootstrapConfirmed = hasRuntimeProjectionSnapshotBootstrapConfirmationEvidence({
      launch: shouldUseLaunchMemberRuntimeEvidence(launchMember, activeRuntimeRunId)
        ? {
            bootstrapConfirmed: launchMember?.bootstrapConfirmed,
            launchState: launchMember?.launchState,
          }
        : undefined,
      runtimeAdapter: {
        bootstrapConfirmed: runtimeAdapterEvidence?.bootstrapConfirmed,
        launchState: runtimeAdapterEvidence?.launchState,
      },
      spawnStatus: {
        bootstrapConfirmed: spawnStatusMember?.bootstrapConfirmed,
        launchState: spawnStatusMember?.launchState,
      },
    });
    const spawnStatusBootstrapEvidence = readTeamProvisioningBootstrapEvidence({
      status: spawnStatusMember,
      nowIso: updatedAt,
    });
    const launchBootstrapEvidence = readTeamProvisioningBootstrapEvidence({
      status: launchMember
        ? {
            bootstrapConfirmed: launchMember.bootstrapConfirmed,
            launchState: launchMember.launchState,
            lastHeartbeatAt: launchMember.lastHeartbeatAt,
            pendingPermissionRequestIds: launchMember.pendingPermissionRequestIds,
            updatedAt: launchMember.lastEvaluatedAt,
          }
        : undefined,
      nowIso: updatedAt,
    });
    const hasOpenCodeRuntimeHandle =
      isOpenCodeMember &&
      (typeof liveRuntimeMember?.pid === 'number' ||
        typeof liveRuntimeMember?.metricsPid === 'number' ||
        typeof liveRuntimeMember?.runtimeSessionId === 'string' ||
        typeof runtimeAdapterPid === 'number' ||
        runtimeAdapterSessionId.length > 0);
    const permissionBlocked =
      liveRuntimeMember?.livenessKind === 'permission_blocked' ||
      hasTeamProvisioningRuntimePermissionBlock(
        launchMember,
        spawnStatusMember,
        runtimeAdapterEvidence
      );
    const hasVerifiedCurrentSecondaryRuntimeCandidate =
      runtimeAdapterEvidenceResolution.owner === 'secondary' &&
      liveRuntimeMember?.livenessKind === 'runtime_process_candidate' &&
      liveRuntimeMember.pidSource === 'opencode_bridge' &&
      typeof liveRuntimeMember.metricsPid === 'number' &&
      liveRuntimeMember.metricsPid > 0 &&
      isMaterializedOpenCodeSessionId(liveRuntimeMember.runtimeSessionId);
    const hasConfirmedCurrentSecondaryRuntimeCandidate =
      hasVerifiedCurrentSecondaryRuntimeCandidate &&
      canUseCurrentSpawnStatusRuntimeTruth &&
      spawnStatusBootstrapEvidence.bootstrapConfirmed;
    const currentOwnershipAllowsRuntimeBootstrapConfirmation =
      runtimeAdapterEvidenceResolution.owner !== 'secondary' ||
      (liveRuntimeMember?.alive === true && isStrongRuntimeEvidence(liveRuntimeMember)) ||
      hasConfirmedCurrentSecondaryRuntimeCandidate;
    const confirmedOpenCodeRuntimeAlive =
      isOpenCodeMember &&
      !permissionBlocked &&
      currentOwnershipAllowsRuntimeBootstrapConfirmation &&
      canUseCurrentSpawnStatusRuntimeTruth &&
      (spawnStatusBootstrapEvidence.bootstrapConfirmed ||
        launchBootstrapEvidence.bootstrapConfirmed) &&
      hasOpenCodeRuntimeHandle &&
      spawnStatusMember?.hardFailure !== true &&
      spawnStatusMember?.launchState !== 'failed_to_start' &&
      spawnStatusMember?.launchState !== 'runtime_pending_permission';
    const confirmedOpenCodeRuntimeAdapterAlive =
      isOpenCodeMember &&
      !permissionBlocked &&
      currentOwnershipAllowsRuntimeBootstrapConfirmation &&
      runtimeAdapterEvidence?.bootstrapConfirmed === true &&
      runtimeAdapterEvidence.runtimeAlive === true &&
      runtimeAdapterEvidence.hardFailure !== true &&
      hasOpenCodeRuntimeHandle;
    const confirmedOpenCodeRuntimeBootstrapAlive =
      confirmedOpenCodeRuntimeAlive || confirmedOpenCodeRuntimeAdapterAlive;
    const confirmedSpawnRuntimeFallback =
      !isOpenCodeMember &&
      !permissionBlocked &&
      spawnStatusBootstrapEvidence.bootstrapConfirmed &&
      spawnStatusMember?.hardFailure !== true &&
      spawnStatusMember?.launchState !== 'failed_to_start' &&
      !isStrongRuntimeEvidence(liveRuntimeMember);
    const confirmedSpawnRuntimeDiagnostic =
      spawnStatusMember?.runtimeDiagnostic ?? liveRuntimeMember?.runtimeDiagnostic;
    const shouldKeepConfirmedSpawnRuntimeDiagnostic =
      !!confirmedSpawnRuntimeDiagnostic &&
      !shouldClearRuntimeDiagnosticAfterBootstrapConfirmation(confirmedSpawnRuntimeDiagnostic);
    const runtimeLivenessFields = resolveTeamProvisioningRuntimeSnapshotLiveness({
      liveAlive: liveRuntimeMember?.alive,
      liveLivenessKind: liveRuntimeMember?.livenessKind,
      livePidSource: liveRuntimeMember?.pidSource,
      liveRuntimeDiagnostic: liveRuntimeMember?.runtimeDiagnostic,
      liveRuntimeDiagnosticSeverity: liveRuntimeMember?.runtimeDiagnosticSeverity,
      spawnRuntimeDiagnostic: confirmedSpawnRuntimeDiagnostic,
      spawnRuntimeDiagnosticSeverity: spawnStatusMember?.runtimeDiagnosticSeverity,
      confirmedRuntimeBootstrapAlive: confirmedOpenCodeRuntimeBootstrapAlive,
      ...(confirmedOpenCodeRuntimeBootstrapAlive
        ? {
            confirmedRuntimeBootstrapDiagnostic:
              'OpenCode bootstrap confirmed; runtime host/session evidence present.',
          }
        : {}),
      confirmedSpawnRuntimeFallback,
      keepConfirmedSpawnRuntimeDiagnostic: shouldKeepConfirmedSpawnRuntimeDiagnostic,
      permissionBlocked,
    });
    if (
      rssPid &&
      !usageStatsByPid.has(rssPid) &&
      isSharedOpenCodeHost &&
      typeof rssPid === 'number' &&
      rssPid > 0
    ) {
      try {
        const refreshedUsageStats = (
          await params.readProcessUsageStatsByPid([rssPid], { ignoreCachedMisses: true })
        ).get(rssPid);
        if (refreshedUsageStats) {
          usageStatsByPid.set(rssPid, refreshedUsageStats);
        }
      } catch (error) {
        params.logDebug(
          `[${params.teamName}] Shared OpenCode host runtime usage refresh failed for pid ${rssPid}; continuing without refreshed metrics: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        // Shared OpenCode host can exit between discovery and the targeted RSS refresh.
      }
    }
    const usageStats = rssPid
      ? buildRuntimeProcessLoadStatsSafely(
          params.teamName,
          memberName,
          {
            rootPid: rssPid,
            usageStatsByPid,
            processTree: runtimeUsageTreesByRootPid.get(rssPid),
            scope: isSharedOpenCodeHost ? 'shared-host' : undefined,
          },
          params.buildRuntimeProcessLoadStats,
          params.logDebug
        )
      : undefined;
    const resourceHistory = rssPid
      ? recordAgentRuntimeResourceSampleSafely(
          params.agentRuntimeResourceHistory,
          {
            teamName: params.teamName,
            memberName,
            timestamp: updatedAt,
            runId: activeRuntimeRunId,
            cpuPercent: usageStats?.cpuPercent,
            rssBytes: usageStats?.rssBytes,
            primaryCpuPercent: usageStats?.primaryCpuPercent,
            primaryRssBytes: usageStats?.primaryRssBytes,
            childCpuPercent: usageStats?.childCpuPercent,
            childRssBytes: usageStats?.childRssBytes,
            processCount: usageStats?.processCount,
            runtimeLoadScope: usageStats?.runtimeLoadScope,
            runtimeLoadTruncated: usageStats?.runtimeLoadTruncated,
            pidSource: liveRuntimeMember?.pidSource,
            pid: rssPid,
            runtimePid: liveRuntimeMember?.metricsPid,
            activeKeys: activeResourceHistoryKeys,
          },
          params.logDebug
        )
      : undefined;
    const runtimeResourceFields = projectRuntimeSnapshotResourceFields({
      source: isSharedOpenCodeHost ? 'runtime-adapter' : 'live-process',
      pid: rssPid,
      runtimePid: liveRuntimeMember?.metricsPid,
      pidSource: liveRuntimeMember?.pidSource,
      usageStats,
      resourceHistory,
    });

    snapshotMembers[memberName] = mapRuntimeProjectionMemberEntry({
      memberName,
      ...runtimeLivenessFields,
      restartable,
      backendType,
      providerId: memberProviderId,
      providerBackendId: memberProviderBackendId,
      laneId: activeRunLaneIdentity.laneId ?? launchMember?.laneId,
      laneKind: activeRunLaneIdentity.laneKind ?? launchMember?.laneKind,
      pid: displayPid,
      runtimeModel,
      cwd: runtimeCwd,
      ...runtimeResourceFields,
      processCommand: liveRuntimeMember?.processCommand,
      paneId: liveRuntimeMember?.tmuxPaneId,
      panePid: liveRuntimeMember?.panePid,
      paneCurrentCommand: liveRuntimeMember?.paneCurrentCommand,
      runtimePid: liveRuntimeMember?.metricsPid,
      runtimeSessionId: liveRuntimeMember?.runtimeSessionId || runtimeAdapterSessionId,
      runtimeLastSeenAt: liveRuntimeMember?.runtimeLastSeenAt,
      historicalBootstrapConfirmed,
      diagnostics: liveRuntimeMember?.diagnostics,
      updatedAt,
    });
  }
  try {
    params.agentRuntimeResourceHistory.prune(params.teamName, activeResourceHistoryKeys);
  } catch (error) {
    params.logDebug(
      `[${params.teamName}] Failed to prune runtime telemetry history; continuing with snapshot: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const persistedLaunchIdentity = persistedTeamMeta?.launchIdentity;
  const snapshotProviderId =
    run?.request.providerId ?? persistedLaunchIdentity?.providerId ?? persistedTeamMeta?.providerId;
  const snapshotProviderBackendId = run
    ? run.request.providerBackendId
    : persistedLaunchIdentity
      ? (persistedLaunchIdentity.providerBackendId ?? persistedTeamMeta?.providerBackendId)
      : persistedTeamMeta?.providerBackendId;
  const snapshot = mapRuntimeProjectionSnapshot({
    teamName: params.teamName,
    updatedAt,
    runId: run?.runId ?? params.runId,
    providerBackendId: migrateProviderBackendId(snapshotProviderId, snapshotProviderBackendId),
    fastMode:
      run?.request.fastMode ??
      persistedLaunchIdentity?.selectedFastMode ??
      persistedTeamMeta?.fastMode,
    members: snapshotMembers,
  });

  if (
    params.getRuntimeSnapshotCacheGeneration(params.teamName) === params.generationAtStart &&
    params.getTrackedRunId(params.teamName) === params.runId
  ) {
    params.rememberAgentRuntimeSnapshot({
      teamName: params.teamName,
      runId: params.runId,
      generationAtStart: params.generationAtStart,
      snapshot,
      ttlMs: params.getAgentRuntimeSnapshotCacheTtlMs(params.teamName, params.runId),
    });
  }
  return snapshot;
}

export async function buildLiveTeamAgentRuntimeMetadata(
  params: {
    teamName: string;
    runId: string | null;
    generationAtStart: number;
    readRuntimeProcessRowsForLiveRuntimeMetadata(params: {
      teamName: string;
      runId: string | null;
      generationAtStart: number;
    }): Promise<{ rows: RuntimeTelemetryProcessTableRow[]; processTableAvailable: boolean }>;
    readWindowsHostProcessRowsForLiveRuntimeMetadata(
      teamName: string
    ): Promise<{ rows: RuntimeTelemetryProcessTableRow[]; processTableAvailable: boolean }>;
  } & RuntimeSnapshotStores &
    TeamProvisioningRuntimeSnapshotBuildCacheReadPort & {
      liveRuntimeMetadataCache: TeamProvisioningLiveRuntimeMetadataCacheWritePort<
        Map<string, LiveTeamAgentRuntimeMetadata>
      >;
    } & RuntimeSnapshotLogging
): Promise<Map<string, LiveTeamAgentRuntimeMetadata>> {
  const run = params.runId ? (params.runs.get(params.runId) ?? null) : null;
  const runtimeAdapterRun = params.runtimeAdapterRunByTeam.get(params.teamName);
  const activeRuntimeRunId = resolveActiveRuntimeRunId(run, params.runId, runtimeAdapterRun);
  const currentRuntimeAdapterRun = shouldUseRuntimeAdapterRunEvidence(
    runtimeAdapterRun,
    activeRuntimeRunId
  )
    ? runtimeAdapterRun
    : undefined;

  let configuredMembers: TeamConfig['members'] = [];
  try {
    configuredMembers = (await params.readConfigSnapshot(params.teamName))?.members ?? [];
  } catch {
    configuredMembers = [];
  }

  let metaMembers: TeamMember[] = [];
  try {
    metaMembers = await params.membersMetaStore.getMembers(params.teamName);
  } catch {
    metaMembers = [];
  }

  const persistedRuntimeMembers = params.readPersistedRuntimeMembers(params.teamName);
  const metadataByMember = new Map<string, LiveTeamAgentRuntimeMetadata>();
  const upsertMetadata = (
    memberName: string,
    patch: Partial<LiveTeamAgentRuntimeMetadata>
  ): void => {
    const existingEntry = findExactMapEntry(metadataByMember, memberName);
    const resolvedMemberName = existingEntry?.[0] ?? memberName;
    const current = existingEntry?.[1] ?? { alive: false };
    metadataByMember.set(resolvedMemberName, {
      ...current,
      ...patch,
      alive: patch.alive ?? current.alive,
    });
  };

  for (const member of persistedRuntimeMembers) {
    const memberName = typeof member.name === 'string' ? member.name.trim() : '';
    if (
      !memberName ||
      isMemberRemovedInMeta(metaMembers, memberName) ||
      isLeadMember({ name: memberName })
    ) {
      continue;
    }
    const runtimeModel =
      findExactActiveRunMemberModel(run, memberName) ??
      findConfiguredMemberModel(configuredMembers, memberName) ??
      findMetaMemberModel(metaMembers, memberName);
    const canUseRuntimeEvidence = shouldUsePersistedRuntimeMemberRuntimeEvidence(
      member,
      activeRuntimeRunId
    );
    const agentId =
      typeof member.agentId === 'string' ? member.agentId.trim() || undefined : undefined;
    upsertMetadata(memberName, {
      providerId: normalizeOptionalTeamProviderId(member.providerId),
      ...(agentId ? { agentId } : {}),
      ...(canUseRuntimeEvidence
        ? {
            backendType: normalizeTeamAgentRuntimeBackendType(member.backendType, false),
            tmuxPaneId:
              typeof member.tmuxPaneId === 'string'
                ? member.tmuxPaneId.trim() || undefined
                : undefined,
            ...(normalizeRuntimePositiveInteger(member.runtimePid)
              ? { metricsPid: normalizeRuntimePositiveInteger(member.runtimePid) }
              : {}),
            ...(typeof member.runtimeSessionId === 'string' && member.runtimeSessionId.trim()
              ? { runtimeSessionId: member.runtimeSessionId.trim() }
              : {}),
          }
        : {}),
      ...(typeof member.cwd === 'string' && member.cwd.trim() ? { cwd: member.cwd.trim() } : {}),
      ...(runtimeModel ? { model: runtimeModel } : {}),
    });
  }

  for (const member of configuredMembers) {
    const memberName = typeof member?.name === 'string' ? member.name.trim() : '';
    if (
      !memberName ||
      isMemberRemovedInMeta(metaMembers, memberName) ||
      isLeadMember({ name: memberName, agentType: member.agentType })
    ) {
      continue;
    }
    const configuredRuntimeMember = member as unknown as Record<string, unknown>;
    const configuredAgentId =
      typeof configuredRuntimeMember.agentId === 'string'
        ? configuredRuntimeMember.agentId.trim()
        : '';
    const configuredTmuxPaneId =
      typeof configuredRuntimeMember.tmuxPaneId === 'string'
        ? configuredRuntimeMember.tmuxPaneId.trim()
        : '';
    const configuredBackendType =
      typeof configuredRuntimeMember.backendType === 'string'
        ? configuredRuntimeMember.backendType
        : undefined;
    const runtimeModel =
      findExactActiveRunMemberModel(run, memberName) ||
      member.model?.trim() ||
      findMetaMemberModel(metaMembers, memberName);
    upsertMetadata(memberName, {
      ...(runtimeModel ? { model: runtimeModel } : {}),
      ...(configuredAgentId ? { agentId: configuredAgentId } : {}),
      ...(configuredTmuxPaneId ? { tmuxPaneId: configuredTmuxPaneId } : {}),
      ...(normalizeOptionalTeamProviderId(member.providerId)
        ? { providerId: normalizeOptionalTeamProviderId(member.providerId) }
        : {}),
      ...(typeof member.cwd === 'string' && member.cwd.trim() ? { cwd: member.cwd.trim() } : {}),
      ...(normalizeTeamAgentRuntimeBackendType(configuredBackendType, false)
        ? {
            backendType: normalizeTeamAgentRuntimeBackendType(configuredBackendType, false),
          }
        : {}),
    });
  }

  for (const member of metaMembers) {
    const memberName = typeof member?.name === 'string' ? member.name.trim() : '';
    if (
      !memberName ||
      member.removedAt ||
      isLeadMember({ name: memberName, agentType: member.agentType })
    ) {
      continue;
    }
    const runtimeModel =
      findExactActiveRunMemberModel(run, memberName) ||
      member.model?.trim() ||
      findConfiguredMemberModel(configuredMembers, memberName);
    upsertMetadata(memberName, {
      ...(runtimeModel ? { model: runtimeModel } : {}),
      ...(normalizeOptionalTeamProviderId(member.providerId)
        ? { providerId: normalizeOptionalTeamProviderId(member.providerId) }
        : {}),
      ...(typeof member.agentId === 'string' && member.agentId.trim()
        ? { agentId: member.agentId.trim() }
        : {}),
      ...(typeof member.cwd === 'string' && member.cwd.trim() ? { cwd: member.cwd.trim() } : {}),
    });
  }

  for (const member of run?.effectiveMembers ?? []) {
    const memberName = member.name?.trim() ?? '';
    if (!memberName || isLeadMember(member) || memberName.toLowerCase() === 'user') {
      continue;
    }
    const providerId = normalizeOptionalTeamProviderId(member.providerId);
    upsertMetadata(memberName, {
      ...(member.model?.trim() ? { model: member.model.trim() } : {}),
      ...(providerId ? { providerId } : {}),
    });
  }

  for (const lane of run?.mixedSecondaryLanes ?? []) {
    const memberName = lane.member.name?.trim() ?? '';
    if (!memberName || isMemberRemovedInMeta(metaMembers, memberName)) {
      continue;
    }
    const evidenceResolution = resolveActiveRunRuntimeAdapterEvidence(
      run,
      currentRuntimeAdapterRun,
      memberName
    );
    const evidence =
      evidenceResolution.owner === 'secondary' ? evidenceResolution.evidence : undefined;
    const runtimeModel = lane.member.model?.trim() || undefined;
    const laneMemberCwd =
      typeof (lane.member as { cwd?: unknown }).cwd === 'string'
        ? (lane.member as { cwd?: string }).cwd?.trim()
        : '';
    const laneCwd = laneMemberCwd || run?.request.cwd;
    upsertMetadata(memberName, {
      backendType: 'process',
      providerId: 'opencode',
      alive: false,
      livenessKind: evidence?.livenessKind,
      pidSource: evidence?.pidSource,
      runtimeDiagnostic: evidence?.runtimeDiagnostic,
      ...(laneCwd ? { cwd: laneCwd } : {}),
      ...(runtimeModel ? { model: runtimeModel } : {}),
      ...(typeof evidence?.runtimePid === 'number' && evidence.runtimePid > 0
        ? { metricsPid: evidence.runtimePid }
        : {}),
      ...(evidence?.sessionId ? { runtimeSessionId: evidence.sessionId } : {}),
    });
  }

  const persistedLaunchSnapshot: PersistedTeamLaunchSnapshot | null = choosePreferredLaunchSnapshot(
    await readBootstrapLaunchSnapshot(params.teamName).catch(() => null),
    await params.launchStateStore.read(params.teamName).catch(() => null)
  );
  const persistedMembers = Object.entries(persistedLaunchSnapshot?.members ?? {});
  for (const [persistedMemberKey, persistedMember] of persistedMembers) {
    const memberName = persistedMember.name?.trim() ?? '';
    if (
      !memberName ||
      !matchesExactTeamMemberName(persistedMemberKey, memberName) ||
      isMemberRemovedInMeta(metaMembers, memberName) ||
      !shouldUseLaunchMemberRuntimeEvidence(persistedMember, activeRuntimeRunId)
    ) {
      continue;
    }
    const activeRunMember = findExactActiveRunMember(run, memberName);
    const activeRunModel = activeRunMember?.model?.trim();
    const primaryEvidenceResolution = resolveActiveRunRuntimeAdapterEvidence(
      run,
      currentRuntimeAdapterRun,
      memberName
    );
    const evidenceModel =
      primaryEvidenceResolution.owner === 'primary'
        ? primaryEvidenceResolution.evidence?.model?.trim()
        : undefined;
    const activeRunProviderId =
      normalizeOptionalTeamProviderId(activeRunMember?.providerId) ??
      inferTeamProviderIdFromModel(activeRunModel ?? evidenceModel);
    const effectiveProviderId = activeRunProviderId ?? persistedMember.providerId;
    upsertMetadata(memberName, {
      backendType:
        effectiveProviderId === 'opencode'
          ? 'process'
          : findExactMapEntry(metadataByMember, memberName)?.[1].backendType,
      providerId: effectiveProviderId,
      alive: false,
      livenessKind: persistedMember.livenessKind,
      pidSource: persistedMember.pidSource,
      runtimeDiagnostic: persistedMember.runtimeDiagnostic,
      runtimeDiagnosticSeverity: persistedMember.runtimeDiagnosticSeverity,
      runtimeLastSeenAt:
        persistedMember.runtimeLastSeenAt ??
        persistedMember.lastHeartbeatAt ??
        persistedMember.lastRuntimeAliveAt,
      ...(activeRunModel
        ? { model: activeRunModel }
        : evidenceModel
          ? { model: evidenceModel }
          : persistedMember.model?.trim()
            ? { model: persistedMember.model.trim() }
            : {}),
      ...(typeof persistedMember.runtimePid === 'number' && persistedMember.runtimePid > 0
        ? { metricsPid: persistedMember.runtimePid }
        : {}),
      ...(persistedMember.runtimeSessionId
        ? { runtimeSessionId: persistedMember.runtimeSessionId }
        : {}),
    });
  }
  for (const [memberName, evidence] of Object.entries(currentRuntimeAdapterRun?.members ?? {})) {
    const normalizedMemberName = evidence.memberName?.trim() || memberName.trim();
    const primaryEvidenceResolution = resolveActiveRunRuntimeAdapterEvidence(
      run,
      currentRuntimeAdapterRun,
      normalizedMemberName
    );
    if (
      !normalizedMemberName ||
      isMemberRemovedInMeta(metaMembers, normalizedMemberName) ||
      primaryEvidenceResolution.owner !== 'primary' ||
      primaryEvidenceResolution.evidence !== evidence
    ) {
      continue;
    }
    const activeRunMember = findExactActiveRunMember(run, normalizedMemberName);
    const activeRunModel = activeRunMember?.model?.trim();
    const evidenceModel = evidence.model?.trim();
    const activeRunProviderId =
      normalizeOptionalTeamProviderId(activeRunMember?.providerId) ??
      normalizeOptionalTeamProviderId(evidence.providerId) ??
      inferTeamProviderIdFromModel(activeRunModel ?? evidenceModel);
    upsertMetadata(normalizedMemberName, {
      alive: false,
      ...(activeRunProviderId === 'opencode'
        ? { backendType: 'process' as const }
        : evidence.backendType
          ? { backendType: evidence.backendType }
          : {}),
      ...(activeRunProviderId ? { providerId: activeRunProviderId } : {}),
      ...(evidence.livenessKind ? { livenessKind: evidence.livenessKind } : {}),
      ...(evidence.pidSource ? { pidSource: evidence.pidSource } : {}),
      ...(evidence.runtimeDiagnostic ? { runtimeDiagnostic: evidence.runtimeDiagnostic } : {}),
      ...(evidence.runtimeDiagnosticSeverity
        ? { runtimeDiagnosticSeverity: evidence.runtimeDiagnosticSeverity }
        : {}),
      ...(activeRunModel
        ? { model: activeRunModel }
        : evidenceModel
          ? { model: evidenceModel }
          : {}),
      ...(typeof evidence.runtimePid === 'number' && evidence.runtimePid > 0
        ? { metricsPid: evidence.runtimePid }
        : {}),
      ...(evidence.sessionId ? { runtimeSessionId: evidence.sessionId } : {}),
    });
  }

  const paneIds = [...metadataByMember.values()]
    .filter((metadata) => metadata.backendType === 'tmux' || metadata.backendType === undefined)
    .map((metadata) => metadata.tmuxPaneId?.trim() ?? '')
    .filter((paneId) => paneId.length > 0 && !paneId.startsWith('process:'));
  let paneInfoById = new Map<string, TmuxPaneRuntimeInfo>();
  if (paneIds.length > 0) {
    try {
      paneInfoById = await listTmuxPaneRuntimeInfoForCurrentPlatform(paneIds);
    } catch (error) {
      params.logDebug(
        `[${params.teamName}] Failed to read tmux pane info for runtime snapshot: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  let processRows: RuntimeTelemetryProcessTableRow[] = [];
  let processTableAvailable = true;
  const shouldReadProcessTable = shouldReadProcessTableForLiveRuntimeMetadata({
    metadataByMember,
    launchSnapshot: persistedLaunchSnapshot,
    paneInfoById,
  });
  if (shouldReadProcessTable) {
    const processRowsResult = await params.readRuntimeProcessRowsForLiveRuntimeMetadata({
      teamName: params.teamName,
      runId: params.runId,
      generationAtStart: params.generationAtStart,
    });
    processRows = processRowsResult.rows;
    processTableAvailable = processRowsResult.processTableAvailable;
  }
  let windowsHostProcessRows: RuntimeTelemetryProcessTableRow[] | null = null;
  let windowsHostProcessTableAvailable = false;
  const getWindowsHostProcessRows = async (): Promise<RuntimeTelemetryProcessTableRow[]> => {
    if (windowsHostProcessRows) {
      return windowsHostProcessRows;
    }
    const result = await params.readWindowsHostProcessRowsForLiveRuntimeMetadata(params.teamName);
    windowsHostProcessRows = result.rows;
    windowsHostProcessTableAvailable = result.processTableAvailable;
    return windowsHostProcessRows;
  };

  for (const [memberName, metadata] of metadataByMember.entries()) {
    const paneId = metadata.tmuxPaneId?.trim() ?? '';
    const exactPersistedLaunchMember = findExactPersistedLaunchMember(
      persistedLaunchSnapshot,
      memberName
    );
    const launchMember = shouldUseLaunchMemberRuntimeEvidence(
      exactPersistedLaunchMember,
      activeRuntimeRunId
    )
      ? exactPersistedLaunchMember
      : undefined;
    const adapterEvidenceResolution = resolveActiveRunRuntimeAdapterEvidence(
      run,
      currentRuntimeAdapterRun,
      memberName
    );
    const adapterEvidence = adapterEvidenceResolution.evidence;
    const adapterStatus: MemberSpawnStatusEntry | undefined = adapterEvidence
      ? {
          status: adapterEvidence.hardFailure
            ? 'error'
            : adapterEvidence.bootstrapConfirmed
              ? 'online'
              : adapterEvidence.agentToolAccepted
                ? 'waiting'
                : 'spawning',
          launchState: adapterEvidence.launchState,
          ...(adapterEvidence.hardFailureReason
            ? { hardFailureReason: adapterEvidence.hardFailureReason }
            : {}),
          ...(adapterEvidence.pendingPermissionRequestIds?.length
            ? { pendingPermissionRequestIds: adapterEvidence.pendingPermissionRequestIds }
            : {}),
          agentToolAccepted: adapterEvidence.agentToolAccepted,
          runtimeAlive: adapterEvidence.runtimeAlive,
          bootstrapConfirmed: adapterEvidence.bootstrapConfirmed,
          hardFailure: adapterEvidence.hardFailure,
          ...(metadata.model ? { runtimeModel: metadata.model } : {}),
          ...(adapterEvidence.livenessKind ? { livenessKind: adapterEvidence.livenessKind } : {}),
          ...(adapterEvidence.runtimeDiagnostic
            ? { runtimeDiagnostic: adapterEvidence.runtimeDiagnostic }
            : {}),
          updatedAt: persistedLaunchSnapshot?.updatedAt ?? nowIso(),
        }
      : undefined;
    const shouldUseWindowsHostRows =
      process.platform === 'win32' &&
      (metadata.providerId === 'opencode' ||
        launchMember?.providerId === 'opencode' ||
        metadata.backendType !== 'tmux') &&
      adapterEvidenceResolution.owner === 'primary' &&
      adapterEvidence?.runtimeAlive !== true &&
      adapterEvidence?.bootstrapConfirmed !== true;
    const hostProcessRows = shouldUseWindowsHostRows ? await getWindowsHostProcessRows() : [];
    const memberProcessRows = shouldUseWindowsHostRows
      ? [...hostProcessRows, ...processRows]
      : processRows;
    const memberProcessTableAvailable = shouldUseWindowsHostRows
      ? windowsHostProcessTableAvailable || processTableAvailable
      : processTableAvailable;
    const trackedStatus = findExactTrackedMemberSpawnStatus(run, memberName);
    const launchStatus =
      isLaunchMemberStatusRelevantToRuntimeRun(launchMember, activeRuntimeRunId) && launchMember
        ? buildLaunchMemberSpawnStatus(launchMember, metadata.model)
        : undefined;
    const status = shouldPreferCurrentLaunchMemberStatus(trackedStatus, launchStatus)
      ? launchStatus
      : shouldPreferCurrentLaunchMemberStatus(trackedStatus, adapterStatus)
        ? adapterStatus
        : (trackedStatus ?? adapterStatus ?? launchStatus);
    const resolvedAt = nowIso();
    const livenessInput = {
      teamName: params.teamName,
      memberName,
      agentId: metadata.agentId,
      backendType: metadata.backendType,
      providerId: metadata.providerId ?? launchMember?.providerId,
      tmuxPaneId: metadata.tmuxPaneId,
      persistedRuntimePid: launchMember?.runtimePid ?? metadata.metricsPid,
      persistedRuntimeSessionId: launchMember?.runtimeSessionId ?? metadata.runtimeSessionId,
      trackedSpawnStatus: status,
      runtimePid: metadata.metricsPid,
      runtimeSessionId: metadata.runtimeSessionId,
      pane: paneId ? paneInfoById.get(paneId) : undefined,
      processRows: memberProcessRows,
      processTableAvailable: memberProcessTableAvailable,
      nowIso: resolvedAt,
    };
    const mixedSecondaryProbe =
      adapterEvidenceResolution.owner === 'secondary'
        ? resolveTeamProvisioningRuntimeLiveness({
            ...livenessInput,
            trackedSpawnStatus: suppressRuntimeBootstrapConfirmation(status),
          })
        : undefined;
    const mixedSecondaryProbeIsLive =
      memberProcessTableAvailable &&
      (mixedSecondaryProbe?.alive === true ||
        hasLiveOpenCodeRuntimePidProbe({
          evidence: adapterEvidence,
          teamName: params.teamName,
          memberName,
          processRows: memberProcessRows,
          processTableAvailable: memberProcessTableAvailable,
        }));
    const resolved =
      mixedSecondaryProbe && !mixedSecondaryProbeIsLive
        ? mixedSecondaryProbe
        : resolveTeamProvisioningRuntimeLiveness(livenessInput);
    const runtimeLastSeenAt =
      resolved.runtimeLastSeenAt ?? (isStrongRuntimeEvidence(resolved) ? resolvedAt : undefined);
    const bootstrapTransportDiagnostic =
      status?.runtimeDiagnostic ?? launchMember?.runtimeDiagnostic;
    const bootstrapTransportDiagnosticSeverity =
      status?.runtimeDiagnosticSeverity ?? launchMember?.runtimeDiagnosticSeverity;
    const bootstrapTransportLaunchState = status?.launchState ?? launchMember?.launchState;
    const bootstrapTransportConfirmed =
      status?.bootstrapConfirmed === true || launchMember?.bootstrapConfirmed === true;
    const hasProcessBootstrapTransportDiagnostic =
      (metadata.backendType === 'process' || metadata.tmuxPaneId?.startsWith('process:')) &&
      !bootstrapTransportConfirmed &&
      (bootstrapTransportLaunchState === 'runtime_pending_bootstrap' ||
        bootstrapTransportLaunchState === 'failed_to_start') &&
      isProcessBootstrapTransportDiagnostic(bootstrapTransportDiagnostic);
    // Prefer bootstrap transport diagnostics over generic pid/liveness text
    // while launch is unconfirmed, otherwise the UI hides the exact stage
    // where process bootstrap got stuck.
    const runtimeDiagnostic = hasProcessBootstrapTransportDiagnostic
      ? bootstrapTransportDiagnostic
      : resolved.runtimeDiagnostic;
    const runtimeDiagnosticSeverity = hasProcessBootstrapTransportDiagnostic
      ? (bootstrapTransportDiagnosticSeverity ?? resolved.runtimeDiagnosticSeverity)
      : resolved.runtimeDiagnosticSeverity;
    metadataByMember.set(memberName, {
      ...metadata,
      alive: resolved.alive,
      ...(typeof resolved.pid === 'number' && resolved.pid > 0 ? { pid: resolved.pid } : {}),
      ...(typeof (resolved.metricsPid ?? metadata.metricsPid) === 'number' &&
      Number.isFinite(resolved.metricsPid ?? metadata.metricsPid) &&
      (resolved.metricsPid ?? metadata.metricsPid)! > 0
        ? { metricsPid: resolved.metricsPid ?? metadata.metricsPid }
        : {}),
      livenessKind: resolved.livenessKind,
      ...(resolved.pidSource ? { pidSource: resolved.pidSource } : {}),
      ...(resolved.processCommand ? { processCommand: resolved.processCommand } : {}),
      ...(resolved.panePid ? { panePid: resolved.panePid } : {}),
      ...(resolved.paneCurrentCommand ? { paneCurrentCommand: resolved.paneCurrentCommand } : {}),
      ...(resolved.runtimeSessionId ? { runtimeSessionId: resolved.runtimeSessionId } : {}),
      ...(runtimeLastSeenAt ? { runtimeLastSeenAt } : {}),
      runtimeDiagnostic,
      runtimeDiagnosticSeverity,
      diagnostics: hasProcessBootstrapTransportDiagnostic
        ? mergeRuntimeDiagnostics(resolved.diagnostics, [bootstrapTransportDiagnostic])
        : resolved.diagnostics,
    });
  }

  if (
    params.getRuntimeSnapshotCacheGeneration(params.teamName) === params.generationAtStart &&
    params.getTrackedRunId(params.teamName) === params.runId
  ) {
    params.liveRuntimeMetadataCache.rememberLiveTeamAgentRuntimeMetadata({
      teamName: params.teamName,
      runId: params.runId,
      generationAtStart: params.generationAtStart,
      metadata: metadataByMember,
      ttlMs: params.getAgentRuntimeSnapshotCacheTtlMs(params.teamName, params.runId),
    });
  }
  return metadataByMember;
}
