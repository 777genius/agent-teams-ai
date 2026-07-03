import { isLeadMember } from '@shared/utils/leadDetection';
import { hasUnsafeProvisionedButNotAliveRuntimeEvidence } from '@shared/utils/teamLaunchFailureReason';

import {
  type BootstrapTranscriptOutcome,
  isBootstrapProofClearableLaunchFailureReason,
  type LeadInboxLaunchReconcileMessage,
  shouldClearRuntimeDiagnosticAfterBootstrapConfirmation,
} from './TeamProvisioningBootstrapTranscript';
import { mentionsProcessTableUnavailable } from './TeamProvisioningLaunchDiagnostics';
import {
  deriveMemberLaunchState,
  isAutoClearableLaunchFailureReason,
  isBootstrapCheckInTimeoutFailureReason,
  isCliProvisionedButNotAliveFailureReason,
  isProvisionedButNotAliveFailureReason,
} from './TeamProvisioningLaunchFailurePolicy';
import { matchesObservedMemberNameForExpected } from './TeamProvisioningMemberIdentity';
import { MEMBER_LAUNCH_GRACE_MS } from './TeamProvisioningMemberSpawnStatusPolicy';
import { isPersistedOpenCodeSecondaryLaneMember } from './TeamProvisioningOpenCodeDiagnosticsPolicy';
import {
  getOpenCodeSecondaryBootstrapStallDiagnosticFromPersisted,
  isBootstrapMemberEvidenceCurrentForMember,
  shouldMarkPersistedOpenCodeBootstrapStalled,
} from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';
import { extractBootstrapFailureReason } from './TeamProvisioningPromptBuilders';
import { mergeRuntimeDiagnostics } from './TeamProvisioningRuntimeMetadata';

import type { ProcessBootstrapTransportSummary } from '../ProcessBootstrapTransportEvidence';
import type { LiveTeamAgentRuntimeMetadata } from './TeamProvisioningRuntimeMetadataPolicy';
import type { PersistedTeamLaunchMemberState, PersistedTeamLaunchPhase } from '@shared/types';

export interface LaunchReconcileConfigMembers {
  configMembers: Set<string>;
  configBootstrapRunIds: Map<string, string>;
  leadName: string;
}

export function createDefaultLaunchReconcileConfigMembers(
  leadName = 'team-lead'
): LaunchReconcileConfigMembers {
  return {
    configMembers: new Set<string>(),
    configBootstrapRunIds: new Map<string, string>(),
    leadName,
  };
}

export function parseLaunchReconcileConfigMembers(
  raw: string,
  defaultLeadName = 'team-lead'
): LaunchReconcileConfigMembers {
  const config = JSON.parse(raw) as {
    members?: { name?: string; agentType?: string; bootstrapRunId?: string }[];
  };
  const configuredMembers = config.members ?? [];
  const leadName =
    configuredMembers.find((member) => isLeadMember(member))?.name?.trim() || defaultLeadName;
  const configMembers = new Set(
    configuredMembers
      .map((member) => (typeof member?.name === 'string' ? member.name.trim() : ''))
      .filter((name) => name.length > 0 && !isLeadMember({ name }))
  );
  const configBootstrapRunIds = new Map(
    configuredMembers.flatMap((member) => {
      const name = typeof member?.name === 'string' ? member.name.trim() : '';
      const runId = typeof member?.bootstrapRunId === 'string' ? member.bootstrapRunId.trim() : '';
      return name.length > 0 && runId.length > 0 && !isLeadMember({ name })
        ? [[name, runId] as const]
        : [];
    })
  );
  return { configMembers, configBootstrapRunIds, leadName };
}

