import {
  hasRealOpenCodeFailureDiagnostic,
  isPersistedOpenCodeSecondaryLaneMember,
  normalizeOpenCodePersistedFailureReason,
  OPENCODE_UNCOMMITTED_BOOTSTRAP_DIAGNOSTIC,
} from './TeamProvisioningOpenCodeDiagnosticsPolicy';

import type {
  TeamRuntimeLaunchResult,
  TeamRuntimeMemberLaunchEvidence,
} from '../runtime/TeamRuntimeAdapter';
import type {
  PersistedTeamLaunchMemberState,
  TeamAgentRuntimeEntry,
  TeamLaunchAggregateState,
} from '@shared/types';

export const MEMBER_BOOTSTRAP_STALL_MS = 5 * 60_000;
export const OPENCODE_APP_MANAGED_BOOTSTRAP_STALLED_DIAGNOSTIC =
  'OpenCode app-managed bootstrap evidence did not commit within 5 min.';
export const OPENCODE_BOOTSTRAP_PENDING_DIAGNOSTIC =
  'opencode_bootstrap_pending_after_materialized_session';
export const OPENCODE_APP_MANAGED_BOOTSTRAP_PENDING_DIAGNOSTIC =
  'OpenCode app-managed bootstrap evidence is pending after materialized session.';

const OPENCODE_MEMBER_SESSION_RECORDED_AT_PATTERN =
  /\bmember_session_recorded\s+at\s+([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+-]+Z?)\b/i;

