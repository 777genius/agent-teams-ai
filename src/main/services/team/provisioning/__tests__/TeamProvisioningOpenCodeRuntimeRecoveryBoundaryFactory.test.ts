import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningOpenCodeRuntimeRecoveryBoundary,
  type TeamProvisioningOpenCodeRuntimeRecoveryBoundaryPorts,
} from '../TeamProvisioningOpenCodeRuntimeRecoveryBoundaryFactory';

import type { OpenCodeRuntimeLaneIndex } from '../../opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import type { TeamLaunchRuntimeAdapter, TeamRuntimeMemberLaunchEvidence } from '../../runtime';
import type { PersistedTeamLaunchMemberState, TeamMember } from '@shared/types';

function createLaneIndex(lanes: OpenCodeRuntimeLaneIndex['lanes']): OpenCodeRuntimeLaneIndex {
  return {
    version: 1,
    updatedAt: '2026-07-02T00:00:00.000Z',
    lanes,
  };
}

function createRuntimeEvidence(
  input: Partial<TeamRuntimeMemberLaunchEvidence> = {}
): TeamRuntimeMemberLaunchEvidence {
  return {
    memberName: 'Bob',
    providerId: 'opencode',
    launchState: 'ready',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    diagnostics: [],
    ...input,
  };
}

function createPersistedMember(
  input: Partial<PersistedTeamLaunchMemberState> = {}
): PersistedTeamLaunchMemberState {
  return {
    name: 'Bob',
    providerId: 'opencode',
    laneId: 'secondary:opencode:bob',
    laneKind: 'secondary',
    laneOwnerProviderId: 'opencode',
    launchState: 'ready',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    runtimePid: 1234,
    runtimeRunId: 'run-persisted',
    lastEvaluatedAt: '2026-07-02T00:00:00.000Z',
    ...input,
  };
}

function createAdapter(
  evidence: TeamRuntimeMemberLaunchEvidence = createRuntimeEvidence()
): TeamLaunchRuntimeAdapter {
  return {
    providerId: 'opencode',
    prepare: vi.fn(),
    launch: vi.fn(),
    reconcile: vi.fn(async (input) => ({
      runId: input.runId,
      teamName: input.teamName,
      launchPhase: 'active',
      teamLaunchState: 'clean_success',
      members: {
        Bob: evidence,
      },
      snapshot: null,
      warnings: [],
      diagnostics: [],
    })) as TeamLaunchRuntimeAdapter['reconcile'],
    stop: vi.fn(),
  };
}

function createPorts(
  input: Partial<TeamProvisioningOpenCodeRuntimeRecoveryBoundaryPorts> = {}
): TeamProvisioningOpenCodeRuntimeRecoveryBoundaryPorts {
  return {
    teamsBasePath: '/fake/teams',
    logger: {
      warn: vi.fn(),
    },
    getOpenCodeRuntimeAdapter: vi.fn(() => createAdapter()),
    createRunId: vi.fn(() => 'run-recovery'),
    readOpenCodeRuntimeLaneIndex: vi.fn(async () => createLaneIndex({})),
    upsertOpenCodeRuntimeLaneIndexEntry: vi.fn(async () => undefined),
    setOpenCodeRuntimeActiveRunManifest: vi.fn(async () => undefined),
    getErrorMessage: vi.fn((error) => (error instanceof Error ? error.message : String(error))),
    ...input,
  };
}