export interface ReconcilePersistedLaunchMemberPorts {
  selectLatestLeadInboxLaunchReconcileMessage(input: {
    messages: readonly LeadInboxLaunchReconcileMessage[];
    expectedMembers: readonly string[];
    expected: string;
    firstSpawnAcceptedAt?: string;
  }): LeadInboxLaunchReconcileMessage | null;
  findBootstrapRuntimeProofObservedAt(
    teamName: string,
    memberName: string,
    member: Pick<
      PersistedTeamLaunchMemberState,
      'firstSpawnAcceptedAt' | 'launchState' | 'hardFailureReason'
    >
  ): Promise<string | null>;
  findBootstrapTranscriptOutcome(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<BootstrapTranscriptOutcome | null>;
  readProcessBootstrapTransportSummary(input: {
    teamName: string;
    memberName: string;
    member: PersistedTeamLaunchMemberState;
  }): Promise<ProcessBootstrapTransportSummary | null>;
  applyProcessBootstrapTransportOverlay(input: {
    member: PersistedTeamLaunchMemberState;
    summary: ProcessBootstrapTransportSummary | null;
    launchPhase: PersistedTeamLaunchPhase;
    finalTimeoutReached?: boolean;
  }): PersistedTeamLaunchMemberState;
  nowMs(): number;
}

export async function reconcilePersistedLaunchMember(input: {
  teamName: string;
  expected: string;
  current: PersistedTeamLaunchMemberState | undefined;
  bootstrapMember: PersistedTeamLaunchMemberState | undefined;
  persistedMemberNames: readonly string[];
  configMembers: ReadonlySet<string>;
  configBootstrapRunIds: ReadonlyMap<string, string>;
  leadInboxMessages: readonly LeadInboxLaunchReconcileMessage[];
  liveRuntimeByMember: ReadonlyMap<string, LiveTeamAgentRuntimeMetadata>;
  launchPhase: PersistedTeamLaunchPhase;
  now: string;
  ports: ReconcilePersistedLaunchMemberPorts;
}): Promise<PersistedTeamLaunchMemberState> {
  const {
    teamName,
    expected,
    bootstrapMember,
    persistedMemberNames,
    configMembers,
    configBootstrapRunIds,
    leadInboxMessages,
    liveRuntimeByMember,
    launchPhase,
    now,
    ports,
  } = input;
  let current = input.current ?? {
    name: expected,
    launchState: 'starting',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    lastEvaluatedAt: now,
  };
  const isOpenCodeSecondaryLaneMember = isPersistedOpenCodeSecondaryLaneMember(current);
  const matchedConfigNames = [...configMembers].filter((name) =>
    matchesObservedMemberNameForExpected(name, expected)
  );
  const configBootstrapRunId = matchedConfigNames
    .map((name) => configBootstrapRunIds.get(name))
    .find((runId): runId is string => typeof runId === 'string' && runId.length > 0);
  const currentBootstrapEvidenceBoundary = configBootstrapRunId
    ? { ...current, runtimeRunId: configBootstrapRunId }
    : current;
  if (
    bootstrapMember?.agentToolAccepted &&
    !current.agentToolAccepted &&
    isBootstrapMemberEvidenceCurrentForMember(
      currentBootstrapEvidenceBoundary,
      bootstrapMember,
      'acceptance'
    )
  ) {
    current.agentToolAccepted = true;
    current.firstSpawnAcceptedAt =
      current.firstSpawnAcceptedAt ?? bootstrapMember.firstSpawnAcceptedAt;
  }
  if (
    bootstrapMember?.bootstrapConfirmed &&
    !current.bootstrapConfirmed &&
    !isOpenCodeSecondaryLaneMember &&
    isBootstrapMemberEvidenceCurrentForMember(
      currentBootstrapEvidenceBoundary,
      bootstrapMember,
      'confirmation'
    )
  ) {
    current.bootstrapConfirmed = true;
    current.lastHeartbeatAt = current.lastHeartbeatAt ?? bootstrapMember.lastHeartbeatAt;
  }
  const runtimeMetadataCandidates = [...liveRuntimeByMember.entries()].filter(([name]) =>
    matchesObservedMemberNameForExpected(name, expected)
  );
  const runtimeMetadata =
    runtimeMetadataCandidates.find(([, metadata]) => metadata.alive) ??
    runtimeMetadataCandidates[0];
  const observedRuntimeAlive = runtimeMetadata?.[1].alive === true;
  const heartbeatMessage = ports.selectLatestLeadInboxLaunchReconcileMessage({
    messages: leadInboxMessages,
    expectedMembers: persistedMemberNames,
    expected,
    firstSpawnAcceptedAt: current.firstSpawnAcceptedAt,
  });
  const heartbeatReason = heartbeatMessage
    ? extractBootstrapFailureReason(heartbeatMessage.text)
    : null;
  const bootstrapFailureReason =
    bootstrapMember?.hardFailure === true &&
    !bootstrapMember.bootstrapConfirmed &&
    isBootstrapMemberEvidenceCurrentForMember(
      currentBootstrapEvidenceBoundary,
      bootstrapMember,
      'confirmation'
    )
      ? (bootstrapMember.hardFailureReason ?? bootstrapMember.runtimeDiagnostic)
      : null;
  const acceptedAtMs =
    current.firstSpawnAcceptedAt != null ? Date.parse(current.firstSpawnAcceptedAt) : NaN;
  const initialFailureReason = current.hardFailureReason ?? current.runtimeDiagnostic;
  const hasBootstrapCheckInTimeoutFailure =
    isBootstrapCheckInTimeoutFailureReason(initialFailureReason);
  const hadAutoClearableFailure = isAutoClearableLaunchFailureReason(initialFailureReason);
  const requiresConfirmedBootstrapToClearFailure =
    isCliProvisionedButNotAliveFailureReason(initialFailureReason);
  const metadataRuntimeDiagnostic = runtimeMetadata?.[1].runtimeDiagnostic;
  const metadataRuntimeDiagnosticSeverity = runtimeMetadata?.[1].runtimeDiagnosticSeverity;
  const metadataLivenessKind = runtimeMetadata?.[1].livenessKind;
  const refreshedRuntimeDiagnosticEvidence =
    metadataRuntimeDiagnostic &&
    current.runtimeDiagnostic &&
    metadataRuntimeDiagnostic !== current.runtimeDiagnostic
      ? `${metadataRuntimeDiagnostic}; ${current.runtimeDiagnostic}`
      : (metadataRuntimeDiagnostic ?? current.runtimeDiagnostic);
  const hasUnsafeProvisionedButNotAliveFailure =
    requiresConfirmedBootstrapToClearFailure &&
    hasUnsafeProvisionedButNotAliveRuntimeEvidence({
      ...current,
      runtimeDiagnostic: refreshedRuntimeDiagnosticEvidence,
      runtimeDiagnosticSeverity:
        metadataRuntimeDiagnosticSeverity ?? current.runtimeDiagnosticSeverity,
      livenessKind: metadataLivenessKind ?? current.livenessKind,
    });
  const shouldPreserveUnsafeMetadataLivenessKind =
    hasUnsafeProvisionedButNotAliveFailure &&
    (metadataLivenessKind === 'not_found' ||
      metadataLivenessKind === 'shell_only' ||
      metadataLivenessKind === 'runtime_process_candidate' ||
      ((metadataLivenessKind === 'registered_only' || metadataLivenessKind === 'stale_metadata') &&
        (metadataRuntimeDiagnosticSeverity ?? current.runtimeDiagnosticSeverity) !== 'error' &&
        !mentionsProcessTableUnavailable(refreshedRuntimeDiagnosticEvidence) &&
        !mentionsProcessTableUnavailable(initialFailureReason)));
  const nextLivenessKind = current.bootstrapConfirmed
    ? metadataLivenessKind === 'runtime_process' ||
      metadataLivenessKind === 'confirmed_bootstrap' ||
      shouldPreserveUnsafeMetadataLivenessKind
      ? metadataLivenessKind
      : current.livenessKind === 'stale_metadata' || current.livenessKind === 'registered_only'
        ? 'confirmed_bootstrap'
        : (current.livenessKind ?? 'confirmed_bootstrap')
    : (metadataLivenessKind ?? current.livenessKind);
  current.runtimeAlive = observedRuntimeAlive;
  current.lastRuntimeAliveAt = observedRuntimeAlive ? now : current.lastRuntimeAliveAt;
  current.livenessKind = nextLivenessKind;
  current.pidSource = runtimeMetadata?.[1].pidSource;
  const shouldKeepUnsafeRuntimeDiagnostic =
    hasUnsafeProvisionedButNotAliveFailure &&
    (metadataRuntimeDiagnostic == null ||
      (current.runtimeDiagnosticSeverity === 'error' &&
        metadataRuntimeDiagnosticSeverity !== 'error'));
  current.runtimeDiagnostic = shouldKeepUnsafeRuntimeDiagnostic
    ? current.runtimeDiagnostic
    : metadataRuntimeDiagnostic;
  current.runtimeDiagnosticSeverity = shouldKeepUnsafeRuntimeDiagnostic
    ? current.runtimeDiagnosticSeverity
    : metadataRuntimeDiagnosticSeverity;
  current.sources = {
    ...(current.sources ?? {}),
    processAlive: observedRuntimeAlive || undefined,
    configRegistered: matchedConfigNames.length > 0 || undefined,
    configDrift:
      heartbeatMessage != null && matchedConfigNames.length === 0
        ? true
        : current.sources?.configDrift,
    inboxHeartbeat: heartbeatMessage != null ? true : current.sources?.inboxHeartbeat,
  };
  const bootstrapProvesSpawnAcceptance =
    bootstrapMember?.agentToolAccepted === true ||
    typeof bootstrapMember?.firstSpawnAcceptedAt === 'string';
  const currentProvesSpawnAcceptance =
    current.agentToolAccepted === true || typeof current.firstSpawnAcceptedAt === 'string';
  if (
    !bootstrapFailureReason &&
    !hasBootstrapCheckInTimeoutFailure &&
    hadAutoClearableFailure &&
    !requiresConfirmedBootstrapToClearFailure &&
    (bootstrapProvesSpawnAcceptance || currentProvesSpawnAcceptance)
  ) {
    current.hardFailure = false;
    current.hardFailureReason = undefined;
    if (current.sources) {
      current.sources.hardFailureSignal = undefined;
    }
  }
  if (
    current.bootstrapConfirmed &&
    !isOpenCodeSecondaryLaneMember &&
    !hasUnsafeProvisionedButNotAliveFailure &&
    isBootstrapProofClearableLaunchFailureReason(current.hardFailureReason)
  ) {
    if (isProvisionedButNotAliveFailureReason(current.hardFailureReason)) {
      current.runtimeAlive = true;
    }
    current.hardFailure = false;
    current.hardFailureReason = undefined;
    if (current.sources) {
      current.sources.hardFailureSignal = undefined;
    }
  }
  if (heartbeatReason) {
    current.hardFailure = true;
    current.hardFailureReason = heartbeatReason;
    current.runtimeDiagnostic = heartbeatReason;
    current.runtimeDiagnosticSeverity = 'error';
    current.diagnostics = mergeRuntimeDiagnostics(current.diagnostics, [heartbeatReason]);
    current.sources.hardFailureSignal = true;
  } else if (bootstrapFailureReason) {
    current.hardFailure = true;
    current.hardFailureReason = bootstrapFailureReason;
    current.runtimeDiagnostic = bootstrapFailureReason;
    current.runtimeDiagnosticSeverity = 'error';
    current.diagnostics = mergeRuntimeDiagnostics(current.diagnostics, [bootstrapFailureReason]);
    current.sources.hardFailureSignal = true;
  } else if (heartbeatMessage && !isOpenCodeSecondaryLaneMember) {
    current.bootstrapConfirmed = true;
    current.lastHeartbeatAt = heartbeatMessage.timestamp;
    current.hardFailure = false;
    current.hardFailureReason = undefined;
  }
  const canApplyBootstrapSuccess =
    !heartbeatReason &&
    !hasUnsafeProvisionedButNotAliveFailure &&
    (current.launchState !== 'failed_to_start' ||
      hadAutoClearableFailure ||
      isBootstrapProofClearableLaunchFailureReason(
        current.hardFailureReason ?? current.runtimeDiagnostic
      ));
  if (!current.bootstrapConfirmed && canApplyBootstrapSuccess) {
    const runtimeProofObservedAt = !isOpenCodeSecondaryLaneMember
      ? await ports.findBootstrapRuntimeProofObservedAt(teamName, expected, current)
      : null;
    const transcriptOutcome = runtimeProofObservedAt
      ? null
      : await ports.findBootstrapTranscriptOutcome(
          teamName,
          expected,
          Number.isFinite(acceptedAtMs) ? acceptedAtMs : null
        );
    const bootstrapObservedAt =
      runtimeProofObservedAt ??
      (transcriptOutcome?.kind === 'success' ? transcriptOutcome.observedAt : null);
    if (bootstrapObservedAt && !isOpenCodeSecondaryLaneMember) {
      current.bootstrapConfirmed = true;
      current.lastHeartbeatAt = current.lastHeartbeatAt ?? bootstrapObservedAt;
      current.runtimeAlive = runtimeProofObservedAt
        ? true
        : current.runtimeAlive === true || requiresConfirmedBootstrapToClearFailure;
      current.lastRuntimeAliveAt = runtimeProofObservedAt
        ? (current.lastRuntimeAliveAt ?? bootstrapObservedAt)
        : current.lastRuntimeAliveAt;
      current.hardFailure = false;
      current.hardFailureReason = undefined;
      if (current.sources) {
        current.sources.hardFailureSignal = undefined;
      }
    } else if (transcriptOutcome?.kind === 'failure' && !current.hardFailure) {
      current.hardFailure = true;
      current.hardFailureReason = transcriptOutcome.reason;
      current.sources.hardFailureSignal = true;
    }
  }
  const graceExpired =
    Number.isFinite(acceptedAtMs) && ports.nowMs() - acceptedAtMs >= MEMBER_LAUNCH_GRACE_MS;
  if (!isOpenCodeSecondaryLaneMember) {
    current = ports.applyProcessBootstrapTransportOverlay({
      member: current,
      summary: await ports.readProcessBootstrapTransportSummary({
        teamName,
        memberName: expected,
        member: current,
      }),
      launchPhase,
      finalTimeoutReached: graceExpired,
    });
  }
  if (current.bootstrapConfirmed && !current.hardFailure && !isOpenCodeSecondaryLaneMember) {
    current.livenessKind =
      current.livenessKind === 'stale_metadata' ||
      current.livenessKind === 'registered_only' ||
      current.livenessKind == null
        ? 'confirmed_bootstrap'
        : current.livenessKind;
    current.pidSource =
      current.pidSource === 'persisted_metadata' || current.pidSource == null
        ? 'runtime_bootstrap'
        : current.pidSource;
    if (shouldClearRuntimeDiagnosticAfterBootstrapConfirmation(current.runtimeDiagnostic)) {
      current.runtimeDiagnostic = undefined;
      current.runtimeDiagnosticSeverity = undefined;
    } else if (!current.runtimeDiagnostic) {
      current.runtimeDiagnosticSeverity = undefined;
    }
    current.bootstrapStalled = undefined;
  }
  if (
    isOpenCodeSecondaryLaneMember &&
    shouldMarkPersistedOpenCodeBootstrapStalled(current, ports.nowMs())
  ) {
    const runtimeDiagnostic = getOpenCodeSecondaryBootstrapStallDiagnosticFromPersisted(current);
    current.launchState = 'runtime_pending_bootstrap';
    current.agentToolAccepted = true;
    current.runtimeAlive =
      current.runtimeAlive === true && current.livenessKind === 'runtime_process';
    current.bootstrapConfirmed = false;
    current.hardFailure = false;
    current.hardFailureReason = undefined;
    current.livenessKind = current.livenessKind ?? 'registered_only';
    current.runtimeDiagnostic = runtimeDiagnostic;
    current.runtimeDiagnosticSeverity = 'warning';
    current.bootstrapStalled = true;
    current.diagnostics = mergeRuntimeDiagnostics(current.diagnostics, [
      runtimeDiagnostic,
      'opencode_bootstrap_stalled',
    ]);
  }
  if (
    current.agentToolAccepted === true &&
    !current.bootstrapConfirmed &&
    !current.runtimeAlive &&
    !current.hardFailure &&
    current.bootstrapStalled !== true &&
    graceExpired
  ) {
    current.hardFailure = true;
    current.hardFailureReason =
      current.hardFailureReason ?? 'Teammate did not join within the launch grace window.';
  }
  current.launchState = deriveMemberLaunchState(current);
  current.lastEvaluatedAt = now;
  return {
    ...current,
    diagnostics: undefined,
  };
}
