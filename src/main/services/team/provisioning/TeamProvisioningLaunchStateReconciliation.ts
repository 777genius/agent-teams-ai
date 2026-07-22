import { getErrorMessage } from '@shared/utils/errorHandling';

import { createPersistedLaunchSnapshot } from '../TeamLaunchStateEvaluator';

import {
  isOpenCodeOverlayMemberRemoved,
  matchesObservedMemberNameForExpected,
  namesMatchCaseInsensitive,
} from './TeamProvisioningMemberIdentity';
import {
  filterStaleOpenCodeOverlayDiagnostics,
  hasRealOpenCodeLaunchDiagnostic,
  hasStaleOpenCodeDiagnostics,
  hasStaleOpenCodeSecondaryLaunchDiagnostic,
  isPersistedOpenCodeSecondaryLaneMember,
} from './TeamProvisioningOpenCodeDiagnosticsPolicy';
import {
  buildOpenCodeUncommittedBootstrapDiagnostic,
  downgradeUncommittedOpenCodeBootstrapEvidence,
  summarizeRuntimeLaunchResultMembers,
} from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';

import type {
  OpenCodeCommittedBootstrapSessionRecord,
  OpenCodeRuntimeLaneIndexEntry,
} from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import type { TeamRuntimeLaunchResult } from '../runtime/TeamRuntimeAdapter';
import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
} from '@shared/types';

export type OpenCodeSecondaryEvidenceOverlayDecision =
  | { kind: 'blocked' | 'none' | 'ambiguous' | 'conflict'; diagnostics: string[] }
  | { kind: 'confirmed_bootstrap'; session: OpenCodeCommittedBootstrapSessionRecord };

export interface OpenCodeSecondaryEvidenceOverlayPorts {
  readLaneIndex(
    teamName: string
  ): Promise<{ lanes: Record<string, OpenCodeRuntimeLaneIndexEntry> } | null>;
  readCommittedBootstrapSessionEvidence(input: { teamName: string; laneId: string }): Promise<{
    committed: boolean;
    activeRunId: string | null;
    sessions: OpenCodeCommittedBootstrapSessionRecord[];
    diagnostics: string[];
  }>;
  hasBootstrapCheckinTombstone(input: {
    teamName: string;
    laneId: string;
    runId: string;
  }): Promise<boolean>;
  nowIso(): string;
}

export interface OpenCodeSecondaryEvidenceOverlayParams {
  teamName: string;
  snapshot: PersistedTeamLaunchSnapshot;
  previousSnapshot?: PersistedTeamLaunchSnapshot | null;
  metaMembers?: readonly { name?: string; removedAt?: unknown }[];
}

export interface OpenCodeSecondaryEvidenceOverlayClassifyParams {
  teamName: string;
  memberName: string;
  current: PersistedTeamLaunchMemberState;
  previous: PersistedTeamLaunchMemberState | null;
  laneEntry: OpenCodeRuntimeLaneIndexEntry | null;
  metaMembers: readonly { name?: string; removedAt?: unknown }[];
  activeRunId: string | null;
  sessions: OpenCodeCommittedBootstrapSessionRecord[];
  diagnostics: readonly string[];
}

function hasActiveOpenCodeOverlayMetaMember(
  metaMembers: readonly { name?: string; removedAt?: unknown }[],
  memberName: string
): boolean {
  return metaMembers.some(
    (member) =>
      typeof member.name === 'string' &&
      namesMatchCaseInsensitive(member.name, memberName) &&
      member.removedAt == null
  );
}

