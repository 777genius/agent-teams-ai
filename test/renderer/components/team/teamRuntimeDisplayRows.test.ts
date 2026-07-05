import { buildTeamRuntimeDisplayRows } from '@renderer/components/team/teamRuntimeDisplayRows';
import { describe, expect, it } from 'vitest';

import type {
  MemberSpawnStatusEntry,
  TeamAgentRuntimeEntry,
  TeamAgentRuntimeSnapshot,
} from '@shared/types';

const members = [{ name: 'alice' }, { name: 'bob' }];

function createRuntimeEntry(overrides: Partial<TeamAgentRuntimeEntry> = {}): TeamAgentRuntimeEntry {
  return {
    memberName: 'alice',
    alive: true,
    restartable: true,
    updatedAt: '2026-05-03T10:00:00.000Z',
    ...overrides,
  };
}

function createRuntimeSnapshot(
  membersByName: Record<string, TeamAgentRuntimeEntry>
): TeamAgentRuntimeSnapshot {
  return {
    teamName: 'my-team',
    updatedAt: '2026-05-03T10:00:00.000Z',
    runId: 'run-1',
    members: membersByName,
  };
}

function createSpawnStatus(
  overrides: Partial<MemberSpawnStatusEntry> = {}
): MemberSpawnStatusEntry {
  return {
    status: 'spawning',
    launchState: 'starting',
    updatedAt: '2026-05-03T10:00:00.000Z',
    ...overrides,
  };
}

