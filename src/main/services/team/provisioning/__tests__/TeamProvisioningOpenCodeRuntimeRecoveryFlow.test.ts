import { describe, expect, it, vi } from 'vitest';

import {
  buildCommittedOpenCodeRecoveryDiagnostics,
  buildOpenCodeRecoveryMember,
  createOpenCodeRuntimeLaneIdResolutionPortsFromService,
  type OpenCodeRuntimeLaneIdResolutionServiceHost,
  type OpenCodeRuntimeLaneRecoveryPorts,
  planOpenCodeDeliveryWatchdogRuntimeRecovery,
  resolveOpenCodeRuntimeLaneId,
  selectCommittedOpenCodeRecoverySession,
  tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery,
} from '../TeamProvisioningOpenCodeRuntimeRecoveryFlow';

import type {
  OpenCodeCommittedBootstrapSessionEvidence,
  OpenCodeRuntimeLaneIndex,
} from '../../opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import type { TeamRuntimeMemberLaunchEvidence } from '../../runtime';
import type { PersistedTeamLaunchSnapshot, TeamMember } from '@shared/types';

function createLaneIndex(lanes: OpenCodeRuntimeLaneIndex['lanes']): OpenCodeRuntimeLaneIndex {
  return {
    version: 1,
    updatedAt: '2026-07-02T00:00:00.000Z',
    lanes,
  };
}

function createRecoverableEvidence(
  input: Partial<TeamRuntimeMemberLaunchEvidence> = {}
): TeamRuntimeMemberLaunchEvidence {
  return {
    memberName: 'Bob',
    providerId: 'opencode',
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    diagnostics: [],
    ...input,
  };
}

function createCommittedEvidence(
  input: Partial<OpenCodeCommittedBootstrapSessionEvidence> = {}
): OpenCodeCommittedBootstrapSessionEvidence {
  return {
    state: 'healthy',
    committed: true,
    activeRunId: 'run-active',
    diagnostics: [],
    sessions: [
      {
        id: 'session-1',
        teamName: 'team-a',
        memberName: 'Bob',
        laneId: 'secondary:opencode:bob',
        runId: 'run-session',
        observedAt: '2026-07-02T00:00:00.000Z',
        source: 'runtime_bootstrap_checkin',
      },
    ],
    ...input,
  };
}

function createPorts(
  input: Partial<OpenCodeRuntimeLaneRecoveryPorts> = {}
): OpenCodeRuntimeLaneRecoveryPorts {
  return {
    teamsBasePath: '/fake/teams',
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    canDeliverToOpenCodeRuntimeForTeam: vi.fn(() => true),
    canAttemptCommittedOpenCodeSessionRecovery: vi.fn(() => true),
    cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: vi.fn(),
    readLaunchState: vi.fn(async () => null),
    tryRecoverMissingOpenCodeSecondaryLaneFromRuntime: vi.fn(async () => null),
    tryRecoverActiveOpenCodeSecondaryLaneFromRuntime: vi.fn(async () =>
      createRecoverableEvidence({ diagnostics: ['runtime diagnostic'] })
    ),
    readOpenCodeMemberDirectory: vi.fn(async () => ({
      config: null,
      teamMeta: null,
      metaMembers: [],
    })),
    resolveOpenCodeMemberIdentityFromDirectory: vi.fn(() => ({
      ok: false as const,
      reason: 'opencode_recipient_unavailable' as const,
    })),
    readConfigForObservation: vi.fn(async () => null),
    readTeamMeta: vi.fn(async () => null),
    readMetaMembers: vi.fn(async () => []),
    readPersistedTeamProjectPath: vi.fn(() => null),
    isOpenCodeRuntimeLaneIndexActive: vi.fn(async () => true),
    readOpenCodeRuntimeLaneIndex: vi.fn(async () => createLaneIndex({})),
    readCommittedOpenCodeBootstrapSessionEvidence: vi.fn(async () =>
      createCommittedEvidence({ diagnostics: ['committed diagnostic'] })
    ),
    upsertOpenCodeRuntimeLaneIndexEntry: vi.fn(async () => undefined),
    setOpenCodeRuntimeActiveRunManifest: vi.fn(async () => undefined),
    ...input,
  };
}

