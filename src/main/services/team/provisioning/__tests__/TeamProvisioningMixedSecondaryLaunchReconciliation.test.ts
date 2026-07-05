import { describe, expect, it } from 'vitest';

import {
  buildMixedSecondaryLaunchSnapshotForRun,
  hasMixedSecondaryLaunchReconcileHeartbeat,
  type MixedSecondaryLaunchReconcileLeadInboxMessage,
  type MixedSecondaryLaunchReconcileMessagePorts,
  type MixedSecondaryLaunchSnapshotPorts,
  type MixedSecondaryLaunchSnapshotRunLike,
  selectLatestMixedSecondaryLaunchReconcileMessage,
  shouldRecoverStalePersistedMixedLaunchSnapshot,
} from '../TeamProvisioningMixedSecondaryLaunchReconciliation';

import type { TeamRuntimeLaunchResult } from '../../runtime/TeamRuntimeAdapter';
import type { MixedSecondaryRuntimeLaneState } from '../TeamProvisioningSecondaryRuntimeRuns';
import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  TeamProvisioningMemberInput,
} from '@shared/types';

type SnapshotParams = Parameters<
  MixedSecondaryLaunchSnapshotPorts<MixedSecondaryLaunchSnapshotRunLike>['buildAggregateLaunchSnapshot']
>[0];

function createSpawnStatus(input: Partial<MemberSpawnStatusEntry> = {}): MemberSpawnStatusEntry {
  return {
    status: 'waiting',
    launchState: 'starting',
    updatedAt: '2026-07-02T00:00:00.000Z',
    ...input,
  };
}

