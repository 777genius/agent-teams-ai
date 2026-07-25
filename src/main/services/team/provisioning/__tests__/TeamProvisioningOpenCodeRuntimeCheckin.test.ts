import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

import { RuntimeStaleEvidenceError } from '../../opencode/store/RuntimeRunTombstoneStore';
import { createPersistedLaunchSnapshot } from '../../TeamLaunchStateEvaluator';
import { createDefaultOpenCodeRuntimeBootstrapEvidencePorts } from '../TeamProvisioningOpenCodeBootstrapEvidence';
import {
  applyOpenCodeRuntimeBootstrapCheckinToTrackedRun,
  assertOpenCodeRuntimeEvidenceAccepted,
  assertOpenCodeRuntimeMemberCheckinAllowed,
  createOpenCodeRuntimeCheckinPorts,
  type OpenCodeRuntimeCheckinPorts,
  type OpenCodeRuntimeCheckinRun,
  recordOpenCodeRuntimeBootstrapCheckin,
  recordOpenCodeRuntimeHeartbeat,
  resolveOpenCodeRuntimeBootstrapCheckinIdempotency,
  updateOpenCodeRuntimeMemberLiveness,
} from '../TeamProvisioningOpenCodeRuntimeCheckin';

import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchSnapshot,
  TeamConfig,
  TeamCreateRequest,
} from '@shared/types';

type TestRun = OpenCodeRuntimeCheckinRun;

const observedAt = '2026-01-01T00:00:00.000Z';
const TEST_CWD = '/repo/project';
const TEST_TEAMS_BASE_PATH = '/workspace/teams';
const TEST_RESULTS_ROOT = join(process.cwd(), 'test-results');

function createSafeTempDir(prefix: string): string {
  mkdirSync(TEST_RESULTS_ROOT, { recursive: true });
  return mkdtempSync(join(TEST_RESULTS_ROOT, prefix));
}

function createDeferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function createRun(): TestRun {
  return {
    runId: 'run-1',
    teamName: 'Team',
    request: {
      teamName: 'Team',
      cwd: TEST_CWD,
      members: [],
    },
    effectiveMembers: [],
    processKilled: false,
    cancelRequested: false,
    mixedSecondaryLanes: [
      {
        laneId: 'secondary:opencode:alice',
        providerId: 'opencode',
        member: { name: 'Alice', model: 'opencode/gpt-5' } as TeamCreateRequest['members'][number],
        runId: null,
        state: 'launching',
        result: null,
        warnings: [],
        diagnostics: [],
      },
    ],
    memberSpawnStatuses: new Map<string, MemberSpawnStatusEntry>(),
    pendingMemberRestarts: new Map<string, unknown>([['Alice', {}]]),
  };
}

function createPorts(
  overrides: Partial<OpenCodeRuntimeCheckinPorts<TestRun>> = {}
): OpenCodeRuntimeCheckinPorts<TestRun> {
  const ports: OpenCodeRuntimeCheckinPorts<TestRun> = {
    teamsBasePath: TEST_TEAMS_BASE_PATH,
    resolveOpenCodeRuntimeLaneId: vi.fn(async () => 'secondary:opencode:alice'),
    resolveCurrentOpenCodeRuntimeRunId: vi.fn(async () => 'run-1'),
    readLaunchState: vi.fn(async () => null),
    writeLaunchState: vi.fn(async () => undefined),
    mutateLaunchState: vi.fn(async (_teamName, mutation) => mutation(null)),
    withTeamLock: vi.fn(async (_teamName, operation) => operation()),
    readConfigForStrictDecision: vi.fn(async () => null),
    readMetaMembers: vi.fn(async () => []),
    readPersistedRuntimeMembers: vi.fn(() => []),
    getTrackedRun: vi.fn(() => null),
    persistTrackedRunLaunchState: vi.fn(async () => undefined),
    invalidateRuntimeSnapshotCaches: vi.fn(),
    emitMemberSpawnChange: vi.fn(),
    emitRuntimeMemberSpawnChange: vi.fn(),
    emitTaskLogChange: vi.fn(),
    createOpenCodeRuntimeBootstrapEvidencePorts: vi.fn(
      () =>
        ({
          teamsBasePath: TEST_TEAMS_BASE_PATH,
        }) as ReturnType<
          OpenCodeRuntimeCheckinPorts<TestRun>['createOpenCodeRuntimeBootstrapEvidencePorts']
        >
    ),
    upsertOpenCodeTaskRecord: vi.fn(async () => 'created' as const),
    syncMemberTaskActivityForRuntimeTransition: vi.fn(),
    syncMemberLaunchGraceCheck: vi.fn(),
  };
  const merged = { ...ports, ...overrides };
  if (!overrides.mutateLaunchState) {
    merged.mutateLaunchState = vi.fn(async (teamName, mutation) => {
      const next = await mutation(await merged.readLaunchState(teamName));
      await merged.writeLaunchState(teamName, next);
      return next;
    });
  }
  return merged;
}

