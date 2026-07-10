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
    members: options.members,
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
  const evidence: TeamRuntimeMemberLaunchEvidence = {
    memberName: options.memberName ?? 'Builder',
    providerId: 'opencode',
    model: options.model ?? HARNESS_INERT_MODEL,
    launchState: options.launchState ?? 'confirmed_alive',
    agentToolAccepted: options.agentToolAccepted ?? true,
    runtimeAlive: options.runtimeAlive ?? true,
    bootstrapConfirmed: options.bootstrapConfirmed ?? true,
    hardFailure: options.hardFailure ?? false,
    ...(options.hardFailureReason ? { hardFailureReason: options.hardFailureReason } : {}),
    sessionId: options.sessionId ?? 'harness-opencode-session',
    bootstrapEvidenceSource: 'runtime_bootstrap_checkin',
    backendType: 'process',
    runtimePid: options.runtimePid ?? 4242,
    livenessKind: 'confirmed_bootstrap',
    pidSource: 'runtime_bootstrap',
    diagnostics: cloneFixture(options.diagnostics ?? []),
  };
  assertNoSecretLikeFixtureValues(evidence);
  return cloneFixture(evidence);
}