function createSnapshot(params: SnapshotParams): PersistedTeamLaunchSnapshot {
  return {
    version: 2,
    teamName: params.teamName,
    updatedAt: '2026-07-02T00:00:00.000Z',
    leadSessionId: params.leadSessionId,
    launchPhase: params.launchPhase,
    expectedMembers: [],
    members: {},
    summary: {
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
    teamLaunchState: 'partial_pending',
  };
}

function createPersistedMember(
  input: Partial<PersistedTeamLaunchMemberState> = {}
): PersistedTeamLaunchMemberState {
  return {
    name: 'Bob',
    providerId: 'opencode',
    launchState: 'runtime_pending_bootstrap',
    agentToolAccepted: true,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    lastEvaluatedAt: '2026-07-02T00:00:00.000Z',
    ...input,
  };
}

function createPersistedSnapshot(input: {
  updatedAt?: string;
  teamLaunchState?: PersistedTeamLaunchSnapshot['teamLaunchState'];
  members?: Record<string, PersistedTeamLaunchMemberState>;
}): PersistedTeamLaunchSnapshot {
  return {
    version: 2,
    teamName: 'team-a',
    updatedAt: input.updatedAt ?? '2026-07-02T00:00:00.000Z',
    launchPhase: 'active',
    expectedMembers: Object.keys(input.members ?? {}),
    members: input.members ?? {},
    summary: {
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

const reconcilePorts: MixedSecondaryLaunchReconcileMessagePorts = {
  resolveExpectedLaunchMemberName: (expectedMembers, candidateName) =>
    expectedMembers.find((memberName) => memberName === candidateName) ?? null,
  isMeaningfulBootstrapCheckInMessage: (text) => text === 'meaningful-check-in',
};

function createPorts(): {
  ports: MixedSecondaryLaunchSnapshotPorts<MixedSecondaryLaunchSnapshotRunLike>;
  getCapturedParams(): SnapshotParams | null;
  getBuildRuntimeSpawnStatusRecordCalls(): number;
} {
  let capturedParams: SnapshotParams | null = null;
  let buildRuntimeSpawnStatusRecordCalls = 0;
  return {
    ports: {
      buildRuntimeSpawnStatusRecord: () => {
        buildRuntimeSpawnStatusRecordCalls += 1;
        return {
          Alice: createSpawnStatus({ launchState: 'confirmed_alive' }),
        };
      },
      buildAggregateLaunchSnapshot: (params) => {
        capturedParams = params;
        return createSnapshot(params);
      },
    },
    getCapturedParams: () => capturedParams,
    getBuildRuntimeSpawnStatusRecordCalls: () => buildRuntimeSpawnStatusRecordCalls,
  };
}

function createRun(input: {
  primaryMembers?: readonly TeamProvisioningMemberInput[];
  lanes?: readonly MixedSecondaryRuntimeLaneState[];
  memberSpawnStatuses?: ReadonlyMap<string, MemberSpawnStatusEntry>;
}): MixedSecondaryLaunchSnapshotRunLike {
  return {
    teamName: 'team-a',
    detectedSessionId: 'lead-session',
    request: {
      providerId: 'codex',
      fastMode: 'on',
    },
    effectiveMembers: input.primaryMembers ?? [{ name: 'Alice', providerId: 'codex' }],
    mixedSecondaryLanes: input.lanes,
    memberSpawnStatuses: input.memberSpawnStatuses ?? new Map(),
  };
}

function createLane(
  input: Partial<MixedSecondaryRuntimeLaneState> = {}
): MixedSecondaryRuntimeLaneState {
  return {
    laneId: 'secondary:opencode:bob',
    providerId: 'opencode',
    member: { name: 'Bob', providerId: 'opencode' },
    runId: 'lane-run-1',
    state: 'queued',
    result: null,
    warnings: [],
    diagnostics: [],
    ...input,
  };
}

describe('TeamProvisioningMixedSecondaryLaunchReconciliation', () => {
  it('skips snapshot construction when a run has no mixed secondary lanes', () => {
    const { ports, getCapturedParams, getBuildRuntimeSpawnStatusRecordCalls } = createPorts();

    const snapshot = buildMixedSecondaryLaunchSnapshotForRun(
      createRun({ lanes: [] }),
      'active',
      ports
    );

    expect(snapshot).toBeNull();
    expect(getCapturedParams()).toBeNull();
    expect(getBuildRuntimeSpawnStatusRecordCalls()).toBe(0);
  });

  it('maps secondary lane runtime evidence through explicit snapshot ports', () => {
    const { ports, getCapturedParams } = createPorts();
    const diagnostics = ['runtime diagnostic'];
    const result: TeamRuntimeLaunchResult = {
      runId: 'lane-run-1',
      teamName: 'team-a',
      launchPhase: 'finished',
      teamLaunchState: 'partial_pending',
      members: {
        Bob: {
          memberName: 'Bob',
          providerId: 'opencode',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          runtimePid: 123,
          sessionId: 'session-1',
          livenessKind: 'runtime_process',
          pidSource: 'opencode_bridge',
          runtimeDiagnostic: 'waiting for check-in',
          runtimeDiagnosticSeverity: 'warning',
          diagnostics,
        },
      },
      warnings: [],
      diagnostics: [],
    };
    const run = createRun({
      lanes: [
        createLane({
          state: 'finished',
          result,
          launchFinishedAtMs: Date.parse('2026-07-02T00:05:00.000Z'),
        }),
      ],
      memberSpawnStatuses: new Map([
        [
          'Bob',
          createSpawnStatus({
            firstSpawnAcceptedAt: '2026-07-02T00:01:00.000Z',
            bootstrapStalled: true,
          }),
        ],
      ]),
    });

    const snapshot = buildMixedSecondaryLaunchSnapshotForRun(run, 'active', ports);

    expect(snapshot?.teamName).toBe('team-a');
    const params = getCapturedParams();
    expect(params).toMatchObject({
      teamName: 'team-a',
      leadSessionId: 'lead-session',
      launchPhase: 'active',
      leadDefaults: {
        providerId: 'codex',
        providerBackendId: 'codex-native',
        selectedFastMode: 'on',
        resolvedFastMode: null,
        launchIdentity: null,
      },
      primaryStatuses: {
        Alice: expect.objectContaining({ launchState: 'confirmed_alive' }),
      },
    });
    expect(params?.secondaryMembers?.[0]).toMatchObject({
      laneId: 'secondary:opencode:bob',
      runtimeRunId: 'lane-run-1',
      member: { name: 'Bob', providerId: 'opencode' },
      evidence: {
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: false,
        hardFailure: false,
        runtimePid: 123,
        sessionId: 'session-1',
        livenessKind: 'runtime_process',
        pidSource: 'opencode_bridge',
        runtimeDiagnostic: 'waiting for check-in',
        runtimeDiagnosticSeverity: 'warning',
        bootstrapStalled: true,
        firstSpawnAcceptedAt: '2026-07-02T00:01:00.000Z',
        diagnostics,
      },
      pendingReason: undefined,
    });
    expect(params?.secondaryMembers?.[0]?.leadDefaults).toBe(params?.leadDefaults);
  });

  it('preserves queued and missing-evidence lane policy without touching persistence', () => {
    const { ports, getCapturedParams } = createPorts();
    const queuedRun = createRun({
      lanes: [createLane({ state: 'queued', runId: null })],
    });

    buildMixedSecondaryLaunchSnapshotForRun(queuedRun, 'active', ports);

    expect(getCapturedParams()?.secondaryMembers?.[0]).toMatchObject({
      laneId: 'secondary:opencode:bob',
      runtimeRunId: null,
      evidence: null,
      pendingReason: 'Queued for OpenCode secondary lane launch.',
    });

    const { ports: finishedPorts, getCapturedParams: getFinishedParams } = createPorts();
    const finishedRun = createRun({
      lanes: [
        createLane({
          state: 'finished',
          result: null,
          diagnostics: [],
        }),
      ],
      memberSpawnStatuses: new Map([['Bob', createSpawnStatus({ bootstrapStalled: true })]]),
    });

    buildMixedSecondaryLaunchSnapshotForRun(finishedRun, 'finished', finishedPorts);

    expect(getFinishedParams()?.secondaryMembers?.[0]).toMatchObject({
      evidence: {
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        bootstrapStalled: true,
        diagnostics: [
          'OpenCode secondary lane finished without runtime evidence. Waiting for runtime reconciliation.',
        ],
      },
      pendingReason: undefined,
    });
  });

  it('detects launch reconcile heartbeats only for meaningful expected member messages at or after first spawn acceptance', () => {
    const snapshot = createPersistedSnapshot({
      members: {
        Bob: createPersistedMember({
          name: 'Bob',
          firstSpawnAcceptedAt: '2026-07-02T00:05:00.000Z',
        }),
      },
    });
    const beforeFirstSpawn: MixedSecondaryLaunchReconcileLeadInboxMessage = {
      from: 'Bob',
      text: 'meaningful-check-in',
      timestamp: '2026-07-02T00:04:59.000Z',
      messageId: 'before',
    };
    const ignoredMessages: MixedSecondaryLaunchReconcileLeadInboxMessage[] = [
      beforeFirstSpawn,
      {
        from: 'Bob',
        text: 'noise',
        timestamp: '2026-07-02T00:06:00.000Z',
        messageId: 'noise',
      },
      {
        from: 'Alice',
        text: 'meaningful-check-in',
        timestamp: '2026-07-02T00:06:00.000Z',
        messageId: 'unexpected',
      },
    ];

    expect(
      hasMixedSecondaryLaunchReconcileHeartbeat({
        snapshot,
        messages: ignoredMessages,
        expectedMembers: ['Bob'],
        ports: reconcilePorts,
      })
    ).toBe(false);

    expect(
      hasMixedSecondaryLaunchReconcileHeartbeat({
        snapshot,
        messages: [
          ...ignoredMessages,
          {
            from: 'Bob',
            text: 'meaningful-check-in',
            timestamp: '2026-07-02T00:05:00.000Z',
            messageId: 'at-boundary',
          },
        ],
        expectedMembers: ['Bob'],
        ports: reconcilePorts,
      })
    ).toBe(true);
  });

  it('selects the latest launch reconcile message by valid timestamp and message id tie-break', () => {
    const oldValid: MixedSecondaryLaunchReconcileLeadInboxMessage = {
      from: 'Bob',
      text: 'meaningful-check-in',
      timestamp: '2026-07-02T00:05:00.000Z',
      messageId: 'old-valid',
    };
    const newerValid: MixedSecondaryLaunchReconcileLeadInboxMessage = {
      from: 'Bob',
      text: 'meaningful-check-in',
      timestamp: '2026-07-02T00:06:00.000Z',
      messageId: 'new-valid',
    };
    const invalidTimestamp: MixedSecondaryLaunchReconcileLeadInboxMessage = {
      from: 'Bob',
      text: 'meaningful-check-in',
      timestamp: 'not-a-date',
      messageId: 'zz-invalid',
    };

    expect(
      selectLatestMixedSecondaryLaunchReconcileMessage({
        messages: [oldValid, newerValid],
        expectedMembers: ['Bob'],
        expected: 'Bob',
        ports: reconcilePorts,
      })
    ).toBe(newerValid);
    expect(
      selectLatestMixedSecondaryLaunchReconcileMessage({
        messages: [invalidTimestamp, oldValid],
        expectedMembers: ['Bob'],
        expected: 'Bob',
        ports: reconcilePorts,
      })
    ).toBe(oldValid);

    const tiedLowId: MixedSecondaryLaunchReconcileLeadInboxMessage = {
      from: 'Bob',
      text: 'meaningful-check-in',
      timestamp: 'not-a-date',
      messageId: 'a',
    };
    const tiedHighId: MixedSecondaryLaunchReconcileLeadInboxMessage = {
      from: 'Bob',
      text: 'meaningful-check-in',
      timestamp: 'not-a-date',
      messageId: 'b',
    };

    expect(
      selectLatestMixedSecondaryLaunchReconcileMessage({
        messages: [tiedLowId, tiedHighId],
        expectedMembers: ['Bob'],
        expected: 'Bob',
        ports: reconcilePorts,
      })
    ).toBe(tiedHighId);
  });

  it('recovers stale mixed snapshots with recoverable terminal OpenCode runtime candidates', () => {
    const recoverableMember = createPersistedMember({
      name: 'Bob',
      launchState: 'failed_to_start',
      hardFailure: true,
    });

    expect(
      shouldRecoverStalePersistedMixedLaunchSnapshot({
        snapshot: createPersistedSnapshot({
          teamLaunchState: 'clean_success',
          members: { Bob: recoverableMember },
        }),
        nowMs: Date.parse('2026-07-02T00:01:00.000Z'),
        graceMs: 120_000,
        isRecoverablePersistedOpenCodeTerminalRuntimeCandidate: (member) =>
          member === recoverableMember,
      })
    ).toBe(true);
  });

  it('does not recover partial pending snapshots younger than launch grace', () => {
    const snapshot = createPersistedSnapshot({
      updatedAt: '2026-07-02T00:00:00.000Z',
      members: {
        Bob: createPersistedMember({
          name: 'Bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          laneId: 'secondary:opencode:bob',
        }),
      },
    });

    expect(
      shouldRecoverStalePersistedMixedLaunchSnapshot({
        snapshot,
        nowMs: Date.parse('2026-07-02T00:01:59.999Z'),
        graceMs: 120_000,
        isRecoverablePersistedOpenCodeTerminalRuntimeCandidate: () => false,
      })
    ).toBe(false);
  });

  it('recovers stale partial pending secondary OpenCode lane members', () => {
    const snapshot = createPersistedSnapshot({
      updatedAt: '2026-07-02T00:00:00.000Z',
      members: {
        Bob: createPersistedMember({
          name: 'Bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          laneId: 'secondary:opencode:bob',
        }),
      },
    });

    expect(
      shouldRecoverStalePersistedMixedLaunchSnapshot({
        snapshot,
        nowMs: Date.parse('2026-07-02T00:02:00.000Z'),
        graceMs: 120_000,
        isRecoverablePersistedOpenCodeTerminalRuntimeCandidate: () => false,
      })
    ).toBe(true);
  });

  it('ignores confirmed and failed members during stale mixed snapshot recovery', () => {
    const snapshot = createPersistedSnapshot({
      updatedAt: '2026-07-02T00:00:00.000Z',
      members: {
        Bob: createPersistedMember({
          name: 'Bob',
          launchState: 'confirmed_alive',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          laneId: 'secondary:opencode:bob',
        }),
        Charlie: createPersistedMember({
          name: 'Charlie',
          launchState: 'failed_to_start',
          hardFailure: true,
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          laneId: 'secondary:opencode:charlie',
        }),
      },
    });

    expect(
      shouldRecoverStalePersistedMixedLaunchSnapshot({
        snapshot,
        nowMs: Date.parse('2026-07-02T00:02:00.000Z'),
        graceMs: 120_000,
        isRecoverablePersistedOpenCodeTerminalRuntimeCandidate: () => false,
      })
    ).toBe(false);
  });
});