function normalizeOverlayRunId(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

export interface GuardCommittedOpenCodeSecondaryLaneEvidencePorts {
  commitOpenCodeRuntimeAdapterLaunchSessionEvidence(input: {
    teamName: string;
    laneId: string;
    result: TeamRuntimeLaunchResult;
  }): Promise<TeamRuntimeLaunchResult>;
  inspectOpenCodeRuntimeLaneStorage(input: { teamName: string; laneId: string }): Promise<{
    hasRuntimeEvidenceOnDisk: boolean;
    manifestEntryCount: number | null;
    manifestUpdatedAt: string | null;
    fileNames: string[];
  }>;
  upsertOpenCodeRuntimeLaneIndexEntry(input: {
    teamName: string;
    laneId: string;
    state: 'active';
    diagnostics: string[];
  }): Promise<void>;
  logWarn(message: string): void;
}

export interface FinalizeMissingRegisteredMembersRunLike {
  teamName: string;
  expectedMembers?: readonly string[];
  memberSpawnStatuses: ReadonlyMap<string, MemberSpawnStatusEntry>;
  pendingMemberRestarts?: { has(memberName: string): boolean };
}

export interface FinalizeMissingRegisteredMembersPorts<
  TRun extends FinalizeMissingRegisteredMembersRunLike,
> {
  getRegisteredTeamMemberNames(teamName: string): Promise<ReadonlySet<string> | null>;
  isMemberLifecycleOperationActive(teamName: string, memberName: string): boolean;
  setMemberSpawnStatus(run: TRun, memberName: string, status: 'error', error: string): void;
}

function hasRegisteredRuntimeName(
  registeredNames: ReadonlySet<string>,
  expectedMemberName: string
): boolean {
  for (const registeredName of registeredNames) {
    if (matchesObservedMemberNameForExpected(registeredName, expectedMemberName)) {
      return true;
    }
  }
  return false;
}

export async function finalizeMissingRegisteredMembersAsFailed<
  TRun extends FinalizeMissingRegisteredMembersRunLike,
>(run: TRun, ports: FinalizeMissingRegisteredMembersPorts<TRun>): Promise<void> {
  if (!run.expectedMembers || run.expectedMembers.length === 0) return;
  const registeredNames = await ports.getRegisteredTeamMemberNames(run.teamName);
  if (!registeredNames) {
    return;
  }

  for (const expected of run.expectedMembers) {
    if (hasRegisteredRuntimeName(registeredNames, expected)) {
      continue;
    }
    if (ports.isMemberLifecycleOperationActive(run.teamName, expected)) {
      continue;
    }
    if (run.pendingMemberRestarts?.has(expected) === true) {
      continue;
    }

    const current = run.memberSpawnStatuses.get(expected);
    if (
      current?.launchState === 'failed_to_start' ||
      current?.launchState === 'skipped_for_launch' ||
      current?.skippedForLaunch === true ||
      current?.bootstrapConfirmed ||
      current?.runtimeAlive
    ) {
      continue;
    }

    ports.setMemberSpawnStatus(
      run,
      expected,
      'error',
      'Teammate was not registered in config.json during launch. Persistent spawn failed.'
    );
  }
}

export function hasCommittedOpenCodeSecondaryEvidenceOverlayDelta(
  snapshot: PersistedTeamLaunchSnapshot | null,
  previousSnapshot: PersistedTeamLaunchSnapshot | null
): boolean {
  if (!snapshot) {
    return false;
  }
  return Object.entries(snapshot.members).some(([memberName, member]) => {
    if (!member.diagnostics?.includes('opencode_bootstrap_evidence_committed')) {
      return false;
    }
    const previous = previousSnapshot?.members[memberName];
    return (
      previous?.launchState !== member.launchState ||
      previous?.bootstrapConfirmed !== member.bootstrapConfirmed ||
      previous?.runtimeSessionId !== member.runtimeSessionId ||
      previous?.livenessKind !== member.livenessKind
    );
  });
}

export function collectOpenCodeSecondaryOverlayCandidates(
  snapshot: PersistedTeamLaunchSnapshot,
  previousSnapshot: PersistedTeamLaunchSnapshot | null
): string[] {
  const names = new Set<string>();
  const allNames = new Set([
    ...Object.keys(snapshot.members),
    ...Object.keys(previousSnapshot?.members ?? {}),
  ]);
  for (const memberName of allNames) {
    const current = snapshot.members[memberName];
    const previous = previousSnapshot?.members[memberName];
    const candidate = current ?? previous;
    if (!isPersistedOpenCodeSecondaryLaneMember(candidate)) {
      continue;
    }
    if (!current || needsOpenCodeSecondaryEvidenceOverlay(current, previous ?? null)) {
      names.add(memberName);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

export function needsOpenCodeSecondaryEvidenceOverlay(
  current: PersistedTeamLaunchMemberState,
  previous: PersistedTeamLaunchMemberState | null
): boolean {
  if (current.launchState === 'confirmed_alive' && current.bootstrapConfirmed) {
    return (
      current.livenessKind !== 'confirmed_bootstrap' && current.livenessKind !== 'runtime_process'
    );
  }
  if (
    previous?.launchState === 'confirmed_alive' &&
    previous.bootstrapConfirmed &&
    current.launchState !== 'confirmed_alive'
  ) {
    return true;
  }
  if (
    current.launchState === 'starting' ||
    current.launchState === 'runtime_pending_bootstrap' ||
    current.launchState === 'runtime_pending_permission'
  ) {
    return true;
  }
  return (
    current.launchState === 'failed_to_start' && hasStaleOpenCodeSecondaryLaunchDiagnostic(current)
  );
}

export async function applyOpenCodeSecondaryEvidenceOverlay(
  params: OpenCodeSecondaryEvidenceOverlayParams,
  ports: OpenCodeSecondaryEvidenceOverlayPorts
): Promise<PersistedTeamLaunchSnapshot> {
  const candidates = collectOpenCodeSecondaryOverlayCandidates(
    params.snapshot,
    params.previousSnapshot ?? null
  );
  if (candidates.length === 0) {
    return params.snapshot;
  }

  const laneIndex = await ports.readLaneIndex(params.teamName).catch(() => null);
  let changed = false;
  const nextMembers: Record<string, PersistedTeamLaunchMemberState> = {
    ...params.snapshot.members,
  };
  const metaMembers = params.metaMembers ?? [];

  for (const memberName of candidates) {
    const current = nextMembers[memberName];
    const previous = params.previousSnapshot?.members[memberName] ?? null;
    const baseMember = current ?? previous;
    if (!baseMember || !isPersistedOpenCodeSecondaryLaneMember(baseMember)) {
      continue;
    }
    if (!current && !hasActiveOpenCodeOverlayMetaMember(metaMembers, memberName)) {
      continue;
    }
    const laneId = baseMember.laneId?.trim();
    if (!laneId) {
      continue;
    }
    const laneEntry = laneIndex?.lanes[laneId] ?? null;
    const evidence = await ports
      .readCommittedBootstrapSessionEvidence({
        teamName: params.teamName,
        laneId,
      })
      .catch((error: unknown) => ({
        committed: false,
        activeRunId: null,
        sessions: [],
        diagnostics: [
          `OpenCode committed bootstrap evidence read failed: ${getErrorMessage(error)}`,
        ],
      }));
    const decision = await classifyOpenCodeSecondaryEvidenceOverlay(
      {
        teamName: params.teamName,
        memberName,
        current: baseMember,
        previous,
        laneEntry,
        metaMembers,
        activeRunId: evidence.activeRunId,
        sessions: evidence.committed ? evidence.sessions : [],
        diagnostics: evidence.diagnostics,
      },
      ports
    );
    if (decision.kind !== 'confirmed_bootstrap') {
      continue;
    }
    const promoted = promoteOpenCodeSecondaryMemberFromCommittedBootstrapEvidence({
      current: baseMember,
      previous,
      session: decision.session,
      now: ports.nowIso(),
    });
    if (!current || JSON.stringify(promoted) !== JSON.stringify(current)) {
      nextMembers[memberName] = promoted;
      changed = true;
    }
  }

  if (!changed) {
    return params.snapshot;
  }

  return createPersistedLaunchSnapshot({
    teamName: params.snapshot.teamName,
    expectedMembers: params.snapshot.expectedMembers,
    bootstrapExpectedMembers: params.snapshot.bootstrapExpectedMembers,
    leadSessionId: params.snapshot.leadSessionId,
    launchPhase: params.snapshot.launchPhase,
    members: nextMembers,
    updatedAt: ports.nowIso(),
  });
}

export async function classifyOpenCodeSecondaryEvidenceOverlay(
  params: OpenCodeSecondaryEvidenceOverlayClassifyParams,
  ports: Pick<OpenCodeSecondaryEvidenceOverlayPorts, 'hasBootstrapCheckinTombstone'>
): Promise<OpenCodeSecondaryEvidenceOverlayDecision> {
  if (isOpenCodeOverlayMemberRemoved(params.metaMembers, params.memberName)) {
    return { kind: 'blocked', diagnostics: ['opencode_overlay_member_removed'] };
  }
  if (params.laneEntry?.state === 'stopped') {
    return { kind: 'blocked', diagnostics: ['opencode_overlay_lane_stopped'] };
  }
  if (hasRealOpenCodeLaunchDiagnostic(params.current)) {
    return { kind: 'blocked', diagnostics: ['opencode_overlay_real_failure_preserved'] };
  }
  if (
    params.current.launchState === 'failed_to_start' &&
    !hasStaleOpenCodeSecondaryLaunchDiagnostic(params.current)
  ) {
    return { kind: 'blocked', diagnostics: ['opencode_overlay_real_failure_preserved'] };
  }
  if (
    params.laneEntry?.state === 'degraded' &&
    !hasStaleOpenCodeSecondaryLaunchDiagnostic(params.current) &&
    !hasStaleOpenCodeDiagnostics(params.laneEntry.diagnostics)
  ) {
    return { kind: 'blocked', diagnostics: ['opencode_overlay_degraded_lane_preserved'] };
  }

  const memberSessions = params.sessions.filter((session) =>
    namesMatchCaseInsensitive(session.memberName, params.memberName)
  );
  if (memberSessions.length === 0) {
    return { kind: 'none', diagnostics: [...params.diagnostics, 'opencode_overlay_no_session'] };
  }

  const currentRunId = normalizeOverlayRunId(params.current.runtimeRunId);
  const previousRunId = normalizeOverlayRunId(params.previous?.runtimeRunId);
  const activeRunId = normalizeOverlayRunId(params.activeRunId);
  const currentSessionId = params.current.runtimeSessionId?.trim() ?? '';
  const previousSessionId = params.previous?.runtimeSessionId?.trim() ?? '';
  const canUsePreviousSessionId =
    previousSessionId.length > 0 &&
    (!currentRunId || !previousRunId || currentRunId === previousRunId);
  const expectedSessionId = currentSessionId || (canUsePreviousSessionId ? previousSessionId : '');
  const selected = expectedSessionId
    ? memberSessions.find((session) => session.id === expectedSessionId)
    : memberSessions.length === 1
      ? memberSessions[0]
      : null;
  if (!selected) {
    return {
      kind: expectedSessionId ? 'conflict' : 'ambiguous',
      diagnostics: [
        expectedSessionId
          ? 'opencode_overlay_session_conflict'
          : 'opencode_overlay_ambiguous_sessions',
      ],
    };
  }
  const selectedRunId = normalizeOverlayRunId(selected.runId);
  if (currentRunId && selectedRunId !== currentRunId) {
    return {
      kind: 'conflict',
      diagnostics: [
        selectedRunId
          ? 'opencode_overlay_current_run_mismatch'
          : 'opencode_overlay_session_run_missing',
      ],
    };
  }
  if (activeRunId && selectedRunId !== activeRunId) {
    return {
      kind: 'conflict',
      diagnostics: [
        selectedRunId
          ? 'opencode_overlay_session_run_mismatch'
          : 'opencode_overlay_session_run_missing',
      ],
    };
  }

  if (selectedRunId) {
    const tombstoned = await ports
      .hasBootstrapCheckinTombstone({
        teamName: params.teamName,
        laneId: params.current.laneId ?? '',
        runId: selectedRunId,
      })
      .catch(() => false);
    if (tombstoned) {
      return { kind: 'blocked', diagnostics: ['opencode_overlay_run_tombstoned'] };
    }
  }

  return { kind: 'confirmed_bootstrap', session: selected };
}

export function promoteOpenCodeSecondaryMemberFromCommittedBootstrapEvidence(input: {
  current: PersistedTeamLaunchMemberState;
  previous: PersistedTeamLaunchMemberState | null;
  session: OpenCodeCommittedBootstrapSessionRecord;
  now: string;
}): PersistedTeamLaunchMemberState {
  const observedAt = input.session.observedAt ?? input.now;
  const diagnostics = [
    ...new Set([
      ...filterStaleOpenCodeOverlayDiagnostics(input.current.diagnostics),
      'opencode_bootstrap_evidence_committed',
    ]),
  ];
  const runtimeAlive = true;
  const livenessKind =
    input.current.livenessKind === 'runtime_process' ||
    input.current.livenessKind === 'confirmed_bootstrap'
      ? input.current.livenessKind
      : 'confirmed_bootstrap';
  const sessionRunId = normalizeOverlayRunId(input.session.runId);
  return {
    ...input.previous,
    ...input.current,
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    bootstrapConfirmed: true,
    runtimeAlive,
    hardFailure: false,
    hardFailureReason: undefined,
    runtimeRunId: sessionRunId || input.current.runtimeRunId,
    runtimeSessionId: input.session.id,
    bootstrapEvidenceSource: input.session.source,
    bootstrapMode:
      input.session.source === 'app_managed_bootstrap'
        ? 'app_managed_context'
        : 'model_tool_checkin',
    appManagedBootstrapCandidate:
      input.session.source === 'app_managed_bootstrap'
        ? input.session.appManagedBootstrapCandidate
        : undefined,
    livenessKind,
    runtimeDiagnostic:
      input.session.source === 'app_managed_bootstrap'
        ? 'OpenCode app-managed bootstrap evidence committed.'
        : 'OpenCode bootstrap evidence committed.',
    runtimeDiagnosticSeverity: 'info',
    firstSpawnAcceptedAt:
      input.current.firstSpawnAcceptedAt ?? input.previous?.firstSpawnAcceptedAt ?? observedAt,
    lastHeartbeatAt: input.current.lastHeartbeatAt ?? input.previous?.lastHeartbeatAt ?? observedAt,
    runtimeLastSeenAt: runtimeAlive ? (input.current.runtimeLastSeenAt ?? observedAt) : undefined,
    lastRuntimeAliveAt: runtimeAlive
      ? (input.current.lastRuntimeAliveAt ?? input.previous?.lastRuntimeAliveAt ?? observedAt)
      : input.current.lastRuntimeAliveAt,
    lastEvaluatedAt: input.now,
    sources: {
      ...(input.previous?.sources ?? {}),
      ...(input.current.sources ?? {}),
      nativeHeartbeat: true,
      processAlive: runtimeAlive || undefined,
    },
    diagnostics,
  };
}

export async function guardCommittedOpenCodeSecondaryLaneEvidence(
  params: {
    teamName: string;
    laneId: string;
    result: TeamRuntimeLaunchResult;
    memberName: string;
  },
  ports: GuardCommittedOpenCodeSecondaryLaneEvidencePorts
): Promise<TeamRuntimeLaunchResult> {
  const memberEvidence = params.result.members[params.memberName];
  if (!memberEvidence) {
    return params.result;
  }

  const claimsBootstrapConfirmed =
    memberEvidence.launchState === 'confirmed_alive' ||
    memberEvidence.bootstrapConfirmed === true ||
    memberEvidence.livenessKind === 'confirmed_bootstrap';
  const runtimeSessionId = memberEvidence.sessionId?.trim();
  const appManagedCandidate =
    memberEvidence.bootstrapEvidenceSource === 'app_managed_bootstrap' &&
    memberEvidence.bootstrapMode === 'app_managed_context'
      ? memberEvidence.appManagedBootstrapCandidate
      : undefined;
  const appManagedCandidateMatches =
    appManagedCandidate?.source === 'app_managed_bootstrap' &&
    appManagedCandidate.teamName === params.teamName &&
    appManagedCandidate.memberName === params.memberName &&
    appManagedCandidate.runId === params.result.runId &&
    appManagedCandidate.laneId === params.laneId &&
    appManagedCandidate.runtimeSessionId === runtimeSessionId;
  if (!claimsBootstrapConfirmed && !appManagedCandidateMatches) {
    return params.result;
  }
  const committedResult = await ports.commitOpenCodeRuntimeAdapterLaunchSessionEvidence({
    teamName: params.teamName,
    laneId: params.laneId,
    result: params.result,
  });
  const committedMemberEvidence = committedResult.members[params.memberName] ?? memberEvidence;

  const storage = await ports.inspectOpenCodeRuntimeLaneStorage({
    teamName: params.teamName,
    laneId: params.laneId,
  });
  if (storage.hasRuntimeEvidenceOnDisk) {
    return committedResult;
  }
  if (!claimsBootstrapConfirmed) {
    return committedResult;
  }

  const diagnostics = buildOpenCodeUncommittedBootstrapDiagnostic(storage);
  const members = {
    ...committedResult.members,
    [params.memberName]: downgradeUncommittedOpenCodeBootstrapEvidence(
      committedMemberEvidence,
      diagnostics
    ),
  };
  await ports
    .upsertOpenCodeRuntimeLaneIndexEntry({
      teamName: params.teamName,
      laneId: params.laneId,
      state: 'active',
      diagnostics,
    })
    .catch((error: unknown) => {
      ports.logWarn(
        `[${params.teamName}] Failed to annotate OpenCode lane ${
          params.laneId
        } after uncommitted bootstrap evidence: ${getErrorMessage(error)}`
      );
    });

  const teamLaunchState = summarizeRuntimeLaunchResultMembers(members);
  return {
    ...params.result,
    launchPhase: teamLaunchState === 'clean_success' ? params.result.launchPhase : 'active',
    teamLaunchState,
    members,
    diagnostics: Array.from(new Set([...committedResult.diagnostics, ...diagnostics])),
  };
}
