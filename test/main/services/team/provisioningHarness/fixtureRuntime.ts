import { createPersistedLaunchSnapshot } from '@main/services/team/TeamLaunchStateEvaluator';

import {
  HARNESS_DEFAULT_NOW_ISO,
  HARNESS_DEFAULT_TEAM_NAME,
  HARNESS_INERT_MODEL,
  HARNESS_INERT_PROVIDER_BACKEND_ID,
} from './fixtureConstants';
import { assertNoSecretLikeFixtureValues } from './fixtureSecrets';
import { cloneFixture } from './harnessData';

import type { TeamRuntimeMemberLaunchEvidence } from '@main/services/team/runtime';
import type {
  MemberLaunchState,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchPhase,
  PersistedTeamLaunchSnapshot,
  TeamAgentRuntimeEntry,
  TeamAgentRuntimeSnapshot,
  TeamFastMode,
  TeamProviderBackendId,
} from '@shared/types';

export interface LaunchStateFixtureOptions {
  teamName?: string;
  expectedMembers?: readonly string[];
  bootstrapExpectedMembers?: readonly string[];
  includeLeadMembers?: boolean;
  leadSessionId?: string;
  launchPhase?: PersistedTeamLaunchPhase;
  members?: Record<string, PersistedTeamLaunchMemberState>;
  updatedAt?: string;
}

export function makeLaunchState(
  options: LaunchStateFixtureOptions = {}
): PersistedTeamLaunchSnapshot {
  const snapshot = createPersistedLaunchSnapshot({
    teamName: options.teamName ?? HARNESS_DEFAULT_TEAM_NAME,
    expectedMembers: options.expectedMembers ?? ['Builder'],
    bootstrapExpectedMembers: options.bootstrapExpectedMembers,
    includeLeadMembers: options.includeLeadMembers,
    leadSessionId: options.leadSessionId ?? 'harness-lead-session',
    launchPhase: options.launchPhase,
    members: cloneFixture(options.members),
    updatedAt: options.updatedAt ?? HARNESS_DEFAULT_NOW_ISO,
  });
  assertNoSecretLikeFixtureValues(snapshot);
  return cloneFixture(snapshot);
}

export interface RuntimeSnapshotFixtureOptions {
  teamName?: string;
  runId?: string | null;
  updatedAt?: string;
  providerBackendId?: TeamProviderBackendId;
  fastMode?: TeamFastMode;
  members?: Record<string, TeamAgentRuntimeEntry>;
}

export function makeRuntimeSnapshot(
  options: RuntimeSnapshotFixtureOptions = {}
): TeamAgentRuntimeSnapshot {
  const updatedAt = options.updatedAt ?? HARNESS_DEFAULT_NOW_ISO;
  const members = cloneFixture(
    options.members ??
      ({
        Builder: {
          memberName: 'Builder',
          alive: true,
          restartable: true,
          backendType: 'process',
          providerId: 'opencode',
          providerBackendId: 'opencode-cli',
          laneId: 'lane-builder',
          laneKind: 'secondary',
          runtimePid: 4242,
          livenessKind: 'confirmed_bootstrap',
          pidSource: 'runtime_bootstrap',
          updatedAt,
        },
      } satisfies Record<string, TeamAgentRuntimeEntry>)
  );
  const snapshot: TeamAgentRuntimeSnapshot = {
    teamName: options.teamName ?? HARNESS_DEFAULT_TEAM_NAME,
    updatedAt,
    runId: options.runId ?? 'harness-run-id',
    providerBackendId: options.providerBackendId ?? HARNESS_INERT_PROVIDER_BACKEND_ID,
    fastMode: options.fastMode ?? 'off',
    members,
  };
  assertNoSecretLikeFixtureValues(snapshot);
  return cloneFixture(snapshot);
}

export interface OpenCodeEvidenceFixtureOptions {
  memberName?: string;
  model?: string;
  launchState?: MemberLaunchState;
  agentToolAccepted?: boolean;
  runtimeAlive?: boolean;
  bootstrapConfirmed?: boolean;
  hardFailure?: boolean;
  hardFailureReason?: string;
  sessionId?: string;
  runtimePid?: number;
  diagnostics?: string[];
}

export function makeOpenCodeEvidence(
  options: OpenCodeEvidenceFixtureOptions = {}
): TeamRuntimeMemberLaunchEvidence {
  const launchState = options.launchState ?? 'confirmed_alive';
  const runtimeObservedByDefault =
    launchState === 'confirmed_alive' ||
    launchState === 'runtime_pending_bootstrap' ||
    launchState === 'runtime_pending_permission';
  const agentToolAccepted = options.agentToolAccepted ?? runtimeObservedByDefault;
  const runtimeAlive = options.runtimeAlive ?? launchState === 'confirmed_alive';
  const bootstrapConfirmed = options.bootstrapConfirmed ?? launchState === 'confirmed_alive';
  const hardFailure = options.hardFailure ?? launchState === 'failed_to_start';
  const sessionId =
    options.sessionId ?? (runtimeObservedByDefault ? 'harness-opencode-session' : undefined);
  const runtimePid = options.runtimePid ?? (runtimeObservedByDefault ? 4242 : undefined);
  const hasRuntimeHandle = sessionId !== undefined || runtimePid !== undefined;
  const livenessKind = bootstrapConfirmed
    ? 'confirmed_bootstrap'
    : launchState === 'runtime_pending_permission'
      ? 'permission_blocked'
      : runtimeAlive || agentToolAccepted || hasRuntimeHandle
        ? 'runtime_process_candidate'
        : 'registered_only';
  const evidence: TeamRuntimeMemberLaunchEvidence = {
    memberName: options.memberName ?? 'Builder',
    providerId: 'opencode',
    model: options.model ?? HARNESS_INERT_MODEL,
    launchState,
    agentToolAccepted,
    runtimeAlive,
    bootstrapConfirmed,
    hardFailure,
    ...(options.hardFailureReason ? { hardFailureReason: options.hardFailureReason } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(bootstrapConfirmed
      ? { bootstrapEvidenceSource: 'runtime_bootstrap_checkin' as const }
      : {}),
    ...(hasRuntimeHandle ? { backendType: 'process' as const } : {}),
    ...(runtimePid !== undefined ? { runtimePid } : {}),
    livenessKind,
    ...(runtimePid !== undefined
      ? {
          pidSource: bootstrapConfirmed
            ? ('runtime_bootstrap' as const)
            : ('opencode_bridge' as const),
        }
      : {}),
    diagnostics: cloneFixture(options.diagnostics ?? []),
  };
  assertNoSecretLikeFixtureValues(evidence);
  return cloneFixture(evidence);
}