describe('TeamProvisioningOpenCodeRuntimeCheckin', () => {
  it('resolves bootstrap check-in idempotency from the launch state port', async () => {
    const snapshot = createPersistedLaunchSnapshot({
      teamName: 'Team',
      expectedMembers: ['Alice'],
      launchPhase: 'active',
      members: {
        Alice: {
          name: 'Alice',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          runtimeRunId: 'run-1',
          runtimeSessionId: 'session-1',
          lastEvaluatedAt: observedAt,
        },
      },
      updatedAt: observedAt,
    });

    const result = await resolveOpenCodeRuntimeBootstrapCheckinIdempotency(
      {
        teamName: 'Team',
        runId: 'run-1',
        memberName: 'Alice',
        runtimeSessionId: 'session-1',
      },
      { readLaunchState: vi.fn(async () => snapshot) }
    );

    expect(result.state).toBe('duplicate');
    expect(result.previousMember?.runtimeSessionId).toBe('session-1');
  });

  it('requires current team configuration and an active configured member', async () => {
    await expect(
      assertOpenCodeRuntimeMemberCheckinAllowed(
        { teamName: 'Team', memberName: 'Alice' },
        {
          readConfigForStrictDecision: vi.fn(
            async () =>
              ({
                name: 'Team',
                members: [{ name: 'Alice', providerId: 'opencode' }],
              }) as TeamConfig
          ),
          readMetaMembers: vi.fn(async () => []),
        }
      )
    ).resolves.toBeUndefined();

    await expect(
      assertOpenCodeRuntimeMemberCheckinAllowed(
        { teamName: 'Team', memberName: 'Removed' },
        {
          readConfigForStrictDecision: vi.fn(
            async () =>
              ({
                name: 'Team',
                members: [{ name: 'Removed', removedAt: Date.parse(observedAt) }],
              }) as TeamConfig
          ),
          readMetaMembers: vi.fn(async () => []),
        }
      )
    ).rejects.toBeInstanceOf(RuntimeStaleEvidenceError);

    await expect(
      assertOpenCodeRuntimeMemberCheckinAllowed(
        { teamName: 'Team', memberName: 'Unknown' },
        {
          readConfigForStrictDecision: vi.fn(
            async () => ({ name: 'Team', members: [] }) as TeamConfig
          ),
          readMetaMembers: vi.fn(async () => []),
        }
      )
    ).rejects.toBeInstanceOf(RuntimeStaleEvidenceError);

    await expect(
      assertOpenCodeRuntimeMemberCheckinAllowed(
        { teamName: 'Team', memberName: 'Alice' },
        {
          readConfigForStrictDecision: vi.fn(async () => null),
          readMetaMembers: vi.fn(async () => []),
        }
      )
    ).rejects.toThrow('team configuration is unavailable');
  });

  it.each([
    {
      caseName: 'without a previous member snapshot',
      previous: null,
    },
    {
      caseName: 'over an older-run member snapshot',
      previous: createPersistedLaunchSnapshot({
        teamName: 'Team',
        expectedMembers: ['Alice'],
        launchPhase: 'active',
        members: {
          Alice: {
            name: 'Alice',
            providerId: 'opencode',
            laneId: 'primary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
            runtimeRunId: 'run-older',
            runtimeSessionId: 'session-older',
            lastEvaluatedAt: observedAt,
          },
        },
        updatedAt: observedAt,
      }),
    },
  ])('rejects a configured non-OpenCode member $caseName', async ({ previous }) => {
    const teamsBasePath = createSafeTempDir('opencode-runtime-bootstrap-provider-');
    const ports = createPorts({
      teamsBasePath,
      resolveOpenCodeRuntimeLaneId: vi.fn(async () => 'primary'),
      resolveCurrentOpenCodeRuntimeRunId: vi.fn(async () => 'run-current'),
      readLaunchState: vi.fn(async () => previous),
      readConfigForStrictDecision: vi.fn(
        async () =>
          ({
            name: 'Team',
            members: [{ name: 'Alice', providerId: 'codex' }],
          }) as TeamConfig
      ),
    });

    try {
      await expect(
        recordOpenCodeRuntimeBootstrapCheckin(
          {
            teamName: 'Team',
            runId: 'run-current',
            memberName: 'Alice',
            runtimeSessionId: 'session-current',
            observedAt,
          },
          ports
        )
      ).rejects.toThrow('member is not owned by OpenCode');
      expect(ports.mutateLaunchState).not.toHaveBeenCalled();
      expect(ports.writeLaunchState).not.toHaveBeenCalled();
    } finally {
      rmSync(teamsBasePath, { recursive: true, force: true });
    }
  });

  it('accepts evidence only for the current runtime run', async () => {
    const teamsBasePath = createSafeTempDir('opencode-runtime-checkin-');
    try {
      await expect(
        assertOpenCodeRuntimeEvidenceAccepted(
          {
            teamName: 'Team',
            runId: 'run-1',
            laneId: 'secondary:opencode:alice',
            evidenceKind: 'heartbeat',
          },
          {
            teamsBasePath,
            resolveCurrentOpenCodeRuntimeRunId: vi.fn(async () => 'run-1'),
          }
        )
      ).resolves.toBeUndefined();

      await expect(
        assertOpenCodeRuntimeEvidenceAccepted(
          {
            teamName: 'Team',
            runId: 'stale-run',
            laneId: 'secondary:opencode:alice',
            evidenceKind: 'heartbeat',
          },
          {
            teamsBasePath,
            resolveCurrentOpenCodeRuntimeRunId: vi.fn(async () => 'run-1'),
          }
        )
      ).rejects.toMatchObject({ reason: 'run_mismatch' });
    } finally {
      rmSync(teamsBasePath, { recursive: true, force: true });
    }
  });

  it('rejects removed, wrong-member, and superseded heartbeat session evidence before mutation', async () => {
    const teamsBasePath = createSafeTempDir('opencode-runtime-heartbeat-identity-');
    const snapshot = createPersistedLaunchSnapshot({
      teamName: 'Team',
      expectedMembers: ['Alice', 'Bob', 'Removed'],
      launchPhase: 'active',
      members: {
        Alice: {
          name: 'Alice',
          providerId: 'opencode',
          laneId: 'primary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          runtimeRunId: 'run-1',
          runtimeSessionId: 'session-alice-current',
          lastEvaluatedAt: observedAt,
        },
        Bob: {
          name: 'Bob',
          providerId: 'opencode',
          laneId: 'primary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          runtimeRunId: 'run-1',
          runtimeSessionId: 'session-bob-current',
          lastEvaluatedAt: observedAt,
        },
        Removed: {
          name: 'Removed',
          providerId: 'opencode',
          laneId: 'primary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          runtimeRunId: 'run-1',
          runtimeSessionId: 'session-removed',
          lastEvaluatedAt: observedAt,
        },
      },
      updatedAt: observedAt,
    });
    const writeLaunchState = vi.fn(async () => undefined);
    const persistTrackedRunLaunchState = vi.fn(async () => undefined);
    const ports = createPorts({
      teamsBasePath,
      resolveOpenCodeRuntimeLaneId: vi.fn(async () => 'primary'),
      readLaunchState: vi.fn(async () => snapshot),
      readConfigForStrictDecision: vi.fn(
        async () =>
          ({
            name: 'Team',
            members: [
              { name: 'Alice', providerId: 'opencode' },
              { name: 'Bob', providerId: 'opencode' },
              { name: 'Removed', providerId: 'opencode', removedAt: Date.parse(observedAt) },
            ],
          }) as TeamConfig
      ),
      writeLaunchState,
      persistTrackedRunLaunchState,
    });

    try {
      await expect(
        recordOpenCodeRuntimeHeartbeat(
          {
            teamName: 'Team',
            runId: 'run-1',
            memberName: 'Removed',
            runtimeSessionId: 'session-removed',
            observedAt,
          },
          ports
        )
      ).rejects.toThrow('member has been removed');
      await expect(
        recordOpenCodeRuntimeHeartbeat(
          {
            teamName: 'Team',
            runId: 'run-1',
            memberName: 'Bob',
            runtimeSessionId: 'session-alice-current',
            observedAt,
          },
          ports
        )
      ).rejects.toThrow('member runtime session does not match');
      await expect(
        recordOpenCodeRuntimeHeartbeat(
          {
            teamName: 'Team',
            runId: 'run-1',
            memberName: 'Alice',
            runtimeSessionId: 'session-alice-superseded',
            observedAt,
          },
          ports
        )
      ).rejects.toThrow('member runtime session does not match');

      expect(writeLaunchState).not.toHaveBeenCalled();
      expect(persistTrackedRunLaunchState).not.toHaveBeenCalled();
      expect(ports.invalidateRuntimeSnapshotCaches).not.toHaveBeenCalled();
      expect(ports.emitMemberSpawnChange).not.toHaveBeenCalled();
      expect(ports.emitRuntimeMemberSpawnChange).not.toHaveBeenCalled();
    } finally {
      rmSync(teamsBasePath, { recursive: true, force: true });
    }
  });

  it('revalidates heartbeat identity against the snapshot owned by the serialized mutation', async () => {
    const teamsBasePath = createSafeTempDir('opencode-runtime-heartbeat-race-');
    const mutationEntered = createDeferred();
    const releaseMutation = createDeferred();
    const supersededSnapshot = createPersistedLaunchSnapshot({
      teamName: 'Team',
      expectedMembers: ['Alice'],
      launchPhase: 'active',
      members: {
        Alice: {
          name: 'Alice',
          providerId: 'opencode',
          laneId: 'primary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          runtimeRunId: 'run-1',
          runtimeSessionId: 'session-new-owner',
          lastEvaluatedAt: observedAt,
        },
      },
      updatedAt: observedAt,
    });
    const writeLaunchState = vi.fn(async () => undefined);
    const ports = createPorts({
      teamsBasePath,
      resolveOpenCodeRuntimeLaneId: vi.fn(async () => 'primary'),
      readConfigForStrictDecision: vi.fn(
        async () =>
          ({
            name: 'Team',
            members: [{ name: 'Alice', providerId: 'opencode' }],
          }) as TeamConfig
      ),
      writeLaunchState,
      mutateLaunchState: vi.fn(async (_teamName, mutation) => {
        mutationEntered.resolve();
        await releaseMutation.promise;
        return await mutation(supersededSnapshot);
      }),
    });

    try {
      const heartbeat = recordOpenCodeRuntimeHeartbeat(
        {
          teamName: 'Team',
          runId: 'run-1',
          memberName: 'Alice',
          runtimeSessionId: 'session-old-owner',
          observedAt,
        },
        ports
      );
      await mutationEntered.promise;
      releaseMutation.resolve();

      await expect(heartbeat).rejects.toThrow('member runtime session does not match');
      expect(writeLaunchState).not.toHaveBeenCalled();
      expect(ports.emitMemberSpawnChange).not.toHaveBeenCalled();
      expect(ports.emitRuntimeMemberSpawnChange).not.toHaveBeenCalled();
    } finally {
      rmSync(teamsBasePath, { recursive: true, force: true });
    }
  });

  it('rejects a same-run conflicting bootstrap session introduced during atomic mutation', async () => {
    const teamsBasePath = createSafeTempDir('opencode-runtime-bootstrap-race-');
    const mutationEntered = createDeferred();
    const releaseMutation = createDeferred();
    const snapshot = (runtimeSessionId: string): PersistedTeamLaunchSnapshot =>
      createPersistedLaunchSnapshot({
        teamName: 'Team',
        expectedMembers: ['Alice'],
        launchPhase: 'active',
        members: {
          Alice: {
            name: 'Alice',
            providerId: 'opencode',
            laneId: 'primary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
            runtimeRunId: 'run-1',
            runtimeSessionId,
            lastEvaluatedAt: observedAt,
          },
        },
        updatedAt: observedAt,
      });
    const supersedingSnapshot = snapshot('session-new-owner');
    const writeLaunchState = vi.fn(async () => undefined);
    const withTeamLock = vi.fn();
    const mutateLaunchState: OpenCodeRuntimeCheckinPorts<TestRun>['mutateLaunchState'] = async (
      _teamName,
      mutation
    ) => {
      mutationEntered.resolve();
      await releaseMutation.promise;
      return await mutation(supersedingSnapshot);
    };
    const ports = createPorts({
      teamsBasePath,
      resolveOpenCodeRuntimeLaneId: vi.fn(async () => 'primary'),
      readLaunchState: vi.fn(async () => null),
      readConfigForStrictDecision: vi.fn(
        async () =>
          ({
            name: 'Team',
            members: [{ name: 'Alice', providerId: 'opencode' }],
          }) as TeamConfig
      ),
      writeLaunchState,
      withTeamLock: async (teamName, operation) => {
        withTeamLock(teamName);
        return await operation();
      },
      mutateLaunchState,
      createOpenCodeRuntimeBootstrapEvidencePorts: vi.fn(() =>
        createDefaultOpenCodeRuntimeBootstrapEvidencePorts({ teamsBasePath })
      ),
    });

    try {
      const checkin = recordOpenCodeRuntimeBootstrapCheckin(
        {
          teamName: 'Team',
          runId: 'run-1',
          memberName: 'Alice',
          runtimeSessionId: 'session-old-owner',
          observedAt,
        },
        ports
      );
      await mutationEntered.promise;
      releaseMutation.resolve();

      await expect(checkin).rejects.toThrow('member runtime session does not match');
      expect(withTeamLock).toHaveBeenCalledWith('Team');
      expect(writeLaunchState).not.toHaveBeenCalled();
      expect(ports.emitMemberSpawnChange).not.toHaveBeenCalled();
      expect(ports.emitRuntimeMemberSpawnChange).not.toHaveBeenCalled();
    } finally {
      releaseMutation.resolve();
      rmSync(teamsBasePath, { recursive: true, force: true });
    }
  });

  it('accepts a first current bootstrap check-in without member state or over an older-run snapshot', async () => {
    const olderRunSnapshot = createPersistedLaunchSnapshot({
      teamName: 'Team',
      expectedMembers: ['Alice'],
      launchPhase: 'active',
      members: {
        Alice: {
          name: 'Alice',
          providerId: 'opencode',
          laneId: 'primary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          runtimeRunId: 'run-older',
          runtimeSessionId: 'session-older',
          lastEvaluatedAt: observedAt,
        },
      },
      updatedAt: observedAt,
    });

    for (const previous of [null, olderRunSnapshot]) {
      const teamsBasePath = createSafeTempDir('opencode-runtime-bootstrap-first-checkin-');
      const persistedSnapshots: PersistedTeamLaunchSnapshot[] = [];
      const mutateLaunchState: OpenCodeRuntimeCheckinPorts<TestRun>['mutateLaunchState'] = async (
        _teamName,
        mutation
      ) => {
        const next = await mutation(previous);
        persistedSnapshots.push(next);
        return next;
      };
      const ports = createPorts({
        teamsBasePath,
        resolveOpenCodeRuntimeLaneId: vi.fn(async () => 'primary'),
        resolveCurrentOpenCodeRuntimeRunId: vi.fn(async () => 'run-current'),
        readLaunchState: vi.fn(async () => previous),
        readConfigForStrictDecision: vi.fn(
          async () =>
            ({
              name: 'Team',
              members: [{ name: 'Alice', providerId: 'opencode' }],
            }) as TeamConfig
        ),
        mutateLaunchState,
        createOpenCodeRuntimeBootstrapEvidencePorts: vi.fn(() =>
          createDefaultOpenCodeRuntimeBootstrapEvidencePorts({ teamsBasePath })
        ),
      });

      try {
        await expect(
          recordOpenCodeRuntimeBootstrapCheckin(
            {
              teamName: 'Team',
              runId: 'run-current',
              memberName: 'Alice',
              runtimeSessionId: 'session-current',
              observedAt,
            },
            ports
          )
        ).resolves.toMatchObject({
          ok: true,
          state: 'accepted',
          runtimeSessionId: 'session-current',
        });
        expect(persistedSnapshots.at(-1)?.members.Alice).toMatchObject({
          runtimeRunId: 'run-current',
          runtimeSessionId: 'session-current',
        });
      } finally {
        rmSync(teamsBasePath, { recursive: true, force: true });
      }
    }
  });

  it('maps check-in port events onto team change events', () => {
    const emitTeamChange = vi.fn();
    const ports = createOpenCodeRuntimeCheckinPorts({
      ...createPorts(),
      emitTeamChange,
    });

    ports.emitRuntimeMemberSpawnChange({
      teamName: 'Team',
      runId: 'run-1',
      memberName: 'Alice',
    });
    ports.emitTaskLogChange({
      teamName: 'Team',
      runId: 'run-1',
      taskId: 'task-1',
      detail: 'opencode-runtime-task-event:started',
    });

    expect(emitTeamChange).toHaveBeenNthCalledWith(1, {
      type: 'member-spawn',
      teamName: 'Team',
      runId: 'run-1',
      detail: 'Alice',
    });
    expect(emitTeamChange).toHaveBeenNthCalledWith(2, {
      type: 'task-log-change',
      teamName: 'Team',
      runId: 'run-1',
      taskId: 'task-1',
      detail: 'opencode-runtime-task-event:started',
      taskSignalKind: 'log',
    });
  });

  it('applies tracked-run liveness and reports no material change for duplicate evidence', () => {
    const run = createRun();
    const ports = {
      getTrackedRun: vi.fn(() => run),
      syncMemberTaskActivityForRuntimeTransition: vi.fn(),
      syncMemberLaunchGraceCheck: vi.fn(),
    };

    const first = applyOpenCodeRuntimeBootstrapCheckinToTrackedRun(
      {
        teamName: 'Team',
        runId: 'run-1',
        memberName: 'Alice',
        runtimeSessionId: 'session-1',
        observedAt,
        diagnostics: ['accepted'],
        metadata: { runtimePid: 1234 },
        reason: 'OpenCode runtime bootstrap check-in accepted',
      },
      ports
    );

    expect(first?.changed).toBe(true);
    expect(run.mixedSecondaryLanes[0]?.state).toBe('finished');
    expect(run.mixedSecondaryLanes[0]?.result?.members.Alice?.sessionId).toBe('session-1');
    expect(run.memberSpawnStatuses.get('Alice')?.launchState).toBe('confirmed_alive');
    expect(run.pendingMemberRestarts?.has('Alice')).toBe(false);

    const second = applyOpenCodeRuntimeBootstrapCheckinToTrackedRun(
      {
        teamName: 'Team',
        runId: 'run-1',
        memberName: 'Alice',
        runtimeSessionId: 'session-1',
        observedAt,
        diagnostics: ['accepted'],
        metadata: { runtimePid: 1234 },
        reason: 'OpenCode runtime bootstrap check-in accepted',
      },
      ports
    );

    expect(second?.changed).toBe(false);
  });

  it('writes persisted liveness and emits a member spawn change for newly confirmed runtime identity', async () => {
    const writeLaunchState = vi.fn(
      async (_teamName: string, _snapshot: PersistedTeamLaunchSnapshot) => undefined
    );
    const emitRuntimeMemberSpawnChange = vi.fn();
    const ports = createPorts({
      writeLaunchState,
      emitRuntimeMemberSpawnChange,
      readPersistedRuntimeMembers: vi.fn(() => [{ name: 'Alice' }]),
    });

    await updateOpenCodeRuntimeMemberLiveness(
      {
        teamName: 'Team',
        runId: 'run-1',
        memberName: 'Alice',
        runtimeSessionId: 'session-1',
        observedAt,
        diagnostics: ['heartbeat-ok'],
        metadata: { runtimePid: 1234 },
        reason: 'OpenCode runtime heartbeat accepted',
      },
      ports
    );

    const snapshot = writeLaunchState.mock.calls[0]?.[1];
    expect(snapshot?.members.Alice?.launchState).toBe('confirmed_alive');
    expect(snapshot?.members.Alice?.runtimePid).toBe(1234);
    expect(emitRuntimeMemberSpawnChange).toHaveBeenCalledWith({
      teamName: 'Team',
      runId: 'run-1',
      memberName: 'Alice',
    });
  });
});