describe('TeamProvisioningOpenCodeRuntimeRecoveryBoundaryFactory', () => {
  it('recovers active OpenCode secondary runtime evidence through the runtime adapter', async () => {
    const adapter = createAdapter(createRuntimeEvidence({ diagnostics: ['runtime diagnostic'] }));
    const ports = createPorts({
      getOpenCodeRuntimeAdapter: vi.fn(() => adapter),
    });
    const boundary = createTeamProvisioningOpenCodeRuntimeRecoveryBoundary(ports);
    const member: TeamMember = {
      name: 'Bob',
      role: 'Builder',
      workflow: 'implementation',
      providerId: 'opencode',
      model: 'model-a',
      effort: 'medium',
      cwd: ' /member/project ',
      isolation: 'worktree',
    };

    await expect(
      boundary.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime({
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        member,
        projectPath: '/project',
        previousLaunchState: null,
      })
    ).resolves.toMatchObject({
      memberName: 'Bob',
      diagnostics: ['runtime diagnostic'],
    });

    expect(adapter.reconcile).toHaveBeenCalledWith({
      runId: 'run-recovery',
      laneId: 'secondary:opencode:bob',
      teamName: 'team-a',
      providerId: 'opencode',
      expectedMembers: [
        {
          name: 'Bob',
          role: 'Builder',
          workflow: 'implementation',
          isolation: 'worktree',
          providerId: 'opencode',
          model: 'model-a',
          effort: 'medium',
          cwd: '/member/project',
        },
      ],
      previousLaunchState: null,
      reason: 'startup_recovery',
    });
  });

  it('does not call the runtime adapter without an adapter or runtime project path', async () => {
    const adapter = createAdapter();
    const withoutAdapter = createTeamProvisioningOpenCodeRuntimeRecoveryBoundary(
      createPorts({ getOpenCodeRuntimeAdapter: vi.fn(() => null) })
    );
    const withoutProject = createTeamProvisioningOpenCodeRuntimeRecoveryBoundary(
      createPorts({ getOpenCodeRuntimeAdapter: vi.fn(() => adapter) })
    );

    await expect(
      withoutAdapter.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime({
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        member: { name: 'Bob', providerId: 'opencode' },
        projectPath: '/project',
        previousLaunchState: null,
      })
    ).resolves.toBeNull();
    await expect(
      withoutProject.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime({
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        member: { name: 'Bob', providerId: 'opencode' },
        projectPath: null,
        previousLaunchState: null,
      })
    ).resolves.toBeNull();

    expect(adapter.reconcile).not.toHaveBeenCalled();
  });

  it('materializes a missing lane index from recoverable persisted and runtime evidence', async () => {
    const upsertOpenCodeRuntimeLaneIndexEntry = vi.fn(async () => undefined);
    const setOpenCodeRuntimeActiveRunManifest = vi.fn(async () => undefined);
    const ports = createPorts({
      getOpenCodeRuntimeAdapter: vi.fn(() =>
        createAdapter(
          createRuntimeEvidence({
            diagnostics: ['runtime diagnostic', 'runtime diagnostic'],
          })
        )
      ),
      upsertOpenCodeRuntimeLaneIndexEntry,
      setOpenCodeRuntimeActiveRunManifest,
    });
    const boundary = createTeamProvisioningOpenCodeRuntimeRecoveryBoundary(ports);

    const result = await boundary.tryRecoverMissingOpenCodeSecondaryLaneFromRuntime({
      teamName: 'team-a',
      laneId: 'secondary:opencode:bob',
      member: { name: 'Bob', providerId: 'opencode' },
      projectPath: '/project',
      previousLaunchState: null,
      persistedMember: createPersistedMember(),
    });

    expect(result?.diagnostics).toEqual([
      'Recovered missing OpenCode runtime lane index from persisted runtime evidence.',
      'runtime diagnostic',
    ]);
    expect(upsertOpenCodeRuntimeLaneIndexEntry).toHaveBeenCalledWith({
      teamsBasePath: '/fake/teams',
      teamName: 'team-a',
      laneId: 'secondary:opencode:bob',
      state: 'active',
      diagnostics: [
        'Recovered missing OpenCode runtime lane index from persisted runtime evidence.',
        'runtime diagnostic',
      ],
    });
    expect(setOpenCodeRuntimeActiveRunManifest).toHaveBeenCalledWith({
      teamsBasePath: '/fake/teams',
      teamName: 'team-a',
      laneId: 'secondary:opencode:bob',
      runId: 'run-persisted',
    });
  });

  it('does not recover missing lanes over stopped or degraded lane index entries', async () => {
    const adapter = createAdapter();
    const ports = createPorts({
      getOpenCodeRuntimeAdapter: vi.fn(() => adapter),
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
    const boundary = createTeamProvisioningOpenCodeRuntimeRecoveryBoundary(ports);

    await expect(
      boundary.tryRecoverMissingOpenCodeSecondaryLaneFromRuntime({
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        member: { name: 'Bob', providerId: 'opencode' },
        projectPath: '/project',
        previousLaunchState: null,
        persistedMember: createPersistedMember(),
      })
    ).resolves.toBeNull();

    expect(adapter.reconcile).not.toHaveBeenCalled();
  });

  it('warns and continues when durable lane recovery writes fail', async () => {
    const logger = { warn: vi.fn() };
    const ports = createPorts({
      logger,
      upsertOpenCodeRuntimeLaneIndexEntry: vi.fn(async () => {
        throw new Error('lane write failed');
      }),
      setOpenCodeRuntimeActiveRunManifest: vi.fn(async () => {
        throw new Error('manifest write failed');
      }),
    });
    const boundary = createTeamProvisioningOpenCodeRuntimeRecoveryBoundary(ports);

    await expect(
      boundary.tryRecoverMissingOpenCodeSecondaryLaneFromRuntime({
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        member: { name: 'Bob', providerId: 'opencode' },
        projectPath: '/project',
        previousLaunchState: null,
        persistedMember: createPersistedMember(),
      })
    ).resolves.toMatchObject({ memberName: 'Bob' });

    expect(logger.warn).toHaveBeenCalledWith(
      '[team-a] Failed to recover missing OpenCode lane index secondary:opencode:bob: lane write failed'
    );
    expect(logger.warn).toHaveBeenCalledWith(
      '[team-a] Failed to materialize recovered OpenCode lane manifest secondary:opencode:bob: manifest write failed'
    );
  });
});
