import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

import { RuntimeStaleEvidenceError } from '../../opencode/store/RuntimeRunTombstoneStore';
import { createPersistedLaunchSnapshot } from '../../TeamLaunchStateEvaluator';
import {
  applyOpenCodeRuntimeBootstrapCheckinToTrackedRun,
  assertOpenCodeRuntimeEvidenceAccepted,
  assertOpenCodeRuntimeMemberCheckinAllowed,
  createOpenCodeRuntimeCheckinPorts,
  type OpenCodeRuntimeCheckinPorts,
  type OpenCodeRuntimeCheckinRun,
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

function createRun(): TestRun {
  return {
    runId: 'run-1',
    teamName: 'Team',
    request: {
      teamName: 'Team',
      cwd: '/tmp/project',
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
  return {
    teamsBasePath: tmpdir(),
    resolveOpenCodeRuntimeLaneId: vi.fn(async () => 'secondary:opencode:alice'),
    resolveCurrentOpenCodeRuntimeRunId: vi.fn(async () => 'run-1'),
    readLaunchState: vi.fn(async () => null),
    writeLaunchState: vi.fn(async () => undefined),
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
          teamsBasePath: tmpdir(),
        }) as ReturnType<
          OpenCodeRuntimeCheckinPorts<TestRun>['createOpenCodeRuntimeBootstrapEvidencePorts']
        >
    ),
    upsertOpenCodeTaskRecord: vi.fn(async () => 'created' as const),
    syncMemberTaskActivityForRuntimeTransition: vi.fn(),
    syncMemberLaunchGraceCheck: vi.fn(),
    ...overrides,
  };
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

  it('allows configured check-ins and rejects removed or unknown members without previous state', async () => {
    await expect(
      assertOpenCodeRuntimeMemberCheckinAllowed(
        { teamName: 'Team', memberName: 'Alice' },
        {
          readConfigForStrictDecision: vi.fn(
            async () =>
              ({
                name: 'Team',
                members: [{ name: 'Alice' }],
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
  });

  it('accepts evidence only for the current runtime run', async () => {
    const teamsBasePath = mkdtempSync(join(tmpdir(), 'opencode-runtime-checkin-'));
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