export function formatOpenCodeLaneTimingMs(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${Math.max(0, Math.round(value))}ms`
    : 'n/a';
}

export function appendDiagnosticOnce(
  diagnostics: readonly string[],
  diagnostic: string | null
): string[] {
  if (!diagnostic || diagnostics.includes(diagnostic)) {
    return [...diagnostics];
  }
  return [...diagnostics, diagnostic];
}

export function buildOpenCodeSecondaryLaneTimingDiagnostic(lane: {
  member: { name: string };
  queuedAtMs?: number;
  launchStartedAtMs?: number;
  launchFinishedAtMs?: number;
}): string | null {
  if (
    typeof lane.queuedAtMs !== 'number' ||
    typeof lane.launchStartedAtMs !== 'number' ||
    typeof lane.launchFinishedAtMs !== 'number'
  ) {
    return null;
  }
  return [
    'OpenCode secondary lane timing:',
    `member=${lane.member.name}`,
    `queueWaitMs=${formatOpenCodeLaneTimingMs(lane.launchStartedAtMs - lane.queuedAtMs)}`,
    `launchMs=${formatOpenCodeLaneTimingMs(lane.launchFinishedAtMs - lane.launchStartedAtMs)}`,
    `totalMs=${formatOpenCodeLaneTimingMs(lane.launchFinishedAtMs - lane.queuedAtMs)}`,
  ].join(' ');
}

export function createUnexpectedMixedSecondaryLaneFailureResult(input: {
  runId: string;
  teamName: string;
  memberName: string;
  message: string;
}): TeamRuntimeLaunchResult {
  return {
    runId: input.runId,
    teamName: input.teamName,
    launchPhase: 'finished',
    teamLaunchState: 'partial_failure',
    members: {
      [input.memberName]: {
        memberName: input.memberName,
        providerId: 'opencode',
        launchState: 'failed_to_start',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: input.message,
        diagnostics: [input.message],
      },
    },
    warnings: [],
    diagnostics: [input.message],
  };
}

export function isExplicitLegacyOpenCodeBootstrap(
  value:
    | {
        bootstrapMode?: 'model_tool_checkin' | 'app_managed_context';
      }
    | undefined
    | null
): boolean {
  return value?.bootstrapMode === 'model_tool_checkin';
}

export function hasRecoverableOpenCodeBootstrapDiagnostic(diagnostics: readonly string[]): boolean {
  const text = diagnostics.join('\n').toLowerCase();
  if (!text) {
    return false;
  }
  if (hasRealOpenCodeFailureDiagnostic(text)) {
    return false;
  }
  return (
    text.includes('runtime_bootstrap_checkin') ||
    text.includes('member_briefing') ||
    text.includes('bootstrap mcp') ||
    text.includes('member_session_recorded') ||
    text.includes('not connected') ||
    text.includes('mcp not connected') ||
    text.includes('member_launch_reconcile_pending') ||
    text.includes('member_launch_preview_timeout')
  );
}

export function collectRuntimeLaunchFailureDiagnostics(
  result: TeamRuntimeLaunchResult,
  memberName: string
): string[] {
  const member = result.members[memberName];
  return [...(member?.diagnostics ?? []), member?.hardFailureReason, ...result.diagnostics].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  );
}

export function collectOpenCodeSecondaryLaneFailureDiagnostics(
  result: TeamRuntimeLaunchResult,
  memberName: string,
  prefixDiagnostics: readonly string[]
): string[] {
  const diagnostics = [
    ...prefixDiagnostics,
    ...collectRuntimeLaunchFailureDiagnostics(result, memberName),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return diagnostics.length > 0 ? diagnostics : ['OpenCode bridge reported member launch failure'];
}

export function isReconciliableOpenCodeUnknownOutcome(diagnostics: readonly string[]): boolean {
  return diagnostics.some((diagnostic) =>
    /outcome must be reconciled before retry/i.test(diagnostic)
  );
}

export function isDefinitiveOpenCodePreLaunchFailure(
  result: TeamRuntimeLaunchResult,
  memberName: string
): boolean {
  const member = result.members[memberName];
  if (!member) {
    return false;
  }
  const hardFailed = member.launchState === 'failed_to_start' || member.hardFailure === true;
  if (!hardFailed) {
    return false;
  }
  const runtimeMaterialized =
    member.agentToolAccepted ||
    member.runtimeAlive ||
    member.bootstrapConfirmed ||
    (typeof member.sessionId === 'string' && member.sessionId.trim().length > 0) ||
    (typeof member.runtimePid === 'number' &&
      Number.isFinite(member.runtimePid) &&
      member.runtimePid > 0);
  if (runtimeMaterialized) {
    return false;
  }
  return !isReconciliableOpenCodeUnknownOutcome(
    collectRuntimeLaunchFailureDiagnostics(result, memberName)
  );
}

export function isMaterializedOpenCodeSessionId(sessionId: unknown): boolean {
  if (typeof sessionId !== 'string') {
    return false;
  }
  const trimmed = sessionId.trim();
  return trimmed.length > 0 && !trimmed.toLowerCase().startsWith('failed:');
}

export function hasMaterializedOpenCodeRuntimeForBootstrap(
  member: TeamRuntimeMemberLaunchEvidence | undefined
): member is TeamRuntimeMemberLaunchEvidence {
  if (!member) {
    return false;
  }
  if (isMaterializedOpenCodeSessionId(member.sessionId)) {
    return true;
  }
  return (
    hasOpenCodeRuntimeLivenessMarker(member) &&
    typeof member.runtimePid === 'number' &&
    Number.isFinite(member.runtimePid) &&
    member.runtimePid > 0
  );
}

export function isRecoverableOpenCodeBootstrapPendingLaunchResult(
  result: TeamRuntimeLaunchResult,
  memberName: string
): boolean {
  const member = result.members[memberName];
  if (!hasMaterializedOpenCodeRuntimeForBootstrap(member)) {
    return false;
  }
  if (member.bootstrapConfirmed || member.launchState === 'confirmed_alive') {
    return false;
  }
  if ((member.pendingPermissionRequestIds?.length ?? 0) > 0) {
    return false;
  }
  return hasRecoverableOpenCodeBootstrapDiagnostic(
    collectRuntimeLaunchFailureDiagnostics(result, memberName)
  );
}

export function summarizeRuntimeLaunchResultMembers(
  members: Record<string, TeamRuntimeMemberLaunchEvidence>
): TeamLaunchAggregateState {
  const values = Object.values(members);
  if (
    values.some((member) => member.launchState === 'failed_to_start' || member.hardFailure === true)
  ) {
    return 'partial_failure';
  }
  if (values.length > 0 && values.every((member) => member.launchState === 'confirmed_alive')) {
    return 'clean_success';
  }
  return 'partial_pending';
}

export function normalizeRecoverableOpenCodeBootstrapPendingLaunchResult(
  result: TeamRuntimeLaunchResult,
  memberName: string,
  diagnostics: readonly string[]
): TeamRuntimeLaunchResult {
  const member = result.members[memberName];
  if (!member) {
    return result;
  }
  const memberDiagnostics = Array.from(
    new Set([
      ...(member.diagnostics ?? []),
      OPENCODE_BOOTSTRAP_PENDING_DIAGNOSTIC,
      isExplicitLegacyOpenCodeBootstrap(member)
        ? 'OpenCode runtime session materialized; waiting for runtime_bootstrap_checkin.'
        : OPENCODE_APP_MANAGED_BOOTSTRAP_PENDING_DIAGNOSTIC,
      ...diagnostics,
    ])
  );
  const normalizedMember: TeamRuntimeMemberLaunchEvidence = {
    ...member,
    launchState: 'runtime_pending_bootstrap',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: false,
    hardFailure: false,
    hardFailureReason: undefined,
    pendingPermissionRequestIds: undefined,
    livenessKind:
      member.livenessKind === 'confirmed_bootstrap'
        ? 'runtime_process'
        : (member.livenessKind ?? 'runtime_process'),
    runtimeDiagnostic:
      member.runtimeDiagnostic ??
      'OpenCode runtime process detected; waiting for bootstrap check-in.',
    runtimeDiagnosticSeverity: member.runtimeDiagnosticSeverity ?? 'info',
    diagnostics: memberDiagnostics,
  };
  const members = {
    ...result.members,
    [memberName]: normalizedMember,
  };
  const teamLaunchState = summarizeRuntimeLaunchResultMembers(members);
  return {
    ...result,
    launchPhase: teamLaunchState === 'clean_success' ? result.launchPhase : 'active',
    teamLaunchState,
    members,
    diagnostics: Array.from(new Set([...result.diagnostics, ...memberDiagnostics])),
  };
}

export function buildOpenCodeUncommittedBootstrapDiagnostic(storage: {
  manifestEntryCount: number | null;
  manifestUpdatedAt: string | null;
  fileNames: string[];
}): string[] {
  return [
    OPENCODE_UNCOMMITTED_BOOTSTRAP_DIAGNOSTIC,
    `OpenCode lane manifest entries: ${storage.manifestEntryCount ?? 0}`,
    ...(storage.manifestUpdatedAt
      ? [`OpenCode lane manifest updated at: ${storage.manifestUpdatedAt}`]
      : []),
    storage.fileNames.length > 0
      ? `OpenCode lane files: ${storage.fileNames.slice(0, 8).join(', ')}`
      : 'OpenCode lane files: none',
  ];
}

export function downgradeUncommittedOpenCodeBootstrapEvidence(
  evidence: TeamRuntimeMemberLaunchEvidence,
  diagnostics: readonly string[]
): TeamRuntimeMemberLaunchEvidence {
  const hasRuntimeHandle = hasOpenCodeRuntimeHandle(evidence);
  return {
    ...evidence,
    launchState: hasRuntimeHandle ? 'runtime_pending_bootstrap' : 'starting',
    agentToolAccepted: hasRuntimeHandle,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    hardFailureReason: undefined,
    livenessKind: hasRuntimeHandle
      ? evidence.livenessKind === 'confirmed_bootstrap'
        ? 'runtime_process_candidate'
        : (evidence.livenessKind ?? 'runtime_process_candidate')
      : 'registered_only',
    runtimeDiagnostic: hasRuntimeHandle
      ? 'OpenCode runtime handle is present, but bootstrap evidence was not committed.'
      : 'OpenCode bootstrap confirmation was not committed to lane runtime evidence.',
    runtimeDiagnosticSeverity: 'warning',
    diagnostics: Array.from(new Set([...evidence.diagnostics, ...diagnostics])),
  };
}

export function promoteCommittedOpenCodeAppManagedBootstrapEvidence(
  evidence: TeamRuntimeMemberLaunchEvidence
): TeamRuntimeMemberLaunchEvidence {
  return {
    ...evidence,
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    hardFailureReason: undefined,
    livenessKind: 'confirmed_bootstrap',
    runtimeDiagnostic:
      'OpenCode app-managed bootstrap evidence was committed and read back by the desktop app.',
    runtimeDiagnosticSeverity: 'info',
    diagnostics: appendDiagnosticOnce(
      evidence.diagnostics,
      'OpenCode app-managed bootstrap evidence committed and read back.'
    ),
  };
}

export function hasOpenCodeRuntimeHandle(
  value:
    | Pick<PersistedTeamLaunchMemberState, 'runtimePid' | 'runtimeSessionId' | 'livenessKind'>
    | Pick<TeamRuntimeMemberLaunchEvidence, 'runtimePid' | 'sessionId' | 'livenessKind'>
    | undefined
): boolean {
  if (!value) {
    return false;
  }
  const runtimePid =
    typeof value.runtimePid === 'number' &&
    Number.isFinite(value.runtimePid) &&
    value.runtimePid > 0;
  const runtimeSessionId = (value as { runtimeSessionId?: unknown }).runtimeSessionId;
  const runtimeEvidenceSessionId = (value as { sessionId?: unknown }).sessionId;
  const sessionId =
    isMaterializedOpenCodeSessionId(runtimeSessionId) ||
    isMaterializedOpenCodeSessionId(runtimeEvidenceSessionId);
  return runtimePid || sessionId;
}

export function hasOpenCodeRuntimeLivenessMarker(
  value: Pick<TeamRuntimeMemberLaunchEvidence, 'livenessKind'> | undefined
): boolean {
  return (
    value?.livenessKind === 'runtime_process' ||
    value?.livenessKind === 'runtime_process_candidate' ||
    value?.livenessKind === 'permission_blocked'
  );
}

export function hasOpenCodeRuntimeEntryHandle(
  value:
    | Pick<TeamAgentRuntimeEntry, 'pid' | 'runtimePid' | 'runtimeSessionId' | 'livenessKind'>
    | undefined
    | null
): boolean {
  if (!value) {
    return false;
  }
  const pid = typeof value.pid === 'number' && Number.isFinite(value.pid) && value.pid > 0;
  const runtimePid =
    typeof value.runtimePid === 'number' &&
    Number.isFinite(value.runtimePid) &&
    value.runtimePid > 0;
  const runtimeSessionId = isMaterializedOpenCodeSessionId(value.runtimeSessionId);
  return pid || runtimePid || runtimeSessionId || hasOpenCodeRuntimeLivenessMarker(value);
}

export function isRecoverablePersistedOpenCodeRuntimeCandidate(
  member: PersistedTeamLaunchMemberState | undefined | null
): boolean {
  if (!member || member.skippedForLaunch) {
    return false;
  }
  if (!isPersistedOpenCodeSecondaryLaneMember(member)) {
    return false;
  }
  const hasPendingPermission = (member.pendingPermissionRequestIds?.length ?? 0) > 0;
  return (
    member.agentToolAccepted === true && (hasOpenCodeRuntimeHandle(member) || hasPendingPermission)
  );
}

export function normalizeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function selectEarliestIsoTimestamp(values: readonly unknown[]): string | undefined {
  let selected: { value: string; timeMs: number } | null = null;
  for (const value of values) {
    const normalized = normalizeIsoTimestamp(value);
    if (!normalized) {
      continue;
    }
    const timeMs = Date.parse(normalized);
    if (!selected || timeMs < selected.timeMs) {
      selected = { value: normalized, timeMs };
    }
  }
  return selected?.value;
}

function extractOpenCodeMemberSessionRecordedAt(
  diagnostics: readonly string[] | undefined
): string[] {
  return (diagnostics ?? []).flatMap((diagnostic) => {
    const match = OPENCODE_MEMBER_SESSION_RECORDED_AT_PATTERN.exec(diagnostic);
    return match?.[1] ? [match[1]] : [];
  });
}

export function resolveOpenCodeBootstrapAcceptedAt(
  member: Pick<PersistedTeamLaunchMemberState, 'firstSpawnAcceptedAt' | 'diagnostics'>
): string | undefined {
  return selectEarliestIsoTimestamp([
    member.firstSpawnAcceptedAt,
    ...extractOpenCodeMemberSessionRecordedAt(member.diagnostics),
  ]);
}

function hasOpenCodeSecondaryFatalBootstrapDiagnostic(
  member: Pick<
    PersistedTeamLaunchMemberState,
    'diagnostics' | 'runtimeDiagnostic' | 'hardFailureReason'
  >
): boolean {
  const text = [member.runtimeDiagnostic, member.hardFailureReason, ...(member.diagnostics ?? [])]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n')
    .toLowerCase();
  return text.length > 0 && hasRealOpenCodeFailureDiagnostic(text);
}

export function selectOpenCodeSecondaryBootstrapStallDiagnostic(
  values: readonly unknown[]
): string | null {
  const normalizedValues = values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => normalizeOpenCodePersistedFailureReason(value))
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  const runtimeCheckinDiagnostic = normalizedValues.find((value) =>
    value.toLowerCase().includes('runtime_bootstrap_checkin')
  );
  if (runtimeCheckinDiagnostic) {
    return runtimeCheckinDiagnostic;
  }

  const memberBriefingDiagnostic = normalizedValues.find((value) =>
    value.toLowerCase().includes('member_briefing')
  );
  if (memberBriefingDiagnostic) {
    return `${memberBriefingDiagnostic}; runtime_bootstrap_checkin did not complete after 5 min.`;
  }

  return null;
}

export function getOpenCodeSecondaryBootstrapStallDiagnosticFromPersisted(
  member: PersistedTeamLaunchMemberState
): string {
  if (!isExplicitLegacyOpenCodeBootstrap(member)) {
    return OPENCODE_APP_MANAGED_BOOTSTRAP_STALLED_DIAGNOSTIC;
  }

  const selected = selectOpenCodeSecondaryBootstrapStallDiagnostic([
    member.runtimeDiagnostic,
    ...(member.diagnostics ?? []),
    member.hardFailureReason,
  ]);
  if (selected) {
    return selected;
  }

  return 'OpenCode bootstrap did not complete runtime_bootstrap_checkin after 5 min.';
}

export function shouldMarkPersistedOpenCodeBootstrapStalled(
  member: PersistedTeamLaunchMemberState,
  nowMs: number
): boolean {
  if (!isPersistedOpenCodeSecondaryLaneMember(member)) {
    return false;
  }
  if (
    member.launchState !== 'runtime_pending_bootstrap' ||
    member.bootstrapConfirmed === true ||
    member.hardFailure === true ||
    member.skippedForLaunch === true ||
    (member.pendingPermissionRequestIds?.length ?? 0) > 0
  ) {
    return false;
  }
  if (hasOpenCodeSecondaryFatalBootstrapDiagnostic(member)) {
    return false;
  }
  const acceptedAt = resolveOpenCodeBootstrapAcceptedAt(member);
  const acceptedAtMs = acceptedAt ? Date.parse(acceptedAt) : NaN;
  if (!Number.isFinite(acceptedAtMs) || nowMs - acceptedAtMs < MEMBER_BOOTSTRAP_STALL_MS) {
    return false;
  }
  return (
    hasOpenCodeRuntimeHandle(member) ||
    hasOpenCodeRuntimeLivenessMarker(member) ||
    hasRecoverableOpenCodeBootstrapDiagnostic(
      [member.runtimeDiagnostic, ...(member.diagnostics ?? [])].filter(
        (value): value is string => typeof value === 'string'
      )
    )
  );
}

export function isRecoverablePersistedOpenCodeTerminalRuntimeCandidate(
  member: PersistedTeamLaunchMemberState | undefined | null
): boolean {
  return (
    isRecoverablePersistedOpenCodeRuntimeCandidate(member) &&
    member?.launchState === 'failed_to_start' &&
    member.hardFailure === true &&
    hasOpenCodeRuntimeHandle(member)
  );
}

export function isRecoverableOpenCodeRuntimeEvidence(
  evidence: TeamRuntimeMemberLaunchEvidence | undefined | null
): evidence is TeamRuntimeMemberLaunchEvidence {
  if (!evidence) {
    return false;
  }
  return (
    evidence.runtimeAlive === true ||
    evidence.bootstrapConfirmed === true ||
    (evidence.pendingPermissionRequestIds?.length ?? 0) > 0 ||
    hasOpenCodeRuntimeHandle(evidence) ||
    (evidence.agentToolAccepted === true && hasOpenCodeRuntimeLivenessMarker(evidence))
  );
}

export function isBootstrapMemberEvidenceCurrentForMember(
  current: { firstSpawnAcceptedAt?: string; lastEvaluatedAt?: string },
  bootstrapMember: Pick<
    PersistedTeamLaunchMemberState,
    'firstSpawnAcceptedAt' | 'lastHeartbeatAt' | 'lastRuntimeAliveAt' | 'lastEvaluatedAt'
  >,
  evidenceKind: 'acceptance' | 'confirmation'
): boolean {
  const bootstrapFirstSpawnAcceptedMs = Date.parse(bootstrapMember.firstSpawnAcceptedAt ?? '');
  const bootstrapLastEvaluatedMs = Date.parse(bootstrapMember.lastEvaluatedAt ?? '');
  const hasDurableBootstrapSpawnAcceptedAt =
    Number.isFinite(bootstrapFirstSpawnAcceptedMs) &&
    (!Number.isFinite(bootstrapLastEvaluatedMs) ||
      bootstrapFirstSpawnAcceptedMs <= bootstrapLastEvaluatedMs);
  const evidenceAt =
    evidenceKind === 'confirmation'
      ? (bootstrapMember.lastHeartbeatAt ??
        bootstrapMember.lastRuntimeAliveAt ??
        bootstrapMember.lastEvaluatedAt)
      : hasDurableBootstrapSpawnAcceptedAt
        ? bootstrapMember.firstSpawnAcceptedAt
        : bootstrapMember.lastEvaluatedAt;
  const evidenceMs = Date.parse(evidenceAt ?? '');
  if (!Number.isFinite(evidenceMs)) {
    return false;
  }
  const firstSpawnAcceptedMs = Date.parse(current.firstSpawnAcceptedAt ?? '');
  const lastEvaluatedMs = Date.parse(current.lastEvaluatedAt ?? '');
  const hasDurableSpawnBoundary =
    Number.isFinite(firstSpawnAcceptedMs) &&
    (!Number.isFinite(lastEvaluatedMs) || firstSpawnAcceptedMs <= lastEvaluatedMs);
  const boundaryMs = hasDurableSpawnBoundary ? firstSpawnAcceptedMs : NaN;
  return !Number.isFinite(boundaryMs) || evidenceMs >= boundaryMs;
}