describe('buildTeamRuntimeDisplayRows', () => {
  it('maps alive runtime entries to running display rows', () => {
    const rows = buildTeamRuntimeDisplayRows({
      members,
      runtimeSnapshot: createRuntimeSnapshot({
        alice: createRuntimeEntry({ runtimeModel: 'claude-sonnet-4.5', runtimePid: 1234 }),
      }),
    });

    expect(rows[0]).toMatchObject({
      memberName: 'alice',
      state: 'running',
      source: 'runtime',
      runtimeModel: 'claude-sonnet-4.5',
      pidLabel: 'runtime pid 1234',
      actionsAllowed: false,
    });
    expect(rows[1]).toMatchObject({
      memberName: 'bob',
      state: 'unknown',
      actionsAllowed: false,
    });
  });

  it('does not treat historical bootstrap as running when runtime is not alive', () => {
    const rows = buildTeamRuntimeDisplayRows({
      members: [{ name: 'alice' }],
      runtimeSnapshot: createRuntimeSnapshot({
        alice: createRuntimeEntry({
          alive: false,
          historicalBootstrapConfirmed: true,
          runtimeDiagnostic: 'Runtime heartbeat is stale',
        }),
      }),
      spawnStatuses: {
        alice: createSpawnStatus({
          status: 'online',
          launchState: 'confirmed_alive',
          bootstrapConfirmed: true,
        }),
      },
    });

    expect(rows[0]).toMatchObject({
      memberName: 'alice',
      state: 'stopped',
      source: 'mixed',
      stateReason: 'Runtime heartbeat is stale',
      actionsAllowed: false,
    });
  });

  it('does not show bootstrap-only runtime evidence as running when spawn says runtime is stopped', () => {
    const rows = buildTeamRuntimeDisplayRows({
      members: [{ name: 'alice' }],
      runtimeSnapshot: createRuntimeSnapshot({
        alice: createRuntimeEntry({
          alive: true,
          livenessKind: 'confirmed_bootstrap',
          runtimeDiagnostic: 'bootstrap confirmed',
          runtimeDiagnosticSeverity: 'info',
        }),
      }),
      spawnStatuses: {
        alice: createSpawnStatus({
          status: 'online',
          launchState: 'confirmed_alive',
          bootstrapConfirmed: true,
          runtimeAlive: false,
          runtimeDiagnostic: 'persisted runtime pid is not alive',
          runtimeDiagnosticSeverity: 'warning',
        }),
      },
    });

    expect(rows[0]).toMatchObject({
      memberName: 'alice',
      state: 'stopped',
      source: 'mixed',
      stateReason: 'persisted runtime pid is not alive',
      diagnosticSeverity: 'warning',
      actionsAllowed: false,
    });
  });

  it('keeps spawn degradation stronger than stopped evidence for mixed rows', () => {
    const rows = buildTeamRuntimeDisplayRows({
      members: [{ name: 'alice' }],
      runtimeSnapshot: createRuntimeSnapshot({
        alice: createRuntimeEntry({
          alive: true,
          livenessKind: 'confirmed_bootstrap',
          runtimeDiagnostic: 'bootstrap confirmed',
        }),
      }),
      spawnStatuses: {
        alice: createSpawnStatus({
          status: 'online',
          launchState: 'runtime_pending_permission',
          bootstrapConfirmed: true,
          runtimeAlive: false,
          pendingPermissionRequestIds: ['perm-1'],
          runtimeDiagnostic: 'Runtime is waiting for permission approval',
          runtimeDiagnosticSeverity: 'warning',
        }),
      },
    });

    expect(rows[0]).toMatchObject({
      memberName: 'alice',
      state: 'degraded',
      source: 'mixed',
      stateReason: 'Runtime is waiting for permission approval',
      diagnosticSeverity: 'warning',
      actionsAllowed: false,
    });
  });

  it('does not show spawn-only confirmed bootstrap as running when spawn says runtime is stopped', () => {
    const rows = buildTeamRuntimeDisplayRows({
      members: [{ name: 'alice' }],
      spawnStatuses: {
        alice: createSpawnStatus({
          status: 'online',
          launchState: 'confirmed_alive',
          bootstrapConfirmed: true,
          runtimeAlive: false,
        }),
      },
    });

    expect(rows[0]).toMatchObject({
      memberName: 'alice',
      state: 'stopped',
      source: 'spawn-status',
      stateReason: 'Spawn status reports runtime is not alive',
      diagnosticSeverity: 'warning',
      actionsAllowed: false,
    });
  });

  it('treats confirmed spawn bootstrap as running even if stale status is still waiting', () => {
    const rows = buildTeamRuntimeDisplayRows({
      members: [{ name: 'alice' }],
      spawnStatuses: {
        alice: createSpawnStatus({
          status: 'waiting',
          launchState: 'confirmed_alive',
          bootstrapConfirmed: true,
          runtimeAlive: true,
          livenessKind: 'registered_only',
        }),
      },
    });

    expect(rows[0]).toMatchObject({
      memberName: 'alice',
      state: 'running',
      source: 'spawn-status',
      stateReason: 'Bootstrap confirmed',
      actionsAllowed: false,
    });
  });

  it('maps a non-alive runtime with error diagnostics to degraded', () => {
    const rows = buildTeamRuntimeDisplayRows({
      members: [{ name: 'alice' }],
      runtimeSnapshot: createRuntimeSnapshot({
        alice: createRuntimeEntry({
          alive: false,
          runtimeDiagnostic: 'Runtime process crashed',
          runtimeDiagnosticSeverity: 'error',
        }),
      }),
    });

    expect(rows[0]).toMatchObject({
      memberName: 'alice',
      state: 'degraded',
      stateReason: 'Runtime process crashed',
      actionsAllowed: false,
    });
  });

  it('degrades mixed rows when runtime is alive but spawn evidence has failed', () => {
    const rows = buildTeamRuntimeDisplayRows({
      members: [{ name: 'alice' }],
      runtimeSnapshot: createRuntimeSnapshot({
        alice: createRuntimeEntry({
          alive: true,
          runtimeDiagnostic: 'Runtime heartbeat is alive',
        }),
      }),
      spawnStatuses: {
        alice: createSpawnStatus({
          status: 'error',
          launchState: 'failed_to_start',
          hardFailure: true,
          hardFailureReason: 'Bootstrap command failed',
        }),
      },
    });

    expect(rows[0]).toMatchObject({
      memberName: 'alice',
      state: 'degraded',
      source: 'mixed',
      stateReason: 'Bootstrap command failed. Process is still alive.',
      actionsAllowed: false,
    });
  });

  it('does not degrade bootstrap-confirmed provisioned-but-not-alive rows', () => {
    const rows = buildTeamRuntimeDisplayRows({
      members: [{ name: 'alice' }],
      runtimeSnapshot: createRuntimeSnapshot({
        alice: createRuntimeEntry({
          alive: false,
          livenessKind: 'confirmed_bootstrap',
          runtimeDiagnostic:
            'runtime pid could not be verified because process table is unavailable',
          runtimeDiagnosticSeverity: 'warning',
        }),
      }),
      spawnStatuses: {
        alice: createSpawnStatus({
          status: 'error',
          launchState: 'failed_to_start',
          runtimeAlive: false,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason: 'CLI process exited (code 1) \u2014 team provisioned but not alive',
          livenessKind: 'confirmed_bootstrap',
        }),
      },
    });

    expect(rows[0]).toMatchObject({
      memberName: 'alice',
      state: 'running',
      source: 'mixed',
      stateReason: 'Bootstrap confirmed',
      diagnosticSeverity: 'warning',
      actionsAllowed: false,
    });
  });

  it('does not degrade bootstrap-confirmed native bootstrap-control rows', () => {
    const rows = buildTeamRuntimeDisplayRows({
      members: [{ name: 'cody' }],
      runtimeSnapshot: createRuntimeSnapshot({
        cody: createRuntimeEntry({
          memberName: 'cody',
          alive: false,
          livenessKind: 'confirmed_bootstrap',
          runtimeDiagnostic: 'persisted runtime pid is not alive',
          runtimeDiagnosticSeverity: 'warning',
        }),
      }),
      spawnStatuses: {
        cody: createSpawnStatus({
          status: 'error',
          launchState: 'failed_to_start',
          runtimeAlive: false,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason:
            '<agent_teams_native_bootstrap_control>\nSystem-level bootstrap rules:\n- This is a private startup context handoff.',
          livenessKind: 'confirmed_bootstrap',
        }),
      },
    });

    expect(rows[0]).toMatchObject({
      memberName: 'cody',
      state: 'running',
      source: 'mixed',
      stateReason: 'Bootstrap confirmed',
      diagnosticSeverity: 'warning',
      actionsAllowed: false,
    });
  });

  it('does not degrade Windows process-table-unavailable registered metadata rows', () => {
    const rows = buildTeamRuntimeDisplayRows({
      members: [{ name: 'alice' }],
      runtimeSnapshot: createRuntimeSnapshot({
        alice: createRuntimeEntry({
          alive: false,
          livenessKind: 'registered_only',
          runtimeDiagnostic:
            'runtime pid could not be verified because process table is unavailable',
          runtimeDiagnosticSeverity: 'warning',
        }),
      }),
      spawnStatuses: {
        alice: createSpawnStatus({
          status: 'error',
          launchState: 'failed_to_start',
          runtimeAlive: false,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason:
            'CLI process exited (code 1) - team provisioned but not alive; process table unavailable',
          livenessKind: 'registered_only',
          runtimeDiagnostic:
            'runtime pid could not be verified because process table is unavailable',
          runtimeDiagnosticSeverity: 'warning',
        }),
      },
    });

    expect(rows[0]).toMatchObject({
      memberName: 'alice',
      state: 'running',
      source: 'mixed',
      stateReason: 'Bootstrap confirmed',
      diagnosticSeverity: 'warning',
      actionsAllowed: false,
    });
  });

  it('uses spawn process-table proof when runtime registered metadata has no diagnostic text', () => {
    const rows = buildTeamRuntimeDisplayRows({
      members: [{ name: 'alice' }],
      runtimeSnapshot: createRuntimeSnapshot({
        alice: createRuntimeEntry({
          alive: false,
          livenessKind: 'registered_only',
          runtimeDiagnosticSeverity: 'warning',
        }),
      }),
      spawnStatuses: {
        alice: createSpawnStatus({
          status: 'error',
          launchState: 'failed_to_start',
          runtimeAlive: false,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason:
            'CLI process exited (code 1) - team provisioned but not alive; process table unavailable',
          livenessKind: 'confirmed_bootstrap',
        }),
      },
    });

    expect(rows[0]).toMatchObject({
      memberName: 'alice',
      state: 'running',
      source: 'mixed',
      stateReason: 'Bootstrap confirmed',
      diagnosticSeverity: 'warning',
      actionsAllowed: false,
    });
  });

  it('does not let stale provisioned-but-not-alive spawn evidence hide runtime errors', () => {
    const rows = buildTeamRuntimeDisplayRows({
      members: [{ name: 'alice' }],
      runtimeSnapshot: createRuntimeSnapshot({
        alice: createRuntimeEntry({
          alive: false,
          livenessKind: 'confirmed_bootstrap',
          runtimeDiagnostic: 'Runtime process crashed',
          runtimeDiagnosticSeverity: 'error',
        }),
      }),
      spawnStatuses: {
        alice: createSpawnStatus({
          status: 'error',
          launchState: 'failed_to_start',
          runtimeAlive: false,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
          livenessKind: 'confirmed_bootstrap',
        }),
      },
    });

    expect(rows[0]).toMatchObject({
      memberName: 'alice',
      state: 'degraded',
      source: 'mixed',
      stateReason: 'Runtime process crashed',
      diagnosticSeverity: 'error',
      actionsAllowed: false,
    });
  });

  it('does not let provisioned-but-not-alive spawn evidence hide stopped runtime evidence', () => {
    const rows = buildTeamRuntimeDisplayRows({
      members: [{ name: 'alice' }],
      runtimeSnapshot: createRuntimeSnapshot({
        alice: createRuntimeEntry({
          alive: false,
          livenessKind: 'not_found',
          runtimeDiagnostic: 'Runtime metadata was not found',
          runtimeDiagnosticSeverity: 'warning',
        }),
      }),
      spawnStatuses: {
        alice: createSpawnStatus({
          status: 'error',
          launchState: 'failed_to_start',
          runtimeAlive: false,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
          livenessKind: 'confirmed_bootstrap',
        }),
      },
    });

    expect(rows[0]).toMatchObject({
      memberName: 'alice',
      state: 'stopped',
      source: 'mixed',
      stateReason: 'Runtime metadata was not found',
      diagnosticSeverity: 'warning',
      actionsAllowed: false,
    });
  });

  it('does not let stopped provisioned-but-not-alive spawn evidence hide live runtime context', () => {
    const rows = buildTeamRuntimeDisplayRows({
      members: [{ name: 'alice' }],
      runtimeSnapshot: createRuntimeSnapshot({
        alice: createRuntimeEntry({
          alive: true,
          livenessKind: 'runtime_process',
          runtimeDiagnostic: 'Runtime process is alive',
          runtimeDiagnosticSeverity: 'info',
        }),
      }),
      spawnStatuses: {
        alice: createSpawnStatus({
          status: 'error',
          launchState: 'failed_to_start',
          runtimeAlive: false,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
          livenessKind: 'not_found',
          runtimeDiagnostic: 'Runtime is no longer registered',
          runtimeDiagnosticSeverity: 'warning',
        }),
      },
    });

    expect(rows[0]).toMatchObject({
      memberName: 'alice',
      state: 'degraded',
      source: 'mixed',
      stateReason: 'Runtime is no longer registered. Process is still alive.',
      diagnosticSeverity: 'warning',
      actionsAllowed: false,
    });
  });

  it('keeps spawn-only runtime errors visible for provisioned-but-not-alive entries', () => {
    const rows = buildTeamRuntimeDisplayRows({
      members: [{ name: 'alice' }],
      spawnStatuses: {
        alice: createSpawnStatus({
          status: 'error',
          launchState: 'failed_to_start',
          runtimeAlive: false,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
          livenessKind: 'confirmed_bootstrap',
          runtimeDiagnostic: 'Runtime process crashed',
          runtimeDiagnosticSeverity: 'error',
        }),
      },
    });

    expect(rows[0]).toMatchObject({
      memberName: 'alice',
      state: 'degraded',
      source: 'spawn-status',
      stateReason: 'Runtime process crashed',
      diagnosticSeverity: 'error',
      actionsAllowed: false,
    });
  });

  it('keeps spawn-only stopped liveness visible for provisioned-but-not-alive entries', () => {
    const rows = buildTeamRuntimeDisplayRows({
      members: [{ name: 'alice' }],
      spawnStatuses: {
        alice: createSpawnStatus({
          status: 'error',
          launchState: 'failed_to_start',
          runtimeAlive: false,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
          livenessKind: 'not_found',
          runtimeDiagnostic: 'Runtime is no longer registered',
          runtimeDiagnosticSeverity: 'warning',
        }),
      },
    });

    expect(rows[0]).toMatchObject({
      memberName: 'alice',
      state: 'degraded',
      source: 'spawn-status',
      stateReason: 'Runtime is no longer registered',
      diagnosticSeverity: 'warning',
      actionsAllowed: false,
    });
  });

  it('degrades spawn-only rows when online process evidence has stalled bootstrap', () => {
    const rows = buildTeamRuntimeDisplayRows({
      members: [{ name: 'alice' }],
      spawnStatuses: {
        alice: createSpawnStatus({
          status: 'online',
          launchState: 'runtime_pending_bootstrap',
          runtimeAlive: true,
          bootstrapStalled: true,
          runtimeDiagnostic: 'Runtime is alive, but bootstrap did not confirm',
        }),
      },
    });

    expect(rows[0]).toMatchObject({
      memberName: 'alice',
      state: 'degraded',
      source: 'spawn-status',
      stateReason: 'Runtime is alive, but bootstrap did not confirm',
      actionsAllowed: false,
    });
  });

  it('uses explicit spawn status handling without promoting unknown statuses to running', () => {
    const rows = buildTeamRuntimeDisplayRows({
      members: [{ name: 'alice' }, { name: 'bob' }, { name: 'carol' }],
      spawnStatuses: {
        alice: createSpawnStatus({ status: 'spawning' }),
        bob: createSpawnStatus({
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: true,
        }),
        carol: createSpawnStatus({ status: 'surprising-new-status' as never }),
      },
    });

    expect(rows.map((row) => [row.memberName, row.state])).toEqual([
      ['alice', 'starting'],
      ['bob', 'running'],
      ['carol', 'unknown'],
    ]);
  });

  it('chooses the latest runtime entry when multiple lanes map to one member', () => {
    const rows = buildTeamRuntimeDisplayRows({
      members: [{ name: 'alice' }],
      runtimeSnapshot: createRuntimeSnapshot({
        'alice-primary': createRuntimeEntry({
          memberName: 'alice',
          alive: false,
          laneKind: 'primary',
          updatedAt: '2026-05-03T10:00:00.000Z',
        }),
        'alice-secondary': createRuntimeEntry({
          memberName: 'alice',
          alive: true,
          laneKind: 'secondary',
          updatedAt: '2026-05-03T10:01:00.000Z',
        }),
      }),
    });

    expect(rows[0]).toMatchObject({
      memberName: 'alice',
      state: 'running',
      laneKind: 'secondary',
      actionsAllowed: false,
    });
  });
});