describe('TeamProvisioningOpenCodeRuntimeRecoveryFlow', () => {
  it('builds OpenCode recovery members with meta values before config and persisted fallbacks', () => {
    const configMember: TeamMember = {
      name: 'bob',
      providerId: 'codex',
      model: 'config-model',
      role: 'config-role',
      workflow: 'config-workflow',
      effort: 'medium',
      cwd: '/config',
      isolation: 'worktree',
    };
    const metaMember: TeamMember = {
      name: 'Bob',
      model: 'meta-model',
      role: 'meta-role',
    };

    expect(
      buildOpenCodeRecoveryMember({
        canonicalMemberName: 'Bob',
        configMember,
        metaMember,
        persistedMember: {
          model: 'persisted-model',
          effort: 'high',
          cwd: '/persisted',
        },
      })
    ).toMatchObject({
      name: 'Bob',
      providerId: 'opencode',
      model: 'meta-model',
      role: 'meta-role',
      workflow: 'config-workflow',
      effort: 'medium',
      cwd: '/config',
      isolation: 'worktree',
    });
  });

  it('plans watchdog recovery without persisted runtime recovery when only committed sessions are allowed', () => {
    expect(
      planOpenCodeDeliveryWatchdogRuntimeRecovery({
        canDeliverToTeamRuntime: false,
        canAttemptCommittedSessionRecovery: true,
        allowCommittedSessionRecoveryWithoutTeamRuntime: true,
      })
    ).toEqual({
      proceed: true,
      recoverPersistedMembers: false,
      recoverCommittedSessions: true,
    });

    expect(
      planOpenCodeDeliveryWatchdogRuntimeRecovery({
        canDeliverToTeamRuntime: false,
        canAttemptCommittedSessionRecovery: false,
        allowCommittedSessionRecoveryWithoutTeamRuntime: true,
      })
    ).toEqual({ proceed: false, cleanupStoppedLanes: true });
  });

  it('selects committed recovery sessions case-insensitively and deduplicates diagnostics', () => {
    const evidence = createCommittedEvidence({
      diagnostics: ['committed diagnostic', 'runtime diagnostic'],
    });
    const runtimeEvidence = createRecoverableEvidence({
      diagnostics: ['runtime diagnostic', 'extra diagnostic'],
    });

    expect(selectCommittedOpenCodeRecoverySession(evidence, ' bob ')?.id).toBe('session-1');
    expect(
      buildCommittedOpenCodeRecoveryDiagnostics({
        committedSessionEvidence: evidence,
        runtimeEvidence,
      })
    ).toEqual([
      'Recovered missing OpenCode runtime lane index from committed session evidence.',
      'committed diagnostic',
      'runtime diagnostic',
      'extra diagnostic',
    ]);
  });

  it('recovers a missing lane index from committed session evidence and active runtime proof', async () => {
    const upsertOpenCodeRuntimeLaneIndexEntry = vi.fn(async () => undefined);
    const setOpenCodeRuntimeActiveRunManifest = vi.fn(async () => undefined);
    const ports = createPorts({
      upsertOpenCodeRuntimeLaneIndexEntry,
      setOpenCodeRuntimeActiveRunManifest,
    });

    await expect(
      tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(
        {
          teamName: 'team-a',
          laneId: 'secondary:opencode:bob',
          member: { name: 'Bob', providerId: 'opencode' },
          projectPath: '/project',
          previousLaunchState: null,
        },
        ports
      )
    ).resolves.toBe(true);

    expect(upsertOpenCodeRuntimeLaneIndexEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        state: 'active',
        diagnostics: [
          'Recovered missing OpenCode runtime lane index from committed session evidence.',
          'committed diagnostic',
          'runtime diagnostic',
        ],
      })
    );
    expect(setOpenCodeRuntimeActiveRunManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        runId: 'run-active',
      })
    );
  });

  it('does not recover committed session evidence over stopped or degraded lane entries', async () => {
    const ports = createPorts({
      readOpenCodeRuntimeLaneIndex: vi.fn(async () =>
        createLaneIndex({
          'secondary:opencode:bob': {
            laneId: 'secondary:opencode:bob',
            state: 'stopped',
            updatedAt: '2026-07-02T00:00:00.000Z',
          },
        })
      ),
    });

    await expect(
      tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(
        {
          teamName: 'team-a',
          laneId: 'secondary:opencode:bob',
          member: { name: 'Bob', providerId: 'opencode' },
          projectPath: '/project',
        },
        ports
      )
    ).resolves.toBe(false);
    expect(ports.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime).not.toHaveBeenCalled();
  });

  it('resolves runtime lane ids from primary, secondary, planned, persisted, then primary fallback', async () => {
    const snapshot = {
      members: {
        Bob: {
          name: 'Bob',
          laneOwnerProviderId: 'opencode',
          laneId: 'secondary:opencode:persisted-bob',
        },
      },
    } as unknown as PersistedTeamLaunchSnapshot;
    const ports = {
      getRuntimeAdapterRun: vi.fn((teamName: string) =>
        teamName === 'primary-team' ? { runId: 'run-primary', providerId: 'opencode' } : undefined
      ),
      getSecondaryRuntimeRuns: vi.fn((teamName: string) =>
        teamName === 'secondary-team'
          ? [{ runId: 'run-secondary', laneId: 'secondary:opencode:bob' }]
          : []
      ),
      getTrackedRunId: vi.fn((teamName: string) =>
        teamName === 'planned-team' ? 'tracked-run' : null
      ),
      getRun: vi.fn((runId: string) =>
        runId === 'tracked-run'
          ? {
              mixedSecondaryLanes: [
                { laneId: 'secondary:opencode:planned-bob', member: { name: 'Bob' } },
              ],
            }
          : null
      ),
      readLaunchState: vi.fn(async (teamName: string) =>
        teamName === 'persisted-team' ? snapshot : null
      ),
    };

    await expect(
      resolveOpenCodeRuntimeLaneId({ teamName: 'primary-team', runId: 'run-primary' }, ports)
    ).resolves.toBe('primary');
    await expect(
      resolveOpenCodeRuntimeLaneId({ teamName: 'secondary-team', runId: 'run-secondary' }, ports)
    ).resolves.toBe('secondary:opencode:bob');
    await expect(
      resolveOpenCodeRuntimeLaneId(
        {
          teamName: 'planned-team',
          runId: 'unknown',
          memberName: 'Bob',
        },
        ports
      )
    ).resolves.toBe('secondary:opencode:planned-bob');
    await expect(
      resolveOpenCodeRuntimeLaneId(
        {
          teamName: 'persisted-team',
          runId: 'unknown',
          memberName: 'Bob',
        },
        ports
      )
    ).resolves.toBe('secondary:opencode:persisted-bob');
    await expect(
      resolveOpenCodeRuntimeLaneId({ teamName: 'fallback-team', runId: 'unknown' }, ports)
    ).resolves.toBe('primary');
  });

  it('builds lane id resolution ports from service dependencies', async () => {
    const service: OpenCodeRuntimeLaneIdResolutionServiceHost = {
      runtimeAdapterRunByTeam: {
        get: vi.fn(() => ({ runId: 'run-primary', providerId: 'opencode' })),
      },
      getSecondaryRuntimeRuns: vi.fn(() => [{ runId: 'run-secondary', laneId: 'lane-secondary' }]),
      runTracking: {
        getTrackedRunId: vi.fn(() => 'tracked-run'),
      },
      runs: {
        get: vi.fn(() => ({ mixedSecondaryLanes: [] })),
      },
      launchStateStore: {
        read: vi.fn(async () => null),
      },
    };

    const ports = createOpenCodeRuntimeLaneIdResolutionPortsFromService(service);

    expect(ports.getRuntimeAdapterRun('team-a')).toEqual({
      runId: 'run-primary',
      providerId: 'opencode',
    });
    expect(ports.getSecondaryRuntimeRuns('team-a')).toEqual([
      { runId: 'run-secondary', laneId: 'lane-secondary' },
    ]);
    expect(ports.getTrackedRunId('team-a')).toBe('tracked-run');
    expect(ports.getRun('tracked-run')).toEqual({ mixedSecondaryLanes: [] });
    await expect(ports.readLaunchState('team-a')).resolves.toBeNull();

    expect(service.runtimeAdapterRunByTeam.get).toHaveBeenCalledWith('team-a');
    expect(service.getSecondaryRuntimeRuns).toHaveBeenCalledWith('team-a');
    expect(service.runTracking.getTrackedRunId).toHaveBeenCalledWith('team-a');
    expect(service.runs.get).toHaveBeenCalledWith('tracked-run');
    expect(service.launchStateStore.read).toHaveBeenCalledWith('team-a');
  });
});
