import { describe, expect, it } from 'vitest';

import {
  recoverStaleMixedSecondaryLaunchSnapshotWithPorts,
  type StaleMixedSecondaryRecoveryPorts,
} from '../TeamProvisioningStaleMixedSecondaryRecovery';

import type { OpenCodeRuntimeLaneIndex } from '../../opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import type { TeamRuntimeMemberLaunchEvidence } from '../../runtime/TeamRuntimeAdapter';
import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  TeamMember,
} from '@shared/types';

type AggregateParams = Parameters<
  StaleMixedSecondaryRecoveryPorts['buildAggregateLaunchSnapshot']
>[0];

const NOW = '2026-07-03T00:00:00.000Z';

function createSpawnStatus(input: Partial<MemberSpawnStatusEntry> = {}): MemberSpawnStatusEntry {
  return {
    status: 'waiting',
    launchState: 'starting',
    updatedAt: NOW,
    ...input,
  };
}

function createSnapshot(
  input: Partial<PersistedTeamLaunchSnapshot> = {}
): PersistedTeamLaunchSnapshot {
  const members = input.members ?? {};
  return {
    version: 2,
    teamName: input.teamName ?? 'team-a',
    updatedAt: input.updatedAt ?? NOW,
    leadSessionId: input.leadSessionId,
    launchPhase: input.launchPhase ?? 'active',
    expectedMembers: input.expectedMembers ?? Object.keys(members),
    members,
    summary: input.summary ?? {
      confirmedCount: 0,
      pendingCount: 0,
      failedCount: 0,
      runtimeAlivePendingCount: 0,
      shellOnlyPendingCount: 0,
      runtimeProcessPendingCount: 0,
      runtimeCandidatePendingCount: 0,
      noRuntimePendingCount: 0,
      permissionPendingCount: 0,
    },
    teamLaunchState: input.teamLaunchState ?? 'partial_pending',
  };
}

function createPersistedMember(
  input: Partial<PersistedTeamLaunchMemberState> = {}
): PersistedTeamLaunchMemberState {
  return {
    name: input.name ?? 'Bob',
    providerId: 'opencode',
    laneId: 'secondary:opencode:Bob',
    laneKind: 'secondary',
    laneOwnerProviderId: 'opencode',
    launchState: 'runtime_pending_bootstrap',
    agentToolAccepted: true,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    lastEvaluatedAt: NOW,
    diagnostics: [],
    ...input,
  };
}

function createRuntimeEvidence(
  input: Partial<TeamRuntimeMemberLaunchEvidence> = {}
): TeamRuntimeMemberLaunchEvidence {
  return {
    memberName: 'Bob',
    providerId: 'opencode',
    launchState: 'runtime_pending_bootstrap',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: false,
    hardFailure: false,
    runtimePid: 1234,
    sessionId: 'runtime-session-1',
    livenessKind: 'runtime_process',
    pidSource: 'opencode_bridge',
    diagnostics: ['runtime alive'],
    ...input,
  };
}

function createLaneIndex(lanes: OpenCodeRuntimeLaneIndex['lanes']): OpenCodeRuntimeLaneIndex {
  return {
    version: 1,
    updatedAt: NOW,
    lanes,
  };
}

function createPorts(input: Partial<StaleMixedSecondaryRecoveryPorts> = {}): {
  ports: StaleMixedSecondaryRecoveryPorts;
  getAggregateParams(): AggregateParams | null;
  getWrittenSnapshot(): PersistedTeamLaunchSnapshot | null;
} {
  let aggregateParams: AggregateParams | null = null;
  let writtenSnapshot: PersistedTeamLaunchSnapshot | null = null;
  const defaultMember: TeamMember = { name: 'Bob', providerId: 'opencode', cwd: '/repo-bob' };
  const ports: StaleMixedSecondaryRecoveryPorts = {
    hasMixedSecondaryLaunchMetadata: () => false,
    shouldRecoverStalePersistedMixedLaunchSnapshot: () => true,
    readTeamMeta: async () => ({ providerId: 'codex', fastMode: 'on' }),
    readMembersMeta: async () => ({
      providerBackendId: 'default',
      members: [{ name: 'Lead' }, defaultMember],
    }),
    readPersistedTeamProjectPath: () => '/repo',
    readOpenCodeRuntimeLaneIndex: async () =>
      createLaneIndex({
        'secondary:opencode:Bob': {
          laneId: 'secondary:opencode:Bob',
          state: 'active',
          updatedAt: NOW,
        },
      }),
    buildPlannedMemberLaneIdentity: ({ member }) =>
      member.providerId === 'opencode'
        ? {
            laneId: `secondary:opencode:${member.name}`,
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
          }
        : {
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'codex',
          },
    buildOpenCodeSecondaryLaneId: (member) => `secondary:opencode:${member.name}`,
    snapshotToMemberSpawnStatuses: () => ({}),
    createInitialMemberSpawnStatusEntry: () => createSpawnStatus(),
    isLeadMember: (member) => member.name === 'Lead',
    tryRecoverMissingOpenCodeSecondaryLaneFromRuntime: async () => null,
    tryRecoverActiveOpenCodeSecondaryLaneFromRuntime: async () => createRuntimeEvidence(),
    resolveCurrentOpenCodeRuntimeRunId: async () => 'resolved-run-id',
    recoverStaleOpenCodeRuntimeLaneIndexEntry: async () => ({
      stale: false,
      degraded: false,
      diagnostics: [],
    }),
    nowIso: () => NOW,
    getTeamsBasePath: () => '/teams',
    buildAggregateLaunchSnapshot: (params) => {
      aggregateParams = params;
      return createSnapshot({
        teamName: params.teamName,
        leadSessionId: params.leadSessionId,
        launchPhase: params.launchPhase,
      });
    },
    writeLaunchStateSnapshot: async (_teamName, snapshot) => {
      writtenSnapshot = snapshot;
      return snapshot;
    },
    ...input,
  };
  return {
    ports,
    getAggregateParams: () => aggregateParams,
    getWrittenSnapshot: () => writtenSnapshot,
  };
}

describe('recoverStaleMixedSecondaryLaunchSnapshotWithPorts', () => {
  it('projects active OpenCode lane runtime evidence into a recovered aggregate snapshot', async () => {
    const persistedSnapshot = createSnapshot({
      leadSessionId: 'lead-session',
      members: {
        Bob: createPersistedMember({
          runtimeRunId: 'persisted-run-id',
          firstSpawnAcceptedAt: '2026-07-03T00:01:00.000Z',
        }),
      },
    });
    const { ports, getAggregateParams, getWrittenSnapshot } = createPorts();

    const result = await recoverStaleMixedSecondaryLaunchSnapshotWithPorts(
      'team-a',
      null,
      persistedSnapshot,
      ports
    );

    expect(result).toBe(getWrittenSnapshot());
    expect(getAggregateParams()).toMatchObject({
      teamName: 'team-a',
      leadSessionId: 'lead-session',
      launchPhase: 'active',
      leadDefaults: {
        providerId: 'codex',
        providerBackendId: null,
        selectedFastMode: 'on',
      },
      primaryMembers: [],
      primaryStatuses: {},
      secondaryMembers: [
        {
          laneId: 'secondary:opencode:Bob',
          runtimeRunId: 'resolved-run-id',
          member: { name: 'Bob', providerId: 'opencode' },
          evidence: {
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: false,
            hardFailure: false,
            runtimePid: 1234,
            sessionId: 'runtime-session-1',
            livenessKind: 'runtime_process',
            pidSource: 'opencode_bridge',
            firstSpawnAcceptedAt: '2026-07-03T00:01:00.000Z',
            diagnostics: ['runtime alive'],
          },
        },
      ],
    });
  });

  it('projects degraded lane-index entries as hard-failed secondary member evidence', async () => {
    const { ports, getAggregateParams, getWrittenSnapshot } = createPorts({
      readOpenCodeRuntimeLaneIndex: async () =>
        createLaneIndex({
          'secondary:opencode:Bob': {
            laneId: 'secondary:opencode:Bob',
            state: 'degraded',
            updatedAt: NOW,
            diagnostics: ['lane has no runtime evidence'],
          },
        }),
      tryRecoverActiveOpenCodeSecondaryLaneFromRuntime: async () => null,
    });

    const result = await recoverStaleMixedSecondaryLaunchSnapshotWithPorts(
      'team-a',
      null,
      null,
      ports
    );

    expect(result).toBe(getWrittenSnapshot());
    expect(getAggregateParams()?.secondaryMembers).toMatchObject([
      {
        laneId: 'secondary:opencode:Bob',
        member: { name: 'Bob', providerId: 'opencode' },
        evidence: {
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'lane has no runtime evidence',
          diagnostics: ['lane has no runtime evidence'],
        },
      },
    ]);
  });

  it('returns null when no runtime, degraded, or stale lane evidence is recovered', async () => {
    const { ports, getAggregateParams, getWrittenSnapshot } = createPorts({
      tryRecoverActiveOpenCodeSecondaryLaneFromRuntime: async () => null,
      recoverStaleOpenCodeRuntimeLaneIndexEntry: async () => ({
        stale: false,
        degraded: false,
        diagnostics: [],
      }),
    });

    const result = await recoverStaleMixedSecondaryLaunchSnapshotWithPorts(
      'team-a',
      null,
      null,
      ports
    );

    expect(result).toBeNull();
    expect(getAggregateParams()).toBeNull();
    expect(getWrittenSnapshot()).toBeNull();
  });
});
